import { describe, expect, it } from "vitest";

import type { RelationRecord } from "./face-db";
import {
  computeRelationImportance,
  relationCategory,
  relationEvidenceMode,
  selectVisibleRelations,
} from "./relation-graph";

const NOW = new Date("2026-08-28T00:00:00Z");

function relation(id: string, fromId: string, toId: string, patch: Partial<RelationRecord> = {}) {
  return {
    id,
    fromId,
    toId,
    label: "认识",
    createdAt: new Date("2026-08-20T00:00:00Z").getTime(),
    confirmationStatus: "confirmed",
    ...patch,
  } satisfies RelationRecord;
}

describe("relationship evidence and category", () => {
  it("conservatively recognizes explicit and inferred bases", () => {
    expect(relationEvidenceMode(relation("a", "1", "2", { basis: "原文：两人是同事" }))).toBe(
      "explicit",
    );
    expect(relationEvidenceMode(relation("b", "1", "2", { basis: "推断依据：同为甲之子" }))).toBe(
      "inferred",
    );
    expect(relationEvidenceMode(relation("c", "1", "2"))).toBe("unknown");
  });

  it("keeps in-law relations separate from blood-family relations", () => {
    expect(relationCategory(relation("a", "1", "2", { label: "婆媳" }))).toBe("in_law");
    expect(relationCategory(relation("b", "1", "2", { label: "母子" }))).toBe("family");
  });

  it("treats missing confidence as neutral rather than zero", () => {
    const result = computeRelationImportance(relation("a", "1", "2"), [], NOW);
    expect(result.components.confidence).toBeGreaterThan(0);
  });
});

describe("relationship graph visibility", () => {
  it("honours per-edge always and hidden policies", () => {
    const always = relation("always", "a", "b", { visibility: "always", confidence: 0 });
    const hidden = relation("hidden", "b", "c", { visibility: "hidden", confidence: 1 });
    const result = selectVisibleRelations({
      relations: [always, hidden],
      mode: "overview",
      now: NOW,
      overviewMinScore: 1,
    });
    expect(result.visible.map((item) => item.id)).toEqual(["always"]);
    expect(result.hidden).toContainEqual({ relation: hidden, reason: "user-hidden" });
  });

  it("shows user-hidden edges in the explicit all-relations view", () => {
    const hidden = relation("hidden", "a", "b", { visibility: "hidden" });
    expect(selectVisibleRelations({ relations: [hidden], mode: "all", now: NOW }).visible).toEqual([
      hidden,
    ]);
  });

  it("does not let a high-score hidden parallel edge suppress a visible edge", () => {
    const hidden = relation("hidden-high", "a", "b", {
      visibility: "hidden",
      confidence: 1,
    });
    const visible = relation("visible-low", "a", "b", {
      visibility: "auto",
      confidence: 0.2,
    });
    const result = selectVisibleRelations({
      relations: [hidden, visible],
      mode: "overview",
      overviewMinScore: 0,
      now: NOW,
    });
    expect(result.visible).toContain(visible);
    expect(result.hidden).toContainEqual({ relation: hidden, reason: "user-hidden" });
  });

  it("preserves a low-salience bridge in overview", () => {
    const left = relation("left", "a", "b", { confidence: 0, createdAt: 1 });
    const bridge = relation("bridge", "b", "c", { confidence: 0, createdAt: 1 });
    const right = relation("right", "c", "d", { confidence: 0, createdAt: 1 });
    const result = selectVisibleRelations({
      relations: [left, bridge, right],
      mode: "overview",
      now: NOW,
      overviewMinScore: 1,
    });
    expect(result.visible.map((item) => item.id)).toEqual(["left", "bridge", "right"]);
  });

  it("folds an inferred edge when an explicit two-hop basis is already visible", () => {
    const parentA = relation("parent-a", "parent", "a", { evidenceMode: "explicit" });
    const parentB = relation("parent-b", "parent", "b", { evidenceMode: "explicit" });
    const sibling = relation("sibling", "a", "b", {
      evidenceMode: "inferred",
      basis: "推断依据：同为 parent 之子",
      confidence: 0.7,
    });
    const result = selectVisibleRelations({
      relations: [parentA, parentB, sibling],
      mode: "overview",
      now: NOW,
      overviewMinScore: 0,
    });
    expect(result.visible.map((item) => item.id)).toEqual(["parent-a", "parent-b"]);
    expect(result.hidden).toContainEqual({ relation: sibling, reason: "derived-redundant" });
  });

  it("limits focus-one to edges whose endpoints are in the one-hop context", () => {
    const first = relation("first", "a", "b");
    const second = relation("second", "b", "c");
    const result = selectVisibleRelations({
      relations: [first, second],
      mode: "focus1",
      selectedId: "a",
      now: NOW,
    });
    expect(result.visible).toEqual([first]);
    expect([...result.focusNodeIds]).toEqual(["a", "b"]);
  });
});
