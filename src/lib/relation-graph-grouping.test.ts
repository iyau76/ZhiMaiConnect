import { describe, expect, it } from "vitest";

import type { CollectionMembershipRecord, CollectionRecord, PersonRecord } from "./face-db";
import {
  buildCircleLayoutProjection,
  DEFAULT_RELATION_GRAPH_GROUPING,
  loadRelationGraphGrouping,
  RELATION_GRAPH_GROUPING_STORAGE_KEY,
  saveRelationGraphGrouping,
} from "./relation-graph-grouping";

function memoryStorage(initial?: string) {
  const values = new Map<string, string>();
  if (initial !== undefined) values.set(RELATION_GRAPH_GROUPING_STORAGE_KEY, initial);
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    value: () => values.get(RELATION_GRAPH_GROUPING_STORAGE_KEY),
  };
}

describe("relation graph grouping preference", () => {
  it("defaults new users to circle layout", () => {
    const storage = memoryStorage();
    expect(loadRelationGraphGrouping(storage)).toBe(DEFAULT_RELATION_GRAPH_GROUPING);
    expect(DEFAULT_RELATION_GRAPH_GROUPING).toBe("circles");
  });

  it.each([
    ["tag", "communities"],
    ["none", "none"],
  ] as const)("migrates the former %s option deterministically", (legacy, expected) => {
    const storage = memoryStorage(legacy);
    expect(loadRelationGraphGrouping(storage)).toBe(expected);
    expect(storage.value()).toBe(expected);
  });

  it("persists exactly one selected mode when switching", () => {
    const storage = memoryStorage();
    for (const mode of ["none", "circles", "communities"] as const) {
      saveRelationGraphGrouping(storage, mode);
      expect(loadRelationGraphGrouping(storage)).toBe(mode);
      expect(storage.value()).toBe(mode);
    }
  });
});

describe("circle layout input", () => {
  const collections = [
    {
      id: "work",
      name: "项目组",
      kind: "context",
      createdAt: 2,
      updatedAt: 2,
    },
    {
      id: "family",
      name: "家人",
      kind: "relationship_circle",
      createdAt: 1,
      updatedAt: 1,
    },
    {
      id: "computed",
      name: "算法社区",
      kind: "computed_community",
      createdAt: 3,
      updatedAt: 3,
    },
  ] satisfies CollectionRecord[];

  const memberships = [
    {
      id: "work-alice",
      collectionId: "work",
      personId: "alice",
      source: "manual",
      createdAt: 2,
    },
    {
      id: "family-alice",
      collectionId: "family",
      personId: "alice",
      source: "ai_approved",
      createdAt: 1,
    },
    {
      id: "family-bob",
      collectionId: "family",
      personId: "bob",
      source: "migration",
      createdAt: 1,
    },
    {
      id: "computed-bob",
      collectionId: "computed",
      personId: "bob",
      source: "computed",
      createdAt: 3,
    },
  ] satisfies CollectionMembershipRecord[];

  it("uses confirmed relationship-circle memberships but not context collections", () => {
    const projection = buildCircleLayoutProjection(
      [{ id: "alice" }, { id: "bob" }],
      [...collections].reverse(),
      [...memberships].reverse(),
    );

    expect(projection.groupByPersonId.get("alice")).toMatchObject({
      label: "家人",
      collectionIds: ["family"],
    });
    expect(projection.groupByPersonId.get("bob")).toMatchObject({
      label: "家人",
      collectionIds: ["family"],
    });
  });

  it("does not infer circles from free text, profile tags, or computed membership", () => {
    const persons = [
      {
        id: "alice",
        name: "Alice",
        note: "大学同学、同事、家人",
        rawProfileText: "她属于摄影圈",
        profile: { tags: ["朋友"] },
        descriptors: [],
        thumb: "",
        createdAt: 1,
      },
      {
        id: "bob",
        name: "Bob",
        note: "项目组",
        descriptors: [],
        thumb: "",
        createdAt: 1,
      },
    ] satisfies PersonRecord[];
    const projection = buildCircleLayoutProjection(persons, collections, [memberships[3]]);

    expect(projection.groups).toHaveLength(1);
    expect(projection.groups[0]).toMatchObject({
      key: "circles:none",
      label: "未分圈层",
      memberIds: ["alice", "bob"],
      collectionIds: [],
    });
  });
});
