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
import { ensureIntakeWorkspace, intakeWorkspaceView } from "./intake-workspace";
import { inferRelationSemantics, type RelationPredicate } from "./relation-ontology";

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

function modelDraftValue<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (key, item: unknown) =>
      key.startsWith("_") ||
      key.startsWith("target") ||
      key.includes("DraftId") ||
      key.includes("PersonId")
        ? undefined
        : item,
    ),
  ) as T;
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
    timeText: "timeText" in input ? input.timeText : undefined,
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
  workspace?: IngestCandidate,
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
    ...(workspace ? { workspace: intakeWorkspaceView(workspace) } : {}),
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
  workspace?: IngestCandidate;
  sourceMaterial?: string;
}): CompiledIntakePlan {
  const parser = new IntakeTaskStateMachine({ planRequired: true });
  parser.acceptPlan(options.candidate);
  const input = record(options.candidate);
  const tasks = parser.plannedTasks();
  const staged: IngestCandidate = ensureIntakeWorkspace(options.workspace ?? {});
  const completionIds = new Map<string, string>();
  const createdPeopleByName = new Map<string, IngestPerson[]>();
  const createdPeopleByRef = new Map<string, IngestPerson>();

  const personKey = (name: string) => normalized(name).replace(/\s+/g, "");

  for (const person of staged.people ?? []) {
    if (person._draftId) createdPeopleByRef.set(person._draftId, person);
    createdPeopleByName.set(personKey(person.name), [
      ...(createdPeopleByName.get(personKey(person.name)) ?? []),
      person,
    ]);
  }

  const replaceWorkspaceRow = <T extends { _draftId?: string }>(rows: T[], row: T, ref: string) => {
    const index = rows.findIndex((candidate) => candidate._draftId === ref);
    if (index < 0) throw new Error(`工作区记录不存在：${ref}`);
    rows[index] = row;
  };

  const existingPersonMatches = (name: string) => {
    const key = personKey(name);
    return options.persons.filter((person) =>
      personNames(person).some((candidate) => personKey(candidate) === key),
    );
  };
  const assertArchivePersonIdMatches = (personId: string, name: string, taskId: string) => {
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
    if (personId) return assertArchivePersonIdMatches(personId, name, taskId);
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
    if (personRef && createdPeopleByRef.has(personRef)) {
      const created = createdPeopleByRef.get(personRef);
      if (!created) throw new Error(`任务 ${taskId} 引用了尚未声明的新人物：${personRef}`);
      if (personKey(created.name) !== personKey(name)) {
        throw new Error(
          `任务 ${taskId} 的计划引用 ${personRef} 属于“${created.name}”，与端点“${name}”不一致`,
        );
      }
      return { draftId: created._draftId };
    }
    if (personRef) return { personId: assertArchivePersonIdMatches(personRef, name, taskId).id };
    const existing = existingPersonMatches(name);
    const created = createdPeopleByName.get(personKey(name)) ?? [];
    const shadowedArchiveIds = new Set(
      created.map((person) => person.targetPersonId).filter((id): id is string => Boolean(id)),
    );
    const unshadowedExisting = existing.filter((person) => !shadowedArchiveIds.has(person.id));
    if (unshadowedExisting.length + created.length !== 1) {
      const candidates = [
        ...unshadowedExisting.map((person) => `${person.name}(${person.id})`),
        ...created.map((person) => `${person.name}(${person._draftId})`),
      ];
      throw new Error(
        `任务 ${taskId} 的人物端点“${name}”必须唯一定位${candidates.length ? `；候选为 ${candidates.join("、")}，请填写 fromPersonId/toPersonId` : ""}`,
      );
    }
    return created.length
      ? { draftId: created[0]._draftId }
      : { personId: unshadowedExisting[0].id };
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
    const workspacePerson = task.target.personId
      ? createdPeopleByRef.get(task.target.personId)
      : (createdPeopleByName.get(personKey(task.target.name)) ?? []).length === 1
        ? createdPeopleByName.get(personKey(task.target.name))?.[0]
        : undefined;
    if (workspacePerson?._draftId) {
      const internal = {
        _draftId: workspacePerson._draftId,
        targetPersonId: workspacePerson.targetPersonId,
        _identityCandidateIds: workspacePerson._identityCandidateIds,
        _identityReason: workspacePerson._identityReason,
        _identityChecked: workspacePerson._identityChecked,
        _fieldGrounding: workspacePerson._fieldGrounding,
        _audit: workspacePerson._audit?.humanEdited ? workspacePerson._audit : undefined,
      };
      const item = parseIngestCandidate(
        JSON.stringify({
          people: [
            { ...modelDraftValue(workspacePerson), ...task.changes, name: task.target.name },
          ],
        }),
      ).people![0];
      Object.assign(item, internal);
      replaceWorkspaceRow(staged.people!, item, workspacePerson._draftId);
      createdPeopleByRef.set(workspacePerson._draftId, item);
      const byName = createdPeopleByName.get(personKey(workspacePerson.name)) ?? [];
      createdPeopleByName.set(
        personKey(workspacePerson.name),
        byName.map((candidate) =>
          candidate._draftId === workspacePerson._draftId ? item : candidate,
        ),
      );
      completionIds.set(task.id, workspacePerson._draftId);
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
    const workspaceFact = task.target.factId
      ? staged.facts?.find((item) => item._draftId === task.target.factId)
      : undefined;
    if (task.intent === "update" && !workspaceFact) {
      throw new Error(`任务 ${task.id} 无法定位要更新的工作区事实`);
    }
    const item = parseIngestCandidate(
      JSON.stringify({
        facts: [
          {
            ...(workspaceFact ? modelDraftValue(workspaceFact) : {}),
            person: task.target.person,
            key: task.target.key,
            value: "value" in task.changes ? task.changes.value : workspaceFact?.value,
            validFrom:
              "validFrom" in task.changes ? task.changes.validFrom : workspaceFact?.validFrom,
            validTo: "validTo" in task.changes ? task.changes.validTo : workspaceFact?.validTo,
            confidence:
              "confidence" in task.changes ? task.changes.confidence : workspaceFact?.confidence,
          },
        ],
      }),
    ).facts![0];
    item._draftId = workspaceFact?._draftId ?? `plan:${task.id}`;
    item._audit = workspaceFact?._audit?.humanEdited ? workspaceFact._audit : undefined;
    if (person.draftId) item.personDraftId = person.draftId;
    if (person.personId) item.personId = person.personId;
    if (workspaceFact?._draftId) replaceWorkspaceRow(staged.facts!, item, workspaceFact._draftId);
    else staged.facts!.push(item);
    completionIds.set(task.id, person.personId ?? person.draftId ?? `plan:${task.id}`);
    normalizedTasks.push(task);
  }

  const modelRelationsThisPlan: IngestRelation[] = [];
  const relationClaimContext = () => ({
    sourceMaterial: options.sourceMaterial,
    personNames: [
      ...options.persons.flatMap(personNames),
      ...(staged.people ?? []).map((person) => person.name),
    ],
  });
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
      if (from.draftId) item.fromDraftId = from.draftId;
      if (to.draftId) item.toDraftId = to.draftId;
      if (from.personId) item.fromPersonId = from.personId;
      if (to.personId) item.toPersonId = to.personId;
      item._draftId = `plan:${task.id}`;
      staged.relations!.push(item);
      modelRelationsThisPlan.push(item);
      completionIds.set(task.id, item._draftId);
      normalizedTasks.push(task);
      continue;
    }
    const workspaceRelationMatches = task.target.relationId
      ? (staged.relations?.filter((relation) => relation._draftId === task.target.relationId) ?? [])
      : (staged.relations?.filter(
          (relation) =>
            ((relation.fromDraftId && relation.fromDraftId === from.draftId) ||
              (relation.fromPersonId && relation.fromPersonId === from.personId) ||
              personKey(relation.from) === personKey(task.target.from)) &&
            ((relation.toDraftId && relation.toDraftId === to.draftId) ||
              (relation.toPersonId && relation.toPersonId === to.personId) ||
              personKey(relation.to) === personKey(task.target.to)) &&
            (!task.target.label || normalized(relation.label) === normalized(task.target.label)),
        ) ?? []);
    const workspaceRelation =
      workspaceRelationMatches.length === 1 ? workspaceRelationMatches[0] : undefined;
    if (workspaceRelation?._draftId) {
      const item = parseIngestCandidate(
        JSON.stringify({
          relations: [
            {
              ...modelDraftValue(workspaceRelation),
              ...task.changes,
              from: task.target.from,
              to: task.target.to,
              label: task.changes.label ?? task.target.label ?? workspaceRelation.label,
            },
          ],
        }),
      ).relations![0];
      item._draftId = workspaceRelation._draftId;
      item.fromDraftId = from.draftId;
      item.toDraftId = to.draftId;
      item.fromPersonId = from.personId;
      item.toPersonId = to.personId;
      item._relationChecked = workspaceRelation._relationChecked;
      item._relationReason = workspaceRelation._relationReason;
      item._audit = workspaceRelation._audit?.humanEdited ? workspaceRelation._audit : undefined;
      replaceWorkspaceRow(staged.relations!, item, workspaceRelation._draftId);
      modelRelationsThisPlan.push(item);
      completionIds.set(task.id, workspaceRelation._draftId);
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
    item.targetRelationId = relation.id;
    item.fromPersonId = from.personId;
    item.toPersonId = to.personId;
    item._relationChecked = true;
    item._relationReason = "typed plan 已由本地唯一锁定现有关系；等待用户核对差异";
    staged.relations!.push(item);
    modelRelationsThisPlan.push(item);
    completionIds.set(task.id, relation.id);
    normalizedTasks.push(task);
  }
  auditModelRelations({ relations: modelRelationsThisPlan }, relationClaimContext());

  for (const originalTask of tasks.filter((candidate) => candidate.domain === "event")) {
    if (originalTask.intent === "create" && originalTask.target.eventId) {
      throw new Error(`任务 ${originalTask.id} 是 create event，不能携带已有 eventId`);
    }
    const titleMatches = options.events.filter(
      (event) => normalized(event.title) === normalized(originalTask.target.title),
    );
    const workspaceTitleMatches = (staged.events ?? []).filter(
      (event) => normalized(event.title) === normalized(originalTask.target.title),
    );
    let task = originalTask;
    if (
      task.intent === "create" &&
      task.target.date === undefined &&
      titleMatches.length + workspaceTitleMatches.length === 1
    ) {
      task = { ...task, intent: "update" };
    } else if (
      task.intent === "create" &&
      task.target.date === undefined &&
      titleMatches.length > 1
    ) {
      throw new Error(`任务 ${task.id} 的事件“${task.target.title}”存在多个同名目标，必须消歧`);
    }
    if (task.intent === "update") {
      const workspaceEvent = task.target.eventId
        ? staged.events?.find((event) => event._draftId === task.target.eventId)
        : workspaceTitleMatches.length === 1
          ? workspaceTitleMatches[0]
          : undefined;
      if (workspaceEvent?._draftId) {
        const item = parseIngestCandidate(
          JSON.stringify({
            events: [
              {
                ...modelDraftValue(workspaceEvent),
                ...task.changes,
                title: task.target.title,
              },
            ],
          }),
        ).events![0];
        item._draftId = workspaceEvent._draftId;
        item.targetEventId = workspaceEvent.targetEventId;
        item._eventChecked = workspaceEvent._eventChecked;
        item._eventReason = workspaceEvent._eventReason;
        const people = item.people?.map((name) => resolveEndpoint(name, task.id));
        item.peopleDraftIds = people?.map((person) => person.draftId);
        item.peoplePersonIds = people?.map((person) => person.personId);
        item._audit = workspaceEvent._audit?.humanEdited ? workspaceEvent._audit : undefined;
        replaceWorkspaceRow(staged.events!, item, workspaceEvent._draftId);
        completionIds.set(task.id, workspaceEvent._draftId);
        normalizedTasks.push(task);
        continue;
      }
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
    const workspaceReminder = task.target.reminderId
      ? staged.reminders?.find((item) => item._draftId === task.target.reminderId)
      : undefined;
    if (task.intent === "update" && !workspaceReminder) {
      throw new Error(`任务 ${task.id} 无法定位要更新的工作区提醒`);
    }
    const item = parseIngestCandidate(
      JSON.stringify({
        reminders: [
          {
            ...(workspaceReminder ? modelDraftValue(workspaceReminder) : {}),
            ...task.changes,
            title: task.target.title,
          },
        ],
      }),
    ).reminders![0];
    item._draftId = workspaceReminder?._draftId ?? `plan:${task.id}`;
    item._audit = workspaceReminder?._audit?.humanEdited ? workspaceReminder._audit : undefined;
    const people = item.people?.map((name) => resolveEndpoint(name, task.id));
    item.peopleDraftIds = people?.map((person) => person.draftId);
    item.peoplePersonIds = people?.map((person) => person.personId);
    if (workspaceReminder?._draftId)
      replaceWorkspaceRow(staged.reminders!, item, workspaceReminder._draftId);
    else staged.reminders!.push(item);
    completionIds.set(task.id, item._draftId);
    normalizedTasks.push(task);
  }

  for (const task of tasks.filter((candidate) => candidate.domain === "evidence")) {
    const workspaceEvidence = task.target.evidenceId
      ? staged.evidence?.find((item) => item._draftId === task.target.evidenceId)
      : undefined;
    if (task.intent === "update" && !workspaceEvidence) {
      throw new Error(`任务 ${task.id} 无法定位要更新的工作区材料`);
    }
    const item = parseIngestCandidate(
      JSON.stringify({
        evidence: [
          {
            ...(workspaceEvidence ? modelDraftValue(workspaceEvidence) : {}),
            ...task.changes,
            title: task.target.title,
          },
        ],
      }),
    ).evidence![0];
    item._draftId = workspaceEvidence?._draftId ?? `plan:${task.id}`;
    item._audit = workspaceEvidence?._audit?.humanEdited ? workspaceEvidence._audit : undefined;
    if (workspaceEvidence?._draftId)
      replaceWorkspaceRow(staged.evidence!, item, workspaceEvidence._draftId);
    else staged.evidence!.push(item);
    completionIds.set(task.id, item._draftId);
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

  staged._revision = options.workspace
    ? Math.max(1, Math.trunc(options.workspace._revision ?? 1)) + 1
    : 1;

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

function compactClaimText(value: string) {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/[\s，。；：、,.!?！？“”'"（）()]/g, "");
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const EXPLICIT_RELATION_CUES: Partial<Record<RelationPredicate, RegExp>> = {
  parent_of: /(父|母|爸|妈|儿子|女儿|孩子|子女|生了|parent|father|mother|son|daughter|child)/i,
  step_parent_of: /(继父|继母|stepfather|stepmother|stepparent)/i,
  spouse_of: /(夫妻|配偶|丈夫|妻|爱人|妾|嫁|娶|结婚|成婚|spouse|husband|wife|married)/i,
  sibling_of: /(兄弟|兄妹|姐弟|姐妹|哥哥|弟弟|姐姐|妹妹|同胞|sibling|brother|sister)/i,
  half_sibling_of: /(同父异母|同母异父|半血缘|half.?sibling)/i,
  step_sibling_of: /(继兄|继弟|继姐|继妹|继兄弟|继姐妹|step.?sibling)/i,
  grandparent_of: /(祖父|祖母|爷爷|奶奶|外公|外婆|祖孙|grandparent)/i,
  great_grandparent_of: /(曾祖|曾孙|great.?grand)/i,
  uncle_aunt_of: /(叔|伯|姑|舅|姨|侄|甥|uncle|aunt|nephew|niece)/i,
  cousin_of: /(堂|表亲|姑表|舅表|姨表|cousin)/i,
  in_law_of: /(翁媳|婆媳|岳父|岳母|公公|婆婆|叔嫂|姑嫂|姻亲|in.?law)/i,
};

function claimBodyWithoutEntityNames(basis: string, personNames: string[]) {
  let body = basis.replace(/^(原文|original)\s*[:：]/i, "");
  for (const name of [...new Set(personNames)].sort((a, b) => b.length - a.length)) {
    if (name.trim()) body = body.replace(new RegExp(escapeRegExp(name.trim()), "giu"), "");
  }
  return body;
}

type RelationClaimIssue = {
  relation: IngestRelation;
  message: string;
};

function sourcePassages(sourceMaterial: string) {
  return (
    sourceMaterial.match(/[^。！？!?；;\n]+[。！？!?；;]?/gu)?.map((passage) => passage.trim()) ??
    []
  ).filter(Boolean);
}

function passageForRelation(
  sourceMaterial: string,
  relation: IngestRelation,
  personNames: string[],
) {
  const from = compactClaimText(relation.from);
  const to = compactClaimText(relation.to);
  const predicate = inferRelationSemantics(relation.label).predicate;
  const cue = EXPLICIT_RELATION_CUES[predicate];
  return sourcePassages(sourceMaterial)
    .filter((passage) => {
      const compact = compactClaimText(passage);
      if (!compact.includes(from) || !compact.includes(to)) return false;
      return !cue || cue.test(claimBodyWithoutEntityNames(passage, personNames));
    })
    .sort((left, right) => left.length - right.length)[0];
}

/**
 * Evidence wording is an audit concern, not a reason to regenerate a complete plan.
 * The compiler aligns paraphrased quotes to source passages when possible and keeps
 * unresolved claims visible as pending draft rows with an explicit reason.
 */
function auditModelRelations(
  draft: IngestCandidate,
  context: { sourceMaterial?: string; personNames?: string[] } = {},
) {
  const personNames = [
    ...(context.personNames ?? []),
    ...(draft.relations ?? []).flatMap((relation) => [relation.from, relation.to]),
  ];
  const issues: RelationClaimIssue[] = [];
  const addIssue = (relation: IngestRelation, message: string) => {
    issues.push({ relation, message });
  };
  for (const relation of draft.relations ?? []) {
    let basis = relation.basis?.trim() ?? "";
    if (!basis) {
      addIssue(relation, "AI 未提供可回查的原文依据");
      continue;
    }
    const explicit = /^(原文|original)\s*[:：]/i.test(basis);
    const inferred = /^(推断依据|inference\s+basis)\s*[:：]/i.test(basis);
    if (inferred) addIssue(relation, "这是 AI 推导关系，不是原文直接断言");
    if (!explicit && !inferred) {
      addIssue(relation, "依据没有标明是原文还是推断");
    }
    const basisBody = basis
      .replace(/^(原文|original|推断依据|inference\s+basis)\s*[:：]/i, "")
      .trim();
    const compactBasis = compactClaimText(basisBody);
    const basisNamesBothEndpoints =
      compactBasis.includes(compactClaimText(relation.from)) &&
      compactBasis.includes(compactClaimText(relation.to));
    if (
      context.sourceMaterial?.trim() &&
      (!compactClaimText(context.sourceMaterial).includes(compactBasis) || !basisNamesBothEndpoints)
    ) {
      const passage = passageForRelation(context.sourceMaterial, relation, personNames);
      if (passage) {
        relation.basis = `原文：${passage}`;
        basis = relation.basis;
      } else {
        addIssue(relation, "依据未能对齐到同时包含关系两端的原文片段");
      }
    }
    const predicate = inferRelationSemantics(relation.label).predicate;
    const cue = EXPLICIT_RELATION_CUES[predicate];
    const semanticBody = claimBodyWithoutEntityNames(basis, personNames);
    if (cue && !cue.test(semanticBody)) {
      addIssue(relation, "关系标签与所附原文不一致，可能把经第三人关联误写成直接关系");
    }
    if (
      /(?:的|\bof\b).*(?:父|母|儿子|女儿|兄|弟|姐|妹|father|mother|son|daughter|brother|sister)/i.test(
        relation.label,
      )
    ) {
      addIssue(relation, "关系标签包含多跳称谓，尚未拆成可核对的原子关系");
    }
  }

  const pluralParentGroups = new Map<string, IngestRelation[]>();
  for (const relation of draft.relations ?? []) {
    if (inferRelationSemantics(relation.label).predicate !== "parent_of") continue;
    const basis = relation.basis?.replace(/^(原文|original)\s*[:：]/i, "").trim() ?? "";
    if (
      !/(他们(?:俩)?(?:的|有)|their)\s*(?:一?个)?\s*(?:儿子|女儿|孩子|子女|son|daughter|child)/i.test(
        basis,
      )
    ) {
      continue;
    }
    const key = `${compactClaimText(basis)}\u0000${normalized(relation.to)}`;
    pluralParentGroups.set(key, [...(pluralParentGroups.get(key) ?? []), relation]);
  }
  for (const relations of pluralParentGroups.values()) {
    if (new Set(relations.map((relation) => normalized(relation.from))).size >= 2) continue;
    const relation = relations[0];
    addIssue(
      relation,
      `“他们的孩子”只生成了一位父母到 ${relation.to} 的关系，另一位父母关系可能遗漏`,
    );
  }

  const messagesByRelation = new Map<IngestRelation, string[]>();
  for (const issue of issues) {
    messagesByRelation.set(issue.relation, [
      ...(messagesByRelation.get(issue.relation) ?? []),
      issue.message,
    ]);
  }
  for (const relation of draft.relations ?? []) {
    const messages = [...new Set(messagesByRelation.get(relation) ?? [])];
    if (messages.length) {
      relation._relationChecked = false;
      relation._relationReason = `AI 生成，请注意辨别：${messages.join("；")}`;
    } else if (!relation._relationReason) {
      relation._relationChecked = true;
      relation._relationReason = "关系依据已与本次材料对齐；仍可在入库前编辑";
    }
  }
  return issues;
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

当前档案与未提交工作区索引（archive id 与 workspace.recordRef 都可稳定寻址）：
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
      ? `本轮唯一动作是一次性声明所有新增和更新，不调用工具、不写工具名、不输出 final。稳定 ID 只能复制上方结构化索引，不得编造：已入库记录使用 archive id；未提交工作区记录使用其 recordRef，并分别填入 personId/relationId/eventId/factId/reminderId/evidenceId。关系端点用 fromPersonId/toPersonId，它们同样可以填写人物 recordRef。补充材料在纠正工作区内容时必须 update 原 recordRef，不能保留旧值再 create 一条新值。新人物没有引用时，用 plan:<person task id> 作为同一计划后续关系端点。“我/me”是保留视角，ID 固定为 ${SELF_PERSON_ID}，不得新建一个名为“我”的普通人物。本地会校验 ID、处理歧义并统一暂存；模型只负责把语义写成 typed plan。每个 changes 必须是可直接进入对应草稿的字段。相同记录同一 domain 的多个字段合并为一项，不得遗漏并列句：
{"type":"plan","summary":"计划摘要","tasks":[
{"id":"person-1","domain":"person","intent":"update","target":{"name":"唐悦","personId":"<索引中的人物ID>"},"changes":{"title":"品牌总监"}},
{"id":"fact-1","domain":"fact","intent":"create","target":{"person":"唐悦","personId":"<索引中的人物ID或 plan:person-1>","key":"毕业院校"},"changes":{"value":"某大学"}},
{"id":"relation-1","domain":"relation","intent":"update","target":{"from":"唐悦","fromPersonId":"<索引中的人物ID>","to":"周宁","toPersonId":"<索引中的人物ID>","relationId":"<索引中的关系ID>","label":"同事"},"changes":{"label":"前同事","basis":"原文：唐悦和周宁现在是前同事"}},
{"id":"event-1","domain":"event","intent":"create","target":{"title":"会议"},"changes":{"date":"2026-09-02","people":["唐悦","周宁"]}},
{"id":"reminder-1","domain":"reminder","intent":"create","target":{"title":"给唐悦发送清单"},"changes":{"due":"2026-08-28","people":["唐悦"],"kind":"custom"}},
{"id":"evidence-1","domain":"evidence","intent":"create","target":{"title":"本次材料摘要"},"changes":{"kind":"note","text":"只保留核对所需的最短原文或摘要","origin":"用户输入"}},
{"id":"summary-1","domain":"summary","intent":"create","target":{"title":"本次材料概要"},"changes":{"text":"给用户浏览草稿用的一句话概要"}}
]}
人物 target 必须有 name，更新时附 personId；事实 target 必须有 person/key，更新工作区事实时附 factId；关系 target 必须有 from/to，更新时附端点引用与 relationId，create 时 label 可放 target.label 或 changes.label；事件 target 必须有 title，更新时附 eventId；提醒和材料更新时分别附 reminderId/evidenceId；概要最多一项。材料已经给出姓名时，禁止再为同一人创建“某人的妹妹（未具名）”之类称谓占位人物。create 与 update 必须按用户语义明确选择。`
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
  /** Addressable uncommitted draft carried across supplement/correction turns. */
  workspace?: IngestCandidate;
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
  const workspace = options.workspace ? ensureIntakeWorkspace(options.workspace) : undefined;
  const staged: IngestCandidate = ensureIntakeWorkspace(workspace ?? {});
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
    planRequired:
      Boolean(options.sourceMaterial?.trim()) && (options.includeArchive || Boolean(workspace)),
  });
  const archiveIndex = compactIntakeArchiveIndex(
    options.includeArchive ? options.persons : [],
    options.includeArchive ? relations : [],
    options.includeArchive ? options.events : [],
    workspace,
  );

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
      auditModelRelations(parsed, { sourceMaterial: options.sourceMaterial });
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
    auditModelRelations({ relations: [item] });
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
    for (const task of compiled.plan.tasks) {
      taskState.completeTask(task.id, task.domain, compiled.completionIds.get(task.id)!);
    }
    taskState.assertFinalizable();
    compiled.staged.summary = compiled.plan.summary || "已根据本次材料生成待确认变更";
    return compiled.staged;
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
        options.sourceMaterial?.trim() && (options.includeArchive || workspace)
          ? taskState.snapshot()
          : null,
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
            temperature: 0,
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
            workspace,
            sourceMaterial: options.sourceMaterial,
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
