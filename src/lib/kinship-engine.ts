import type { IngestCandidate, IngestRelation } from "./intake-draft";
import { normalizeRelationSemanticKind } from "./relation-semantics";

interface NamedEdge extends IngestRelation {
  supportKey: string;
}

function name(value: string) {
  return value.trim();
}

function isExplicit(relation: IngestRelation) {
  return /^(原文|original)\s*[:：]/i.test(relation.basis?.trim() ?? "");
}

function relationKey(relation: Pick<IngestRelation, "from" | "to" | "label">) {
  const kind = normalizeRelationSemanticKind(relation.label);
  const mutual = ["sibling", "half_sibling", "step_sibling", "spouse", "cousin", "clan"].includes(
    kind,
  );
  const endpoints = mutual
    ? [name(relation.from), name(relation.to)].sort().join("\u0000")
    : `${name(relation.from)}\u0000${name(relation.to)}`;
  return `${endpoints}\u0000${kind}`;
}

function inferred(from: string, to: string, label: string, basis: string): IngestRelation {
  return {
    from,
    to,
    label,
    note: "本地亲属规则推导，需核验",
    basis: `推断依据：${basis}`,
    confidence: 0.7,
  };
}

function genderOfLabel(label: string, endpoint: "from" | "to") {
  if (endpoint === "from") {
    if (/(父子|父女|爸爸|父亲|father)/i.test(label)) return "male";
    if (/(母子|母女|妈妈|母亲|mother)/i.test(label)) return "female";
  } else {
    if (/(父子|母子|儿子|son)/i.test(label)) return "male";
    if (/(父女|母女|女儿|daughter)/i.test(label)) return "female";
  }
  return undefined;
}

/**
 * Deterministic closure over explicit kinship edges. It intentionally derives
 * only short, auditable patterns and leaves every generated edge pending review.
 */
export function deriveKinshipRelations(
  draft: IngestCandidate,
  supportingRelations: IngestRelation[] = [],
) {
  const source = [...supportingRelations, ...(draft.relations ?? [])];
  const explicit: NamedEdge[] = source
    .filter(isExplicit)
    .map((relation) => ({ ...relation, supportKey: relationKey(relation) }));
  const existing = new Set(source.map(relationKey));
  const additions: IngestRelation[] = [];
  const genders = new Map<string, "male" | "female">();
  for (const person of draft.people ?? []) {
    if (/^(男|male)$/i.test(person.gender?.trim() ?? "")) genders.set(name(person.name), "male");
    if (/^(女|female)$/i.test(person.gender?.trim() ?? ""))
      genders.set(name(person.name), "female");
  }
  for (const relation of explicit) {
    const fromGender = genderOfLabel(relation.label, "from");
    const toGender = genderOfLabel(relation.label, "to");
    if (fromGender) genders.set(name(relation.from), fromGender);
    if (toGender) genders.set(name(relation.to), toGender);
  }

  const add = (relation: IngestRelation) => {
    if (!name(relation.from) || !name(relation.to) || name(relation.from) === name(relation.to))
      return;
    const key = relationKey(relation);
    if (existing.has(key)) return;
    existing.add(key);
    additions.push(relation);
  };

  const parents = explicit.filter(
    (relation) => normalizeRelationSemanticKind(relation.label) === "parent_child",
  );
  const siblings = explicit.filter((relation) =>
    ["sibling", "half_sibling"].includes(normalizeRelationSemanticKind(relation.label)),
  );
  const spouses = explicit.filter(
    (relation) => normalizeRelationSemanticKind(relation.label) === "spouse",
  );

  const parentsByChild = new Map<string, NamedEdge[]>();
  for (const parent of parents) {
    parentsByChild.set(name(parent.to), [...(parentsByChild.get(name(parent.to)) ?? []), parent]);
  }

  // Shared explicit parent -> sibling. Distinguish half-siblings only when both other parents are known.
  for (let left = 0; left < parents.length; left += 1) {
    for (let right = left + 1; right < parents.length; right += 1) {
      const a = parents[left];
      const b = parents[right];
      if (name(a.from) !== name(b.from) || name(a.to) === name(b.to)) continue;
      const otherParentsA = (parentsByChild.get(name(a.to)) ?? []).filter(
        (edge) => name(edge.from) !== name(a.from),
      );
      const otherParentsB = (parentsByChild.get(name(b.to)) ?? []).filter(
        (edge) => name(edge.from) !== name(a.from),
      );
      const knownDifferentOtherParents =
        otherParentsA.length > 0 &&
        otherParentsB.length > 0 &&
        !otherParentsA.some((leftParent) =>
          otherParentsB.some((rightParent) => name(leftParent.from) === name(rightParent.from)),
        );
      const sharedParentGender = genders.get(name(a.from));
      const label = knownDifferentOtherParents
        ? sharedParentGender === "male"
          ? "同父异母兄弟姐妹"
          : sharedParentGender === "female"
            ? "同母异父兄弟姐妹"
            : "半血缘兄弟姐妹"
        : "兄弟姐妹";
      add(
        inferred(
          a.to,
          b.to,
          label,
          `${a.to}与${b.to}同为${a.from}的子女${knownDifferentOtherParents ? "，且材料明确给出不同的另一位父母" : ""}；未依据材料猜测长幼`,
        ),
      );
    }
  }
  const siblingSupports: NamedEdge[] = [
    ...siblings,
    ...additions
      .filter((relation) =>
        ["sibling", "half_sibling"].includes(normalizeRelationSemanticKind(relation.label)),
      )
      .map((relation) => ({ ...relation, supportKey: relationKey(relation) })),
  ];

  // Step-parent plus that step-parent's explicit child -> step-siblings without blood relation.
  const stepParents = explicit.filter(
    (relation) => normalizeRelationSemanticKind(relation.label) === "step_parent",
  );
  for (const step of stepParents) {
    for (const child of parents.filter((relation) => name(relation.from) === name(step.from))) {
      if (name(child.to) === name(step.to)) continue;
      add(
        inferred(
          step.to,
          child.to,
          "继兄弟姐妹（无血缘）",
          `${step.from}是${step.to}的继父母，同时是${child.to}的父母`,
        ),
      );
    }
  }

  // Parent chain of two or three edges -> grandparent / great-grandparent.
  for (const first of parents) {
    for (const second of parents) {
      if (name(first.to) !== name(second.from)) continue;
      const middleGender = genders.get(name(first.to));
      add(
        inferred(
          first.from,
          second.to,
          middleGender === "female" ? "外祖孙" : "祖孙",
          `${first.from}是${first.to}的父母，${first.to}是${second.to}的父母`,
        ),
      );
      for (const third of parents) {
        if (name(second.to) !== name(third.from)) continue;
        add(
          inferred(
            first.from,
            third.to,
            "曾祖孙",
            `${first.from}→${first.to}→${second.to}→${third.to}为连续三代明确父母子女关系`,
          ),
        );
      }
    }
  }

  // A parent's explicit sibling -> uncle/aunt relation to the child.
  for (const parent of parents) {
    for (const sibling of siblingSupports) {
      const parentName = name(parent.from);
      const siblingName =
        name(sibling.from) === parentName
          ? name(sibling.to)
          : name(sibling.to) === parentName
            ? name(sibling.from)
            : "";
      if (!siblingName) continue;
      const parentGender = genders.get(parentName);
      const siblingGender = genders.get(siblingName);
      const label =
        parentGender === "female"
          ? siblingGender === "male"
            ? "舅甥"
            : siblingGender === "female"
              ? "姨甥"
              : "母系旁亲"
          : siblingGender === "female"
            ? "姑侄"
            : siblingGender === "male"
              ? "叔伯侄"
              : "父系旁亲";
      add(
        inferred(
          siblingName,
          parent.to,
          label,
          `${siblingName}与${parentName}是兄弟姐妹，${parentName}是${parent.to}的父母`,
        ),
      );
    }
  }

  // Children of explicit/auditable sibling parents -> cousin branch without guessing seniority.
  for (const sibling of siblingSupports) {
    const leftParent = name(sibling.from);
    const rightParent = name(sibling.to);
    for (const leftChild of parents.filter((relation) => name(relation.from) === leftParent)) {
      for (const rightChild of parents.filter((relation) => name(relation.from) === rightParent)) {
        const leftGender = genders.get(leftParent);
        const rightGender = genders.get(rightParent);
        const label =
          leftGender === "male" && rightGender === "male"
            ? "堂亲"
            : leftGender === "female" && rightGender === "female"
              ? "姨表亲"
              : "姑舅表亲";
        add(
          inferred(
            leftChild.to,
            rightChild.to,
            label,
            `${leftParent}与${rightParent}是兄弟姐妹，分别是${leftChild.to}与${rightChild.to}的父母；未猜测表亲长幼`,
          ),
        );
      }
    }
  }

  // Spouse's explicit parent or sibling -> in-law, never a blood relation.
  for (const spouse of spouses) {
    for (const person of [name(spouse.from), name(spouse.to)]) {
      const partner = person === name(spouse.from) ? name(spouse.to) : name(spouse.from);
      for (const parent of parents.filter((relation) => name(relation.to) === person)) {
        const parentGender = genders.get(name(parent.from));
        const partnerGender = genders.get(partner);
        const label =
          partnerGender === "female" ? (parentGender === "female" ? "婆媳" : "翁媳") : "岳婿";
        add(
          inferred(
            parent.from,
            partner,
            label,
            `${parent.from}是${person}的父母，${person}与${partner}是配偶；该关系为姻亲`,
          ),
        );
      }
      for (const sibling of siblingSupports) {
        const siblingName =
          name(sibling.from) === person
            ? name(sibling.to)
            : name(sibling.to) === person
              ? name(sibling.from)
              : "";
        if (siblingName) {
          add(
            inferred(
              partner,
              siblingName,
              "姻亲（配偶兄弟姐妹）",
              `${person}与${partner}是配偶，${person}与${siblingName}是兄弟姐妹；不得标成血亲`,
            ),
          );
        }
      }
    }
  }

  return { ...draft, relations: [...(draft.relations ?? []), ...additions] };
}
