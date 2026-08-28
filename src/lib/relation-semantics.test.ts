import { describe, expect, it } from "vitest";

import { normalizeRelationSemanticKind, relationsEquivalent } from "./relation-semantics";

describe("relation semantics", () => {
  it("normalizes title variants without changing the displayed label", () => {
    expect(normalizeRelationSemanticKind("爷爷")).toBe("grandparent_of");
    expect(normalizeRelationSemanticKind("外婆")).toBe("grandparent_of");
    expect(normalizeRelationSemanticKind("姻亲（配偶兄弟姐妹）")).toBe("in_law_of");
    expect(normalizeRelationSemanticKind("堂兄妹")).toBe("cousin_of");
    expect(normalizeRelationSemanticKind("姑表兄妹")).toBe("cousin_of");
    expect(normalizeRelationSemanticKind("舅表姐弟")).toBe("cousin_of");
  });

  it("keeps different user-defined relations between the same people independent", () => {
    const base = { id: "a", fromId: "p1", toId: "p2", createdAt: 1 };
    expect(
      relationsEquivalent(
        { ...base, label: "摄影导师" },
        { ...base, id: "b", label: "早期投资人" },
      ),
    ).toBe(false);
  });
});
