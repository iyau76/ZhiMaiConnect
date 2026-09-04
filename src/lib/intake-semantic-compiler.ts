import {
  createArchiveMutationPlan,
  createOrganizeCollectionOperation,
  type ArchiveMutationOperation,
  type ArchiveMutationPlan,
  type ArchiveMutationSnapshot,
} from "./archive-mutation-plan";
import {
  resolveSemanticRecordRef,
  type ArchiveRecordResolverSnapshot,
  type RecordResolution,
  type ResolvedRecordCandidate,
} from "./archive-record-resolver";
import type {
  CollectionRecord,
  EvidenceRecord,
  LifeEventRecord,
  PersonRecord,
  RelationRecord,
  ReminderRecord,
} from "./face-db";
import {
  parseIngestCandidate,
  type IngestCandidate,
  type IngestEvent,
  type IngestPerson,
  type IngestRelation,
} from "./intake-draft";
import {
  parseSemanticIntakePlan,
  semanticPersonEndpointSchema,
  type SemanticCollectionClassification,
  type SemanticIntakePlan,
  type SemanticIntakeTask,
  type SemanticPersonEndpoint,
} from "./intake-semantic-plan";
import {
  SemanticIntakeTaskStateMachine,
  type SemanticIntakeIssue,
  type SemanticIntakeTaskSnapshot,
} from "./intake-task-state";
import { ensureIntakeWorkspace } from "./intake-workspace";

export interface IntakeSemanticCompilerSnapshot extends ArchiveRecordResolverSnapshot {
  reminders?: readonly ReminderRecord[];
  evidence?: readonly EvidenceRecord[];
}

export interface IntakeSemanticCompilation {
  plan: SemanticIntakePlan;
  draft: IngestCandidate;
  proposal?: ArchiveMutationPlan;
  issues: SemanticIntakeIssue[];
  state: SemanticIntakeTaskSnapshot;
}

export interface LocalCollectionClassificationAssignment {
  /** Stable archive ID resolved only inside the local intake harness. */
  personId: string;
  collections: SemanticCollectionClassification[];
  reason?: string;
}

export interface LocalCollectionClassificationResult {
  taskId: string;
  assignments: LocalCollectionClassificationAssignment[];
  issues: SemanticIntakeIssue[];
}

interface ResolvedTask {
  task: SemanticIntakeTask;
  target?: ResolvedRecordCandidate;
  endpoints?: [ResolvedRecordCandidate, ResolvedRecordCandidate];
  people?: ResolvedRecordCandidate[];
  collectionId?: string;
  collection?: CollectionRecord;
  membershipChanges?: Array<{ personId: string; action: "add" | "remove" }>;
  classificationAssignments?: LocalCollectionClassificationAssignment[];
  proposalTargetIds?: string[];
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

const CLIENT_BINDING_FIELDS = new Set([
  "recordRef",
  "personId",
  "personDraftId",
  "fromPersonId",
  "toPersonId",
  "fromDraftId",
  "toDraftId",
  "peoplePersonIds",
  "peopleDraftIds",
]);

function modelDraftValue<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (key, item: unknown) =>
      key.startsWith("_") || key.startsWith("target") || CLIENT_BINDING_FIELDS.has(key)
        ? undefined
        : item,
    ),
  ) as T;
}

function workspacePersonFromChanges(
  current: IngestPerson,
  changes: Record<string, unknown>,
): IngestPerson {
  const parsed = parseIngestCandidate(
    JSON.stringify({
      people: [
        {
          ...modelDraftValue(current),
          ...changes,
          name: changes.name ?? current.name,
        },
      ],
    }),
  ).people![0];
  const grounding = Object.fromEntries(
    Object.entries(current._fieldGrounding ?? {}).filter(([field]) => !(field in changes)),
  );
  return {
    ...current,
    ...parsed,
    _fieldGrounding: Object.keys(grounding).length ? grounding : undefined,
  };
}

function personDraftFromChanges(person: PersonRecord, changes: unknown): IngestPerson {
  const input = record(changes);
  const { circle: _legacyCircle, ...withoutCircle } = input;
  return parseIngestCandidate(
    JSON.stringify({ people: [{ ...withoutCircle, name: input.name ?? person.name }] }),
  ).people![0];
}

function eventDraftFromChanges(
  event: LifeEventRecord,
  changes: unknown,
  people: ResolvedRecordCandidate[],
): IngestEvent {
  const input = record(changes);
  const { people: _semanticPeople, ...fields } = input;
  return parseIngestCandidate(
    JSON.stringify({
      events: [
        {
          title: fields.title ?? event.title,
          detail: "detail" in fields ? fields.detail : event.detail,
          date: "date" in fields ? fields.date : event.date,
          timeText: fields.timeText,
          dateEnd: "dateEnd" in fields ? fields.dateEnd : event.dateEnd,
          precision: "precision" in fields ? fields.precision : (event.precision ?? "day"),
          place: "place" in fields ? fields.place : event.place,
          people: people.length ? people.map((person) => person.label) : undefined,
          kind: "kind" in fields ? fields.kind : event.kind,
          confidence: fields.confidence,
        },
      ],
    }),
  ).events![0];
}

function relationDraftFromChanges(
  relation: RelationRecord,
  persons: readonly PersonRecord[],
  changes: unknown,
): IngestRelation {
  const input = record(changes);
  const names = new Map(persons.map((person) => [person.id, person.name]));
  return parseIngestCandidate(
    JSON.stringify({
      relations: [
        {
          from: names.get(relation.fromId) ?? relation.fromId,
          to: names.get(relation.toId) ?? relation.toId,
          label: input.label ?? relation.label,
          note: "note" in input ? input.note : relation.note,
          basis: "basis" in input ? input.basis : relation.basis,
          confidence: "confidence" in input ? input.confidence : relation.confidence,
        },
      ],
    }),
  ).relations![0];
}

function upsert<T>(rows: T[], item: T, key: (value: T) => string) {
  const id = key(item);
  const index = rows.findIndex((row) => key(row) === id);
  if (index >= 0) rows[index] = item;
  else rows.push(item);
}

function issueFromResolution(
  taskId: string,
  path: string,
  resolution: RecordResolution,
): SemanticIntakeIssue {
  if (resolution.status === "resolved") {
    throw new Error(`引用 ${path} 已解析，不能转换为问题`);
  }
  return {
    taskId,
    stage: "RESOLVE",
    code: resolution.status === "ambiguous" ? "ambiguous" : "missing",
    message: resolution.reason,
    path,
    candidates: resolution.candidates.map((candidate) => ({
      id: candidate.id,
      label: candidate.label,
    })),
  };
}

function resolveOne(
  ref: unknown,
  snapshot: ArchiveRecordResolverSnapshot,
): { candidate?: ResolvedRecordCandidate; resolution: RecordResolution } {
  const resolution = resolveSemanticRecordRef(ref, snapshot);
  return {
    candidate:
      resolution.status === "resolved" && resolution.cardinality === "one"
        ? resolution.candidates[0]
        : undefined,
    resolution,
  };
}

function semanticPeople(changes: Record<string, unknown>) {
  if (!("people" in changes)) return { refs: [] as SemanticPersonEndpoint[], invalid: false };
  if (!Array.isArray(changes.people))
    return { refs: [] as SemanticPersonEndpoint[], invalid: true };
  const refs: SemanticPersonEndpoint[] = [];
  for (const value of changes.people) {
    const candidate = typeof value === "string" ? { kind: "person" as const, name: value } : value;
    const parsed = semanticPersonEndpointSchema.safeParse(candidate);
    if (!parsed.success) return { refs: [] as SemanticPersonEndpoint[], invalid: true };
    refs.push(parsed.data);
  }
  return { refs, invalid: false };
}

function resolvePeople(
  task: SemanticIntakeTask,
  changes: Record<string, unknown>,
  snapshot: ArchiveRecordResolverSnapshot,
) {
  const parsed = semanticPeople(changes);
  if (parsed.invalid) {
    return {
      people: [] as ResolvedRecordCandidate[],
      issues: [
        {
          taskId: task.id,
          stage: "RESOLVE" as const,
          code: "invalid" as const,
          message: "changes.people 必须是人物语义引用数组",
          path: "changes.people",
        },
      ],
    };
  }
  const people: ResolvedRecordCandidate[] = [];
  const issues: SemanticIntakeIssue[] = [];
  parsed.refs.forEach((ref, index) => {
    const result = resolveOne(ref, snapshot);
    if (result.candidate) people.push(result.candidate);
    else issues.push(issueFromResolution(task.id, `changes.people[${index}]`, result.resolution));
  });
  return { people, issues };
}

function bindPeople<
  T extends {
    people?: string[];
    peopleDraftIds?: Array<string | undefined>;
    peoplePersonIds?: Array<string | undefined>;
  },
>(item: T, people: readonly ResolvedRecordCandidate[]) {
  if (!people.length) return item;
  item.people = people.map((person) => person.label);
  item.peopleDraftIds = people.map((person) =>
    person.source === "workspace" ? person.id : undefined,
  );
  item.peoplePersonIds = people.map((person) =>
    person.source === "archive" || person.source === "virtual" ? person.id : undefined,
  );
  return item;
}

function archivePeople(
  personIds: readonly string[] | undefined,
  persons: readonly PersonRecord[],
): ResolvedRecordCandidate[] {
  const byId = new Map(persons.map((person) => [person.id, person]));
  return (personIds ?? []).flatMap((personId) => {
    const person = byId.get(personId);
    return person
      ? [
          {
            domain: "person" as const,
            id: person.id,
            label: person.name,
            source: "archive" as const,
            record: person,
          },
        ]
      : [];
  });
}

function collectionSnapshot(snapshot: IntakeSemanticCompilerSnapshot): ArchiveMutationSnapshot {
  return {
    persons: [...snapshot.persons],
    assertions: [],
    derivedRelations: [],
    evidenceLinks: [],
    evidence: [...(snapshot.evidence ?? [])],
    caseEvents: [],
    viewPreferences: [],
    referralPolicies: [],
    lifeEvents: [...snapshot.events],
    reminders: [...(snapshot.reminders ?? [])],
    tasks: [],
    projects: [],
    collections: [...snapshot.collections],
    collectionMemberships: [...(snapshot.collectionMemberships ?? [])],
  };
}

function newLocalId(prefix: string) {
  return `${prefix}:${crypto.randomUUID()}`;
}

function normalizedCollectionName(value: string) {
  return value.normalize("NFKC").trim().toLocaleLowerCase("zh-CN");
}

/**
 * Compile every valid semantic task independently against a complete local
 * snapshot. Only this function turns semantic references into stable IDs.
 */
export function compileSemanticIntakePlan(options: {
  candidate: unknown;
  snapshot: IntakeSemanticCompilerSnapshot;
  collectionClassifications?: readonly LocalCollectionClassificationResult[];
}): IntakeSemanticCompilation {
  const parsed = parseSemanticIntakePlan(options.candidate);
  if (!parsed.plan.tasks.length) {
    throw new Error(
      parsed.issues.length
        ? `semantic_plan 没有可执行任务：${parsed.issues.map((issue) => issue.message).join("；")}`
        : "semantic_plan 没有可执行任务",
    );
  }
  const state = new SemanticIntakeTaskStateMachine();
  const parseIssues: SemanticIntakeIssue[] = parsed.issues.map((issue) => ({
    taskId: issue.taskId,
    stage: "UNDERSTAND",
    code: "invalid",
    message: issue.message,
    path: issue.taskIndex === undefined ? undefined : `tasks[${issue.taskIndex}]`,
  }));
  state.acceptPlan(parsed.plan, parseIssues);

  const baseWorkspace = ensureIntakeWorkspace(structuredClone(options.snapshot.workspace ?? {}));
  const plannedPeople = [...(baseWorkspace.people ?? [])];
  const plannedPersonIds = new Map<string, string>();
  for (const task of parsed.plan.tasks) {
    if (task.domain !== "person" || task.intent !== "create" || task.target.kind !== "person") {
      continue;
    }
    const draftId = `draft:person:${task.id}`;
    plannedPersonIds.set(task.id, draftId);
    plannedPeople.push({ name: task.target.name, _draftId: draftId });
  }
  const resolverSnapshot: IntakeSemanticCompilerSnapshot = {
    ...options.snapshot,
    workspace: { ...baseWorkspace, people: plannedPeople },
  };
  for (const task of parsed.plan.tasks) state.markDiscovered(task.id);
  state.beginResolution();

  const resolved = new Map<string, ResolvedTask>();
  const classifications = new Map(
    (options.collectionClassifications ?? []).map((result) => [result.taskId, result]),
  );
  for (const task of parsed.plan.tasks) {
    const fatal: SemanticIntakeIssue[] = [];
    const soft: SemanticIntakeIssue[] = [];
    const data: ResolvedTask = { task };
    const changes = "changes" in task ? record(task.changes) : {};

    if (task.domain === "person") {
      if (task.intent === "create") {
        if (task.target.kind !== "person") {
          fatal.push({
            taskId: task.id,
            stage: "RESOLVE",
            code: "invalid",
            message: "新增人物必须使用 person 语义引用",
            path: "target",
          });
        } else {
          data.target = {
            domain: "person",
            id: plannedPersonIds.get(task.id)!,
            label: task.target.name,
            source: "workspace",
          };
        }
      } else {
        const result = resolveOne(task.target, resolverSnapshot);
        if (result.candidate) data.target = result.candidate;
        else fatal.push(issueFromResolution(task.id, "target", result.resolution));
      }
      if ("circle" in changes) {
        soft.push({
          taskId: task.id,
          stage: "RESOLVE",
          code: "unsupported",
          message: "圈层必须通过 collection 与 membership 任务表达，person.circle 已忽略",
          path: "changes.circle",
        });
      }
    } else if (task.domain === "relation") {
      if (task.target.kind === "workspace") {
        if (task.intent === "create") {
          fatal.push({
            taskId: task.id,
            stage: "RESOLVE",
            code: "invalid",
            message: "新增关系不能把已有 workspace 记录作为目标",
            path: "target",
          });
        } else {
          const result = resolveOne(task.target, resolverSnapshot);
          if (result.candidate) data.target = result.candidate;
          else fatal.push(issueFromResolution(task.id, "target", result.resolution));
        }
      } else {
        const from = resolveOne(task.target.from, resolverSnapshot);
        const to = resolveOne(task.target.to, resolverSnapshot);
        if (!from.candidate)
          fatal.push(issueFromResolution(task.id, "target.from", from.resolution));
        if (!to.candidate) fatal.push(issueFromResolution(task.id, "target.to", to.resolution));
        if (from.candidate && to.candidate) data.endpoints = [from.candidate, to.candidate];
        if (task.intent === "update") {
          const relation = resolveOne(task.target, resolverSnapshot);
          if (relation.candidate) data.target = relation.candidate;
          else fatal.push(issueFromResolution(task.id, "target", relation.resolution));
        } else {
          data.target = {
            domain: "relation",
            id: `draft:relation:${task.id}`,
            label: task.target.label ?? String(changes.label ?? "关系"),
            source: "workspace",
          };
        }
      }
    } else if (task.domain === "event") {
      const people = resolvePeople(task, changes, resolverSnapshot);
      data.people = people.people;
      fatal.push(...people.issues);
      if (task.intent === "create") {
        if (task.target.kind !== "event") {
          fatal.push({
            taskId: task.id,
            stage: "RESOLVE",
            code: "invalid",
            message: "新增事件必须使用 event 语义引用",
            path: "target",
          });
        } else {
          data.target = {
            domain: "event",
            id: `draft:event:${task.id}`,
            label: task.target.title,
            source: "workspace",
          };
        }
      } else {
        const result = resolveOne(task.target, resolverSnapshot);
        if (result.candidate) data.target = result.candidate;
        else fatal.push(issueFromResolution(task.id, "target", result.resolution));
      }
    } else if (task.domain === "fact") {
      if (task.intent === "create" && task.target.kind === "fact") {
        const person = resolveOne(task.target.person, resolverSnapshot);
        if (person.candidate) data.people = [person.candidate];
        else fatal.push(issueFromResolution(task.id, "target.person", person.resolution));
        data.target = {
          domain: "fact",
          id: `draft:fact:${task.id}`,
          label: task.target.key,
          source: "workspace",
        };
      } else {
        const result = resolveOne(task.target, resolverSnapshot);
        if (result.candidate) data.target = result.candidate;
        else fatal.push(issueFromResolution(task.id, "target", result.resolution));
      }
    } else if (task.domain === "reminder") {
      const people = resolvePeople(task, changes, resolverSnapshot);
      data.people = people.people;
      fatal.push(...people.issues);
      if (task.intent === "create" && task.target.kind === "reminder") {
        data.target = {
          domain: "reminder",
          id: `draft:reminder:${task.id}`,
          label: task.target.title,
          source: "workspace",
        };
      } else {
        const result = resolveOne(task.target, resolverSnapshot);
        if (result.candidate) data.target = result.candidate;
        else fatal.push(issueFromResolution(task.id, "target", result.resolution));
      }
    } else if (task.domain === "evidence") {
      if (task.intent === "create" && task.target.kind === "evidence") {
        data.target = {
          domain: "evidence",
          id: `draft:evidence:${task.id}`,
          label: task.target.title,
          source: "workspace",
        };
      } else {
        const result = resolveOne(task.target, resolverSnapshot);
        if (result.candidate) data.target = result.candidate;
        else fatal.push(issueFromResolution(task.id, "target", result.resolution));
      }
    } else if (task.domain === "collection" && task.intent === "classify") {
      const selection = resolveSemanticRecordRef(task.target, resolverSnapshot);
      if (selection.status !== "resolved") {
        fatal.push(issueFromResolution(task.id, "target", selection));
      } else {
        const selectedPeople = new Map(selection.candidates.map((person) => [person.id, person]));
        const classification = classifications.get(task.id);
        if (!classification && selectedPeople.size) {
          fatal.push({
            taskId: task.id,
            stage: "DISCOVER",
            code: "missing",
            message: "全库圈层分类尚未返回任何本地批次结果",
            path: "classification",
          });
        } else {
          soft.push(...(classification?.issues ?? []));
          const seenPeople = new Set<string>();
          const validAssignments: LocalCollectionClassificationAssignment[] = [];
          for (const assignment of classification?.assignments ?? []) {
            const person = selectedPeople.get(assignment.personId);
            if (!person) {
              soft.push({
                taskId: task.id,
                stage: "RESOLVE",
                code: "invalid",
                message: "分类结果引用了本轮选择范围之外的人物",
                path: "classification.assignments",
              });
              continue;
            }
            if (seenPeople.has(assignment.personId)) {
              soft.push({
                taskId: task.id,
                stage: "RESOLVE",
                code: "invalid",
                message: `人物“${person.label}”在分类结果中重复出现`,
                path: "classification.assignments",
              });
              continue;
            }
            seenPeople.add(assignment.personId);
            const uniqueCollections = new Map<string, SemanticCollectionClassification>();
            let ambiguous = false;
            for (const collection of assignment.collections) {
              const key = normalizedCollectionName(collection.name);
              const matches = options.snapshot.collections.filter(
                (candidate) =>
                  candidate.kind === "relationship_circle" &&
                  normalizedCollectionName(candidate.name) === key,
              );
              if (matches.length > 1) {
                soft.push({
                  taskId: task.id,
                  stage: "RESOLVE",
                  code: "ambiguous",
                  message: `圈层名“${collection.name}”匹配到多个已有圈层，人物“${person.label}”保持原分类`,
                  path: "classification.assignments.collections",
                  candidates: matches.map((candidate) => ({
                    id: candidate.id,
                    label: candidate.name,
                  })),
                });
                ambiguous = true;
                break;
              }
              if (!uniqueCollections.has(key)) uniqueCollections.set(key, collection);
            }
            if (!ambiguous) {
              validAssignments.push({
                ...assignment,
                collections: [...uniqueCollections.values()],
              });
            }
          }
          if (selectedPeople.size && !validAssignments.length) {
            fatal.push({
              taskId: task.id,
              stage: "RESOLVE",
              code: "missing",
              message: "全库圈层分类没有可编译的人物条目",
              path: "classification.assignments",
            });
          } else {
            data.people = validAssignments.flatMap((assignment) => {
              const person = selectedPeople.get(assignment.personId);
              return person ? [person] : [];
            });
            data.classificationAssignments = validAssignments;
          }
        }
      }
    } else {
      const collectionResolution = resolveSemanticRecordRef(task.target, resolverSnapshot);
      if (collectionResolution.status === "ambiguous") {
        fatal.push(issueFromResolution(task.id, "target", collectionResolution));
      } else if (collectionResolution.status === "resolved") {
        const target = collectionResolution.candidates[0];
        const collection = target.record as CollectionRecord;
        if (collection.kind === "computed_community") {
          fatal.push({
            taskId: task.id,
            stage: "RESOLVE",
            code: "unsupported",
            message: "拓扑社区是可重建投影，不能作为人工圈层修改",
            path: "target",
          });
        } else {
          data.target = target;
          data.collectionId = target.id;
          data.collection = collection;
        }
      } else if (task.target.collectionKind === "computed_community") {
        fatal.push({
          taskId: task.id,
          stage: "RESOLVE",
          code: "unsupported",
          message: "不能创建或修改 projector 管理的拓扑社区",
          path: "target",
        });
      } else {
        data.collectionId = newLocalId("collection");
      }

      const membershipChanges = new Map<string, "add" | "remove">();
      task.memberships.forEach((membership, index) => {
        const resolution = resolveSemanticRecordRef(membership.people, resolverSnapshot);
        if (resolution.status !== "resolved") {
          soft.push(issueFromResolution(task.id, `memberships[${index}].people`, resolution));
          return;
        }
        for (const person of resolution.candidates) {
          if (person.source === "workspace") {
            soft.push({
              taskId: task.id,
              stage: "RESOLVE",
              code: "unsupported",
              message: `新人物“${person.label}”需先获得档案 ID，当前圈层提案暂不包含它`,
              path: `memberships[${index}].people`,
            });
            continue;
          }
          membershipChanges.set(person.id, membership.action);
        }
      });
      data.membershipChanges = [...membershipChanges].map(([personId, action]) => ({
        personId,
        action,
      }));
    }

    if (fatal.length) {
      state.markNeedsInput(task.id, fatal[0]);
      fatal.slice(1).forEach((issue) => state.addTaskIssue(task.id, issue));
      soft.forEach((issue) => state.addTaskIssue(task.id, issue));
      continue;
    }
    state.markResolved(
      task.id,
      data.target ? [data.target.id] : data.collectionId ? [data.collectionId] : [],
    );
    soft.forEach((issue) => state.addTaskIssue(task.id, issue));
    resolved.set(task.id, data);
  }

  state.beginProposal();
  const draft = ensureIntakeWorkspace(structuredClone(baseWorkspace));
  const operations: ArchiveMutationOperation[] = [];
  const usedCollectionTargets = new Set<string>();
  const mutationSnapshot = collectionSnapshot(options.snapshot);

  for (const task of parsed.plan.tasks) {
    const data = resolved.get(task.id);
    if (!data) continue;
    const changes = "changes" in task ? record(task.changes) : {};
    try {
      if (task.domain === "person") {
        const { circle: _legacyCircle, ...personChanges } = changes;
        if (task.intent === "create") {
          if (task.target.kind !== "person") throw new Error("新增人物目标不是 person 引用");
          const item = parseIngestCandidate(
            JSON.stringify({ people: [{ ...personChanges, name: task.target.name }] }),
          ).people![0];
          item._draftId = data.target!.id;
          draft.people!.push(item);
        } else if (data.target?.source === "workspace") {
          const current = data.target.record as IngestPerson;
          const item = workspacePersonFromChanges(current, personChanges);
          item._draftId = data.target.id;
          upsert(draft.people!, item, (person) => person._draftId ?? person.name);
        } else {
          const current = data.target!.record as PersonRecord;
          const item = personDraftFromChanges(current, personChanges);
          item.targetPersonId = current.id;
          item._identityChecked = true;
          item._identityReason = "语义引用已由本地完整档案唯一解析；等待用户核对";
          upsert(draft.people!, item, (person) => person.targetPersonId ?? person.name);
        }
      } else if (task.domain === "fact") {
        if (task.intent === "update") {
          const current = data.target!.record as NonNullable<IngestCandidate["facts"]>[number];
          const item = parseIngestCandidate(
            JSON.stringify({ facts: [{ ...modelDraftValue(current), ...changes }] }),
          ).facts![0];
          item._draftId = data.target!.id;
          item.personDraftId = current.personDraftId;
          item.personId = current.personId;
          upsert(draft.facts!, item, (fact) => fact._draftId ?? `${fact.person}:${fact.key}`);
        } else {
          if (task.target.kind !== "fact") throw new Error("新增事实目标不是 fact 引用");
          const person = data.people![0];
          const item = parseIngestCandidate(
            JSON.stringify({ facts: [{ ...changes, person: person.label, key: task.target.key }] }),
          ).facts![0];
          item._draftId = data.target!.id;
          if (person.source === "workspace") item.personDraftId = person.id;
          else item.personId = person.id;
          draft.facts!.push(item);
        }
      } else if (task.domain === "relation") {
        if (task.intent === "update" && data.target?.source === "archive") {
          const current = data.target.record as RelationRecord;
          const item = relationDraftFromChanges(current, options.snapshot.persons, changes);
          item.targetRelationId = current.id;
          item.fromPersonId = current.fromId;
          item.toPersonId = current.toId;
          item._relationChecked = true;
          item._relationReason = "语义引用已由本地完整档案唯一解析；等待用户核对";
          upsert(
            draft.relations!,
            item,
            (relation) => relation.targetRelationId ?? relation._draftId ?? relation.label,
          );
        } else if (task.intent === "update") {
          const current = data.target!.record as IngestRelation;
          const item = parseIngestCandidate(
            JSON.stringify({ relations: [{ ...modelDraftValue(current), ...changes }] }),
          ).relations![0];
          item._draftId = data.target!.id;
          item.fromDraftId = current.fromDraftId;
          item.toDraftId = current.toDraftId;
          item.fromPersonId = current.fromPersonId;
          item.toPersonId = current.toPersonId;
          upsert(draft.relations!, item, (relation) => relation._draftId ?? relation.label);
        } else {
          if (task.target.kind !== "relation") throw new Error("新增关系目标不是 relation 引用");
          const [from, to] = data.endpoints!;
          const item = parseIngestCandidate(
            JSON.stringify({
              relations: [
                {
                  ...changes,
                  from: from.label,
                  to: to.label,
                  label: changes.label ?? task.target.label,
                },
              ],
            }),
          ).relations![0];
          item._draftId = data.target!.id;
          if (from.source === "workspace") item.fromDraftId = from.id;
          else item.fromPersonId = from.id;
          if (to.source === "workspace") item.toDraftId = to.id;
          else item.toPersonId = to.id;
          draft.relations!.push(item);
        }
      } else if (task.domain === "event") {
        const { people: _semanticPeople, ...eventChanges } = changes;
        if (task.intent === "update" && data.target?.source === "archive") {
          const current = data.target.record as LifeEventRecord;
          const people =
            "people" in changes
              ? (data.people ?? [])
              : archivePeople(current.personIds, options.snapshot.persons);
          const item = eventDraftFromChanges(current, changes, people);
          item.targetEventId = current.id;
          item._eventChecked = true;
          item._eventReason = "语义引用已由本地完整档案唯一解析；等待用户核对";
          bindPeople(item, people);
          upsert(
            draft.events!,
            item,
            (event) => event.targetEventId ?? event._draftId ?? event.title,
          );
        } else if (task.intent === "update") {
          const current = data.target!.record as IngestEvent;
          const item = parseIngestCandidate(
            JSON.stringify({ events: [{ ...modelDraftValue(current), ...eventChanges }] }),
          ).events![0];
          item._draftId = data.target!.id;
          item.targetEventId = current.targetEventId;
          if ("people" in changes) {
            bindPeople(item, data.people ?? []);
          } else {
            item.peopleDraftIds = current.peopleDraftIds;
            item.peoplePersonIds = current.peoplePersonIds;
          }
          upsert(draft.events!, item, (event) => event._draftId ?? event.title);
        } else {
          if (task.target.kind !== "event") throw new Error("新增事件目标不是 event 引用");
          const item = parseIngestCandidate(
            JSON.stringify({ events: [{ ...eventChanges, title: task.target.title }] }),
          ).events![0];
          item._draftId = data.target!.id;
          bindPeople(item, data.people ?? []);
          draft.events!.push(item);
        }
      } else if (task.domain === "reminder") {
        const { people: _semanticPeople, ...reminderChanges } = changes;
        if (task.intent === "update") {
          if (data.target?.source !== "workspace") {
            throw new Error("当前归档提醒更新尚未进入统一 mutation 域");
          }
          const current = data.target.record as NonNullable<IngestCandidate["reminders"]>[number];
          const item = parseIngestCandidate(
            JSON.stringify({ reminders: [{ ...modelDraftValue(current), ...reminderChanges }] }),
          ).reminders![0];
          item._draftId = data.target.id;
          if ("people" in changes) {
            bindPeople(item, data.people ?? []);
          } else {
            item.peopleDraftIds = current.peopleDraftIds;
            item.peoplePersonIds = current.peoplePersonIds;
          }
          upsert(draft.reminders!, item, (reminder) => reminder._draftId ?? reminder.title);
        } else {
          if (task.target.kind !== "reminder") throw new Error("新增提醒目标不是 reminder 引用");
          const item = parseIngestCandidate(
            JSON.stringify({ reminders: [{ ...reminderChanges, title: task.target.title }] }),
          ).reminders![0];
          item._draftId = data.target!.id;
          bindPeople(item, data.people ?? []);
          draft.reminders!.push(item);
        }
      } else if (task.domain === "evidence") {
        if (task.intent === "update") {
          if (data.target?.source !== "workspace") {
            throw new Error("当前归档材料更新尚未进入统一 mutation 域");
          }
          const current = data.target.record as NonNullable<IngestCandidate["evidence"]>[number];
          const item = parseIngestCandidate(
            JSON.stringify({ evidence: [{ ...modelDraftValue(current), ...changes }] }),
          ).evidence![0];
          item._draftId = data.target.id;
          upsert(draft.evidence!, item, (evidence) => evidence._draftId ?? evidence.title ?? "");
        } else {
          if (task.target.kind !== "evidence") throw new Error("新增材料目标不是 evidence 引用");
          const item = parseIngestCandidate(
            JSON.stringify({ evidence: [{ ...changes, title: task.target.title }] }),
          ).evidence![0];
          item._draftId = data.target!.id;
          draft.evidence!.push(item);
        }
      } else if (task.domain === "collection" && task.intent === "classify") {
        const assignments = data.classificationAssignments ?? [];
        const affectedPersonIds = new Set(assignments.map((assignment) => assignment.personId));
        const desiredByPerson = new Map(
          assignments.map((assignment) => [
            assignment.personId,
            new Set(
              assignment.collections.map((collection) => normalizedCollectionName(collection.name)),
            ),
          ]),
        );
        const collectionSpecs = new Map<string, SemanticCollectionClassification>();
        for (const assignment of assignments) {
          for (const collection of assignment.collections) {
            const key = normalizedCollectionName(collection.name);
            if (!collectionSpecs.has(key)) collectionSpecs.set(key, collection);
          }
        }
        const existingRelationshipCircles = options.snapshot.collections.filter(
          (collection) => collection.kind === "relationship_circle",
        );
        const existingByName = new Map(
          existingRelationshipCircles.map((collection) => [
            normalizedCollectionName(collection.name),
            collection,
          ]),
        );
        const taskOperations: ArchiveMutationOperation[] = [];
        const taskTargetIds: string[] = [];

        for (const collection of existingRelationshipCircles) {
          const key = normalizedCollectionName(collection.name);
          const existingMembers = new Set(
            (options.snapshot.collectionMemberships ?? [])
              .filter((membership) => membership.collectionId === collection.id)
              .map((membership) => membership.personId),
          );
          const memberships = [...affectedPersonIds].flatMap((personId) => {
            const desired = desiredByPerson.get(personId)?.has(key) ?? false;
            const exists = existingMembers.has(personId);
            return desired === exists
              ? []
              : [{ personId, action: desired ? ("add" as const) : ("remove" as const) }];
          });
          if (!memberships.length) continue;
          if (usedCollectionTargets.has(collection.id)) {
            throw new Error(`圈层“${collection.name}”在同一计划中已有其它整理任务`);
          }
          taskOperations.push(
            createOrganizeCollectionOperation(mutationSnapshot, {
              collectionId: collection.id,
              reason: parsed.plan.summary ?? "按人物档案重新整理圈层",
              replacement: {
                name: collection.name,
                kind: "relationship_circle",
                color: collection.color ?? null,
              },
              memberships,
              id: `classify-collection:${task.id}:${taskOperations.length + 1}`,
            }),
          );
          taskTargetIds.push(collection.id);
        }

        for (const [key, collection] of collectionSpecs) {
          if (existingByName.has(key)) continue;
          const personIds = assignments
            .filter((assignment) => desiredByPerson.get(assignment.personId)?.has(key))
            .map((assignment) => assignment.personId);
          if (!personIds.length) continue;
          const collectionId = newLocalId("collection");
          taskOperations.push(
            createOrganizeCollectionOperation(mutationSnapshot, {
              collectionId,
              reason: parsed.plan.summary ?? "按人物档案重新整理圈层",
              replacement: {
                name: collection.name,
                kind: "relationship_circle",
                color: collection.color ?? null,
              },
              memberships: personIds.map((personId) => ({ personId, action: "add" })),
              id: `classify-collection:${task.id}:${taskOperations.length + 1}`,
            }),
          );
          taskTargetIds.push(collectionId);
        }
        for (const targetId of taskTargetIds) usedCollectionTargets.add(targetId);
        operations.push(...taskOperations);
        data.proposalTargetIds = taskTargetIds;
      } else {
        const collectionId = data.collectionId!;
        if (usedCollectionTargets.has(collectionId)) {
          throw new Error("同一语义计划不能重复整理同一圈层");
        }
        usedCollectionTargets.add(collectionId);
        const existingMemberships = new Set(
          (options.snapshot.collectionMemberships ?? [])
            .filter((membership) => membership.collectionId === collectionId)
            .map((membership) => membership.personId),
        );
        const effectiveMemberships = (data.membershipChanges ?? []).filter((change) =>
          change.action === "add"
            ? !existingMemberships.has(change.personId)
            : existingMemberships.has(change.personId),
        );
        const nextName = task.changes?.name ?? data.collection?.name ?? task.target.name;
        const nextKind =
          task.changes?.collectionKind ??
          (data.collection?.kind === "context" ? "context" : "relationship_circle");
        const nextColor =
          task.changes && "color" in task.changes
            ? (task.changes.color ?? null)
            : (data.collection?.color ?? null);
        const replacementChanged =
          !data.collection ||
          data.collection.name !== nextName ||
          data.collection.kind !== nextKind ||
          (data.collection.color ?? null) !== nextColor;
        if (replacementChanged || effectiveMemberships.length) {
          operations.push(
            createOrganizeCollectionOperation(mutationSnapshot, {
              collectionId,
              reason: parsed.plan.summary ?? `整理圈层“${task.target.name}”`,
              replacement: { name: nextName, kind: nextKind, color: nextColor },
              memberships: effectiveMemberships,
              id: `organize-collection:${task.id}`,
            }),
          );
        }
      }
      state.markProposed(
        task.id,
        data.proposalTargetIds ??
          (data.target ? [data.target.id] : data.collectionId ? [data.collectionId] : []),
      );
    } catch (error) {
      state.markNeedsInput(task.id, {
        taskId: task.id,
        stage: "PROPOSE",
        code: "compile",
        message: error instanceof Error ? error.message : "无法编译任务",
      });
    }
  }

  const finalState = state.finish();
  draft.summary = parsed.plan.summary ?? draft.summary ?? "已根据本次材料生成待确认变更";
  draft._revision = options.snapshot.workspace
    ? Math.max(1, Math.trunc(options.snapshot.workspace._revision ?? 1)) + 1
    : 1;
  const proposal = operations.length
    ? createArchiveMutationPlan(
        {
          title: parsed.plan.summary ?? "录入材料中的圈层变更",
          reason: "语义任务已由本地完整档案解析，等待用户批准",
          operations,
        },
        { id: newLocalId("intake-plan") },
      )
    : undefined;
  return {
    plan: parsed.plan,
    draft,
    proposal,
    issues: finalState.issues,
    state: finalState,
  };
}
