import type { RelationRecord } from "./face-db";
import { isMutualRelation } from "./relation-kind";
import {
  inferRelationSemantics,
  relationshipProjectionKey,
  type RelationPredicate,
} from "./relation-ontology";

const LEGACY_KIND_TO_PREDICATE: Record<string, RelationPredicate> = {
  parent_child: "parent_of",
  step_parent: "step_parent_of",
  spouse: "spouse_of",
  sibling: "sibling_of",
  half_sibling: "half_sibling_of",
  step_sibling: "step_sibling_of",
  grandparent: "grandparent_of",
  great_grandparent: "great_grandparent_of",
  uncle_nibling: "uncle_aunt_of",
  cousin: "cousin_of",
  in_law: "in_law_of",
  clan: "clan_of",
  work: "colleague_of",
  school: "classmate_of",
  friend: "friend_of",
};

/** Legacy import/manual-label adapter; new records already carry a predicate. */
export function normalizeRelationSemanticKind(label: string): RelationPredicate {
  return inferRelationSemantics(label).predicate;
}

/** A projection key collapses display edges, never independent evidence assertions. */
export function relationSemanticKey(input: {
  fromId: string;
  toId: string;
  label: string;
  mutual?: boolean;
  semanticKind?: string;
  predicate?: RelationPredicate;
  qualifiers?: RelationRecord["qualifiers"];
}) {
  const inferred = inferRelationSemantics(input.label);
  const predicate =
    input.predicate ??
    (input.semanticKind ? LEGACY_KIND_TO_PREDICATE[input.semanticKind] : undefined) ??
    inferred.predicate;
  return relationshipProjectionKey({
    fromId: input.fromId,
    toId: input.toId,
    predicate,
    customMutual: input.mutual,
    customLabel: input.label,
    qualifiers: input.qualifiers ?? inferred.qualifiers,
  });
}

export function relationsEquivalent(a: RelationRecord, b: RelationRecord) {
  return (
    relationSemanticKey(a) === relationSemanticKey(b) && isMutualRelation(a) === isMutualRelation(b)
  );
}
