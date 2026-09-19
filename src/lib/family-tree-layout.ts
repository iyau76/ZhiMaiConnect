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

interface GenerationConstraint {
  fromId: string;
  toId: string;
  delta: number;
  priority: number;
}

interface GroupGenerationConstraint {
  from: string;
  to: string;
  delta: number;
  priority: number;
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

/**
 * Directed generational distance encoded by a kinship edge.
 *
 * The `from` endpoint is the older side for parent/uncle/grandparent
 * predicates. A null result means the relationship does not guarantee a
 * generational order and must not move either endpoint.
 */
export function familyTreeGenerationDelta(relation: RelationRecord): number | null {
  const predicate = predicateOf(relation);
  if (predicate === "parent_of" || predicate === "step_parent_of") return 1;
  if (predicate === "grandparent_of") return 2;
  if (predicate === "great_grandparent_of") return 3;
  if (predicate === "uncle_aunt_of") return 1;
  if (predicate === "in_law_of") {
    if (
      relation.qualifiers?.inLawRole === "father_in_law" ||
      relation.qualifiers?.inLawRole === "mother_in_law"
    )
      return 1;
    if (relation.qualifiers?.inLawRole === "sibling_in_law") return 0;
    return null;
  }
  if (
    predicate === "spouse_of" ||
    predicate === "sibling_of" ||
    predicate === "half_sibling_of" ||
    predicate === "step_sibling_of" ||
    predicate === "cousin_of"
  )
    return 0;
  return null;
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

function maximumConstraintPath(
  from: string,
  to: string,
  constraints: GroupGenerationConstraint[],
  seen = new Set<string>(),
): number | null {
  if (from === to) return 0;
  if (seen.has(from)) return null;
  seen.add(from);
  let best: number | null = null;
  for (const constraint of constraints) {
    if (constraint.from !== from) continue;
    const rest = maximumConstraintPath(constraint.to, to, constraints, seen);
    if (rest === null) continue;
    best = Math.max(best ?? Number.NEGATIVE_INFINITY, constraint.delta + rest);
  }
  return best;
}

/** Keep only people who participate in at least one kinship edge. */
export function selectFamilyTreePeople(input: {
  people: Array<Pick<PersonRecord, "id" | "name">>;
  relations: RelationRecord[];
}) {
  const candidateIds = new Set(input.people.map((person) => person.id));
  const includedIds = new Set<string>();
  for (const relation of input.relations) {
    if (!candidateIds.has(relation.fromId) || !candidateIds.has(relation.toId)) continue;
    if (!familyTreeEdgeKind(relation)) continue;
    includedIds.add(relation.fromId);
    includedIds.add(relation.toId);
  }
  return input.people.filter((person) => includedIds.has(person.id));
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
  const generationConstraints: GenerationConstraint[] = [];

  for (const relation of input.relations) {
    if (!idSet.has(relation.fromId) || !idSet.has(relation.toId)) continue;
    const predicate = predicateOf(relation);
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
    const generationDelta = familyTreeGenerationDelta(relation);
    if (
      kind === "spouse" ||
      kind === "sibling" ||
      predicate === "cousin_of" ||
      generationDelta === 0
    )
      union(relation.fromId, relation.toId);
    if (generationDelta !== null && generationDelta > 0) {
      generationConstraints.push({
        fromId: relation.fromId,
        toId: relation.toId,
        delta: generationDelta,
        priority: kind === "parent" ? 0 : 1,
      });
    }
  }

  const parentsByChild = new Map<string, string[]>();
  for (const edge of familyEdges) {
    if (edge.kind !== "parent") continue;
    parentsByChild.set(edge.toId, [...(parentsByChild.get(edge.toId) ?? []), edge.fromId]);
  }

  const groups = [...new Set(ids.map((id) => find(id)))].sort();
  const generationByGroup = new Map<string, number>(groups.map((group) => [group, 0]));
  const groupConstraints = new Map<string, GroupGenerationConstraint>();
  for (const constraint of generationConstraints) {
    const from = find(constraint.fromId);
    const to = find(constraint.toId);
    if (from === to) continue;
    const grouped = { from, to, delta: constraint.delta, priority: constraint.priority };
    const key = `${from}\u0000${to}`;
    const existing = groupConstraints.get(key);
    if (
      !existing ||
      grouped.priority < existing.priority ||
      (grouped.priority === existing.priority && existing.delta < grouped.delta)
    ) {
      groupConstraints.set(key, grouped);
    }
  }

  // Parent chains are the primary structure. Accept an extended kinship rule
  // only when it does not create a positive cycle that would repeatedly push a
  // whole branch down the tree.
  const acceptedConstraints: GroupGenerationConstraint[] = [];
  const orderedConstraints = [...groupConstraints.values()].sort(
    (left, right) =>
      left.priority - right.priority ||
      right.delta - left.delta ||
      left.from.localeCompare(right.from) ||
      left.to.localeCompare(right.to),
  );
  for (const constraint of orderedConstraints) {
    const reverse = maximumConstraintPath(constraint.to, constraint.from, acceptedConstraints);
    if (reverse !== null && reverse + constraint.delta > 0) continue;
    acceptedConstraints.push(constraint);
  }

  // The accepted graph is acyclic, so this converges within one pass per
  // group even for disconnected family components.
  for (let pass = 0; pass < groups.length; pass += 1) {
    let changed = false;
    for (const constraint of acceptedConstraints) {
      const next = (generationByGroup.get(constraint.from) ?? 0) + constraint.delta;
      if ((generationByGroup.get(constraint.to) ?? 0) < next) {
        generationByGroup.set(constraint.to, next);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const minimumGeneration = Math.min(0, ...generationByGroup.values());
  for (const group of groups) {
    generationByGroup.set(group, (generationByGroup.get(group) ?? 0) - minimumGeneration);
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
  /** 估算名字的占位宽度：同一行里挨得太近，文字就会互相压住。 */
  const labelWidthOf = (id: string) => {
    const name = nameById.get(id) ?? id;
    return Math.max(72, name.length * 15 + 24);
  };
  /** 相邻两个人的最小间距：长名字按半宽相加再留一点白，短名字用基准间距。 */
  const gapBetween = (leftId: string, rightId: string) =>
    Math.max(horizontalGap, (labelWidthOf(leftId) + labelWidthOf(rightId)) / 2 + 22);

  const rowPlacements: Array<{ generation: number; offsets: number[]; width: number }> = [];
  for (const [generation, row] of [...rowOrders.entries()].sort(
    ([left], [right]) => left - right,
  )) {
    const offsets: number[] = [];
    row.forEach((id, index) => {
      offsets.push(index === 0 ? 0 : offsets[index - 1] + gapBetween(row[index - 1], id ?? ""));
    });
    const leftEdge = -(row.length ? labelWidthOf(row[0]) : 0) / 2;
    const rightEdge = row.length
      ? offsets[row.length - 1] + labelWidthOf(row[row.length - 1]) / 2
      : 0;
    rowPlacements.push({
      generation,
      offsets: offsets.map((value) => value - leftEdge),
      width: rightEdge - leftEdge,
    });
  }

  const widestRowWidth = Math.max(0, ...rowPlacements.map((row) => row.width));
  const width = Math.max(760, horizontalPadding * 2, widestRowWidth + horizontalPadding * 2);
  const height = Math.max(
    520,
    verticalPadding * 2 + Math.max(0, generationCount - 1) * verticalGap,
  );
  const size = Math.max(width, height);
  const yOffset = (size - height) / 2;
  const positions = new Map<string, { x: number; y: number }>();

  for (const row of rowPlacements) {
    const startX = (size - row.width) / 2;
    const rowIds = rowOrders.get(row.generation) ?? [];
    rowIds.forEach((id, index) => {
      positions.set(id, {
        x: startX + (row.offsets[index] ?? 0),
        y: yOffset + verticalPadding + row.generation * verticalGap,
      });
    });
  }

  const nodes: FamilyTreeLayoutNode[] = [...ids].sort().map((id) => {
    const point = positions.get(id) ?? { x: size / 2, y: yOffset + verticalPadding };
    return {
      id,
      name: nameById.get(id) ?? id,
      generation: generationById.get(id) ?? 0,
      x: point.x,
      y: point.y,
    };
  });

  return {
    nodes: nodes.sort((left, right) => left.id.localeCompare(right.id)),
    edges: familyEdges.sort((left, right) => left.id.localeCompare(right.id)),
    generationCount,
    width,
    height,
    size,
  };
}
