import { describe, expect, it } from "vitest";

import { findRelationDependencies, normalizeRelationSemanticKind } from "./relation-semantics";

describe("relation semantics", () => {
  it("normalizes title variants without changing the displayed label", () => {
    expect(normalizeRelationSemanticKind("爷爷")).toBe("grandparent");
    expect(normalizeRelationSemanticKind("外婆")).toBe("grandparent");
    expect(normalizeRelationSemanticKind("姻亲（配偶兄弟姐妹）")).toBe("in_law");
    expect(normalizeRelationSemanticKind("堂兄妹")).toBe("cousin");
    expect(normalizeRelationSemanticKind("姑表兄妹")).toBe("cousin");
    expect(normalizeRelationSemanticKind("舅表姐弟")).toBe("cousin");
  });

  it("records the shortest explicit support chain for an inferred edge", () => {
    const relations = [
      {
        id: "r1",
        fromId: "a",
        toId: "b",
        label: "母子",
        createdAt: 1,
        evidenceMode: "explicit" as const,
      },
      {
        id: "r2",
        fromId: "b",
        toId: "c",
        label: "父子",
        createdAt: 1,
        evidenceMode: "explicit" as const,
      },
      {
        id: "r3",
        fromId: "x",
        toId: "y",
        label: "同事",
        createdAt: 1,
        evidenceMode: "explicit" as const,
      },
    ];
    expect(findRelationDependencies("a", "c", relations)).toEqual(["r1", "r2"]);
  });
});
