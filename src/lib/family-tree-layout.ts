import type { PersonRecord, RelationRecord } from "./face-db";
import {
  inferRelationSemantics,
  relationCategoryFor,
  type RelationPredicate,
} from "./relation-ontology";

const PARENT_PREDICATES = new Set<RelationPredicate>(["parent_of", "step_parent_of"]);
const SIBLING_PREDICATES = new Set<RelationPredicate>([
  "sibling_of",
  "half_sibling_of",
  "step_sibling_of",
]);

export type FamilyTreeEdgeKind = "parent" | "spouse" | "sibling" | "kinship";

export interface FamilyTreeLayoutNode {
  id: string;
  name: string;
  generation: number;
  x: number;
  y: number;
}

export interface FamilyTreeLayoutEdge {
  id: string;
  relationId: string;
  fromId: string;
  toId: string;
  kind: FamilyTreeEdgeKind;
  label: string;
}

export interface FamilyTreeLayout {
  nodes: FamilyTreeLayoutNode[];
  edges: FamilyTreeLayoutEdge[];
  generationCount: number;
  width: number;
  height: number;
  size: number;
}

function predicateOf(relation: RelationRecord) {
  return relation.predicate ?? inferRelationSemantics(relation.label).predicate;
}

export function isFamilyTreeRelation(relation: RelationRecord) {
  return relationCategoryFor(predicateOf(relation)) === "kinship";
}

export function familyTreeEdgeKind(relation: RelationRecord): FamilyTreeEdgeKind | null {
  const predicate = predicateOf(relation);
  if (PARENT_PREDICATES.has(predicate)) return "parent";
  if (SIBLING_PREDICATES.has(predicate)) return "sibling";
  if (predicate === "spouse_of") return "spouse";
  // Keep every accepted kinship edge visible, even without a generational rule.
  return isFamilyTreeRelation(relation) ? "kinship" : null;
}

function createDisjointSet(ids: string[]) {
  const parent = new Map(ids.map((id) => [id, id]));
  const find = (id: string): string => {
    const current = parent.get(id);
    if (!current || current === id) return id;
    const root = find(current);
    parent.set(id, root);
    return root;
  };
  const union = (left: string, right: string) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot === rightRoot) return;
    const [first, second] = [leftRoot, rightRoot].sort();
    parent.set(second, first);
  };
  return { find, union };
}

function orderKeyFor(
  id: string,
  parentsByChild: Map<string, string[]>,
  nameOf: (id: string) => string,
  seen = new Set<string>(),
): string {
  if (seen.has(id)) return nameOf(id);
  const parents = [...new Set(parentsByChild.get(id) ?? [])].sort();
  if (!parents.length) return nameOf(id);
  seen.add(id);
  return parents
    .map((parentId) => orderKeyFor(parentId, parentsByChild, nameOf, seen))
    .sort()
    .join("|");
}

/**
 * Build a deterministic generational family-tree projection.
 *
 * Spouses and siblings share a generation, children stay below every recorded
 * parent, and disconnected families each start at generation zero. The result
 * is disposable visual geometry and is never written back to the archive.
 */
export function buildFamilyTreeLayout(input: {
  people: Array<Pick<PersonRecord, "id" | "name">>;
  relations: RelationRecord[];
}): FamilyTreeLayout {
  const people = [...input.people].sort((left, right) => left.id.localeCompare(right.id));
  const ids = people.map((person) => person.id);
  const idSet = new Set(ids);
  const nameById = new Map(people.map((person) => [person.id, person.name]));
  const { find, union } = createDisjointSet(ids);
  const familyEdges: FamilyTreeLayoutEdge[] = [];

  for (const relation of input.relations) {
    if (!idSet.has(relation.fromId) || !idSet.has(relation.toId)) continue;
    const kind = familyTreeEdgeKind(relation);
    if (!kind) continue;
    familyEdges.push({
      id: relation.id,
      relationId: relation.id,
      fromId: relation.fromId,
      toId: relation.toId,
      kind,
      label: relation.label,
    });
    // Generic kinship can span generations. It must not collapse a parent and
    // child into one row or manufacture missing parents to complete a pedigree.
    if (kind === "spouse" || kind === "sibling") union(relation.fromId, relation.toId);
  }

  const parentsByChild = new Map<string, string[]>();
  const childrenByParent = new Map<string, string[]>();
  for (const edge of familyEdges) {
    if (edge.kind !== "parent") continue;
    parentsByChild.set(edge.toId, [...(parentsByChild.get(edge.toId) ?? []), edge.fromId]);
    childrenByParent.set(edge.fromId, [...(childrenByParent.get(edge.fromId) ?? []), edge.toId]);
  }

  const groupParentEdges: Array<{ from: string; to: string }> = [];
  const groupChildren = new Map<string, Set<string>>();
  const groupIndegree = new Map<string, number>();
  for (const edge of familyEdges) {
    if (edge.kind !== "parent") continue;
    const from = find(edge.fromId);
    const to = find(edge.toId);
    if (from === to) continue;
    groupParentEdges.push({ from, to });
    const children = groupChildren.get(from) ?? new Set<string>();
    children.add(to);
    groupChildren.set(from, children);
  }

  const groups = [...new Set(ids.map((id) => find(id)))].sort();
  const groupIds = new Set(groups);
  for (const group of groups) groupIndegree.set(group, 0);
  for (const edge of groupParentEdges) {
    if (groupIds.has(edge.to)) {
      groupIndegree.set(edge.to, (groupIndegree.get(edge.to) ?? 0) + 1);
    }
  }

  const generationByGroup = new Map<string, number>(groups.map((group) => [group, 0]));
  const queue = groups.filter((group) => (groupIndegree.get(group) ?? 0) === 0);
  const visited = new Set<string>();
  while (queue.length) {
    const group = queue.shift()!;
    if (visited.has(group)) continue;
    visited.add(group);
    for (const child of groupChildren.get(group) ?? []) {
      generationByGroup.set(
        child,
        Math.max(generationByGroup.get(child) ?? 0, (generationByGroup.get(group) ?? 0) + 1),
      );
      const remaining = (groupIndegree.get(child) ?? 0) - 1;
      groupIndegree.set(child, remaining);
      if (remaining === 0) queue.push(child);
    }
  }

  // Malformed or cyclic family data still gets a stable display instead of an
  // empty graph. Repeated relaxation converges for normal disconnected trees.
  for (let pass = 0; pass < groups.length; pass += 1) {
    let changed = false;
    for (const edge of groupParentEdges) {
      const next = (generationByGroup.get(edge.from) ?? 0) + 1;
      if ((generationByGroup.get(edge.to) ?? 0) < next) {
        generationByGroup.set(edge.to, next);
        changed = true;
      }
    }
    if (!changed) break;
  }

  const generationById = new Map(ids.map((id) => [id, generationByGroup.get(find(id)) ?? 0]));
  const generationCount = Math.max(0, ...generationById.values()) + (people.length ? 1 : 0);
  const rows = new Map<number, string[]>();
  for (const id of ids) {
    const generation = generationById.get(id) ?? 0;
    rows.set(generation, [...(rows.get(generation) ?? []), id]);
  }

  const rowOrders = new Map<number, string[]>();
  for (const [generation, row] of rows) {
    const rowGroups = new Map<string, string[]>();
    for (const id of row) {
      const group = find(id);
      rowGroups.set(group, [...(rowGroups.get(group) ?? []), id]);
    }
    const sortedGroups = [...rowGroups.entries()].sort(([left], [right]) => {
      const leftKey = orderKeyFor(left, parentsByChild, (id) => nameById.get(id) ?? id);
      const rightKey = orderKeyFor(right, parentsByChild, (id) => nameById.get(id) ?? id);
      return leftKey.localeCompare(rightKey, "zh-CN") || left.localeCompare(right);
    });
    rowOrders.set(
      generation,
      sortedGroups.flatMap(([, members]) =>
        members.sort(
          (left, right) =>
            (nameById.get(left) ?? left).localeCompare(nameById.get(right) ?? right, "zh-CN") ||
            left.localeCompare(right),
        ),
      ),
    );
  }

  const horizontalGap = 190;
  const verticalGap = 180;
  const horizontalPadding = 100;
  const verticalPadding = 96;
  const widestRow = Math.max(1, ...[...rowOrders.values()].map((row) => row.length));
  const width = Math.max(760, horizontalPadding * 2 + (widestRow - 1) * horizontalGap);
  const height = Math.max(
    520,
    verticalPadding * 2 + Math.max(0, generationCount - 1) * verticalGap,
  );
  const size = Math.max(width, height);
  const yOffset = (size - height) / 2;
  const nodes: FamilyTreeLayoutNode[] = [];

  for (const [generation, row] of [...rowOrders.entries()].sort(
    ([left], [right]) => left - right,
  )) {
    const rowWidth = (row.length - 1) * horizontalGap;
    const startX = (size - rowWidth) / 2;
    row.forEach((id, index) => {
      nodes.push({
        id,
        name: nameById.get(id) ?? id,
        generation,
        x: startX + index * horizontalGap,
        y: yOffset + verticalPadding + generation * verticalGap,
      });
    });
  }

  return {
    nodes: nodes.sort((left, right) => left.id.localeCompare(right.id)),
    edges: familyEdges.sort((left, right) => left.id.localeCompare(right.id)),
    generationCount,
    width,
    height,
    size,
  };
}
