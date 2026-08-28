import type { LifeEventRecord, RelationRecord } from "./face-db";
import { inferRelationSemantics, relationCategoryFor } from "./relation-ontology";

export type GraphViewMode = "overview" | "standard" | "all";
export type RelationCategory = "family" | "in_law" | "work" | "school" | "friend" | "other";

export interface RelationImportance {
  score: number;
  category: RelationCategory;
  evidenceMode: NonNullable<RelationRecord["evidenceMode"]>;
  components: {
    confirmation: number;
    evidence: number;
    confidence: number;
    freshness: number;
    sharedEvents: number;
    provenance: number;
  };
}

export interface RelationVisibilityResult {
  visible: RelationRecord[];
  hidden: Array<{
    relation: RelationRecord;
    reason:
      | "user-hidden"
      | "rejected"
      | "outside-focus"
      | "derived-redundant"
      | "low-salience"
      | "overview-redundant"
      | "parallel";
  }>;
  focusNodeIds: Set<string>;
  importance: Map<string, RelationImportance>;
}

export interface RelationVisibilityOptions {
  relations: RelationRecord[];
  events?: LifeEventRecord[];
  mode: GraphViewMode;
  selectedId?: string | null;
  /** Selection changes emphasis only; it never removes graph data. */
  focusDepth?: 1 | 2;
  now?: Date;
  /** 产品校准参数集中在这里，不能伪装成论文给出的固定阈值。 */
  overviewMinScore?: number;
}

const INFERRED_BASIS = /^推断依据\s*[:：]|^inference\s+basis\s*[:：]/i;
const EXPLICIT_BASIS = /^原文\s*[:：]|^original\s*[:：]/i;

export function relationEvidenceMode(
  relation: RelationRecord,
): NonNullable<RelationRecord["evidenceMode"]> {
  if (relation.recordType === "derived") return "inferred";
  if (relation.recordType === "assertion") return "explicit";
  if (relation.evidenceMode) return relation.evidenceMode;
  const basis = relation.basis?.trim() ?? "";
  if (INFERRED_BASIS.test(basis)) return "inferred";
  if (EXPLICIT_BASIS.test(basis)) return "explicit";
  return "unknown";
}

export function relationCategory(
  relation: Pick<RelationRecord, "label" | "semanticKind" | "predicate">,
) {
  const predicate = relation.predicate ?? inferRelationSemantics(relation.label).predicate;
  if (predicate === "in_law_of" || predicate === "spouse_of") return "in_law" as const;
  const category = relationCategoryFor(predicate);
  if (category === "kinship") return "family" as const;
  if (category === "work") return "work" as const;
  if (category === "school") return "school" as const;
  if (category === "social") return "friend" as const;
  return "other" as const;
}

function dateAgeDays(date: string, now: Date) {
  const at = new Date(`${date}T00:00:00`).getTime();
  if (!Number.isFinite(at)) return null;
  return Math.max(0, Math.floor((now.getTime() - at) / 86_400_000));
}

function sharedEventScore(relation: RelationRecord, events: LifeEventRecord[], now: Date) {
  const shared = events.filter(
    (event) =>
      event.personIds?.includes(relation.fromId) && event.personIds.includes(relation.toId),
  );
  if (!shared.length) return 0;
  const mostRecent = Math.min(
    ...shared.map((event) => dateAgeDays(event.date, now) ?? Number.POSITIVE_INFINITY),
  );
  const recency = mostRecent <= 30 ? 1 : mostRecent <= 180 ? 0.72 : mostRecent <= 365 ? 0.45 : 0.2;
  const frequency = Math.min(1, shared.length / 4);
  return Math.min(0.2, 0.13 * recency + 0.07 * frequency);
}

export function computeRelationImportance(
  relation: RelationRecord,
  events: LifeEventRecord[] = [],
  now = new Date(),
): RelationImportance {
  const evidenceMode = relationEvidenceMode(relation);
  const confirmation =
    relation.confirmationStatus === "rejected"
      ? 0
      : relation.confirmationStatus === "pending"
        ? 0.04
        : 0.22;
  const evidence = evidenceMode === "explicit" ? 0.22 : evidenceMode === "inferred" ? 0.08 : 0.14;
  // 缺失置信度取中性值，而不是按 0 分处理。
  const confidence =
    0.15 *
    (relation.confidence === undefined ? 0.5 : Math.min(1, Math.max(0, relation.confidence)));
  const ageDays = Math.max(
    0,
    Math.floor((now.getTime() - (relation.updatedAt ?? relation.createdAt)) / 86_400_000),
  );
  const freshness =
    0.14 * (ageDays <= 30 ? 1 : ageDays <= 180 ? 0.72 : ageDays <= 365 ? 0.45 : 0.2);
  const sharedEvents = sharedEventScore(relation, events, now);
  const provenance =
    relation.source?.kind === "manual" ? 0.07 : relation.source?.kind === "ai" ? 0.035 : 0.05;
  const components = { confirmation, evidence, confidence, freshness, sharedEvents, provenance };
  return {
    score: Math.min(
      1,
      Object.values(components).reduce((sum, value) => sum + value, 0),
    ),
    category: relationCategory(relation),
    evidenceMode,
    components,
  };
}

function pairKey(a: string, b: string) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function adjacency(relations: RelationRecord[]) {
  const result = new Map<string, Set<string>>();
  for (const relation of relations) {
    if (relation.confirmationStatus === "rejected") continue;
    if (!result.has(relation.fromId)) result.set(relation.fromId, new Set());
    if (!result.has(relation.toId)) result.set(relation.toId, new Set());
    result.get(relation.fromId)!.add(relation.toId);
    result.get(relation.toId)!.add(relation.fromId);
  }
  return result;
}

function nodesWithin(relations: RelationRecord[], selectedId: string, maxHops: number) {
  const graph = adjacency(relations);
  const distance = new Map<string, number>([[selectedId, 0]]);
  const queue = [selectedId];
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    const depth = distance.get(current) ?? 0;
    if (depth >= maxHops) continue;
    for (const next of graph.get(current) ?? []) {
      if (distance.has(next)) continue;
      distance.set(next, depth + 1);
      queue.push(next);
    }
  }
  return new Set(distance.keys());
}

/** 找到无向简单图中的桥；多条平行关系会被视为同一条结构连接。 */
function bridgePairs(relations: RelationRecord[]) {
  const graph = adjacency(relations);
  const discovered = new Map<string, number>();
  const low = new Map<string, number>();
  const bridges = new Set<string>();
  let clock = 0;

  const visit = (node: string, parent: string | null) => {
    clock += 1;
    discovered.set(node, clock);
    low.set(node, clock);
    for (const next of graph.get(node) ?? []) {
      if (next === parent) continue;
      if (!discovered.has(next)) {
        visit(next, node);
        low.set(node, Math.min(low.get(node)!, low.get(next)!));
        if (low.get(next)! > discovered.get(node)!) bridges.add(pairKey(node, next));
      } else {
        low.set(node, Math.min(low.get(node)!, discovered.get(next)!));
      }
    }
  };
  for (const node of graph.keys()) if (!discovered.has(node)) visit(node, null);
  return bridges;
}

function hasVisibleSupports(relation: RelationRecord, relationsById: Map<string, RelationRecord>) {
  const supportIds = relation.supportingRelationIds ?? relation.derivedFromRelationIds ?? [];
  return (
    supportIds.length > 0 &&
    supportIds.every((id) => {
      const support = relationsById.get(id);
      return (
        support &&
        support.confirmationStatus !== "rejected" &&
        support.visibility !== "hidden" &&
        relationEvidenceMode(support) !== "inferred"
      );
    })
  );
}

function semanticBundleKey(relation: RelationRecord) {
  const predicate = relation.predicate ?? inferRelationSemantics(relation.label).predicate;
  const qualifiers = relation.qualifiers ? JSON.stringify(relation.qualifiers) : "";
  const customLabel = predicate === "custom" ? relation.label.trim().toLocaleLowerCase() : "";
  return `${pairKey(relation.fromId, relation.toId)}|${predicate}|${customLabel}|${qualifiers}`;
}

function relationImportanceOrder(
  importance: Map<string, RelationImportance>,
  left: RelationRecord,
  right: RelationRecord,
) {
  return (
    (importance.get(right.id)?.score ?? 0) - (importance.get(left.id)?.score ?? 0) ||
    (right.updatedAt ?? right.createdAt) - (left.updatedAt ?? left.createdAt) ||
    left.id.localeCompare(right.id)
  );
}

/**
 * A maximum-weight spanning forest preserves a readable route through every
 * connected component. This is the structural backbone of overview mode; a
 * fixed score threshold alone cannot keep dense, uniformly fresh graphs legible.
 */
function maximumWeightForest(
  relations: RelationRecord[],
  importance: Map<string, RelationImportance>,
) {
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    const current = parent.get(id) ?? id;
    if (!parent.has(id)) parent.set(id, id);
    if (current === id) return id;
    const root = find(current);
    parent.set(id, root);
    return root;
  };
  const selected = new Set<string>();
  for (const relation of [...relations].sort((left, right) =>
    relationImportanceOrder(importance, left, right),
  )) {
    const fromRoot = find(relation.fromId);
    const toRoot = find(relation.toId);
    if (fromRoot === toRoot) continue;
    parent.set(fromRoot, toRoot);
    selected.add(relation.id);
  }
  return selected;
}

function overviewEdgeBudget(relations: RelationRecord[], backboneSize: number) {
  const nodeCount = new Set(relations.flatMap((relation) => [relation.fromId, relation.toId])).size;
  // One spanning edge per node keeps paths legible; the extra 30% leaves room
  // for strong non-tree ties without allowing a dense graph to fill the frame.
  return Math.max(backboneSize, Math.ceil(nodeCount * 1.3));
}

export function selectVisibleRelations(
  options: RelationVisibilityOptions,
): RelationVisibilityResult {
  const now = options.now ?? new Date();
  const threshold = options.overviewMinScore ?? 0.52;
  const importance = new Map(
    options.relations.map((relation) => [
      relation.id,
      computeRelationImportance(relation, options.events ?? [], now),
    ]),
  );
  const focusNodeIds = options.selectedId
    ? nodesWithin(options.relations, options.selectedId, options.focusDepth ?? 1)
    : new Set(options.relations.flatMap((relation) => [relation.fromId, relation.toId]));
  const bridges = bridgePairs(
    options.relations.filter((relation) => relation.visibility !== "hidden"),
  );
  const relationsById = new Map(options.relations.map((relation) => [relation.id, relation]));
  const bestParallel = new Map<string, string>();
  for (const relation of options.relations) {
    if (relation.visibility === "hidden" || relation.confirmationStatus === "rejected") continue;
    const key = semanticBundleKey(relation);
    const previousId = bestParallel.get(key);
    if (!previousId || importance.get(relation.id)!.score > importance.get(previousId)!.score)
      bestParallel.set(key, relation.id);
  }

  const visible: RelationRecord[] = [];
  const hidden: RelationVisibilityResult["hidden"] = [];
  const overviewCandidates: RelationRecord[] = [];
  for (const relation of options.relations) {
    if (relation.confirmationStatus === "rejected") {
      hidden.push({ relation, reason: "rejected" });
      continue;
    }
    if (options.mode === "all") {
      visible.push(relation);
      continue;
    }
    if (relation.visibility === "hidden") {
      hidden.push({ relation, reason: "user-hidden" });
      continue;
    }
    if (relation.visibility === "always" && options.mode !== "overview") {
      visible.push(relation);
      continue;
    }
    const key = semanticBundleKey(relation);
    if (bestParallel.get(key) !== relation.id) {
      hidden.push({ relation, reason: "parallel" });
      continue;
    }
    if (
      relationEvidenceMode(relation) === "inferred" &&
      hasVisibleSupports(relation, relationsById)
    ) {
      hidden.push({ relation, reason: "derived-redundant" });
      continue;
    }
    if (options.mode === "standard") {
      visible.push(relation);
      continue;
    }
    overviewCandidates.push(relation);
  }

  if (options.mode === "overview") {
    const selected = maximumWeightForest(overviewCandidates, importance);
    for (const relation of overviewCandidates) {
      if (
        relation.visibility === "always" ||
        bridges.has(pairKey(relation.fromId, relation.toId))
      ) {
        selected.add(relation.id);
      }
    }
    const budget = overviewEdgeBudget(overviewCandidates, selected.size);
    for (const relation of [...overviewCandidates].sort((left, right) =>
      relationImportanceOrder(importance, left, right),
    )) {
      if (selected.size >= budget) break;
      if ((importance.get(relation.id)?.score ?? 0) >= threshold) selected.add(relation.id);
    }
    for (const relation of overviewCandidates) {
      if (selected.has(relation.id)) visible.push(relation);
      else {
        hidden.push({
          relation,
          reason:
            (importance.get(relation.id)?.score ?? 0) < threshold
              ? "low-salience"
              : "overview-redundant",
        });
      }
    }
  }

  return { visible, hidden, focusNodeIds, importance };
}
