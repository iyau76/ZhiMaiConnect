import { describe, expect, it } from "vitest";

import {
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
