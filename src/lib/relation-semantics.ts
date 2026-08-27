import type { RelationRecord } from "./face-db";
import { inferMutual, isMutualRelation } from "./relation-kind";

function compact(label: string) {
  return label
    .trim()
    .toLocaleLowerCase("zh-CN")
    .replace(/[\s·_/、，,（）()-]+/g, "");
}

/** Stable semantic bucket for deduplication and rules; the original label is always retained. */
export function normalizeRelationSemanticKind(label: string) {
  const value = compact(label);
  if (!value) return "other";
  if (/(曾祖|曾孙|greatgrand)/i.test(value)) return "great_grandparent";
  if (/(外祖|祖孙|祖父|祖母|爷爷|奶奶|外公|外婆|grandparent)/i.test(value)) return "grandparent";
  if (/(继兄|继弟|继姐|继妹|stepsibling)/i.test(value)) return "step_sibling";
  if (/(继父|继母|stepfather|stepmother|stepparent)/i.test(value)) return "step_parent";
  if (/(同父异母|同母异父|半血缘|halfsibling)/i.test(value)) return "half_sibling";
  if (/(翁媳|婆媳|岳婿|岳父|岳母|公公|婆婆|叔嫂|姻亲|inlaw)/i.test(value)) return "in_law";
  if (/(夫妻|配偶|丈夫|妻子|爱人|spouse|husband|wife)/i.test(value)) return "spouse";
  if (/(父子|父女|母子|母女|父母|爸爸|妈妈|parent|father|mother)/i.test(value))
    return "parent_child";
  // Cousin labels often contain 兄/妹/姐/弟, so they must be classified before siblings.
  if (/(堂|姑表|舅表|姨表|表亲|cousin)/i.test(value)) return "cousin";
  if (/(兄弟|兄妹|姐弟|姐妹|同胞|sibling|brother|sister)/i.test(value)) return "sibling";
  if (/(叔侄|伯侄|姑侄|舅甥|姨甥|uncle|aunt|nephew|niece)/i.test(value)) return "uncle_nibling";
  if (/(同宗|宗亲|族亲|族兄|族弟|clan)/i.test(value)) return "clan";
  if (/(同事|同僚|上下级|领导|下属|colleague|coworker)/i.test(value)) return "work";
  if (/(同学|校友|师生|classmate|schoolmate)/i.test(value)) return "school";
  if (/(朋友|好友|熟人|friend|acquaintance)/i.test(value)) return "friend";
  return `label:${value}`;
}

export function relationSemanticKey(input: {
  fromId: string;
  toId: string;
  label: string;
  mutual?: boolean;
  semanticKind?: string;
}) {
  const kind = input.semanticKind || normalizeRelationSemanticKind(input.label);
  const mutual = input.mutual ?? inferMutual(input.label);
  const endpoints = mutual
    ? [input.fromId, input.toId].sort().join("\u0000")
    : `${input.fromId}\u0000${input.toId}`;
  return `${endpoints}\u0000${kind}`;
}

/** Resolve an inferred edge to the shortest confirmed explicit chain it depends on. */
export function findRelationDependencies(
  fromId: string,
  toId: string,
  relations: RelationRecord[],
  maxEdges = 4,
) {
  const eligible = relations.filter(
    (relation) =>
      relation.confirmationStatus !== "rejected" &&
      relation.evidenceMode !== "inferred" &&
      relation.fromId !== relation.toId,
  );
  const adjacent = new Map<string, Array<{ next: string; relationId: string }>>();
  for (const relation of eligible) {
    adjacent.set(relation.fromId, [
      ...(adjacent.get(relation.fromId) ?? []),
      { next: relation.toId, relationId: relation.id },
    ]);
    // Kinship semantics are traversable in both directions even when the display arrow is directed.
    adjacent.set(relation.toId, [
      ...(adjacent.get(relation.toId) ?? []),
      { next: relation.fromId, relationId: relation.id },
    ]);
  }
  const queue: Array<{ personId: string; relationIds: string[]; visited: Set<string> }> = [
    { personId: fromId, relationIds: [], visited: new Set([fromId]) },
  ];
  while (queue.length) {
    const current = queue.shift()!;
    if (current.relationIds.length >= maxEdges) continue;
    for (const edge of adjacent.get(current.personId) ?? []) {
      if (current.visited.has(edge.next)) continue;
      const relationIds = [...current.relationIds, edge.relationId];
      if (edge.next === toId) return relationIds;
      queue.push({
        personId: edge.next,
        relationIds,
        visited: new Set([...current.visited, edge.next]),
      });
    }
  }
  return [];
}

export function relationsEquivalent(a: RelationRecord, b: RelationRecord) {
  return (
    relationSemanticKey(a) === relationSemanticKey(b) && isMutualRelation(a) === isMutualRelation(b)
  );
}
