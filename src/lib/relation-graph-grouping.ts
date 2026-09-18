export type RelationGraphGroupingMode = "none" | "circles" | "communities";

export const RELATION_GRAPH_GROUPING_STORAGE_KEY = "openglass.relationGraph.groupBy";
export const DEFAULT_RELATION_GRAPH_GROUPING: RelationGraphGroupingMode = "circles";

type GroupingStorage = Pick<Storage, "getItem" | "setItem">;

/** `tag` was the former two-option control's topology-community value. */
export function migrateRelationGraphGrouping(stored: string | null): RelationGraphGroupingMode {
  if (stored === "none") return "none";
  if (stored === "tag" || stored === "communities") return "communities";
  if (stored === "circles") return "circles";
  return DEFAULT_RELATION_GRAPH_GROUPING;
}

export function loadRelationGraphGrouping(storage: GroupingStorage): RelationGraphGroupingMode {
  const stored = storage.getItem(RELATION_GRAPH_GROUPING_STORAGE_KEY);
  const mode = migrateRelationGraphGrouping(stored);
  if (stored !== null && stored !== mode) {
    storage.setItem(RELATION_GRAPH_GROUPING_STORAGE_KEY, mode);
  }
  return mode;
}

export function saveRelationGraphGrouping(
  storage: GroupingStorage,
  mode: RelationGraphGroupingMode,
) {
  storage.setItem(RELATION_GRAPH_GROUPING_STORAGE_KEY, mode);
}
