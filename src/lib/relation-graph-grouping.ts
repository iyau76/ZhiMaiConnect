import type { CollectionMembershipRecord, CollectionRecord, PersonRecord } from "./face-db";

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

export interface CircleLayoutGroup {
  key: string;
  label: string;
  memberIds: string[];
  collectionIds: string[];
}

export interface CircleLayoutProjection {
  groups: CircleLayoutGroup[];
  groupByPersonId: Map<string, CircleLayoutGroup>;
}

function compareCollections(left: CollectionRecord, right: CollectionRecord) {
  const leftRank = left.kind === "relationship_circle" ? 0 : 1;
  const rightRank = right.kind === "relationship_circle" ? 0 : 1;
  if (leftRank !== rightRank) return leftRank - rightRank;
  if (left.name !== right.name) return left.name < right.name ? -1 : 1;
  return left.id < right.id ? -1 : left.id === right.id ? 0 : 1;
}

/**
 * Builds spatial groups only from durable, user-confirmed collection membership.
 * A person in several circles gets a stable composite group, so no membership is
 * silently discarded merely because a graph node can occupy only one position.
 */
export function buildCircleLayoutProjection(
  persons: Array<Pick<PersonRecord, "id">>,
  collections: CollectionRecord[],
  memberships: CollectionMembershipRecord[],
  unassignedLabel = "未分圈层",
): CircleLayoutProjection {
  const personIds = new Set(persons.map((person) => person.id));
  const collectionById = new Map(
    collections
      .filter((collection) => collection.kind === "relationship_circle")
      .map((collection) => [collection.id, collection] as const),
  );
  const collectionsByPersonId = new Map<string, CollectionRecord[]>();

  for (const membership of memberships) {
    if (membership.source === "computed" || !personIds.has(membership.personId)) continue;
    const collection = collectionById.get(membership.collectionId);
    if (!collection) continue;
    const current = collectionsByPersonId.get(membership.personId) ?? [];
    if (!current.some((item) => item.id === collection.id)) current.push(collection);
    collectionsByPersonId.set(membership.personId, current);
  }

  const groupsByKey = new Map<string, CircleLayoutGroup>();
  const groupByPersonId = new Map<string, CircleLayoutGroup>();
  for (const person of persons) {
    const personCollections = [...(collectionsByPersonId.get(person.id) ?? [])].sort(
      compareCollections,
    );
    const collectionIds = personCollections.map((collection) => collection.id);
    const key = collectionIds.length ? `circles:${collectionIds.join("\u0000")}` : "circles:none";
    let group = groupsByKey.get(key);
    if (!group) {
      group = {
        key,
        label: personCollections.length
          ? [...new Set(personCollections.map((collection) => collection.name))].join(" / ")
          : unassignedLabel,
        memberIds: [],
        collectionIds,
      };
      groupsByKey.set(key, group);
    }
    group.memberIds.push(person.id);
    groupByPersonId.set(person.id, group);
  }

  return {
    groups: [...groupsByKey.values()],
    groupByPersonId,
  };
}
