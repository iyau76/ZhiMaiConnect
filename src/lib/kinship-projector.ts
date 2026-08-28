import {
  resolveRelationSemantics,
  relationshipProjectionKey,
  type RelationPredicate,
  type RelationQualifiers,
} from "./relation-ontology";

export const KINSHIP_PROJECTOR_VERSION = 2;

export interface RelationshipAssertionInput {
  id: string;
  fromId: string;
  toId: string;
  label: string;
  predicate?: RelationPredicate;
  qualifiers?: RelationQualifiers;
  mutual?: boolean;
  basis?: string;
  confidence?: number;
  confirmationStatus?: "pending" | "confirmed" | "rejected";
  /** Legacy migration fields. They are read only at this boundary. */
  evidenceMode?: "explicit" | "inferred" | "unknown";
  derivedFromRelationIds?: string[];
}

export interface RelationshipPersonInput {
  id: string;
  name: string;
  profile?: { gender?: string };
}

export interface DerivedRelationshipRecord {
  id: string;
  recordType: "derived";
  fromId: string;
  toId: string;
  predicate: RelationPredicate;
  qualifiers: RelationQualifiers;
  label: string;
  confidence: number;
  ruleId: string;
  ruleVersion: number;
  supportingRelationIds: string[];
  explanation: string;
}

export interface KinshipProjection {
  relations: DerivedRelationshipRecord[];
  diagnostics: {
    ignoredRejected: number;
    ignoredPending: number;
    ignoredLegacyDerived: number;
    duplicateProjectionCount: number;
  };
}

interface CanonicalAssertion extends RelationshipAssertionInput {
  predicate: RelationPredicate;
  qualifiers: RelationQualifiers;
}

type Gender = "male" | "female" | "unknown";

function gender(value?: string): Gender {
  if (/^(男|男性|male|m)$/i.test(value?.trim() ?? "")) return "male";
  if (/^(女|女性|female|f)$/i.test(value?.trim() ?? "")) return "female";
  return "unknown";
}

function uniqueSorted(values: Iterable<string>) {
  return [...new Set(values)].sort();
}

function stableHash(value: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function isLegacyDerived(relation: RelationshipAssertionInput) {
  return (
    relation.evidenceMode === "inferred" ||
    Boolean(relation.derivedFromRelationIds?.length) ||
    /^推断依据\s*[:：]|^inference\s+basis\s*[:：]/i.test(relation.basis?.trim() ?? "")
  );
}

function canonicalize(relation: RelationshipAssertionInput): CanonicalAssertion {
  const semantics = resolveRelationSemantics(relation);
  return {
    ...relation,
    predicate: semantics.predicate,
    qualifiers: semantics.qualifiers,
  };
}

function supportConfidence(assertionsById: Map<string, CanonicalAssertion>, ids: string[]) {
  const values = ids
    .map((id) => assertionsById.get(id)?.confidence)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return values.length ? Math.min(...values) : 0.9;
}

/**
 * Build a disposable kinship projection from assertion facts.
 *
 * Generated relations are never fed back as rule inputs. Every result therefore
 * has an exact proof set of assertion ids, and rebuilding from the same set is
 * deterministic regardless of insertion/model-output order.
 */
export function projectKinshipRelations(options: {
  assertions: RelationshipAssertionInput[];
  persons?: RelationshipPersonInput[];
}): KinshipProjection {
  const diagnostics = {
    ignoredRejected: 0,
    ignoredPending: 0,
    ignoredLegacyDerived: 0,
    duplicateProjectionCount: 0,
  };
  const assertions = options.assertions
    .filter((relation) => {
      if (relation.confirmationStatus === "rejected") {
        diagnostics.ignoredRejected += 1;
        return false;
      }
      if (relation.confirmationStatus === "pending") {
        diagnostics.ignoredPending += 1;
        return false;
      }
      if (isLegacyDerived(relation)) {
        diagnostics.ignoredLegacyDerived += 1;
        return false;
      }
      return relation.fromId !== relation.toId;
    })
    .map(canonicalize)
    .sort((left, right) => left.id.localeCompare(right.id));
  const assertionsById = new Map(assertions.map((relation) => [relation.id, relation]));
  const personById = new Map((options.persons ?? []).map((person) => [person.id, person]));
  const genderById = new Map(
    (options.persons ?? []).map((person) => [person.id, gender(person.profile?.gender)]),
  );
  const assertionProjectionKeys = new Set(
    assertions.map((relation) =>
      relationshipProjectionKey({
        fromId: relation.fromId,
        toId: relation.toId,
        predicate: relation.predicate,
        customMutual: relation.mutual,
        customLabel: relation.label,
        qualifiers: relation.qualifiers,
      }),
    ),
  );
  const projected = new Map<string, DerivedRelationshipRecord>();

  const personName = (id: string) => personById.get(id)?.name ?? id;
  const add = (input: {
    fromId: string;
    toId: string;
    predicate: RelationPredicate;
    qualifiers?: RelationQualifiers;
    label: string;
    ruleId: string;
    supportingRelationIds: string[];
    explanation: string;
    confidenceFactor?: number;
  }) => {
    if (!input.fromId || !input.toId || input.fromId === input.toId) return;
    const qualifiers = input.qualifiers ?? {};
    const key = relationshipProjectionKey({
      fromId: input.fromId,
      toId: input.toId,
      predicate: input.predicate,
      customLabel: input.label,
      qualifiers,
    });
    if (assertionProjectionKeys.has(key)) return;
    const supportingRelationIds = uniqueSorted(input.supportingRelationIds);
    const existing = projected.get(key);
    if (existing) {
      diagnostics.duplicateProjectionCount += 1;
      // Pick the shortest proof, then the lexical proof, so input order cannot win.
      const nextProof = supportingRelationIds.join("\u0000");
      const oldProof = existing.supportingRelationIds.join("\u0000");
      if (
        supportingRelationIds.length > existing.supportingRelationIds.length ||
        (supportingRelationIds.length === existing.supportingRelationIds.length &&
          nextProof >= oldProof)
      )
        return;
    }
    const confidence = Math.max(
      0,
      Math.min(
        0.85,
        supportConfidence(assertionsById, supportingRelationIds) * (input.confidenceFactor ?? 0.78),
      ),
    );
    projected.set(key, {
      id: `derived-${stableHash(`${input.ruleId}\u0000${key}\u0000${supportingRelationIds.join("\u0000")}`)}`,
      recordType: "derived",
      fromId: input.fromId,
      toId: input.toId,
      predicate: input.predicate,
      qualifiers,
      label: input.label,
      confidence: Number(confidence.toFixed(4)),
      ruleId: input.ruleId,
      ruleVersion: KINSHIP_PROJECTOR_VERSION,
      supportingRelationIds,
      explanation: input.explanation,
    });
  };

  const parents = assertions.filter((relation) => relation.predicate === "parent_of");
  const stepParents = assertions.filter((relation) => relation.predicate === "step_parent_of");
  const spouses = assertions.filter((relation) => relation.predicate === "spouse_of");
  const explicitSiblings = assertions.filter((relation) =>
    ["sibling_of", "half_sibling_of"].includes(relation.predicate),
  );
  const parentsByChild = new Map<string, CanonicalAssertion[]>();
  const childrenByParent = new Map<string, CanonicalAssertion[]>();
  for (const edge of parents) {
    parentsByChild.set(edge.toId, [...(parentsByChild.get(edge.toId) ?? []), edge]);
    childrenByParent.set(edge.fromId, [...(childrenByParent.get(edge.fromId) ?? []), edge]);
    const role = edge.qualifiers.parentRole;
    if (role === "father" && genderById.get(edge.fromId) === "unknown")
      genderById.set(edge.fromId, "male");
    if (role === "mother" && genderById.get(edge.fromId) === "unknown")
      genderById.set(edge.fromId, "female");
    const childRole = edge.qualifiers.childRole;
    if (childRole === "son" && genderById.get(edge.toId) === "unknown")
      genderById.set(edge.toId, "male");
    if (childRole === "daughter" && genderById.get(edge.toId) === "unknown")
      genderById.set(edge.toId, "female");
  }

  // Shared explicit parents -> one current sibling projection per child pair.
  const childIds = [...parentsByChild.keys()].sort();
  for (let leftIndex = 0; leftIndex < childIds.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < childIds.length; rightIndex += 1) {
      const leftId = childIds[leftIndex];
      const rightId = childIds[rightIndex];
      const leftParents = parentsByChild.get(leftId) ?? [];
      const rightParents = parentsByChild.get(rightId) ?? [];
      const rightParentIds = new Set(rightParents.map((edge) => edge.fromId));
      const shared = leftParents.filter((edge) => rightParentIds.has(edge.fromId));
      if (!shared.length) continue;
      const leftSet = new Set(leftParents.map((edge) => edge.fromId));
      const rightSet = new Set(rightParents.map((edge) => edge.fromId));
      const knownDifferentOtherParents =
        leftSet.size >= 2 &&
        rightSet.size >= 2 &&
        [...leftSet].some((id) => !rightSet.has(id)) &&
        [...rightSet].some((id) => !leftSet.has(id));
      const sharedParentId = shared[0].fromId;
      const sharedRole =
        genderById.get(sharedParentId) === "male"
          ? "father"
          : genderById.get(sharedParentId) === "female"
            ? "mother"
            : "parent";
      const predicate: RelationPredicate = knownDifferentOtherParents
        ? "half_sibling_of"
        : "sibling_of";
      const support = [
        ...shared,
        ...rightParents.filter((edge) => edge.fromId === sharedParentId),
        ...(knownDifferentOtherParents ? leftParents : []),
        ...(knownDifferentOtherParents ? rightParents : []),
      ].map((edge) => edge.id);
      const label = knownDifferentOtherParents
        ? sharedRole === "father"
          ? "同父异母兄弟姐妹"
          : sharedRole === "mother"
            ? "同母异父兄弟姐妹"
            : "半血缘兄弟姐妹"
        : "兄弟姐妹";
      add({
        fromId: leftId,
        toId: rightId,
        predicate,
        qualifiers: { lineage: "blood", sharedParentRole: sharedRole },
        label,
        ruleId: "kinship.shared-parent.sibling",
        supportingRelationIds: support,
        explanation: `${personName(leftId)}与${personName(rightId)}有材料明确记录的共同父母${knownDifferentOtherParents ? "，且双方另有不同父母" : ""}`,
      });
    }
  }

  // Two/three explicit parent edges -> grand/great-grandparent.
  for (const first of parents) {
    for (const second of childrenByParent.get(first.toId) ?? []) {
      const middleGender = genderById.get(first.toId) ?? "unknown";
      add({
        fromId: first.fromId,
        toId: second.toId,
        predicate: "grandparent_of",
        qualifiers: { lineage: "blood" },
        label: middleGender === "female" ? "外祖孙" : "祖孙",
        ruleId: "kinship.parent-chain.grandparent",
        supportingRelationIds: [first.id, second.id],
        explanation: `${personName(first.fromId)}是${personName(first.toId)}的父母，${personName(first.toId)}是${personName(second.toId)}的父母`,
      });
      for (const third of childrenByParent.get(second.toId) ?? []) {
        add({
          fromId: first.fromId,
          toId: third.toId,
          predicate: "great_grandparent_of",
          qualifiers: { lineage: "blood" },
          label: "曾祖孙",
          ruleId: "kinship.parent-chain.great-grandparent",
          supportingRelationIds: [first.id, second.id, third.id],
          explanation: `${personName(first.fromId)}到${personName(third.toId)}有三条连续且明确的父母子女事实`,
          confidenceFactor: 0.72,
        });
      }
    }
  }

  const siblingProofs: Array<{
    leftId: string;
    rightId: string;
    supportIds: string[];
  }> = explicitSiblings.map((edge) => ({
    leftId: edge.fromId,
    rightId: edge.toId,
    supportIds: [edge.id],
  }));
  // Add direct shared-parent proof patterns, not previously generated edges.
  for (const parentId of [...childrenByParent.keys()].sort()) {
    const children = (childrenByParent.get(parentId) ?? []).sort((a, b) =>
      a.toId.localeCompare(b.toId),
    );
    for (let left = 0; left < children.length; left += 1) {
      for (let right = left + 1; right < children.length; right += 1) {
        if (children[left].toId === children[right].toId) continue;
        siblingProofs.push({
          leftId: children[left].toId,
          rightId: children[right].toId,
          supportIds: [children[left].id, children[right].id],
        });
      }
    }
  }

  // Parent + explicit/direct sibling proof -> uncle/aunt; no derived edge is read.
  for (const parent of parents) {
    for (const sibling of siblingProofs) {
      const relativeId =
        sibling.leftId === parent.fromId
          ? sibling.rightId
          : sibling.rightId === parent.fromId
            ? sibling.leftId
            : undefined;
      if (!relativeId) continue;
      const parentGender = genderById.get(parent.fromId) ?? "unknown";
      const relativeGender = genderById.get(relativeId) ?? "unknown";
      const label =
        parentGender === "female"
          ? relativeGender === "male"
            ? "舅甥"
            : relativeGender === "female"
              ? "姨甥"
              : "母系旁亲"
          : relativeGender === "female"
            ? "姑侄"
            : relativeGender === "male"
              ? "叔伯侄"
              : "父系旁亲";
      add({
        fromId: relativeId,
        toId: parent.toId,
        predicate: "uncle_aunt_of",
        qualifiers: { lineage: "blood" },
        label,
        ruleId: "kinship.parent-sibling.uncle-aunt",
        supportingRelationIds: [parent.id, ...sibling.supportIds],
        explanation: `${personName(relativeId)}与${personName(parent.fromId)}有明确兄弟姐妹依据，后者是${personName(parent.toId)}的父母`,
      });
    }
  }

  // Sibling parents' explicitly recorded children -> cousins.
  for (const sibling of siblingProofs) {
    const leftChildren = childrenByParent.get(sibling.leftId) ?? [];
    const rightChildren = childrenByParent.get(sibling.rightId) ?? [];
    for (const leftChild of leftChildren) {
      for (const rightChild of rightChildren) {
        const leftGender = genderById.get(sibling.leftId) ?? "unknown";
        const rightGender = genderById.get(sibling.rightId) ?? "unknown";
        const branches =
          leftGender === "male" && rightGender === "male"
            ? (["paternal_uncle", "paternal_uncle", "堂亲"] as const)
            : leftGender === "male" && rightGender === "female"
              ? (["paternal_aunt", "maternal_uncle", "姑表亲"] as const)
              : leftGender === "female" && rightGender === "male"
                ? (["maternal_uncle", "paternal_aunt", "舅表亲"] as const)
                : leftGender === "female" && rightGender === "female"
                  ? (["maternal_aunt", "maternal_aunt", "姨表亲"] as const)
                  : (["unspecified", "unspecified", "表亲"] as const);
        add({
          fromId: leftChild.toId,
          toId: rightChild.toId,
          predicate: "cousin_of",
          qualifiers: {
            lineage: "blood",
            cousinBranch: branches[0],
            inverseCousinBranch: branches[1],
          },
          label: branches[2],
          ruleId: "kinship.sibling-parents.cousin",
          supportingRelationIds: [leftChild.id, rightChild.id, ...sibling.supportIds],
          explanation: `${personName(sibling.leftId)}与${personName(sibling.rightId)}有明确兄弟姐妹依据，分别是两位当事人的父母`,
          confidenceFactor: 0.72,
        });
      }
    }
  }

  // Step-parent + that person's explicit child -> step-siblings.
  for (const step of stepParents) {
    for (const child of childrenByParent.get(step.fromId) ?? []) {
      if (child.toId === step.toId) continue;
      add({
        fromId: step.toId,
        toId: child.toId,
        predicate: "step_sibling_of",
        qualifiers: { lineage: "step" },
        label: "继兄弟姐妹（无血缘）",
        ruleId: "kinship.step-parent.step-sibling",
        supportingRelationIds: [step.id, child.id],
        explanation: `${personName(step.fromId)}是${personName(step.toId)}的继父母，同时是${personName(child.toId)}的父母`,
      });
    }
  }

  // Spouse plus explicit parent/sibling proof -> marriage lineage only.
  for (const spouse of spouses) {
    for (const [personId, partnerId] of [
      [spouse.fromId, spouse.toId],
      [spouse.toId, spouse.fromId],
    ] as const) {
      for (const parent of parentsByChild.get(personId) ?? []) {
        const parentGender = genderById.get(parent.fromId) ?? "unknown";
        add({
          fromId: parent.fromId,
          toId: partnerId,
          predicate: "in_law_of",
          qualifiers: {
            lineage: "marriage",
            inLawRole:
              parentGender === "male"
                ? "father_in_law"
                : parentGender === "female"
                  ? "mother_in_law"
                  : "unspecified",
          },
          label:
            parentGender === "male"
              ? "姻亲（配偶之父）"
              : parentGender === "female"
                ? "姻亲（配偶之母）"
                : "姻亲（配偶父母）",
          ruleId: "kinship.spouse-parent.in-law",
          supportingRelationIds: [spouse.id, parent.id],
          explanation: `${personName(parent.fromId)}是${personName(personId)}的父母，${personName(personId)}与${personName(partnerId)}是配偶`,
        });
      }
      for (const sibling of siblingProofs) {
        const siblingId =
          sibling.leftId === personId
            ? sibling.rightId
            : sibling.rightId === personId
              ? sibling.leftId
              : undefined;
        if (!siblingId) continue;
        add({
          fromId: partnerId,
          toId: siblingId,
          predicate: "in_law_of",
          qualifiers: { lineage: "marriage", inLawRole: "sibling_in_law" },
          label: "姻亲（配偶兄弟姐妹）",
          ruleId: "kinship.spouse-sibling.in-law",
          supportingRelationIds: [spouse.id, ...sibling.supportIds],
          explanation: `${personName(personId)}与${personName(partnerId)}是配偶，${personName(personId)}与${personName(siblingId)}有明确兄弟姐妹依据`,
        });
      }
    }
  }

  return {
    relations: [...projected.values()].sort((left, right) => left.id.localeCompare(right.id)),
    diagnostics,
  };
}
