import type {
  CollectionMembershipRecord,
  CollectionRecord,
  EvidenceRecord,
  LifeEventRecord,
  PersonRecord,
  RelationRecord,
  ReminderRecord,
} from "./face-db";
import type { IngestCandidate } from "./intake-draft";
import {
  semanticRecordRefSchema,
  type SemanticCollectionRef,
  type SemanticPersonEndpoint,
  type SemanticPersonRef,
  type SemanticRecordRef,
} from "./intake-semantic-plan";
import { SELF_PERSON_ID } from "./person-identity";

export type ResolvedRecordDomain =
  "person" | "fact" | "relation" | "event" | "reminder" | "evidence" | "collection";

export interface ArchiveRecordResolverSnapshot {
  persons: readonly PersonRecord[];
  events: readonly LifeEventRecord[];
  relations: readonly RelationRecord[];
  collections: readonly CollectionRecord[];
  collectionMemberships?: readonly CollectionMembershipRecord[];
  reminders?: readonly ReminderRecord[];
  evidence?: readonly EvidenceRecord[];
  workspace?: IngestCandidate;
}

export interface ResolvedRecordCandidate {
  domain: ResolvedRecordDomain;
  id: string;
  label: string;
  source: "archive" | "workspace" | "virtual";
  record?: unknown;
}

export type RecordResolution =
  | {
      status: "resolved";
      ref: SemanticRecordRef;
      cardinality: "one" | "many";
      candidates: ResolvedRecordCandidate[];
    }
  | {
      status: "ambiguous";
      ref: SemanticRecordRef;
      candidates: ResolvedRecordCandidate[];
      reason: string;
    }
  | {
      status: "missing";
      ref: SemanticRecordRef | unknown;
      candidates: [];
      reason: string;
    };

function normalized(value: string | undefined) {
  return (value ?? "")
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("zh-CN")
    .replace(/[\s，。！？、；：,.!?;:()（）/]+/g, "");
}

function personAliases(person: PersonRecord) {
  return (person.profile?.identities ?? []).map((identity) => identity.alias).filter(Boolean);
}

function exact(value: string | undefined, expected: string | undefined) {
  return expected === undefined || normalized(value) === normalized(expected);
}

function matchesPersonHints(person: PersonRecord, ref: SemanticPersonRef) {
  const hints = ref.hints;
  if (!hints) return true;
  if (
    hints.alias &&
    !personAliases(person).some((candidate) => normalized(candidate) === normalized(hints.alias))
  ) {
    return false;
  }
  return (
    exact(person.profile?.relation, hints.relation) &&
    exact(person.profile?.title, hints.title) &&
    exact(person.profile?.org, hints.org) &&
    exact(person.profile?.department, hints.department)
  );
}

function personCandidates(
  ref: SemanticPersonRef,
  snapshot: ArchiveRecordResolverSnapshot,
): ResolvedRecordCandidate[] {
  const key = normalized(ref.name);
  const archive = snapshot.persons
    .filter(
      (person) =>
        (normalized(person.name) === key ||
          personAliases(person).some((alias) => normalized(alias) === key)) &&
        matchesPersonHints(person, ref),
    )
    .map((person) => ({
      domain: "person" as const,
      id: person.id,
      label: person.name,
      source: "archive" as const,
      record: person,
    }));
  const workspace = (snapshot.workspace?.people ?? [])
    .filter((person) => {
      const aliases = (person.identities ?? []).map((identity) => identity.alias).filter(Boolean);
      const nameMatches =
        normalized(person.name) === key || aliases.some((alias) => normalized(alias) === key);
      if (!nameMatches || !ref.hints) return nameMatches;
      return (
        (!ref.hints.alias || aliases.some((alias) => exact(alias, ref.hints?.alias))) &&
        exact(person.relation, ref.hints.relation) &&
        exact(person.title, ref.hints.title) &&
        exact(person.org, ref.hints.org) &&
        exact(person.department, ref.hints.department)
      );
    })
    .filter((person) => Boolean(person._draftId))
    .map((person) => ({
      domain: "person" as const,
      id: person._draftId!,
      label: person.name,
      source: "workspace" as const,
      record: person,
    }));
  const representedArchiveIds = new Set(
    workspace.flatMap((candidate) => {
      const targetPersonId = (candidate.record as { targetPersonId?: string }).targetPersonId;
      return targetPersonId ? [targetPersonId] : [];
    }),
  );
  return [...archive.filter((candidate) => !representedArchiveIds.has(candidate.id)), ...workspace];
}

function resolutionForCandidates(
  ref: SemanticRecordRef,
  candidates: ResolvedRecordCandidate[],
  missingReason: string,
): RecordResolution {
  if (candidates.length === 1) {
    return { status: "resolved", ref, cardinality: "one", candidates };
  }
  if (candidates.length > 1) {
    return { status: "ambiguous", ref, candidates, reason: "语义引用匹配到多个候选" };
  }
  return { status: "missing", ref, candidates: [], reason: missingReason };
}

function endpointCandidates(
  ref: SemanticPersonEndpoint,
  snapshot: ArchiveRecordResolverSnapshot,
): ResolvedRecordCandidate[] {
  if (ref.kind === "person") return personCandidates(ref, snapshot);
  if (ref.kind === "self") {
    const exactSelf = snapshot.persons.find((person) => person.id === SELF_PERSON_ID);
    const ego = exactSelf
      ? [exactSelf]
      : snapshot.persons.filter((person) => person.entityRole === "ego");
    if (ego.length) {
      return ego.map((person) => ({
        domain: "person" as const,
        id: person.id,
        label: person.name,
        source: "archive" as const,
        record: person,
      }));
    }
    return [
      {
        domain: "person",
        id: SELF_PERSON_ID,
        label: "我",
        source: "virtual",
      },
    ];
  }
  const workspace = resolveWorkspace(ref, snapshot);
  return workspace.status === "resolved" ? workspace.candidates : [];
}

function workspaceRows(workspace: IngestCandidate | undefined) {
  return {
    person: workspace?.people ?? [],
    fact: workspace?.facts ?? [],
    relation: workspace?.relations ?? [],
    event: workspace?.events ?? [],
    reminder: workspace?.reminders ?? [],
    evidence: workspace?.evidence ?? [],
  };
}

function workspaceLabel(domain: keyof ReturnType<typeof workspaceRows>, row: unknown) {
  const value = row as Record<string, unknown>;
  if (domain === "person") return String(value.name ?? "未命名人物");
  if (domain === "relation") {
    return `${String(value.from ?? "?")} — ${String(value.label ?? "关系")} — ${String(value.to ?? "?")}`;
  }
  return String(value.title ?? value.key ?? "未命名记录");
}

function resolveWorkspace(
  ref: Extract<SemanticRecordRef, { kind: "workspace" }>,
  snapshot: ArchiveRecordResolverSnapshot,
): RecordResolution {
  const rows = workspaceRows(snapshot.workspace)[ref.domain];
  const matches = rows.filter((row) => (row as { _draftId?: string })._draftId === ref.recordRef);
  const candidates = matches.map((row) => ({
    domain: ref.domain,
    id: ref.recordRef,
    label: workspaceLabel(ref.domain, row),
    source: "workspace" as const,
    record: row,
  }));
  return resolutionForCandidates(ref, candidates, `工作区中不存在 ${ref.recordRef}`);
}

function collectionCandidates(
  ref: SemanticCollectionRef,
  snapshot: ArchiveRecordResolverSnapshot,
): ResolvedRecordCandidate[] {
  return snapshot.collections
    .filter(
      (collection) =>
        normalized(collection.name) === normalized(ref.name) &&
        (!ref.collectionKind || collection.kind === ref.collectionKind),
    )
    .map((collection) => ({
      domain: "collection" as const,
      id: collection.id,
      label: collection.name,
      source: "archive" as const,
      record: collection,
    }));
}

function resolveEvent(
  ref: Extract<SemanticRecordRef, { kind: "event" }>,
  snapshot: ArchiveRecordResolverSnapshot,
): RecordResolution {
  const personIds = ref.person
    ? endpointCandidates(ref.person, snapshot).map((item) => item.id)
    : [];
  if (ref.person && !personIds.length) {
    return { status: "missing", ref, candidates: [], reason: "事件关联人物无法定位" };
  }
  const candidates = snapshot.events
    .filter(
      (event) =>
        normalized(event.title) === normalized(ref.title) &&
        exact(event.date, ref.date) &&
        exact(event.kind, ref.eventKind) &&
        (!ref.person || event.personIds?.some((id) => personIds.includes(id))),
    )
    .map((event) => ({
      domain: "event" as const,
      id: event.id,
      label: event.title,
      source: "archive" as const,
      record: event,
    }));
  return resolutionForCandidates(ref, candidates, `找不到事件“${ref.title}”`);
}

function resolveFact(
  ref: Extract<SemanticRecordRef, { kind: "fact" }>,
  snapshot: ArchiveRecordResolverSnapshot,
): RecordResolution {
  const people = endpointCandidates(ref.person, snapshot);
  if (!people.length) {
    return { status: "missing", ref, candidates: [], reason: "事实关联人物无法定位" };
  }
  const personIds = new Set(people.map((candidate) => candidate.id));
  const candidates = (snapshot.workspace?.facts ?? [])
    .filter(
      (fact) =>
        normalized(fact.key) === normalized(ref.key) &&
        ((fact.personId && personIds.has(fact.personId)) ||
          (fact.personDraftId && personIds.has(fact.personDraftId)) ||
          people.some((person) => normalized(person.label) === normalized(fact.person))),
    )
    .filter((fact) => Boolean(fact._draftId))
    .map((fact) => ({
      domain: "fact" as const,
      id: fact._draftId!,
      label: `${fact.person} · ${fact.key}`,
      source: "workspace" as const,
      record: fact,
    }));
  return resolutionForCandidates(ref, candidates, `找不到人物事实“${ref.key}”`);
}

function resolveReminder(
  ref: Extract<SemanticRecordRef, { kind: "reminder" }>,
  snapshot: ArchiveRecordResolverSnapshot,
): RecordResolution {
  const people = ref.person ? endpointCandidates(ref.person, snapshot) : [];
  const personIds = new Set(people.map((candidate) => candidate.id));
  if (ref.person && !people.length) {
    return { status: "missing", ref, candidates: [], reason: "提醒关联人物无法定位" };
  }
  const archive = (snapshot.reminders ?? [])
    .filter(
      (reminder) =>
        normalized(reminder.title) === normalized(ref.title) &&
        exact(reminder.due, ref.due) &&
        (!ref.person || reminder.personIds?.some((id) => personIds.has(id))),
    )
    .map((reminder) => ({
      domain: "reminder" as const,
      id: reminder.id,
      label: reminder.title,
      source: "archive" as const,
      record: reminder,
    }));
  const workspace = (snapshot.workspace?.reminders ?? [])
    .filter(
      (reminder) =>
        normalized(reminder.title) === normalized(ref.title) &&
        exact(reminder.due, ref.due) &&
        (!ref.person ||
          reminder.peoplePersonIds?.some((id) => id && personIds.has(id)) ||
          reminder.peopleDraftIds?.some((id) => id && personIds.has(id)) ||
          reminder.people?.some((name) =>
            people.some((person) => normalized(person.label) === normalized(name)),
          )),
    )
    .filter((reminder) => Boolean(reminder._draftId))
    .map((reminder) => ({
      domain: "reminder" as const,
      id: reminder._draftId!,
      label: reminder.title,
      source: "workspace" as const,
      record: reminder,
    }));
  return resolutionForCandidates(ref, [...archive, ...workspace], `找不到提醒“${ref.title}”`);
}

function resolveEvidence(
  ref: Extract<SemanticRecordRef, { kind: "evidence" }>,
  snapshot: ArchiveRecordResolverSnapshot,
): RecordResolution {
  const archive = (snapshot.evidence ?? [])
    .filter(
      (evidence) =>
        normalized(evidence.title) === normalized(ref.title) && exact(evidence.origin, ref.origin),
    )
    .map((evidence) => ({
      domain: "evidence" as const,
      id: evidence.id,
      label: evidence.title,
      source: "archive" as const,
      record: evidence,
    }));
  const workspace = (snapshot.workspace?.evidence ?? [])
    .filter(
      (evidence) =>
        normalized(evidence.title) === normalized(ref.title) && exact(evidence.origin, ref.origin),
    )
    .filter((evidence) => Boolean(evidence._draftId))
    .map((evidence) => ({
      domain: "evidence" as const,
      id: evidence._draftId!,
      label: evidence.title ?? "未命名材料",
      source: "workspace" as const,
      record: evidence,
    }));
  return resolutionForCandidates(ref, [...archive, ...workspace], `找不到材料“${ref.title}”`);
}

function resolveRelation(
  ref: Extract<SemanticRecordRef, { kind: "relation" }>,
  snapshot: ArchiveRecordResolverSnapshot,
): RecordResolution {
  const from = endpointCandidates(ref.from, snapshot);
  const to = endpointCandidates(ref.to, snapshot);
  if (!from.length || !to.length) {
    return { status: "missing", ref, candidates: [], reason: "关系端点无法定位" };
  }
  const fromIds = new Set(from.map((candidate) => candidate.id));
  const toIds = new Set(to.map((candidate) => candidate.id));
  const candidates = snapshot.relations
    .filter((relation) => {
      const forward = fromIds.has(relation.fromId) && toIds.has(relation.toId);
      const reverse = fromIds.has(relation.toId) && toIds.has(relation.fromId);
      const endpointMatch = ref.direction === "from_to" ? forward : forward || reverse;
      const typeMatch =
        !ref.recordType || ref.recordType === "any" || relation.recordType === ref.recordType;
      return (
        endpointMatch &&
        typeMatch &&
        (!ref.label || normalized(relation.label) === normalized(ref.label))
      );
    })
    .map((relation) => ({
      domain: "relation" as const,
      id: relation.id,
      label: relation.label,
      source: "archive" as const,
      record: relation,
    }));
  return resolutionForCandidates(ref, candidates, "找不到符合端点与标签的关系");
}

function resolvePeopleSelection(
  ref: Extract<SemanticRecordRef, { kind: "person_selection" }>,
  snapshot: ArchiveRecordResolverSnapshot,
): RecordResolution {
  if (ref.scope === "all") {
    return {
      status: "resolved",
      ref,
      cardinality: "many",
      candidates: snapshot.persons.map((person) => ({
        domain: "person",
        id: person.id,
        label: person.name,
        source: "archive",
        record: person,
      })),
    };
  }
  const collections = collectionCandidates(ref.collection, snapshot);
  if (collections.length !== 1) {
    return collections.length
      ? { status: "ambiguous", ref, candidates: collections, reason: "圈层选择器匹配到多个圈层" }
      : { status: "missing", ref, candidates: [], reason: `找不到圈层“${ref.collection.name}”` };
  }
  const personIds = new Set(
    (snapshot.collectionMemberships ?? [])
      .filter((membership) => membership.collectionId === collections[0].id)
      .map((membership) => membership.personId),
  );
  return {
    status: "resolved",
    ref,
    cardinality: "many",
    candidates: snapshot.persons
      .filter((person) => personIds.has(person.id))
      .map((person) => ({
        domain: "person",
        id: person.id,
        label: person.name,
        source: "archive",
        record: person,
      })),
  };
}

/** Resolve one semantic selector without letting one miss invalidate any sibling selector. */
export function resolveSemanticRecordRef(
  rawRef: SemanticRecordRef | unknown,
  snapshot: ArchiveRecordResolverSnapshot,
): RecordResolution {
  const parsed = semanticRecordRefSchema.safeParse(rawRef);
  if (!parsed.success) {
    return {
      status: "missing",
      ref: rawRef,
      candidates: [],
      reason: "语义引用不符合 recordRef 契约",
    };
  }
  const ref = parsed.data;
  if (ref.kind === "self") {
    return {
      status: "resolved",
      ref,
      cardinality: "one",
      candidates: endpointCandidates(ref, snapshot),
    };
  }
  if (ref.kind === "workspace") return resolveWorkspace(ref, snapshot);
  if (ref.kind === "person") {
    return resolutionForCandidates(ref, personCandidates(ref, snapshot), `找不到人物“${ref.name}”`);
  }
  if (ref.kind === "fact") return resolveFact(ref, snapshot);
  if (ref.kind === "event") return resolveEvent(ref, snapshot);
  if (ref.kind === "reminder") return resolveReminder(ref, snapshot);
  if (ref.kind === "evidence") return resolveEvidence(ref, snapshot);
  if (ref.kind === "relation") return resolveRelation(ref, snapshot);
  if (ref.kind === "collection") {
    return resolutionForCandidates(
      ref,
      collectionCandidates(ref, snapshot),
      `找不到圈层“${ref.name}”`,
    );
  }
  return resolvePeopleSelection(ref, snapshot);
}

/** Batch resolution is item-isolated: invalid, ambiguous and missing refs remain visible. */
export function resolveSemanticRecordRefs(
  refs: readonly unknown[],
  snapshot: ArchiveRecordResolverSnapshot,
) {
  return refs.map((ref) => resolveSemanticRecordRef(ref, snapshot));
}
