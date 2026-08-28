import { describe, expect, it } from "vitest";

import {
  canonicalRelationKey,
  inferRelationSemantics,
  predicateFromLabel,
  relationCategoryFor,
  relationIsSymmetric,
} from "./relation-ontology";

describe("canonical relation ontology", () => {
  it.each([
    ["父子", "parent_of"],
    ["同父异母兄妹", "half_sibling_of"],
    ["前同事", "colleague_of"],
    ["大学室友", "roommate_of"],
    ["暗恋对象", "has_crush_on"],
    ["我的女神", "admires"],
    ["姑表兄妹", "cousin_of"],
    ["赵姨娘是贾政的妾", "spouse_of"],
    ["嫁给了", "spouse_of"],
    ["大儿子", "parent_of"],
    ["母亲", "parent_of"],
    ["妹妹", "sibling_of"],
  ])("maps %s to %s", (label, predicate) => {
    expect(predicateFromLabel(label)).toBe(predicate);
  });

  it("does not turn a directional crush into a mutual relation just because it contains 对象", () => {
    expect(relationIsSymmetric(predicateFromLabel("暗恋对象"))).toBe(false);
  });

  it("keeps role, branch and time qualifiers outside the display label", () => {
    expect(inferRelationSemantics("前同事")).toEqual(
      expect.objectContaining({
        predicate: "colleague_of",
        qualifiers: expect.objectContaining({ temporalStatus: "former" }),
      }),
    );
    expect(inferRelationSemantics("姑表兄妹").qualifiers.cousinBranch).toBe("paternal_aunt");
    expect(inferRelationSemantics("母女").qualifiers).toEqual(
      expect.objectContaining({ parentRole: "mother", childRole: "daughter" }),
    );
  });

  it("deduplicates symmetric predicates independent of endpoint order", () => {
    expect(canonicalRelationKey({ fromId: "a", toId: "b", predicate: "colleague_of" })).toBe(
      canonicalRelationKey({ fromId: "b", toId: "a", predicate: "colleague_of" }),
    );
    expect(canonicalRelationKey({ fromId: "a", toId: "b", predicate: "parent_of" })).not.toBe(
      canonicalRelationKey({ fromId: "b", toId: "a", predicate: "parent_of" }),
    );
  });

  it("keeps role-bearing qualifiers in the projection identity", () => {
    expect(
      canonicalRelationKey({
        fromId: "a",
        toId: "b",
        predicate: "parent_of",
        qualifiers: { parentRole: "father", childRole: "son" },
      }),
    ).not.toBe(
      canonicalRelationKey({
        fromId: "a",
        toId: "b",
        predicate: "parent_of",
        qualifiers: { parentRole: "mother", childRole: "daughter" },
      }),
    );
    expect(
      canonicalRelationKey({
        fromId: "a",
        toId: "b",
        predicate: "in_law_of",
        qualifiers: { inLawRole: "father_in_law" },
      }),
    ).not.toBe(
      canonicalRelationKey({
        fromId: "a",
        toId: "b",
        predicate: "in_law_of",
        qualifiers: { inLawRole: "sibling_in_law" },
      }),
    );
  });

  it("provides one category source for every consumer", () => {
    expect(relationCategoryFor("parent_of")).toBe("kinship");
    expect(relationCategoryFor("classmate_of")).toBe("school");
    expect(relationCategoryFor("has_crush_on")).toBe("social");
  });
});
