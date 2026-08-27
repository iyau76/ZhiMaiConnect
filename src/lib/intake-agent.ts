import { parseLooseJson } from "./ai-text";
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
import { deriveKinshipRelations } from "./kinship-engine";
import { serializeToolHistory } from "./agent-history";

const MAX_ROUNDS = 12;
const MAX_HISTORY = 8_000;
const MAX_VALIDATION_REPAIRS = 2;

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
    if (!basis) throw new Error(`relations[${index}] 缺少 basis；AI 关系必须提供原文或推断依据`);
    const explicit = /^(原文|original)\s*[:：]/i.test(basis);
    const inferred = /^(推断依据|inference\s+basis)\s*[:：]/i.test(basis);
    if (!explicit && !inferred) {
      throw new Error(`relations[${index}].basis 必须以“原文：”或“推断依据：”开头`);
    }
    if (inferred && (relation.confidence ?? 1) > 0.75) {
      throw new Error(`relations[${index}] 是推导关系，confidence 必须不高于 0.75`);
    }
  }
}

/** Keep whole history entries so truncation never produces malformed JSON. */
export const serializeIntakeHistory = (
  history: Array<{ call: unknown; result: unknown }>,
  maxCharacters = MAX_HISTORY,
) => serializeToolHistory(history, maxCharacters);

function promptForRound(
  extractionPrompt: string,
  round: number,
  history: Array<{ call: unknown; result: unknown }>,
  includeArchive: boolean,
) {
  const phase =
    round === 1
      ? "PLAN：判断是新增、更新还是跨档案推导"
      : history.some((entry) => record(entry.call).type === "schema_correction")
        ? "VERIFY：根据校验错误修正草稿"
        : round >= MAX_ROUNDS - 2
          ? "FINAL：停止扩展检索，形成可确认草稿"
          : "SEARCH / STAGE：按需读取档案并暂存增量变更";
  const archiveGuide = includeArchive
    ? `你现在也可以按需调用本机档案工具。若材料明显是在纠正或更新已录入的人物、事件或关系，不要新建重复记录：先检索、读取并核对 ID，再调用对应的 stage_*_update。暂存工具只形成待用户确认的草稿，不会直接写库。

本机档案工具：
- search_profiles {query,limit}：按姓名及档案字段检索人物
- get_profile {personId}：读取一份人物档案
- search_events {query,limit}：按标题、详情、地点、日期或关联人物检索事件
- get_event {eventId}：读取一条事件
- search_relations {query,limit}：按人物姓名、关系标签、依据和备注检索关系
- get_relation {relationId}：读取一条关系及两端人物
- stage_person_update {personId,changes}：暂存人物字段修改；changes 只写需要改变的字段
- stage_event_update {eventId,changes}：暂存事件修改；changes 可含 title/detail/date/dateEnd/precision/place/people/kind
- stage_relation_update {relationId,changes}：暂存关系修改；changes 可含 from/to/label/note/basis/confidence`
    : "用户未授权本轮读取已有档案，不得调用本机档案工具；只根据本次材料整理新增草稿。";
  return `${extractionPrompt}

${archiveGuide}

相互独立的只读查询可在同一轮批量调用，最多 4 个；写入暂存工具按顺序执行。单工具格式：
{"type":"tool","summary":"简短说明","tool":"search_profiles","args":{"query":"小雨"}}
批量工具格式：
{"type":"tools","summary":"并行核对人物和关系","calls":[{"tool":"get_profile","args":{"personId":"..."}},{"tool":"get_relation","args":{"relationId":"..."}}]}

完成后输出：
{"type":"final","summary":"简短说明","draft":<前述严格结构的草稿 JSON>}
已经通过 stage_* 暂存的更新不要在 final.draft 中重复。若无需工具，也可直接输出前述严格结构的草稿 JSON，以兼容简单新增录入。

这是第 ${round}/${MAX_ROUNDS} 轮，当前阶段为 ${phase}。已有工具结果：
${serializeIntakeHistory(history) || "[]"}`;
}

function publicRelation(relation: RelationRecord, persons: PersonRecord[]) {
  const names = new Map(persons.map((person) => [person.id, person.name]));
  return {
    id: relation.id,
    from: names.get(relation.fromId) ?? relation.fromId,
    to: names.get(relation.toId) ?? relation.toId,
    label: relation.label,
    note: relation.note,
    basis: relation.basis,
    evidenceMode: relation.evidenceMode,
    confidence: relation.confidence,
    confirmationStatus: relation.confirmationStatus,
    updatedAt: relation.updatedAt ?? relation.createdAt,
  };
}

function publicPerson(person: PersonRecord, relations: RelationRecord[], persons: PersonRecord[]) {
  const profile = person.profile ?? {};
  const { contact, employeeId, fingerprintRef, fieldSources, identities, ...safeProfile } = profile;
  void employeeId;
  void fingerprintRef;
  void fieldSources;
  return {
    id: person.id,
    name: person.name,
    note: person.note,
    profile: {
      ...safeProfile,
      hasContact: Boolean(contact?.trim()),
      identities: (identities ?? []).map((identity) => ({
        platform: identity.platform,
        alias: identity.alias,
        validFrom: identity.validFrom,
        validTo: identity.validTo,
      })),
    },
    relationships: relations
      .filter((relation) => relation.fromId === person.id || relation.toId === person.id)
      .slice(0, 30)
      .map((relation) => publicRelation(relation, persons)),
    updatedAt: person.updatedAt ?? person.createdAt,
  };
}

function publicEvent(event: LifeEventRecord, persons: PersonRecord[]) {
  const names = new Map(persons.map((person) => [person.id, person.name]));
  return {
    id: event.id,
    title: event.title,
    detail: event.detail,
    date: event.date,
    dateEnd: event.dateEnd,
    precision: event.precision ?? "day",
    place: event.place,
    people: (event.personIds ?? []).map((id) => names.get(id) ?? id),
    kind: event.kind,
    updatedAt: event.updatedAt ?? event.createdAt,
  };
}

export async function runIntakeAgent(options: {
  preset: ProviderPreset;
  extractionPrompt: string;
  persons: PersonRecord[];
  events: LifeEventRecord[];
  relations?: RelationRecord[];
  includeArchive: boolean;
  signal?: AbortSignal;
  onTrace?: (event: IntakeAgentTrace) => void;
}): Promise<IngestCandidate> {
  const trace = options.onTrace ?? (() => undefined);
  const history: Array<{ call: unknown; result: unknown }> = [];
  const staged: IngestCandidate = { people: [], events: [], relations: [] };
  const relations = options.relations ?? [];
  const personNames = new Map(options.persons.map((person) => [person.id, person.name]));
  const supportingRelations: IngestRelation[] = relations
    .filter((relation) => relation.evidenceMode === "explicit" && relation.basis)
    .map((relation) => ({
      from: personNames.get(relation.fromId) ?? relation.fromId,
      to: personNames.get(relation.toId) ?? relation.toId,
      label: relation.label,
      note: relation.note,
      basis: /^(原文|original)\s*[:：]/i.test(relation.basis ?? "")
        ? relation.basis
        : `原文：${relation.basis}`,
      confidence: relation.confidence,
    }));
  let validationRepairs = 0;

  const finish = (candidate: unknown) => {
    try {
      const parsed = parseIngestCandidate(JSON.stringify(candidate ?? {}));
      validateModelRelations(parsed);
      const draft = deriveKinshipRelations(parsed, supportingRelations);
      validateModelRelations(draft);
      return mergeDrafts(staged, draft);
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

  type ToolHandler = (args: Record<string, unknown>) => unknown | Promise<unknown>;
  const tools: Record<string, ToolHandler> = {
    search_profiles: (args) => {
      const query = clipped(args.query, 200).toLocaleLowerCase();
      const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 30);
      const matches = options.persons.filter((person) =>
        JSON.stringify(publicPerson(person, relations, options.persons))
          .toLocaleLowerCase()
          .includes(query),
      );
      return {
        matches: matches.slice(0, limit).map((person) => ({ id: person.id, name: person.name })),
      };
    },
    get_profile: (args) => {
      const person = options.persons.find((item) => item.id === clipped(args.personId, 200));
      return person ? publicPerson(person, relations, options.persons) : { error: "人物不存在" };
    },
    search_events: (args) => {
      const query = clipped(args.query, 200).toLocaleLowerCase();
      const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 30);
      const matches = options.events.filter((event) =>
        JSON.stringify(publicEvent(event, options.persons)).toLocaleLowerCase().includes(query),
      );
      return {
        matches: matches.slice(0, limit).map((event) => publicEvent(event, options.persons)),
      };
    },
    get_event: (args) => {
      const event = options.events.find((item) => item.id === clipped(args.eventId, 200));
      return event ? publicEvent(event, options.persons) : { error: "事件不存在" };
    },
    search_relations: (args) => {
      const query = clipped(args.query, 200).toLocaleLowerCase();
      const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 30);
      const matches = relations.filter((relation) =>
        JSON.stringify(publicRelation(relation, options.persons))
          .toLocaleLowerCase()
          .includes(query),
      );
      return {
        matches: matches
          .slice(0, limit)
          .map((relation) => publicRelation(relation, options.persons)),
      };
    },
    get_relation: (args) => {
      const relation = relations.find((item) => item.id === clipped(args.relationId, 200));
      return relation ? publicRelation(relation, options.persons) : { error: "关系不存在" };
    },
    stage_person_update: (args) => {
      const person = options.persons.find((item) => item.id === clipped(args.personId, 200));
      if (!person) throw new Error("人物不存在，请先检索确认 ID");
      const item = personDraftFromChanges(person, args.changes);
      item.targetPersonId = person.id;
      item._identityChecked = true;
      item._identityReason = "AI 工具已定位现有档案；等待用户核对差异";
      upsertStaged(staged.people!, item, (value) => value.targetPersonId ?? normalized(value.name));
      return { staged: true, domain: "person", id: person.id, message: "仅暂存，尚未写入" };
    },
    stage_event_update: (args) => {
      const event = options.events.find((item) => item.id === clipped(args.eventId, 200));
      if (!event) throw new Error("事件不存在，请先检索确认 ID");
      const item = eventDraftFromChanges(event, args.changes);
      item.targetEventId = event.id;
      item._eventChecked = true;
      item._eventReason = "AI 工具已定位现有事件；等待用户核对差异";
      upsertStaged(staged.events!, item, (value) => value.targetEventId ?? normalized(value.title));
      return { staged: true, domain: "event", id: event.id, message: "仅暂存，尚未写入" };
    },
    stage_relation_update: (args) => {
      const relation = relations.find((item) => item.id === clipped(args.relationId, 200));
      if (!relation) throw new Error("关系不存在，请先检索确认 ID");
      const item = relationDraftFromChanges(relation, options.persons, args.changes);
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
    if (!options.includeArchive) return { error: "用户未授权本轮读取已有档案" };
    const handler = tools[tool];
    return handler ? await handler(args) : { error: "不支持的工具" };
  };

  for (let round = 1; round <= MAX_ROUNDS; round += 1) {
    options.signal?.throwIfAborted();
    let raw = "";
    let activityMark = 500;
    trace({ kind: "status", text: `智能体正在整理第 ${round} 轮` });
    await askModel(
      options.preset,
      promptForRound(options.extractionPrompt, round, history, options.includeArchive),
      null,
      [],
      (chunk) => {
        raw += chunk;
        if (raw.length >= activityMark) {
          trace({ kind: "model", text: `模型持续输出 · ${raw.length.toLocaleString()} 个字符` });
          activityMark += 800;
        }
      },
      options.signal ?? new AbortController().signal,
    );

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
      if (draft) return draft;
      continue;
    }
    if (response.type === "final") {
      const draft = finish(response.draft);
      if (draft) return draft;
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
        history.push({ call: { tool, args }, result });
        trace({ kind: "tool", text: `${tool || "未知工具"} 已返回` });
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
    trace({ kind: "tool", text: `${response.tool} 已返回，继续整理` });
    history.push({ call, result });
  }
  throw new Error("AI 在限定轮次内没有形成可确认的录入草稿");
}
