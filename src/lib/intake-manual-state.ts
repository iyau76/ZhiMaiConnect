import { SENSITIVE_PERSON_FIELDS } from "./intake-grounding";
import type {
  IngestAuditFields,
  IngestCandidate,
  IngestEvent,
  IngestEvidence,
  IngestFact,
  IngestPerson,
  IngestRelation,
  IngestReminder,
} from "./intake-draft";

/** Preserve explicit user edits when a supplemented draft is reorganised by the model. */
export function carryManualState(
  result: IngestCandidate,
  previous: IngestCandidate,
): IngestCandidate {
  const usedPeople = new Set<number>();
  const people = (result.people ?? []).map((person) => {
    const resultNameCount = (result.people ?? []).filter(
      (candidate) => candidate.name.trim() === person.name.trim(),
    ).length;
    const previousNameCount = (previous.people ?? []).filter(
      (candidate) => candidate.name.trim() === person.name.trim(),
    ).length;
    const previousIndex = (previous.people ?? []).findIndex(
      (candidate, candidateIndex) =>
        !usedPeople.has(candidateIndex) &&
        ((person._draftId && candidate._draftId === person._draftId) ||
          (resultNameCount === 1 &&
            previousNameCount === 1 &&
            candidate.name.trim() === person.name.trim())),
    );
    const old = previous.people?.[previousIndex];
    if (!old) return person;
    usedPeople.add(previousIndex);
    const next: IngestPerson = {
      ...person,
      _draftId: old._draftId ?? person._draftId,
      _fieldGrounding: { ...(person._fieldGrounding ?? {}) },
    };
    for (const field of SENSITIVE_PERSON_FIELDS) {
      if (old._fieldGrounding?.[field]?.status !== "manual") continue;
      (next as unknown as Record<string, unknown>)[field] = structuredClone(
        (old as unknown as Record<string, unknown>)[field],
      );
      next._fieldGrounding![field] = { status: "manual" };
    }
    if (old._audit?.humanEdited) {
      next._audit = {
        ...old._audit,
        confirmationStatus: "pending",
        confidence: undefined,
        humanEdited: true,
      };
    }
    return next;
  });
  for (const [index, person] of (previous.people ?? []).entries()) {
    if (usedPeople.has(index) || !person._audit?.humanEdited) continue;
    // Never match people by array position: the model may rename and reorder them
    // in the same response. Keeping an unmatched manual record separate is safer
    // than silently attaching its user-entered fields to another person.
    people.push({
      ...structuredClone(person),
      _audit: {
        ...person._audit,
        confirmationStatus: "pending",
        confidence: undefined,
        humanEdited: true,
      },
    });
  }

  const carryEditedItems = <T extends IngestAuditFields>(
    current: T[] | undefined,
    oldItems: T[] | undefined,
    keyOf: (item: T) => string,
  ) => {
    const next = [...(current ?? [])];
    for (const old of oldItems ?? []) {
      if (!old._audit?.humanEdited) continue;
      const index = next.findIndex((item) => keyOf(item) === keyOf(old));
      const preserved = {
        ...structuredClone(old),
        _audit: {
          ...old._audit,
          confirmationStatus: "pending" as const,
          confidence: undefined,
          humanEdited: true,
        },
      } as T;
      if (index >= 0) next[index] = preserved;
      else next.push(preserved);
    }
    return next;
  };

  return {
    ...result,
    collections: carryEditedItems(
      result.collections,
      previous.collections,
      (item) => item._draftId,
    ),
    people,
    facts: carryEditedItems(result.facts, previous.facts, (item) => {
      const fact = item as IngestFact;
      return `${fact.personDraftId ?? fact.person.trim()}\u0000${fact.key.trim()}`;
    }) as IngestFact[],
    relations: carryEditedItems(result.relations, previous.relations, (item) => {
      const relation = item as IngestRelation;
      return `${relation.fromDraftId ?? relation.from.trim()}\u0000${relation.toDraftId ?? relation.to.trim()}\u0000${relation.label.trim()}`;
    }) as IngestRelation[],
    events: carryEditedItems(result.events, previous.events, (item) =>
      (item as IngestEvent).title.trim(),
    ) as IngestEvent[],
    reminders: carryEditedItems(result.reminders, previous.reminders, (item) =>
      (item as IngestReminder).title.trim(),
    ) as IngestReminder[],
    evidence: carryEditedItems(
      result.evidence,
      previous.evidence,
      (item) =>
        `${(item as IngestEvidence).title?.trim() ?? ""}\u0000${
          (item as IngestEvidence).origin?.trim() ?? ""
        }`,
    ) as IngestEvidence[],
  };
}
