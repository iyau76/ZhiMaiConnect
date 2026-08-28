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
import {
  IntakeTaskStateMachine,
  type IntakeMutationPlan,
  type IntakeMutationTask,
  type IntakeTaskSnapshot,
} from "./intake-task-state";
import { isSelfReference, SELF_PERSON_ID } from "./person-identity";

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

type IntakeResponse =
  IntakeToolCall | IntakeToolBatch | IntakeFinal | IntakeMutationPlan | IngestCandidate;

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

function personNames(person: PersonRecord) {
  return [person.name, ...(person.profile?.identities ?? []).map((identity) => identity.alias)];
}

function compactIntakeArchiveIndex(
  persons: readonly PersonRecord[],
  relations: readonly RelationRecord[],
  events: readonly LifeEventRecord[],
) {
  const names = new Map(persons.map((person) => [person.id, person.name]));
  const fitRows = (rows: unknown[]) => {
    const selected: unknown[] = [];
    for (const row of rows) {
      if (JSON.stringify([...selected, row]).length > 2_000) break;
      selected.push(row);
    }
    return selected;
  };
  return JSON.stringify({
    persons: fitRows(
      persons.map((person) => ({
        id: person.id,
        name: person.name,
        entityRole: person.entityRole ?? "contact",
        aliases: (person.profile?.identities ?? []).map((identity) => identity.alias),
        relation: person.profile?.relation ?? "",
        title: person.profile?.title ?? "",
        org: person.profile?.org ?? "",
      })),
    ),
    relations: fitRows(
      relations
        .filter((relation) => relation.recordType !== "derived")
        .map((relation) => ({
          id: relation.id,
          fromPersonId: relation.fromId,
          from: names.get(relation.fromId) ?? relation.fromId,
          toPersonId: relation.toId,
          to: names.get(relation.toId) ?? relation.toId,
          label: relation.label,
        })),
    ),
    events: fitRows(
      events.map((event) => ({ id: event.id, title: event.title, date: event.date })),
    ),
  });
}

interface CompiledIntakePlan {
  plan: IntakeMutationPlan;
  staged: IngestCandidate;
  completionIds: Map<string, string>;
}

/** Pure compile boundary: no task-state or staged-draft mutation occurs before this succeeds. */
export function compileIntakePlan(options: {
  candidate: unknown;
  persons: readonly PersonRecord[];
  relations: readonly RelationRecord[];
  events: readonly LifeEventRecord[];
}): CompiledIntakePlan {
  const parser = new IntakeTaskStateMachine({ planRequired: true });
  parser.acceptPlan(options.candidate);
  const input = record(options.candidate);
  const tasks = parser.plannedTasks();
  const staged: IngestCandidate = {
    people: [],
    facts: [],
    relations: [],
    events: [],
    reminders: [],
    evidence: [],
  };
  const completionIds = new Map<string, string>();
  const createdPeopleByName = new Map<string, IngestPerson[]>();
  const createdPeopleByRef = new Map<string, IngestPerson>();

  const personKey = (name: string) => normalized(name).replace(/\s+/g, "");

  const existingPersonMatches = (name: string) => {
    const key = personKey(name);
    return options.persons.filter((person) =>
      personNames(person).some((candidate) => personKey(candidate) === key),
    );
  };
  const assertPersonIdMatches = (personId: string, name: string, taskId: string) => {
    const person = options.persons.find((candidate) => candidate.id === personId);
    if (!person) throw new Error(`任务 ${taskId} 引用了不存在的人物 ID：${personId}`);
    if (
      !isSelfReference(name) &&
      !personNames(person).some((candidate) => personKey(candidate) === personKey(name))
    ) {
      throw new Error(
        `任务 ${taskId} 的人物 ID ${personId} 属于“${person.name}”，与目标名“${name}”不一致`,
      );
    }
    return person;
  };
  const resolveExistingPerson = (name: string, taskId: string, personId?: string) => {
    if (personId) return assertPersonIdMatches(personId, name, taskId);
    if (isSelfReference(name)) {
      const self = options.persons.find(
        (person) => person.id === SELF_PERSON_ID || person.entityRole === "ego",
      );
      if (self) return self;
    }
    const matches = existingPersonMatches(name);
    if (matches.length !== 1) {
      throw new Error(
        matches.length
          ? `任务 ${taskId} 的人物“${name}”匹配到多个现有档案：${matches.map((person) => `${person.name}(${person.id})`).join("、")}；请在 target.personId 指定稳定 ID`
          : `任务 ${taskId} 的人物“${name}”不存在；若是新人物，必须在同一 plan 中声明 create person`,
      );
    }
    return matches[0];
  };
  const resolveEndpoint = (name: string, taskId: string, personRef?: string) => {
    if (isSelfReference(name)) {
      if (personRef && personRef !== SELF_PERSON_ID) {
        throw new Error(`任务 ${taskId} 的“${name}”只能引用 ${SELF_PERSON_ID}`);
      }
      return { personId: SELF_PERSON_ID };
    }
    if (personRef?.startsWith("plan:")) {
      const created = createdPeopleByRef.get(personRef);
      if (!created) throw new Error(`任务 ${taskId} 引用了尚未声明的新人物：${personRef}`);
      if (personKey(created.name) !== personKey(name)) {
        throw new Error(
          `任务 ${taskId} 的计划引用 ${personRef} 属于“${created.name}”，与端点“${name}”不一致`,
        );
      }
      return { draftId: created._draftId };
    }
    if (personRef) return { personId: assertPersonIdMatches(personRef, name, taskId).id };
    const existing = existingPersonMatches(name);
    const created = createdPeopleByName.get(personKey(name)) ?? [];
    if (existing.length + created.length !== 1) {
      const candidates = [
        ...existing.map((person) => `${person.name}(${person.id})`),
        ...created.map((person) => `${person.name}(${person._draftId})`),
      ];
      throw new Error(
        `任务 ${taskId} 的人物端点“${name}”必须唯一定位${candidates.length ? `；候选为 ${candidates.join("、")}，请填写 fromPersonId/toPersonId` : ""}`,
      );
    }
    return created.length ? { draftId: created[0]._draftId } : { personId: existing[0].id };
  };

  const normalizedTasks: IntakeMutationTask[] = [];
  for (const task of tasks.filter((candidate) => candidate.domain === "person")) {
    if (task.intent === "create") {
      if (task.target.personId) {
        throw new Error(`任务 ${task.id} 是 create person，不能携带已有 personId`);
      }
      const item = parseIngestCandidate(
        JSON.stringify({ people: [{ ...task.changes, name: task.target.name }] }),
      ).people![0];
      item._draftId = `plan:${task.id}`;
      createdPeopleByRef.set(item._draftId, item);
      createdPeopleByName.set(personKey(item.name), [
        ...(createdPeopleByName.get(personKey(item.name)) ?? []),
        item,
      ]);
      staged.people!.push(item);
      completionIds.set(task.id, item._draftId);
      normalizedTasks.push(task);
      continue;
    }
    const person = resolveExistingPerson(task.target.name, task.id, task.target.personId);
    const item = personDraftFromChanges(person, task.changes);
    item.targetPersonId = person.id;
    item._identityChecked = true;
    item._identityReason = "typed plan 已由本地唯一锁定现有档案；等待用户核对差异";
    staged.people!.push(item);
    completionIds.set(task.id, person.id);
    normalizedTasks.push(task);
  }

  for (const task of tasks.filter((candidate) => candidate.domain === "fact")) {
    const person = resolveEndpoint(task.target.person, task.id, task.target.personId);
    const item = parseIngestCandidate(
      JSON.stringify({
        facts: [
          {
            person: task.target.person,
            key: task.target.key,
            value: task.changes.value,
            validFrom: task.changes.validFrom,
            validTo: task.changes.validTo,
            confidence: task.changes.confidence,
          },
        ],
      }),
    ).facts![0];
    if (person.draftId) item.personDraftId = person.draftId;
    if (person.personId) item.personId = person.personId;
    staged.facts!.push(item);
    completionIds.set(task.id, person.personId ?? person.draftId ?? `plan:${task.id}`);
    normalizedTasks.push(task);
  }

  for (const task of tasks.filter((candidate) => candidate.domain === "relation")) {
    const from = resolveEndpoint(task.target.from, task.id, task.target.fromPersonId);
    const to = resolveEndpoint(task.target.to, task.id, task.target.toPersonId);
    if (task.intent === "create") {
      if (task.target.relationId) {
        throw new Error(`任务 ${task.id} 是 create relation，不能携带已有 relationId`);
      }
      const item = parseIngestCandidate(
        JSON.stringify({
          relations: [
            {
              ...task.changes,
              label: task.changes.label ?? task.target.label,
              from: task.target.from,
              to: task.target.to,
            },
          ],
        }),
      ).relations![0];
      validateModelRelations({ relations: [item] });
      if (from.draftId) item.fromDraftId = from.draftId;
      if (to.draftId) item.toDraftId = to.draftId;
      if (from.personId) item.fromPersonId = from.personId;
      if (to.personId) item.toPersonId = to.personId;
      staged.relations!.push(item);
      completionIds.set(task.id, `plan:${task.id}`);
      normalizedTasks.push(task);
      continue;
    }
    if (!from.personId || !to.personId) {
      throw new Error(`任务 ${task.id} 不能更新尚未提交的新人物关系`);
    }
    const matches = options.relations.filter((relation) => {
      if (relation.recordType === "derived") return false;
      if (task.target.relationId && relation.id !== task.target.relationId) return false;
      return (
        ((relation.fromId === from.personId && relation.toId === to.personId) ||
          (relation.fromId === to.personId && relation.toId === from.personId)) &&
        (!task.target.label || normalized(relation.label) === normalized(task.target.label))
      );
    });
    if (matches.length !== 1) {
      throw new Error(
        matches.length
          ? `任务 ${task.id} 的关系目标匹配到多个事实关系`
          : `任务 ${task.id} 无法唯一定位要更新的事实关系`,
      );
    }
    const relation = matches[0];
    const item = relationDraftFromChanges(relation, [...options.persons], task.changes);
    validateModelRelations({ relations: [item] });
    item.targetRelationId = relation.id;
    item.fromPersonId = from.personId;
    item.toPersonId = to.personId;
    item._relationChecked = true;
    item._relationReason = "typed plan 已由本地唯一锁定现有关系；等待用户核对差异";
    staged.relations!.push(item);
    completionIds.set(task.id, relation.id);
    normalizedTasks.push(task);
  }

  for (const originalTask of tasks.filter((candidate) => candidate.domain === "event")) {
    if (originalTask.intent === "create" && originalTask.target.eventId) {
      throw new Error(`任务 ${originalTask.id} 是 create event，不能携带已有 eventId`);
    }
    const titleMatches = options.events.filter(
      (event) => normalized(event.title) === normalized(originalTask.target.title),
    );
    let task = originalTask;
    if (task.intent === "create" && task.target.date === undefined && titleMatches.length === 1) {
      task = { ...task, intent: "update" };
    } else if (
      task.intent === "create" &&
      task.target.date === undefined &&
      titleMatches.length > 1
    ) {
      throw new Error(`任务 ${task.id} 的事件“${task.target.title}”存在多个同名目标，必须消歧`);
    }
    if (task.intent === "update") {
      const matches = options.events.filter(
        (event) =>
          (!task.target.eventId || event.id === task.target.eventId) &&
          normalized(event.title) === normalized(task.target.title) &&
          (!task.target.date || event.date === task.target.date),
      );
      if (matches.length !== 1) {
        throw new Error(
          matches.length
            ? `任务 ${task.id} 的事件“${task.target.title}”存在歧义`
            : `任务 ${task.id} 无法唯一定位事件“${task.target.title}”`,
        );
      }
      const event = matches[0];
      const item = eventDraftFromChanges(event, task.changes);
      item.targetEventId = event.id;
      item._eventChecked = true;
      item._eventReason = "typed plan 已由本地唯一锁定现有事件；等待用户核对差异";
      const people = item.people?.map((name) => resolveEndpoint(name, task.id));
      item.peopleDraftIds = people?.map((person) => person.draftId);
      item.peoplePersonIds = people?.map((person) => person.personId);
      staged.events!.push(item);
      completionIds.set(task.id, event.id);
      normalizedTasks.push(task);
      continue;
    }
    const item = parseIngestCandidate(
      JSON.stringify({ events: [{ ...task.changes, title: task.target.title }] }),
    ).events![0];
    item._draftId = `plan:${task.id}`;
    const people = item.people?.map((name) => resolveEndpoint(name, task.id));
    item.peopleDraftIds = people?.map((person) => person.draftId);
    item.peoplePersonIds = people?.map((person) => person.personId);
    staged.events!.push(item);
    completionIds.set(task.id, item._draftId);
    normalizedTasks.push(task);
  }

  for (const task of tasks.filter((candidate) => candidate.domain === "reminder")) {
    if (task.intent !== "create") throw new Error(`任务 ${task.id} 暂不支持更新已有提醒`);
    const item = parseIngestCandidate(
      JSON.stringify({ reminders: [{ ...task.changes, title: task.target.title }] }),
    ).reminders![0];
    const people = item.people?.map((name) => resolveEndpoint(name, task.id));
    item.peopleDraftIds = people?.map((person) => person.draftId);
    item.peoplePersonIds = people?.map((person) => person.personId);
    staged.reminders!.push(item);
    completionIds.set(task.id, `plan:${task.id}`);
    normalizedTasks.push(task);
  }

  for (const task of tasks.filter((candidate) => candidate.domain === "evidence")) {
    const item = parseIngestCandidate(
      JSON.stringify({
        evidence: [
          {
            kind: task.changes.kind,
            title: task.target.title,
            text: task.changes.text,
            origin: task.changes.origin,
            confidence: task.changes.confidence,
          },
        ],
      }),
    ).evidence![0];
    staged.evidence!.push(item);
    completionIds.set(task.id, `plan:${task.id}`);
    normalizedTasks.push(task);
  }

  const summaryTasks = tasks.filter((candidate) => candidate.domain === "summary");
  if (summaryTasks.length > 1) throw new Error("一次录入计划只能包含一项材料概要");
  for (const task of summaryTasks) {
    const parsed = parseIngestCandidate(JSON.stringify({ summary: task.changes.text })).summary;
    if (!parsed) throw new Error(`任务 ${task.id} 的 changes.text 必须是非空概要`);
    staged.summary = parsed;
    completionIds.set(task.id, `plan:${task.id}`);
    normalizedTasks.push(task);
  }

  return {
    plan: {
      type: "plan",
      summary: staged.summary || clipped(input.summary, 500) || undefined,
      tasks: normalizedTasks,
    },
    staged,
    completionIds,
  };
}

function mergeDrafts(staged: IngestCandidate, finalDraft: IngestCandidate): IngestCandidate {
  const merge = <T>(first: T[], second: T[], key: (item: T) => string) => {
    const rows = new Map<string, T>();
    for (const item of [...first, ...second]) rows.set(key(item), item);
    return [...rows.values()];
  };
  return {
    ...finalDraft,
    people: merge(
      finalDraft.people ?? [],
      staged.people ?? [],
      (item) => item.targetPersonId ?? item._draftId ?? `name:${normalized(item.name)}`,
    ),
    events: merge(
      finalDraft.events ?? [],
      staged.events ?? [],
      (item) =>
        item.targetEventId ?? item._draftId ?? `${normalized(item.title)}:${item.date ?? ""}`,
    ),
    relations: merge(
      finalDraft.relations ?? [],
      staged.relations ?? [],
      (item) =>
        item.targetRelationId ??
        `${item.fromPersonId ?? item.fromDraftId ?? normalized(item.from)}\u0000${item.toPersonId ?? item.toDraftId ?? normalized(item.to)}\u0000${normalized(item.label)}`,
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
  taskState: IntakeTaskSnapshot | null,
  archiveIndex: string,
) {
  const phase = taskState
    ? taskState.phase === "planning"
      ? "PLAN：声明完整 typed plan"
      : taskState.phase === "working"
        ? "STAGE：本地正在执行 typed plan"
        : "DONE：本地账本已经闭合"
    : round === 1
      ? "PLAN：判断是新增、更新还是跨档案推导"
      : history.some((entry) => record(entry.call).type === "schema_correction")
        ? "VERIFY：根据校验错误修正草稿"
        : round >= maxRounds - 2
          ? "FINAL：停止扩展检索，形成可确认草稿"
          : "SEARCH / STAGE：按需读取档案并暂存增量变更";
  const taskGuide = taskState
    ? `录入任务账本（由本地状态机维护）：
${JSON.stringify(taskState)}

当前档案结构化索引（含可核验稳定 ID；只允许引用索引中的 ID）：
${archiveIndex}`
    : "";
  const toolResponseGuide = `相互独立的只读查询可在同一轮批量调用，最多 4 个；写入暂存工具按顺序执行。单工具格式：
{"type":"tool","summary":"简短说明","tool":"search_profiles","args":{"query":"小雨"}}
批量工具格式：
{"type":"tools","summary":"并行核对人物和关系","calls":[{"tool":"get_profiles","args":{"personIds":["..."]}},{"tool":"get_relation","args":{"relationId":"..."}}]}`;
  const finalResponseGuide = `完成后输出：
{"type":"final","summary":"简短说明","draft":<前述严格结构的草稿 JSON>}
已经通过 stage_* 暂存的更新不要在 final.draft 中重复。若无需工具，也可直接输出前述严格结构的草稿 JSON，以兼容简单新增录入。`;
  const responseGuide =
    taskState?.nextAction === "declare_plan"
      ? `本轮唯一动作是一次性声明所有新增和更新，不调用工具、不写工具名、不输出 final。稳定 ID 只能复制上方结构化索引，不得编造：更新现有记录或遇到同名人物时必须写 personId/relationId/eventId；关系端点用 fromPersonId/toPersonId。新人物没有执行 ID，用 plan:<person task id> 作为后续关系端点引用。“我/me”是保留视角，ID 固定为 ${SELF_PERSON_ID}，不得新建一个名为“我”的普通人物。本地会校验 ID、处理歧义并统一暂存；模型只负责把语义写成 typed plan。每个 changes 必须是可直接进入对应草稿的字段。相同记录同一 domain 的多个字段合并为一项，不得遗漏并列句：
{"type":"plan","summary":"计划摘要","tasks":[
{"id":"person-1","domain":"person","intent":"update","target":{"name":"唐悦","personId":"<索引中的人物ID>"},"changes":{"title":"品牌总监"}},
{"id":"fact-1","domain":"fact","intent":"create","target":{"person":"唐悦","personId":"<索引中的人物ID或 plan:person-1>","key":"毕业院校"},"changes":{"value":"某大学"}},
{"id":"relation-1","domain":"relation","intent":"update","target":{"from":"唐悦","fromPersonId":"<索引中的人物ID>","to":"周宁","toPersonId":"<索引中的人物ID>","relationId":"<索引中的关系ID>","label":"同事"},"changes":{"label":"前同事","basis":"原文：唐悦和周宁现在是前同事"}},
{"id":"event-1","domain":"event","intent":"create","target":{"title":"会议"},"changes":{"date":"2026-09-02","people":["唐悦","周宁"]}},
{"id":"reminder-1","domain":"reminder","intent":"create","target":{"title":"给唐悦发送清单"},"changes":{"due":"2026-08-28","people":["唐悦"],"kind":"custom"}},
{"id":"evidence-1","domain":"evidence","intent":"create","target":{"title":"本次材料摘要"},"changes":{"kind":"note","text":"只保留核对所需的最短原文或摘要","origin":"用户输入"}},
{"id":"summary-1","domain":"summary","intent":"create","target":{"title":"本次材料概要"},"changes":{"text":"给用户浏览草稿用的一句话概要"}}
]}
人物 target 必须有 name，更新时尽量附 personId；事实 target 必须有 person/key，并用 personId 绑定已有人物或 plan:person-task 绑定同轮新人物；关系 target 必须有 from/to，更新时附端点 ID 与 relationId，create 时 label 可放 target.label 或 changes.label；事件 target 必须有 title，更新时附 eventId；提醒、材料与概要 target 必须有 title，当前只允许 create；概要最多一项。材料已经给出姓名时，禁止再为同一人创建“某人的妹妹（未具名）”之类称谓占位人物。create 与 update 必须按用户语义明确选择。`
      : taskState
        ? "typed plan 由本地执行，不再请求模型复述草稿。"
        : `${toolResponseGuide}

${finalResponseGuide}`;
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

${taskGuide}

${responseGuide}

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
  const staged: IngestCandidate = {
    people: [],
    facts: [],
    events: [],
    relations: [],
    reminders: [],
    evidence: [],
  };
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
  const taskState = new IntakeTaskStateMachine({
    planRequired: options.includeArchive && Boolean(options.sourceMaterial?.trim()),
  });
  const archiveIndex = options.includeArchive
    ? compactIntakeArchiveIndex(options.persons, relations, options.events)
    : "{}";

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
      taskState.assertFinalizable();
      return mergeDrafts(staged, parsed);
    } catch (error) {
      if (validationRepairs >= MAX_VALIDATION_REPAIRS) throw error;
      validationRepairs += 1;
      const message = error instanceof Error ? error.message : "草稿不符合结构约束";
      runtime.recordLifecycle(
        "validation",
        {
          contract: "intake_draft",
          action: "repair_requested",
          attempt: validationRepairs,
          error: message,
        },
        "failed",
      );
      history.push({
        call: { type: "schema_correction", attempt: validationRepairs },
        result: { error: message },
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

  const completeTask = (
    taskId: string | undefined,
    domain: "person" | "relation" | "event",
    targetId: string,
  ) => (taskId ? taskState.completeTask(taskId, domain, targetId) : taskState.snapshot());

  const stagePersonUpdate = (personId: string, changes: unknown, taskId?: string) => {
    const person = options.persons.find((item) => item.id === personId);
    if (!person) throw new Error("人物不存在，请先检索确认 ID");
    const item = personDraftFromChanges(person, changes);
    item.targetPersonId = person.id;
    item._identityChecked = true;
    item._identityReason = "typed plan 已由本地锁定现有档案；等待用户核对差异";
    const snapshot = completeTask(taskId, "person", person.id);
    upsertStaged(staged.people!, item, (value) => value.targetPersonId ?? normalized(value.name));
    runtime.recordLifecycle("validation", {
      contract: "intake_task_ledger",
      action: "stage_completed",
      snapshot,
    });
    return { staged: true, domain: "person", id: person.id, message: "仅暂存，尚未写入" };
  };

  const stageEventUpdate = (eventId: string, changes: unknown, taskId?: string) => {
    const event = options.events.find((item) => item.id === eventId);
    if (!event) throw new Error("事件不存在，请先检索确认 ID");
    const item = eventDraftFromChanges(event, changes);
    item.targetEventId = event.id;
    item._eventChecked = true;
    item._eventReason = "typed plan 已由本地锁定现有事件；等待用户核对差异";
    const snapshot = completeTask(taskId, "event", event.id);
    upsertStaged(staged.events!, item, (value) => value.targetEventId ?? normalized(value.title));
    runtime.recordLifecycle("validation", {
      contract: "intake_task_ledger",
      action: "stage_completed",
      snapshot,
    });
    return { staged: true, domain: "event", id: event.id, message: "仅暂存，尚未写入" };
  };

  const stageRelationUpdate = (relationId: string, changes: unknown, taskId?: string) => {
    const relation = relations.find((item) => item.id === relationId);
    if (!relation) throw new Error("关系不存在，请先检索确认 ID");
    if (relation.recordType === "derived") {
      throw new Error(
        `派生关系不能直接修改；请修改支持事实：${(
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
    item._relationReason = "typed plan 已由本地锁定现有关系；等待用户核对差异";
    const snapshot = completeTask(taskId, "relation", relation.id);
    upsertStaged(
      staged.relations!,
      item,
      (value) => value.targetRelationId ?? `${normalized(value.from)}:${normalized(value.to)}`,
    );
    runtime.recordLifecycle("validation", {
      contract: "intake_task_ledger",
      action: "stage_completed",
      snapshot,
    });
    return { staged: true, domain: "relation", id: relation.id, message: "仅暂存，尚未写入" };
  };

  services.intakeStaging = {
    stagePersonUpdate,
    stageEventUpdate,
    stageRelationUpdate,
  };

  const commitCompiledPlan = (compiled: CompiledIntakePlan) => {
    taskState.acceptPlan(compiled.plan);
    staged.people!.push(...(compiled.staged.people ?? []));
    staged.facts!.push(...(compiled.staged.facts ?? []));
    staged.relations!.push(...(compiled.staged.relations ?? []));
    staged.events!.push(...(compiled.staged.events ?? []));
    staged.reminders!.push(...(compiled.staged.reminders ?? []));
    staged.evidence!.push(...(compiled.staged.evidence ?? []));
    for (const task of compiled.plan.tasks) {
      taskState.completeTask(task.id, task.domain, compiled.completionIds.get(task.id)!);
    }
    taskState.assertFinalizable();
    staged.summary = compiled.plan.summary || "已根据本次材料生成待确认变更";
    return staged;
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
        options.includeArchive && options.sourceMaterial?.trim() ? taskState.snapshot() : null,
        archiveIndex,
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
      if (response.type === "plan") {
        try {
          const compiled = compileIntakePlan({
            candidate: response,
            persons: options.persons,
            relations,
            events: options.events,
          });
          const draft = commitCompiledPlan(compiled);
          const snapshot = taskState.snapshot();
          runtime.recordLifecycle("validation", {
            contract: "intake_task_ledger",
            action: "plan_compiled",
            snapshot,
          });
          history.push({ call: response, result: { accepted: true, snapshot } });
          trace({
            kind: "check",
            text: `已建立 ${snapshot.tasks.length} 项 typed plan，本地正在锁定 ID 并统一暂存`,
          });
          completeRun();
          return draft;
        } catch (error) {
          if (!taskState.acceptsPlan()) throw error;
          if (validationRepairs >= MAX_VALIDATION_REPAIRS) throw error;
          validationRepairs += 1;
          const message = error instanceof Error ? error.message : "任务计划无效";
          runtime.recordLifecycle(
            "validation",
            {
              contract: "intake_task_ledger",
              action: "repair_requested",
              attempt: validationRepairs,
              error: message,
            },
            "failed",
          );
          history.push({
            call: {
              type: "plan_validation",
              summary: response.summary,
              taskCount: Array.isArray(response.tasks) ? response.tasks.length : 0,
            },
            result: { error: message, requiredAction: "修正错误后重新返回完整 typed plan" },
          });
          trace({ kind: "check", text: "任务计划不符合执行契约，正在修正" });
        }
        continue;
      }
      if (taskState.acceptsPlan()) {
        const error = new Error("首轮必须返回 typed plan；不要调用工具或输出 final");
        if (validationRepairs >= MAX_VALIDATION_REPAIRS) throw error;
        validationRepairs += 1;
        runtime.recordLifecycle(
          "validation",
          {
            contract: "intake_task_ledger",
            action: "repair_requested",
            attempt: validationRepairs,
            error: error.message,
          },
          "failed",
        );
        history.push({ call: response, result: { error: error.message } });
        trace({ kind: "check", text: "模型未返回 typed plan，正在要求修正" });
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
