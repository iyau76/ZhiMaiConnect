import type { IngestCandidate, IngestEvent, IngestPerson, IngestRelation } from "./intake-draft";

export type IntakeWorkspaceDomain =
  "person" | "fact" | "relation" | "event" | "reminder" | "evidence";

function newRecordRef(domain: IntakeWorkspaceDomain) {
  return `draft:${domain}:${crypto.randomUUID()}`;
}

function withRecordRef<T extends { _draftId?: string }>(
  domain: IntakeWorkspaceDomain,
  value: T,
): T {
  return {
    ...value,
    _draftId:
      value._draftId && !value._draftId.startsWith("plan:") ? value._draftId : newRecordRef(domain),
  };
}

function uniquePersonRef(people: IngestPerson[], name: string) {
  const matches = people.filter((person) => person.name.trim() === name.trim());
  return matches.length === 1 ? matches[0]._draftId : undefined;
}

/**
 * An intake draft is a real workspace, not a disposable model response. Every
 * reviewable row receives a stable temporary identity that survives supplement,
 * correction, autosave and re-render cycles.
 */
export function ensureIntakeWorkspace(candidate: IngestCandidate): IngestCandidate {
  const personRefChanges = new Map<string, string>();
  const people = (candidate.people ?? []).map((person) => {
    const value = withRecordRef("person", person);
    if (person._draftId && value._draftId && person._draftId !== value._draftId) {
      personRefChanges.set(person._draftId, value._draftId);
    }
    return value;
  });
  const personRef = (name: string) => uniquePersonRef(people, name);
  const remapPersonRef = (value?: string) =>
    value ? (personRefChanges.get(value) ?? value) : undefined;
  return {
    ...candidate,
    _revision: Math.max(1, Math.trunc(candidate._revision ?? 1)),
    _groundingWarnings: (candidate._groundingWarnings ?? []).map((warning) => ({
      ...warning,
      personDraftId: remapPersonRef(warning.personDraftId) ?? warning.personDraftId,
    })),
    people,
    collections: candidate.collections?.map((collection) => ({
      ...collection,
      memberships: collection.memberships.map((member) => ({
        ...member,
        personDraftId: remapPersonRef(member.personDraftId),
      })),
    })),
    facts: (candidate.facts ?? []).map((fact) =>
      withRecordRef("fact", {
        ...fact,
        personDraftId: remapPersonRef(fact.personDraftId) ?? personRef(fact.person),
      }),
    ),
    relations: (candidate.relations ?? []).map((relation) =>
      withRecordRef("relation", {
        ...relation,
        fromDraftId: remapPersonRef(relation.fromDraftId) ?? personRef(relation.from),
        toDraftId: remapPersonRef(relation.toDraftId) ?? personRef(relation.to),
      }),
    ),
    events: (candidate.events ?? []).map((event) =>
      withRecordRef("event", {
        ...event,
        peopleDraftIds: (event.people ?? []).map(
          (name, index) => remapPersonRef(event.peopleDraftIds?.[index]) ?? personRef(name),
        ),
      }),
    ),
    reminders: (candidate.reminders ?? []).map((reminder) =>
      withRecordRef("reminder", {
        ...reminder,
        peopleDraftIds: (reminder.people ?? []).map(
          (name, index) => remapPersonRef(reminder.peopleDraftIds?.[index]) ?? personRef(name),
        ),
      }),
    ),
    evidence: (candidate.evidence ?? []).map((item) => withRecordRef("evidence", item)),
  };
}

function publicPerson(person: IngestPerson) {
  const {
    _draftId,
    _audit,
    _fieldGrounding,
    _identityCandidateIds,
    _identityReason,
    _identityChecked,
    targetPersonId: _targetPersonId,
    ...value
  } = person;
  return { recordRef: _draftId, ...value };
}

function publicRelation(relation: IngestRelation) {
  const {
    _draftId,
    _audit,
    _relationChecked,
    _relationReason,
    targetRelationId: _targetRelationId,
    fromPersonId: _fromPersonId,
    toPersonId: _toPersonId,
    ...value
  } = relation;
  return { recordRef: _draftId, ...value };
}

function publicEvent(event: IngestEvent) {
  const {
    _draftId,
    _audit,
    _eventCandidateIds,
    _eventChecked,
    _eventReason,
    _groundingVerified,
    targetEventId: _targetEventId,
    peoplePersonIds: _peoplePersonIds,
    ...value
  } = event;
  return { recordRef: _draftId, ...value };
}

/** Compact, addressable model view of the current uncommitted workspace. */
export function intakeWorkspaceView(candidate: IngestCandidate) {
  const workspace = ensureIntakeWorkspace(candidate);
  return {
    revision: workspace._revision,
    collections: workspace.collections?.map((collection) => ({
      name: collection.name,
      kind: collection.kind,
      memberships: collection.memberships.map((member) => ({
        person: member.person,
        action: member.action,
      })),
    })),
    people: (workspace.people ?? []).map(publicPerson),
    facts: (workspace.facts ?? []).map(({ _draftId, _audit, personId: _personId, ...value }) => ({
      recordRef: _draftId,
      ...value,
    })),
    relations: (workspace.relations ?? []).map(publicRelation),
    events: (workspace.events ?? []).map(publicEvent),
    reminders: (workspace.reminders ?? []).map(
      ({ _draftId, _audit, peoplePersonIds: _peoplePersonIds, ...value }) => ({
        recordRef: _draftId,
        ...value,
      }),
    ),
    evidence: (workspace.evidence ?? []).map(({ _draftId, _audit, ...value }) => ({
      recordRef: _draftId,
      ...value,
    })),
    summary: workspace.summary,
  };
}
