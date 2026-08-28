import type { PersonRecord, RelationRecord } from "./face-db";

export interface RelationCommunity {
  id: string;
  memberIds: string[];
  internalWeight: number;
}

export interface RelationCommunityOptions {
  /** Larger values favour smaller communities. This is a product control, not a factual claim. */
  resolution?: number;
  maxPasses?: number;
}

export interface RelationCommunityOverviewNode {
  id: string;
  memberIds: string[];
  internalRelationCount: number;
  isolated: boolean;
}

export interface RelationCommunityOverviewEdge {
  id: string;
  fromId: string;
  toId: string;
  relationCount: number;
  explicitCount: number;
  inferredCount: number;
}

function edgeWeight(relation: RelationRecord) {
  if (relation.confirmationStatus === "rejected") return 0;
  const evidence =
    relation.recordType === "derived"
      ? 0.24
      : relation.recordType === "assertion" || relation.evidenceMode === "explicit"
        ? 1
        : 0.58;
  const confirmation = relation.confirmationStatus === "pending" ? 0.55 : 1;
  const confidence = relation.confidence === undefined ? 0.75 : relation.confidence;
  return evidence * confirmation * Math.max(0.1, confidence);
}

function communityId(memberIds: string[]) {
  const text = memberIds.join("\u0000");
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `community:${hash.toString(16).padStart(8, "0")}`;
}

/**
 * Deterministic, one-level Louvain projection used only for graph layout.
 *
 * It never writes a person's circle or creates relationship facts. Explicit
 * user collections remain independent overlays; this disposable projection is
 * rebuilt from the current graph whenever assertions change.
 */
export function detectRelationCommunities(
  persons: Array<Pick<PersonRecord, "id">>,
  relations: RelationRecord[],
  options: RelationCommunityOptions = {},
): RelationCommunity[] {
  const nodeIds = [...new Set(persons.map((person) => person.id))].sort();
  const nodeSet = new Set(nodeIds);
  const adjacency = new Map<string, Map<string, number>>(
    nodeIds.map((id) => [id, new Map<string, number>()]),
  );
  for (const relation of relations) {
    if (
      relation.fromId === relation.toId ||
      !nodeSet.has(relation.fromId) ||
      !nodeSet.has(relation.toId)
    ) {
      continue;
    }
    const weight = edgeWeight(relation);
    if (!weight) continue;
    const from = adjacency.get(relation.fromId)!;
    const to = adjacency.get(relation.toId)!;
    from.set(relation.toId, (from.get(relation.toId) ?? 0) + weight);
    to.set(relation.fromId, (to.get(relation.fromId) ?? 0) + weight);
  }

  const degree = new Map(
    nodeIds.map((id) => [
      id,
      [...(adjacency.get(id)?.values() ?? [])].reduce((sum, value) => sum + value, 0),
    ]),
  );
  const twiceWeight = [...degree.values()].reduce((sum, value) => sum + value, 0);
  const labels = new Map(nodeIds.map((id) => [id, id]));
  const totals = new Map(nodeIds.map((id) => [id, degree.get(id) ?? 0]));
  const resolution = options.resolution ?? 1.08;

  if (twiceWeight > 0) {
    for (let pass = 0; pass < (options.maxPasses ?? 30); pass += 1) {
      let changed = false;
      for (const nodeId of nodeIds) {
        const nodeDegree = degree.get(nodeId) ?? 0;
        if (!nodeDegree) continue;
        const current = labels.get(nodeId)!;
        totals.set(current, (totals.get(current) ?? 0) - nodeDegree);
        const neighbourWeights = new Map<string, number>();
        for (const [neighbourId, weight] of adjacency.get(nodeId) ?? []) {
          const label = labels.get(neighbourId)!;
          neighbourWeights.set(label, (neighbourWeights.get(label) ?? 0) + weight);
        }
        neighbourWeights.set(current, neighbourWeights.get(current) ?? 0);

        let best = current;
        let bestGain = Number.NEGATIVE_INFINITY;
        for (const candidate of [...neighbourWeights.keys()].sort()) {
          const gain =
            (neighbourWeights.get(candidate) ?? 0) -
            (resolution * nodeDegree * (totals.get(candidate) ?? 0)) / twiceWeight;
          if (gain > bestGain + 1e-12 || (Math.abs(gain - bestGain) <= 1e-12 && candidate < best)) {
            best = candidate;
            bestGain = gain;
          }
        }
        labels.set(nodeId, best);
        totals.set(best, (totals.get(best) ?? 0) + nodeDegree);
        if (best !== current) changed = true;
      }
      if (!changed) break;
    }
  }

  const membersByLabel = new Map<string, string[]>();
  for (const nodeId of nodeIds) {
    const label = labels.get(nodeId)!;
    membersByLabel.set(label, [...(membersByLabel.get(label) ?? []), nodeId]);
  }
  return [...membersByLabel.values()]
    .map((memberIds) => {
      memberIds.sort();
      const memberSet = new Set(memberIds);
      let internalWeight = 0;
      for (const memberId of memberIds) {
        for (const [neighbourId, weight] of adjacency.get(memberId) ?? []) {
          if (memberId < neighbourId && memberSet.has(neighbourId)) internalWeight += weight;
        }
      }
      return { id: communityId(memberIds), memberIds, internalWeight };
    })
    .sort(
      (left, right) =>
        right.memberIds.length - left.memberIds.length ||
        left.memberIds.join("\u0000").localeCompare(right.memberIds.join("\u0000")),
    );
}

export function relationCommunityMap(communities: RelationCommunity[]) {
  return new Map(
    communities.flatMap((community) =>
      community.memberIds.map((personId) => [personId, community.id] as const),
    ),
  );
}

/**
 * Lossless overview projection for very large graphs.
 *
 * It aggregates topology communities only for drawing. Every person id and
 * every inter-community relation count remains available for drill-down; the
 * projection is never persisted as a circle or relationship fact. Completely
 * isolated singletons share one visual bucket so 200 unconnected contacts do
 * not become 200 unreadable eight-pixel dots.
 */
export function buildRelationCommunityOverview(
  persons: Array<Pick<PersonRecord, "id">>,
  relations: RelationRecord[],
  communities: RelationCommunity[],
): {
  nodes: RelationCommunityOverviewNode[];
  edges: RelationCommunityOverviewEdge[];
} {
  const personIds = new Set(persons.map((person) => person.id));
  const usableRelations = relations.filter(
    (relation) =>
      relation.confirmationStatus !== "rejected" &&
      personIds.has(relation.fromId) &&
      personIds.has(relation.toId) &&
      relation.fromId !== relation.toId,
  );
  const incidentIds = new Set(
    usableRelations.flatMap((relation) => [relation.fromId, relation.toId]),
  );
  const sourceCommunityByPersonId = relationCommunityMap(communities);
  const isolatedId = "community:isolated";
  const overviewIdByPersonId = new Map<string, string>();
  for (const person of persons) {
    overviewIdByPersonId.set(
      person.id,
      incidentIds.has(person.id)
        ? (sourceCommunityByPersonId.get(person.id) ?? `community:person:${person.id}`)
        : isolatedId,
    );
  }

  const membersById = new Map<string, string[]>();
  for (const person of persons) {
    const id = overviewIdByPersonId.get(person.id)!;
    membersById.set(id, [...(membersById.get(id) ?? []), person.id]);
  }
  const internalCounts = new Map<string, number>();
  const edgeCounts = new Map<
    string,
    {
      fromId: string;
      toId: string;
      relationCount: number;
      explicitCount: number;
      inferredCount: number;
    }
  >();
  for (const relation of usableRelations) {
    const fromId = overviewIdByPersonId.get(relation.fromId)!;
    const toId = overviewIdByPersonId.get(relation.toId)!;
    if (fromId === toId) {
      internalCounts.set(fromId, (internalCounts.get(fromId) ?? 0) + 1);
      continue;
    }
    const [left, right] = [fromId, toId].sort();
    const key = `${left}\u0000${right}`;
    const row = edgeCounts.get(key) ?? {
      fromId: left,
      toId: right,
      relationCount: 0,
      explicitCount: 0,
      inferredCount: 0,
    };
    row.relationCount += 1;
    if (relation.recordType === "derived" || relation.evidenceMode === "inferred") {
      row.inferredCount += 1;
    } else {
      row.explicitCount += 1;
    }
    edgeCounts.set(key, row);
  }

  const nodes = [...membersById.entries()]
    .map(([id, memberIds]) => ({
      id,
      memberIds: memberIds.sort(),
      internalRelationCount: internalCounts.get(id) ?? 0,
      isolated: id === isolatedId,
    }))
    .sort(
      (left, right) =>
        right.memberIds.length - left.memberIds.length || left.id.localeCompare(right.id),
    );
  const edges = [...edgeCounts.entries()]
    .map(([key, row]) => ({ id: `overview-edge:${key}`, ...row }))
    .sort(
      (left, right) => right.relationCount - left.relationCount || left.id.localeCompare(right.id),
    );
  return { nodes, edges };
}
