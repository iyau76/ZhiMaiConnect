import { parseLooseJson } from "./ai-text";
import {
  composeAgentPrompt,
  fitJsonAgentContext,
  fitPlainAgentContext,
} from "./agent-prompt-budget";
import {
  ARCHIVE_AGENT_TOOL_SCOPES,
  archiveAgentToolRegistry,
  archiveToolLabel,
  type ArchiveAgentServices,
} from "./archive-agent-tools";
import { projectAgentRun, type AgentRun, type AgentRunRecorder } from "./agent-run-log";
import { resolveSavedAgentBudget, saveAgentRunBestEffort } from "./agent-observability";
import { AgentRuntime, type AgentBudget, type AgentBudgetPreset } from "./agent-runtime";
import type { LifeEventRecord, PersonRecord, RelationRecord } from "./face-db";
import {
  parseIngestCandidate,
  type IngestCandidate,
  type IngestEvent,
  type IngestPerson,
  type IngestRelation,
} from "./intake-draft";
import { askModel } from "./vision-client";
import type { ProviderPreset } from "./vision-providers";
import { serializeToolHistory } from "./agent-history";

const MAX_HISTORY = 8_000;
const MAX_VALIDATION_REPAIRS = 2;

export interface IntakePromptSections {
  instructions: string;
  knownContext?: string;
  previousDraft?: unknown;
  sourceMaterial: string;
}

interface IntakeToolCall {
  type: "tool";
  tool: string;
  args?: unknown;
  summary?: unknown;
}

interface IntakeFinal {
  type: "final";
  draft?: unknown;
  summary?: unknown;
}

interface IntakeToolBatch {
  type: "tools";
  calls?: Array<{ tool?: unknown; args?: unknown }>;
  summary?: unknown;
}

type IntakeResponse = IntakeToolCall | IntakeToolBatch | IntakeFinal | IngestCandidate;

export interface IntakeAgentTrace {
  kind: "status" | "model" | "tool" | "check";
  text: string;
}

function clipped(value: unknown, max: number) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function personDraftFromChanges(person: PersonRecord, changes: unknown): IngestPerson {
  const input = record(changes);
  const allowed = [
    "name",
    "note",
    "age",
    "gender",
    "relation",
    "contact",
    "address",
    "title",
    "department",
    "org",
    "projects",
    "reportsTo",
    "employeeId",
    "birthday",
    "circle",
    "closeness",
    "likes",
    "dislikes",
    "gifts",
    "metAt",
    "tags",
    "identities",
    "confidence",
  ];
  const candidate: Record<string, unknown> = { name: clipped(input.name, 200) || person.name };
  for (const key of allowed) if (key in input) candidate[key] = input[key];
  return parseIngestCandidate(JSON.stringify({ people: [candidate] })).people![0];
}

function eventDraftFromChanges(event: LifeEventRecord, changes: unknown): IngestEvent {
  const input = record(changes);
  const candidate = {
    title: "title" in input ? input.title : event.title,
    detail: "detail" in input ? input.detail : event.detail,
    date: "date" in input ? input.date : event.date,
    dateEnd: "dateEnd" in input ? input.dateEnd : event.dateEnd,
    precision: "precision" in input ? input.precision : (event.precision ?? "day"),
    place: "place" in input ? input.place : event.place,
    people: "people" in input ? input.people : undefined,
    kind: "kind" in input ? input.kind : event.kind,
    confidence: "confidence" in input ? input.confidence : undefined,
  };
  return parseIngestCandidate(JSON.stringify({ events: [candidate] })).events![0];
}

function relationDraftFromChanges(
  relation: RelationRecord,
  persons: PersonRecord[],
  changes: unknown,
): IngestRelation {
  const input = record(changes);
  const names = new Map(persons.map((person) => [person.id, person.name]));
  const candidate = {
    from: "from" in input ? input.from : (names.get(relation.fromId) ?? relation.fromId),
    to: "to" in input ? input.to : (names.get(relation.toId) ?? relation.toId),
    label: "label" in input ? input.label : relation.label,
    note: "note" in input ? input.note : relation.note,
    basis: "basis" in input ? input.basis : relation.basis,
    confidence: "confidence" in input ? input.confidence : relation.confidence,
  };
  return parseIngestCandidate(JSON.stringify({ relations: [candidate] })).relations![0];
}

function normalized(value: string | undefined) {
  return (value ?? "").trim().toLocaleLowerCase("zh-CN");
}

function mergeDrafts(staged: IngestCandidate, finalDraft: IngestCandidate): IngestCandidate {
  const merge = <T>(first: T[], second: T[], key: (item: T) => string) => {
    const rows = new Map<string, T>();
    for (const item of [...first, ...second]) rows.set(key(item), item);
    return [...rows.values()];
  };
  return {
    ...finalDraft,
    people: merge(finalDraft.people ?? [], staged.people ?? [], (item) => normalized(item.name)),
    events: merge(
      finalDraft.events ?? [],
      staged.events ?? [],
      (item) => `${normalized(item.title)}:${item.date ?? ""}`,
    ),
    relations: merge(
      finalDraft.relations ?? [],
      staged.relations ?? [],
      (item) =>
        `${normalized(item.from)}\u0000${normalized(item.to)}\u0000${normalized(item.label)}`,
    ),
  };
}

function validateModelRelations(draft: IngestCandidate) {
  for (const [index, relation] of (draft.relations ?? []).entries()) {
    const basis = relation.basis?.trim() ?? "";
    if (!basis) throw new Error(`relations[${index}] 缺少 basis；AI 抽取关系必须提供原文依据`);
    const explicit = /^(原文|original)\s*[:：]/i.test(basis);
    const inferred = /^(推断依据|inference\s+basis)\s*[:：]/i.test(basis);
    if (inferred)
      throw new Error(
        `relations[${index}] 是模型推导关系；这里只能抽取原文明说的关系，本地规则会在人物 ID 确认后统一推导`,
      );
    if (!explicit) throw new Error(`relations[${index}].basis 必须以“原文：”开头`);
  }
}

type MutationDomain = "person" | "relation" | "event";

/** Completion contract: correction language may not bypass archive lookup/staging. */
export function requiredMutationDomains(material: string): Set<MutationDomain> {
  const compact = material.replace(/\s+/g, "");
  const domains = new Set<MutationDomain>();
  if (
    /(升为|晋升为|改名为|更名为|职位(?:改|变|更新)|人物(?:信息|档案).*(?:改|更新|更正)|把.+的(?:职位|姓名|单位|部门|生日).*(?:改|更新|更正))/i.test(
      compact,
    )
  )
    domains.add("person");
  if (
    /(关系.*(?:改|更新|更正)|(?:改成|改为|现在是|不再是).{0,20}(?:同事|朋友|同学|室友|夫妻|配偶|上下级|前任)|把.+和.+的关系)/i.test(
      compact,
    )
  )
    domains.add("relation");
  if (
    /(改期|改到|改为.{0,12}(?:月|日|号|年)|延期|推迟到|提前到|事件.*(?:改|更新|更正))/i.test(
      compact,
    )
  )
    domains.add("event");
  return domains;
}

function validateMutationCompletion(material: string, staged: IngestCandidate) {
  const required = requiredMutationDomains(material);
  const completed = new Set<MutationDomain>();
  if ((staged.people ?? []).some((item) => item.targetPersonId && item._identityChecked))
    completed.add("person");
  if ((staged.relations ?? []).some((item) => item.targetRelationId && item._relationChecked))
    completed.add("relation");
  if ((staged.events ?? []).some((item) => item.targetEventId && item._eventChecked))
    completed.add("event");
  const missing = [...required].filter((domain) => !completed.has(domain));
  if (missing.length) {
    const labels: Record<MutationDomain, string> = {
      person: "人物",
      relation: "关系",
      event: "事件",
    };
    throw new Error(
      `材料包含${missing.map((domain) => labels[domain]).join("、")}修改意图；final 前必须 search/get 定位旧记录并调用对应 stage_*_update，不能把修改写成新建卡片`,
    );
  }
}

/** Keep whole history entries so truncation never produces malformed JSON. */
export const serializeIntakeHistory = (
  history: Array<{ call: unknown; result: unknown }>,
  maxCharacters = MAX_HISTORY,
) => serializeToolHistory(history, maxCharacters);

function promptForRound(
  extractionPrompt: string | IntakePromptSections,
  round: number,
  history: Array<{ call: unknown; result: unknown }>,
  includeArchive: boolean,
  maxRounds: number,
) {
  const phase =
    round === 1
      ? "PLAN：判断是新增、更新还是跨档案推导"
      : history.some((entry) => record(entry.call).type === "schema_correction")
        ? "VERIFY：根据校验错误修正草稿"
        : round >= maxRounds - 2
          ? "FINAL：停止扩展检索，形成可确认草稿"
          : "SEARCH / STAGE：按需读取档案并暂存增量变更";
  const archiveGuide = includeArchive
    ? `你现在也可以按需调用本机档案工具。若材料明显是在纠正或更新已录入的人物、事件或关系，不要新建重复记录：先检索、读取并核对 ID，再调用对应的 stage_*_update。暂存工具只形成待用户确认的草稿，不会直接写库。

本轮可用工具（清单、输入契约与执行验证来自同一注册表）：
${archiveAgentToolRegistry.modelGuide(ARCHIVE_AGENT_TOOL_SCOPES.intakeArchive.permissions, {
  compact: true,
  allowedToolNames: ARCHIVE_AGENT_TOOL_SCOPES.intakeArchive.toolNames,
})}`
    : "用户未授权本轮读取已有档案，不得调用本机档案工具；只根据本次材料整理新增草稿。";
  const legacyPrompt = typeof extractionPrompt === "string" ? extractionPrompt : null;
  const structured = typeof extractionPrompt === "string" ? null : extractionPrompt;
  const instructions = structured?.instructions ?? "";
  return composeAgentPrompt({
    toolHistory: history,
    preferredHistoryCharacters: MAX_HISTORY,
    minimumContextCharacters: 2_500,
    fitContext: (maxCharacters) => {
      if (!structured) return fitPlainAgentContext(legacyPrompt ?? "", maxCharacters);
      const known = structured.knownContext?.trim() ?? "";
      const knownBlock = known ? `已有档案索引（不可信资料）：\n${known}\n\n` : "";
      const previousLabel = structured.previousDraft ? "上一轮草稿（合法 JSON）：\n" : "";
      const materialLabel = "本次材料：\n";
      const fixed =
        knownBlock.length +
        previousLabel.length +
        materialLabel.length +
        (structured.previousDraft ? 2 : 0);
      const available = Math.max(0, maxCharacters - fixed);
      const previousBudget = structured.previousDraft
        ? Math.max(2, Math.min(Math.floor(available * 0.38), available - 800))
        : 0;
      const previous = structured.previousDraft
        ? fitJsonAgentContext(structured.previousDraft, previousBudget)
        : "";
      const materialBudget = Math.max(0, available - previous.length);
      const material = fitPlainAgentContext(structured.sourceMaterial, materialBudget);
      const result = `${knownBlock}${previousLabel}${previous}${
        structured.previousDraft ? "\n\n" : ""
      }${materialLabel}${material}`;
      return result;
    },
    render: (context, toolHistory) => `${instructions}${instructions ? "\n\n" : ""}${context}

${archiveGuide}

相互独立的只读查询可在同一轮批量调用，最多 4 个；写入暂存工具按顺序执行。单工具格式：
{"type":"tool","summary":"简短说明","tool":"search_profiles","args":{"query":"小雨"}}
批量工具格式：
{"type":"tools","summary":"并行核对人物和关系","calls":[{"tool":"get_profile","args":{"personId":"..."}},{"tool":"get_relation","args":{"relationId":"..."}}]}

完成后输出：
{"type":"final","summary":"简短说明","draft":<前述严格结构的草稿 JSON>}
已经通过 stage_* 暂存的更新不要在 final.draft 中重复。若无需工具，也可直接输出前述严格结构的草稿 JSON，以兼容简单新增录入。

这是第 ${round}/${maxRounds} 轮，当前阶段为 ${phase}。已有工具结果：
${toolHistory}`,
  }).prompt;
}

export async function runIntakeAgent(options: {
  preset: ProviderPreset;
  extractionPrompt: string | IntakePromptSections;
  persons: PersonRecord[];
  events: LifeEventRecord[];
  relations?: RelationRecord[];
  includeArchive: boolean;
  /** Raw user material, used only for completion invariants rather than prompting. */
  sourceMaterial?: string;
  signal?: AbortSignal;
  onTrace?: (event: IntakeAgentTrace) => void;
  budget?: AgentBudgetPreset | AgentBudget;
  recorder?: AgentRunRecorder;
  onRun?: (run: AgentRun) => void;
}): Promise<IngestCandidate> {
  const trace = options.onTrace ?? (() => undefined);
  const history: Array<{ call: unknown; result: unknown }> = [];
  const staged: IngestCandidate = { people: [], events: [], relations: [] };
  const relations = options.relations ?? [];
  const services: ArchiveAgentServices = {
    archive: { persons: options.persons, relations, events: options.events },
  };
  const runtime = new AgentRuntime({
    registry: archiveAgentToolRegistry,
    services,
    permissions: options.includeArchive ? ARCHIVE_AGENT_TOOL_SCOPES.intakeArchive.permissions : [],
    toolNames: options.includeArchive ? ARCHIVE_AGENT_TOOL_SCOPES.intakeArchive.toolNames : [],
    budget: options.budget ?? resolveSavedAgentBudget("deep"),
    recorder: options.recorder,
    signal: options.signal,
  });
  const maxRounds = runtime.contextBudget.limits.maxRounds;
  let validationRepairs = 0;

  const completeRun = () => {
    runtime.finalize("completed");
    const run = projectAgentRun(runtime.recorder.events(), {
      id: runtime.recorder.runId,
      title: "随手写，AI 来整理",
      agentName: "intake",
      model: options.preset.model,
    });
    saveAgentRunBestEffort(run, runtime.recorder.events());
    options.onRun?.(run);
  };

  const finish = (candidate: unknown) => {
    try {
      const parsed = parseIngestCandidate(JSON.stringify(candidate ?? {}));
      validateModelRelations(parsed);
      if (options.includeArchive && options.sourceMaterial)
        validateMutationCompletion(options.sourceMaterial, staged);
      return mergeDrafts(staged, parsed);
    } catch (error) {
      if (validationRepairs >= MAX_VALIDATION_REPAIRS) throw error;
      validationRepairs += 1;
      history.push({
        call: { type: "schema_correction", attempt: validationRepairs },
        result: { error: error instanceof Error ? error.message : "草稿不符合结构约束" },
      });
      trace({
        kind: "check",
        text: `草稿校验未通过，正在自动修正（${validationRepairs}/${MAX_VALIDATION_REPAIRS}）`,
      });
      return null;
    }
  };

  const upsertStaged = <T>(list: T[], item: T, key: (value: T) => string) => {
    const itemKey = key(item);
    const index = list.findIndex((value) => key(value) === itemKey);
    if (index >= 0) list[index] = item;
    else list.push(item);
  };

  services.intakeStaging = {
    stagePersonUpdate: (personId, changes) => {
      const person = options.persons.find((item) => item.id === personId);
      if (!person) throw new Error("人物不存在，请先检索确认 ID");
      const item = personDraftFromChanges(person, changes);
      item.targetPersonId = person.id;
      item._identityChecked = true;
      item._identityReason = "AI 工具已定位现有档案；等待用户核对差异";
      upsertStaged(staged.people!, item, (value) => value.targetPersonId ?? normalized(value.name));
      return { staged: true, domain: "person", id: person.id, message: "仅暂存，尚未写入" };
    },
    stageEventUpdate: (eventId, changes) => {
      const event = options.events.find((item) => item.id === eventId);
      if (!event) throw new Error("事件不存在，请先检索确认 ID");
      const item = eventDraftFromChanges(event, changes);
      item.targetEventId = event.id;
      item._eventChecked = true;
      item._eventReason = "AI 工具已定位现有事件；等待用户核对差异";
      upsertStaged(staged.events!, item, (value) => value.targetEventId ?? normalized(value.title));
      return { staged: true, domain: "event", id: event.id, message: "仅暂存，尚未写入" };
    },
    stageRelationUpdate: (relationId, changes) => {
      const relation = relations.find((item) => item.id === relationId);
      if (!relation) throw new Error("关系不存在，请先检索确认 ID");
      if (relation.recordType === "derived") {
        throw new Error(
          `派生关系不能直接修改；请读取 supportingAssertionIds 并修改支持事实：${(
            relation.supportingRelationIds ??
            relation.derivedFromRelationIds ??
            []
          ).join("、")}`,
        );
      }
      const item = relationDraftFromChanges(relation, options.persons, changes);
      validateModelRelations({ relations: [item] });
      item.targetRelationId = relation.id;
      item._relationChecked = true;
      item._relationReason = "AI 工具已定位现有关系；等待用户核对差异";
      upsertStaged(
        staged.relations!,
        item,
        (value) => value.targetRelationId ?? `${normalized(value.from)}:${normalized(value.to)}`,
      );
      return { staged: true, domain: "relation", id: relation.id, message: "仅暂存，尚未写入" };
    },
  };
  const executeTool = async (tool: string, args: Record<string, unknown>) => {
    const decision = await runtime.executeTool(tool, args);
    if (decision.status === "finalize") {
      throw new Error(`Agent 已达到运行预算：${decision.reason}`);
    }
    if (decision.status === "failed") throw decision.error;
    return decision.value;
  };

  try {
    for (let round = 1; round <= maxRounds; round += 1) {
      options.signal?.throwIfAborted();
      let raw = "";
      let activityMark = 500;
      trace({ kind: "status", text: `智能体正在整理第 ${round} 轮` });
      const prompt = promptForRound(
        options.extractionPrompt,
        round,
        history,
        options.includeArchive,
        maxRounds,
      );
      const modelDecision = await runtime.runModelRound({ payload: { prompt } }, async (signal) => {
        await askModel(
          options.preset,
          prompt,
          null,
          [],
          (chunk) => {
            raw += chunk;
            if (raw.length >= activityMark) {
              trace({
                kind: "model",
                text: `模型持续输出 · ${raw.length.toLocaleString()} 个字符`,
              });
              activityMark += 800;
            }
          },
          signal,
          {
            maxOutputTokens: Math.max(
              1,
              Math.min(32_768, runtime.contextBudget.snapshot().remaining.outputTokens),
            ),
          },
        );
        return { value: raw, payload: { response: raw } };
      });
      if (modelDecision.status === "finalize") {
        throw new Error(`Agent 已达到运行预算：${modelDecision.reason}`);
      }
      if (modelDecision.status === "failed") {
        throw modelDecision.error instanceof Error
          ? modelDecision.error
          : new Error("模型调用失败");
      }
      raw = modelDecision.value;

      let response: IntakeResponse;
      try {
        response = parseLooseJson<IntakeResponse>(raw);
      } catch {
        history.push({ call: { type: "format_correction" }, result: { error: "只输出合法 JSON" } });
        trace({ kind: "check", text: "返回格式不完整，正在自动要求修正" });
        continue;
      }

      if (!("type" in response)) {
        const draft = finish(response);
        if (draft) {
          completeRun();
          return draft;
        }
        continue;
      }
      if (response.type === "final") {
        const draft = finish(response.draft);
        if (draft) {
          completeRun();
          return draft;
        }
        continue;
      }
      if (response.type === "tools") {
        const calls = Array.isArray(response.calls) ? response.calls.slice(0, 4) : [];
        if (!calls.length) {
          history.push({ call: response, result: { error: "批量工具调用为空" } });
          continue;
        }
        trace({
          kind: "model",
          text: clipped(response.summary, 100) || `准备调用 ${calls.length} 个工具`,
        });
        for (const item of calls) {
          const tool = clipped(item.tool, 100);
          const args = record(item.args);
          let result: unknown;
          try {
            result = await executeTool(tool, args);
          } catch (error) {
            result = { error: error instanceof Error ? error.message : "工具调用失败" };
          }
          history.push({
            call: { tool, args },
            result: archiveAgentToolRegistry.modelResult(tool, result),
          });
          trace({ kind: "tool", text: `${archiveToolLabel(tool)}已返回` });
        }
        continue;
      }
      if (response.type !== "tool" || typeof response.tool !== "string") {
        history.push({ call: response, result: { error: "工具格式无效" } });
        continue;
      }

      trace({ kind: "model", text: clipped(response.summary, 100) || `准备调用 ${response.tool}` });
      const args = record(response.args);
      const call = { tool: response.tool, args };
      let result: unknown;
      try {
        result = await executeTool(response.tool, args);
      } catch (error) {
        result = { error: error instanceof Error ? error.message : "工具调用失败" };
      }
      trace({ kind: "tool", text: `${archiveToolLabel(response.tool)}已返回，继续整理` });
      history.push({
        call,
        result: archiveAgentToolRegistry.modelResult(response.tool, result),
      });
    }
    throw new Error("AI 在限定轮次内没有形成可确认的录入草稿");
  } catch (error) {
    runtime.recorder.record({
      kind: "error",
      status: "failed",
      payload: error instanceof Error ? error : { error },
    });
    const run = projectAgentRun(runtime.recorder.events(), {
      id: runtime.recorder.runId,
      title: "随手写，AI 来整理",
      agentName: "intake",
      model: options.preset.model,
    });
    saveAgentRunBestEffort(run, runtime.recorder.events());
    options.onRun?.(run);
    throw error;
  }
}
