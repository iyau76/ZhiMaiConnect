import { describe, expect, it } from "vitest";

import type { PersonRecord, RelationRecord } from "./face-db";
import { buildRelationCommunityOverview, detectRelationCommunities } from "./relation-community";

const people = (ids: string[]) => ids.map((id) => ({ id }) as Pick<PersonRecord, "id">);
const edge = (id: string, fromId: string, toId: string, patch: Partial<RelationRecord> = {}) =>
  ({
    id,
    fromId,
    toId,
    label: "认识",
    recordType: "assertion",
    confirmationStatus: "confirmed",
    confidence: 1,
    createdAt: 1,
    ...patch,
  }) satisfies RelationRecord;

describe("detectRelationCommunities", () => {
  it("separates two dense groups connected by one weak bridge", () => {
    const relations = [
      edge("ab", "a", "b"),
      edge("ac", "a", "c"),
      edge("bc", "b", "c"),
      edge("de", "d", "e"),
      edge("df", "d", "f"),
      edge("ef", "e", "f"),
      edge("bridge", "c", "d", { recordType: "derived", confidence: 0.5 }),
    ];
    const result = detectRelationCommunities(people(["a", "b", "c", "d", "e", "f"]), relations);
    expect(result.map((community) => community.memberIds)).toEqual([
      ["a", "b", "c"],
      ["d", "e", "f"],
    ]);
  });

  it("is invariant to input order and keeps isolated people", () => {
    const persons = people(["isolated", "a", "b", "c"]);
    const relations = [edge("ab", "a", "b"), edge("bc", "b", "c")];
    const first = detectRelationCommunities(persons, relations);
    const second = detectRelationCommunities([...persons].reverse(), [...relations].reverse());
    expect(second).toEqual(first);
    expect(first.some((community) => community.memberIds.includes("isolated"))).toBe(true);
  });

  it("does not let many low-confidence derived edges override strong facts", () => {
    const relations = [
      edge("ab", "a", "b"),
      edge("cd", "c", "d"),
      edge("ac", "a", "c", { recordType: "derived", confidence: 0.1 }),
      edge("ad", "a", "d", { recordType: "derived", confidence: 0.1 }),
      edge("bc", "b", "c", { recordType: "derived", confidence: 0.1 }),
      edge("bd", "b", "d", { recordType: "derived", confidence: 0.1 }),
    ];
    expect(
      detectRelationCommunities(people(["a", "b", "c", "d"]), relations).map(
        (community) => community.memberIds,
      ),
    ).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });
});

describe("buildRelationCommunityOverview", () => {
  it("collapses isolated people while preserving every member and aggregate edge count", () => {
    const persons = people(["a", "b", "c", "d", "lonely-1", "lonely-2"]);
    const relations = [
      edge("ab", "a", "b"),
      edge("cd", "c", "d"),
      edge("bridge-1", "b", "c"),
      edge("bridge-2", "a", "d", { recordType: "derived", evidenceMode: "inferred" }),
    ];
    const communities = [
      { id: "left", memberIds: ["a", "b"], internalWeight: 1 },
      { id: "right", memberIds: ["c", "d"], internalWeight: 1 },
      { id: "single-1", memberIds: ["lonely-1"], internalWeight: 0 },
      { id: "single-2", memberIds: ["lonely-2"], internalWeight: 0 },
    ];

    const overview = buildRelationCommunityOverview(persons, relations, communities);
    expect(overview.nodes).toHaveLength(3);
    expect(overview.nodes.find((node) => node.isolated)?.memberIds).toEqual([
      "lonely-1",
      "lonely-2",
    ]);
    expect(overview.nodes.flatMap((node) => node.memberIds).sort()).toEqual(
      persons.map((person) => person.id).sort(),
    );
    expect(overview.edges).toMatchObject([
      { relationCount: 2, explicitCount: 1, inferredCount: 1 },
    ]);
  });

  it("ignores rejected and out-of-scope edges", () => {
    const persons = people(["a", "b", "c"]);
    const relations = [
      edge("ab", "a", "b"),
      edge("rejected", "b", "c", { confirmationStatus: "rejected" }),
      edge("outside", "a", "missing"),
    ];
    const communities = [
      { id: "connected", memberIds: ["a", "b"], internalWeight: 1 },
      { id: "c", memberIds: ["c"], internalWeight: 0 },
    ];
    const overview = buildRelationCommunityOverview(persons, relations, communities);
    expect(overview.edges).toEqual([]);
    expect(overview.nodes.find((node) => node.id === "connected")?.internalRelationCount).toBe(1);
    expect(overview.nodes.find((node) => node.isolated)?.memberIds).toEqual(["c"]);
  });
});
