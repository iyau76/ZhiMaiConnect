import { parseLooseJson } from "./ai-text";
import type { LifeEventRecord, PersonRecord } from "./face-db";
import {
  parseIngestCandidate,
  type IngestCandidate,
  type IngestEvent,
  type IngestPerson,
} from "./intake-draft";
import { askModel } from "./vision-client";
import type { ProviderPreset } from "./vision-providers";

const MAX_ROUNDS = 8;
const MAX_HISTORY = 8_000;

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

type IntakeResponse = IntakeToolCall | IntakeFinal | IngestCandidate;

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

function promptForRound(
  extractionPrompt: string,
  round: number,
  history: Array<{ call: unknown; result: unknown }>,
  includeArchive: boolean,
) {
  const archiveGuide = includeArchive
    ? `你现在也可以按需调用本机档案工具。若材料明显是在纠正或更新已录入的人物/事件，不要新建重复记录：先检索、读取并核对 ID，再调用 stage_person_update 或 stage_event_update。暂存工具只形成待用户确认的草稿，不会直接写库。

本机档案工具：
- search_profiles {query,limit}：按姓名及档案字段检索人物
- get_profile {personId}：读取一份人物档案
- search_events {query,limit}：按标题、详情、地点、日期或关联人物检索事件
- get_event {eventId}：读取一条事件
- stage_person_update {personId,changes}：暂存人物字段修改；changes 只写需要改变的字段
- stage_event_update {eventId,changes}：暂存事件修改；changes 可含 title/detail/date/dateEnd/precision/place/people/kind`
    : "用户未授权本轮读取已有档案，不得调用本机档案工具；只根据本次材料整理新增草稿。";
  return `${extractionPrompt}

${archiveGuide}

每轮最多调用一个工具。工具调用只能输出：
{"type":"tool","summary":"简短说明","tool":"search_profiles","args":{"query":"小雨"}}

完成后输出：
{"type":"final","summary":"简短说明","draft":<前述严格结构的草稿 JSON>}
已经通过 stage_* 暂存的更新不要在 final.draft 中重复。若无需工具，也可直接输出前述严格结构的草稿 JSON，以兼容简单新增录入。

这是第 ${round}/${MAX_ROUNDS} 轮。已有工具结果：
${JSON.stringify(history).slice(-MAX_HISTORY) || "[]"}`;
}

function publicPerson(person: PersonRecord) {
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
  includeArchive: boolean;
  signal?: AbortSignal;
  onTrace?: (event: IntakeAgentTrace) => void;
}): Promise<IngestCandidate> {
  const trace = options.onTrace ?? (() => undefined);
  const history: Array<{ call: unknown; result: unknown }> = [];
  const stagedPeople: IngestPerson[] = [];
  const stagedEvents: IngestEvent[] = [];

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
      const draft = parseIngestCandidate(JSON.stringify(response));
      return {
        ...draft,
        people: [...stagedPeople, ...(draft.people ?? [])],
        events: [...stagedEvents, ...(draft.events ?? [])],
      };
    }
    if (response.type === "final") {
      const draft = parseIngestCandidate(JSON.stringify(response.draft ?? {}));
      return {
        ...draft,
        people: [...stagedPeople, ...(draft.people ?? [])],
        events: [...stagedEvents, ...(draft.events ?? [])],
      };
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
      if (!options.includeArchive) {
        result = { error: "用户未授权本轮读取已有档案" };
      } else if (response.tool === "search_profiles") {
        const query = clipped(args.query, 200).toLocaleLowerCase();
        const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 30);
        const matches = options.persons.filter((person) =>
          JSON.stringify(publicPerson(person)).toLocaleLowerCase().includes(query),
        );
        result = {
          matches: matches.slice(0, limit).map((person) => ({ id: person.id, name: person.name })),
        };
      } else if (response.tool === "get_profile") {
        const person = options.persons.find((item) => item.id === clipped(args.personId, 200));
        result = person ? publicPerson(person) : { error: "人物不存在" };
      } else if (response.tool === "search_events") {
        const query = clipped(args.query, 200).toLocaleLowerCase();
        const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 30);
        const matches = options.events.filter((event) =>
          JSON.stringify(publicEvent(event, options.persons)).toLocaleLowerCase().includes(query),
        );
        result = {
          matches: matches.slice(0, limit).map((event) => publicEvent(event, options.persons)),
        };
      } else if (response.tool === "get_event") {
        const event = options.events.find((item) => item.id === clipped(args.eventId, 200));
        result = event ? publicEvent(event, options.persons) : { error: "事件不存在" };
      } else if (response.tool === "stage_person_update") {
        const person = options.persons.find((item) => item.id === clipped(args.personId, 200));
        if (!person) throw new Error("人物不存在，请先检索确认 ID");
        const staged = personDraftFromChanges(person, args.changes);
        staged.targetPersonId = person.id;
        staged._identityChecked = true;
        staged._identityReason = "AI 工具已定位现有档案；等待用户核对差异";
        stagedPeople.push(staged);
        result = { staged: true, personId: person.id, message: "仅暂存，尚未写入" };
      } else if (response.tool === "stage_event_update") {
        const event = options.events.find((item) => item.id === clipped(args.eventId, 200));
        if (!event) throw new Error("事件不存在，请先检索确认 ID");
        const staged = eventDraftFromChanges(event, args.changes);
        staged.targetEventId = event.id;
        staged._eventChecked = true;
        staged._eventReason = "AI 工具已定位现有事件；等待用户核对差异";
        stagedEvents.push(staged);
        result = { staged: true, eventId: event.id, message: "仅暂存，尚未写入" };
      } else {
        result = { error: "不支持的工具" };
      }
    } catch (error) {
      result = { error: error instanceof Error ? error.message : "工具调用失败" };
    }
    trace({ kind: "tool", text: `${response.tool} 已返回，继续整理` });
    history.push({ call, result });
  }
  throw new Error("AI 在限定轮次内没有形成可确认的录入草稿");
}
