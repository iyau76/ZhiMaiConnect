/**
 * Canonical relationship vocabulary.
 *
 * User-facing labels are deliberately kept outside the ontology: a label may be
 * “大学同学”, “前同事” or “妾”, while graph direction, deduplication and rules
 * must depend on a stable predicate instead of substring checks scattered across
 * the application.
 */

export const RELATION_PREDICATES = [
  "parent_of",
  "step_parent_of",
  "spouse_of",
  "sibling_of",
  "half_sibling_of",
  "step_sibling_of",
  "grandparent_of",
  "great_grandparent_of",
  "uncle_aunt_of",
  "cousin_of",
  "in_law_of",
  "clan_of",
  "colleague_of",
  "classmate_of",
  "roommate_of",
  "friend_of",
  "knows",
  "reports_to",
  "manages",
  "has_crush_on",
  "admires",
  "collaborates_with",
  "custom",
] as const;

export type RelationPredicate = (typeof RELATION_PREDICATES)[number];
export type RelationCategory = "kinship" | "work" | "school" | "social" | "other";

export interface RelationQualifiers {
  parentRole?: "father" | "mother" | "parent";
  childRole?: "son" | "daughter" | "child";
  sharedParentRole?: "father" | "mother" | "parent";
  cousinBranch?:
    "paternal_uncle" | "paternal_aunt" | "maternal_uncle" | "maternal_aunt" | "unspecified";
  /** Cousin branch when traversing the symmetric relation in reverse. */
  inverseCousinBranch?:
    "paternal_uncle" | "paternal_aunt" | "maternal_uncle" | "maternal_aunt" | "unspecified";
  inLawRole?: "father_in_law" | "mother_in_law" | "sibling_in_law" | "unspecified";
  partnerRole?: "husband" | "wife" | "concubine" | "partner";
  lineage?: "blood" | "step" | "clan" | "marriage" | "unknown";
  temporalStatus?: "current" | "former" | "unknown";
  validFrom?: string;
  validTo?: string;
}

export interface InferredRelationSemantics {
  predicate: RelationPredicate;
  qualifiers: RelationQualifiers;
}

export interface RelationPredicateDefinition {
  predicate: RelationPredicate;
  category: RelationCategory;
  symmetric: boolean;
  defaultLabel: string;
}

const DEFINITIONS: Record<RelationPredicate, RelationPredicateDefinition> = {
  parent_of: {
    predicate: "parent_of",
    category: "kinship",
    symmetric: false,
    defaultLabel: "父母子女",
  },
  step_parent_of: {
    predicate: "step_parent_of",
    category: "kinship",
    symmetric: false,
    defaultLabel: "继父母子女",
  },
  spouse_of: { predicate: "spouse_of", category: "kinship", symmetric: true, defaultLabel: "配偶" },
  sibling_of: {
    predicate: "sibling_of",
    category: "kinship",
    symmetric: true,
    defaultLabel: "兄弟姐妹",
  },
  half_sibling_of: {
    predicate: "half_sibling_of",
    category: "kinship",
    symmetric: true,
    defaultLabel: "半血缘兄弟姐妹",
  },
  step_sibling_of: {
    predicate: "step_sibling_of",
    category: "kinship",
    symmetric: true,
    defaultLabel: "继兄弟姐妹",
  },
  grandparent_of: {
    predicate: "grandparent_of",
    category: "kinship",
    symmetric: false,
    defaultLabel: "祖孙",
  },
  great_grandparent_of: {
    predicate: "great_grandparent_of",
    category: "kinship",
    symmetric: false,
    defaultLabel: "曾祖孙",
  },
  uncle_aunt_of: {
    predicate: "uncle_aunt_of",
    category: "kinship",
    symmetric: false,
    defaultLabel: "叔姑舅姨与侄甥",
  },
  cousin_of: {
    predicate: "cousin_of",
    category: "kinship",
    symmetric: true,
    defaultLabel: "堂表亲",
  },
  in_law_of: {
    predicate: "in_law_of",
    category: "kinship",
    symmetric: false,
    defaultLabel: "姻亲",
  },
  clan_of: { predicate: "clan_of", category: "kinship", symmetric: true, defaultLabel: "宗亲" },
  colleague_of: {
    predicate: "colleague_of",
    category: "work",
    symmetric: true,
    defaultLabel: "同事",
  },
  classmate_of: {
    predicate: "classmate_of",
    category: "school",
    symmetric: true,
    defaultLabel: "同学",
  },
  roommate_of: {
    predicate: "roommate_of",
    category: "school",
    symmetric: true,
    defaultLabel: "室友",
  },
  friend_of: { predicate: "friend_of", category: "social", symmetric: true, defaultLabel: "朋友" },
  knows: { predicate: "knows", category: "social", symmetric: true, defaultLabel: "认识" },
  reports_to: {
    predicate: "reports_to",
    category: "work",
    symmetric: false,
    defaultLabel: "汇报给",
  },
  manages: { predicate: "manages", category: "work", symmetric: false, defaultLabel: "管理" },
  has_crush_on: {
    predicate: "has_crush_on",
    category: "social",
    symmetric: false,
    defaultLabel: "暗恋",
  },
  admires: { predicate: "admires", category: "social", symmetric: false, defaultLabel: "仰慕" },
  collaborates_with: {
    predicate: "collaborates_with",
    category: "work",
    symmetric: true,
    defaultLabel: "合作",
  },
  custom: { predicate: "custom", category: "other", symmetric: false, defaultLabel: "关系" },
};

function compact(label: string) {
  return label
    .trim()
    .toLocaleLowerCase("zh-CN")
    .replace(/[\s·_/、，,（）()\-—]+/g, "");
}

export function isRelationPredicate(value: unknown): value is RelationPredicate {
  return typeof value === "string" && (RELATION_PREDICATES as readonly string[]).includes(value);
}

/** The single compatibility boundary for legacy records that have no predicate. */
export function predicateFromLabel(label: string): RelationPredicate {
  return inferRelationSemantics(label).predicate;
}

/**
 * Legacy/import boundary only. New writes must provide a predicate and explicit
 * qualifiers; consumers must not repeatedly guess semantics from display text.
 */
export function inferRelationSemantics(label: string): InferredRelationSemantics {
  const value = compact(label);
  if (!value) return { predicate: "custom", qualifiers: {} };

  const temporalStatus = /(^|[^目])前(同事|同学|室友|朋友|妻|夫)|former|ex/i.test(value)
    ? "former"
    : "current";

  const result = (
    predicate: RelationPredicate,
    qualifiers: RelationQualifiers = {},
  ): InferredRelationSemantics => ({ predicate, qualifiers: { temporalStatus, ...qualifiers } });

  // Directional feelings must win over the generic word “对象”.
  if (/(暗恋|单恋|crush)/i.test(value)) return result("has_crush_on");
  if (/(女神|男神|仰慕|崇拜|admire)/i.test(value)) return result("admires");
  if (/(曾祖|曾孙|greatgrand)/i.test(value))
    return result("great_grandparent_of", { lineage: "blood" });
  if (/(外祖|祖孙|祖父|祖母|爷爷|奶奶|外公|外婆|grandparent)/i.test(value))
    return result("grandparent_of", { lineage: "blood" });
  if (
    /(?:继父|继母)(?:的)?(?:儿子|女儿|孩子)|step(?:father|mother)(?:'s)?(?:son|daughter|child)/i.test(
      value,
    )
  )
    return result("step_sibling_of", { lineage: "step" });
  if (/(继兄|继弟|继姐|继妹|stepsibling)/i.test(value))
    return result("step_sibling_of", { lineage: "step" });
  if (/(继父|继母|stepfather|stepmother|stepparent)/i.test(value))
    return result("step_parent_of", { lineage: "step" });
  if (/(同父异母|同母异父|半血缘|halfsibling)/i.test(value))
    return result("half_sibling_of", {
      lineage: "blood",
      sharedParentRole: /同父异母/.test(value)
        ? "father"
        : /同母异父/.test(value)
          ? "mother"
          : "parent",
    });
  if (/(翁媳|婆媳|岳婿|岳父|岳母|公公|婆婆|叔嫂|姑嫂|姻亲|inlaw)/i.test(value))
    return result("in_law_of", {
      lineage: "marriage",
      inLawRole: /(岳父|公公|翁媳)/.test(value)
        ? "father_in_law"
        : /(岳母|婆婆|婆媳)/.test(value)
          ? "mother_in_law"
          : /(叔嫂|姑嫂)/.test(value)
            ? "sibling_in_law"
            : "unspecified",
    });
  if (/(夫妻|配偶|丈夫|妻子|爱人|正妻|妾|嫁给|娶了|成婚|结婚|spouse|husband|wife)/i.test(value))
    return result("spouse_of", {
      lineage: "marriage",
      partnerRole: /妾/.test(value)
        ? "concubine"
        : /(妻|wife)/i.test(value)
          ? "wife"
          : /(丈夫|husband)/i.test(value)
            ? "husband"
            : "partner",
    });
  if (
    /(父子|父女|母子|母女|父母|父亲|母亲|爸爸|妈妈|亲生父|亲生母|儿子|女儿|孩子|子女|长子|次子|长女|次女|parent|father|mother|son|daughter|child)/i.test(
      value,
    )
  )
    return result("parent_of", {
      lineage: "blood",
      parentRole: /(母|妈妈|mother)/i.test(value)
        ? "mother"
        : /(父|爸爸|father)/i.test(value)
          ? "father"
          : "parent",
      childRole: /(女|daughter)/i.test(value)
        ? "daughter"
        : /(子|儿|son)/i.test(value)
          ? "son"
          : "child",
    });
  if (/(堂|姑表|舅表|姨表|表亲|cousin)/i.test(value))
    return result("cousin_of", {
      lineage: "blood",
      cousinBranch: /堂/.test(value)
        ? "paternal_uncle"
        : /姑表/.test(value)
          ? "paternal_aunt"
          : /舅表/.test(value)
            ? "maternal_uncle"
            : /姨表/.test(value)
              ? "maternal_aunt"
              : "unspecified",
    });
  if (/(兄弟|兄妹|姐弟|姐妹|哥哥|弟弟|姐姐|妹妹|同胞|sibling|brother|sister)/i.test(value))
    return result("sibling_of", { lineage: "blood" });
  if (
    /(叔侄|伯侄|姑侄|舅甥|姨甥|叔伯侄|叔父|叔叔|伯父|伯伯|姑母|姑妈|舅父|舅舅|姨母|姨妈|内侄|uncle|aunt|nephew|niece)/i.test(
      value,
    )
  )
    return result("uncle_aunt_of", { lineage: "blood" });
  if (/(同宗|宗亲|族亲|族兄|族弟|clan)/i.test(value)) return result("clan_of", { lineage: "clan" });
  if (/(汇报|直属上级|reports?to)/i.test(value)) return result("reports_to");
  if (/(管理|领导|下属|上司|主管|manager|supervisor)/i.test(value)) return result("manages");
  if (/(室友|roommate)/i.test(value)) return result("roommate_of");
  if (/(同学|校友|同班|classmate|schoolmate|alumni)/i.test(value)) return result("classmate_of");
  if (/(前同事|同事|同僚|colleague|coworker)/i.test(value)) return result("colleague_of");
  if (/(合作|搭档|合伙|collaborat|partner)/i.test(value)) return result("collaborates_with");
  if (/(朋友|好友|闺蜜|发小|friend)/i.test(value)) return result("friend_of");
  if (/(熟人|认识|acquaintance|knows)/i.test(value)) return result("knows");
  return result("custom");
}

/**
 * Resolve one durable semantic record at the compatibility/write boundary.
 * Explicit predicate/qualifier fields remain authoritative, while role details
 * omitted by older records are recovered from a matching display label once.
 */
export function resolveRelationSemantics(input: {
  label: string;
  predicate?: RelationPredicate;
  qualifiers?: RelationQualifiers;
}): InferredRelationSemantics {
  const inferred = inferRelationSemantics(input.label);
  const predicate = input.predicate ?? inferred.predicate;
  return {
    predicate,
    qualifiers: {
      ...(predicate === inferred.predicate ? inferred.qualifiers : {}),
      ...input.qualifiers,
    },
  };
}

function genderRole(value: string | undefined) {
  const normalized = value?.trim().toLocaleLowerCase("zh-CN") ?? "";
  if (/^(?:女|女性|女生|woman|female|girl)$/.test(normalized)) return "female" as const;
  if (/^(?:男|男性|男生|man|male|boy)$/.test(normalized)) return "male" as const;
  return undefined;
}

/**
 * Compile a source relation against already extracted entity facts. Display
 * wording never gets to overrule an explicit endpoint gender: this keeps the
 * durable parent/child roles stable even when a model varies “母子/母女”.
 */
export function resolveRelationSemanticsForPeople(input: {
  label: string;
  predicate?: RelationPredicate;
  qualifiers?: RelationQualifiers;
  fromGender?: string;
  toGender?: string;
}): InferredRelationSemantics {
  const semantics = resolveRelationSemantics(input);
  if (semantics.predicate === "spouse_of") {
    return {
      ...semantics,
      qualifiers: {
        ...semantics.qualifiers,
        // “丈夫/妻子” often names the opposite endpoint, so it cannot be a
        // direction-free relationship identity. Gender lives on the people;
        // only concubinage remains a relationship-level distinction here.
        partnerRole: semantics.qualifiers.partnerRole === "concubine" ? "concubine" : "partner",
      },
    };
  }
  if (semantics.predicate !== "parent_of" && semantics.predicate !== "step_parent_of") {
    return semantics;
  }
  const parentGender = genderRole(input.fromGender);
  const childGender = genderRole(input.toGender);
  return {
    ...semantics,
    qualifiers: {
      ...semantics.qualifiers,
      ...(parentGender
        ? { parentRole: parentGender === "female" ? ("mother" as const) : ("father" as const) }
        : {}),
      ...(childGender
        ? { childRole: childGender === "female" ? ("daughter" as const) : ("son" as const) }
        : {}),
    },
  };
}

export function relationDefinition(predicate: RelationPredicate) {
  return DEFINITIONS[predicate];
}

export function relationIsSymmetric(predicate: RelationPredicate, customMutual = false) {
  return predicate === "custom" ? customMutual : DEFINITIONS[predicate].symmetric;
}

export function relationCategoryFor(predicate: RelationPredicate) {
  return DEFINITIONS[predicate].category;
}

/**
 * Key for a collapsed graph projection, never an assertion identity. Multiple
 * assertions/evidence items may intentionally project to the same current edge.
 */
export function relationshipProjectionKey(input: {
  fromId: string;
  toId: string;
  predicate: RelationPredicate;
  customMutual?: boolean;
  customLabel?: string;
  qualifiers?: RelationQualifiers;
}) {
  const endpoints = relationIsSymmetric(input.predicate, input.customMutual)
    ? [input.fromId, input.toId].sort().join("\u0000")
    : `${input.fromId}\u0000${input.toId}`;
  const qualifierKey = [
    input.qualifiers?.parentRole,
    input.qualifiers?.childRole,
    input.qualifiers?.sharedParentRole,
    input.qualifiers?.cousinBranch,
    input.qualifiers?.inverseCousinBranch,
    input.qualifiers?.inLawRole,
    input.qualifiers?.partnerRole,
    input.qualifiers?.lineage,
    input.qualifiers?.temporalStatus,
    input.qualifiers?.validFrom,
    input.qualifiers?.validTo,
  ]
    .filter(Boolean)
    .join("|");
  const customLabel = input.predicate === "custom" ? compact(input.customLabel ?? "") : "";
  return `${endpoints}\u0000${input.predicate}\u0000${customLabel}\u0000${qualifierKey}`;
}

/** @deprecated Use relationshipProjectionKey; assertions are identified by id. */
export const canonicalRelationKey = relationshipProjectionKey;
