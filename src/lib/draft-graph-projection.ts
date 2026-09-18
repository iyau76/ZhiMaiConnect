/**
 * 录入草稿 + 本地档案 → 一张可渲染的关系网。
 *
 * 纯函数，不读数据库、不改草稿：只把「姓名 / 草稿 id / 档案 id」解析成稳定的节点 id，
 * 并标出这次新增的人和这次要更新的已有档案。录入页的关系网预览靠它把
 * 未入库的草稿和已经入库的档案画在同一张图上。
 */

/** 草稿人物的「新建人物」标记；等于档案 id 时才表示更新已有档案。 */
export const CREATE_NEW_PERSON_ID = "__create_new_person__";

export interface DraftGraphPersonInput {
  _draftId?: string;
  name?: string;
  targetPersonId?: string;
}

export interface DraftGraphRelationInput {
  from: string;
  to: string;
  label: string;
  fromDraftId?: string;
  toDraftId?: string;
  fromPersonId?: string;
  toPersonId?: string;
}

export interface DraftGraphArchivePersonInput {
  id: string;
  name: string;
}

export interface DraftGraphArchiveRelationInput {
  id: string;
  fromId: string;
  toId: string;
  label: string;
}

export interface DraftGraphCircleInput {
  id: string;
  name: string;
}

export interface DraftGraphMembershipInput {
  collectionId: string;
  personId: string;
  source?: string;
}

export interface DraftGraphNode {
  /** 新建人物用 `draft:<_draftId 或姓名>`；更新/已有的人用档案 id。 */
  id: string;
  name: string;
  /** 这次新进档案的人。 */
  isNew: boolean;
  /** 这次要更新已有档案的人。 */
  haloed: boolean;
  /** 圈层名（去重，最多留前 3 个），没有就空数组。 */
  circles: string[];
}

export interface DraftGraphEdge {
  id: string;
  /** 指向 DraftGraphNode.id */
  from: string;
  to: string;
  label: string;
  /** 这次录入里的关系 */
  isNew: boolean;
}

export interface DraftGraphProjection {
  nodes: DraftGraphNode[];
  edges: DraftGraphEdge[];
  /** 只包含至少有一个成员的圈层 */
  circles: Array<{ key: string; label: string; memberIds: string[] }>;
}

export interface BuildDraftGraphProjectionInput {
  draftPeople: readonly DraftGraphPersonInput[];
  draftRelations: readonly DraftGraphRelationInput[];
  archivePeople: readonly DraftGraphArchivePersonInput[];
  archiveRelations: readonly DraftGraphArchiveRelationInput[];
  /** 档案里已有的圈层和这次录入的圈层草稿放一起，key 用圈层 id。 */
  circles: readonly DraftGraphCircleInput[];
  /** 圈层成员；source === "computed" 的派生社区忽略。 */
  memberships: readonly DraftGraphMembershipInput[];
}

function trimmed(value?: string) {
  return (value ?? "").trim();
}

/** 草稿人物投影成哪个节点：能对上档案 id 的用档案 id，其余算新建。 */
function draftPersonNodeId(person: DraftGraphPersonInput, archiveIds: ReadonlySet<string>) {
  const target = trimmed(person.targetPersonId);
  if (target && target !== CREATE_NEW_PERSON_ID && archiveIds.has(target)) return target;
  return `draft:${trimmed(person._draftId) || trimmed(person.name)}`;
}

/**
 * 按 fromPersonId → fromDraftId → 姓名唯一匹配 解析草稿关系的两端。
 * 姓名同时对应多个节点时返回 null（不猜）；两端解析成同一个人的自环也返回 null。
 */
export function resolveDraftRelationEndpoints(
  relation: DraftGraphRelationInput,
  draftPeople: readonly DraftGraphPersonInput[],
  nodes: readonly Pick<DraftGraphNode, "id" | "name">[],
): { from: string; to: string } | null {
  const nodeIds = new Set(nodes.map((node) => node.id));
  const draftIdToNodeId = new Map<string, string>();
  for (const person of draftPeople) {
    const draftId = trimmed(person._draftId);
    if (!draftId || draftIdToNodeId.has(draftId)) continue;
    const target = trimmed(person.targetPersonId);
    const candidates = [
      target && target !== CREATE_NEW_PERSON_ID ? target : "",
      `draft:${draftId}`,
    ].filter(Boolean);
    const nodeId = candidates.find((candidate) => nodeIds.has(candidate));
    if (nodeId) draftIdToNodeId.set(draftId, nodeId);
  }

  const nameCounts = new Map<string, number>();
  for (const node of nodes) {
    const name = trimmed(node.name);
    if (name) nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
  }

  const resolveSide = (personId?: string, draftId?: string, name?: string) => {
    const direct = trimmed(personId);
    if (direct && nodeIds.has(direct)) return direct;
    const byDraft = draftIdToNodeId.get(trimmed(draftId));
    if (byDraft) return byDraft;
    const byName = trimmed(name);
    if (byName && nameCounts.get(byName) === 1) {
      return nodes.find((node) => trimmed(node.name) === byName)?.id ?? null;
    }
    return null;
  };

  const from = resolveSide(relation.fromPersonId, relation.fromDraftId, relation.from);
  const to = resolveSide(relation.toPersonId, relation.toDraftId, relation.to);
  if (!from || !to || from === to) return null;
  return { from, to };
}

export function buildDraftGraphProjection(
  input: BuildDraftGraphProjectionInput,
): DraftGraphProjection {
  const archiveIds = new Set(input.archivePeople.map((person) => person.id));
  const nodeById = new Map<string, DraftGraphNode>();
  const addNode = (node: DraftGraphNode) => {
    if (!nodeById.has(node.id)) nodeById.set(node.id, node);
  };

  for (const person of input.archivePeople) {
    addNode({
      id: person.id,
      name: trimmed(person.name),
      isNew: false,
      haloed: false,
      circles: [],
    });
  }

  for (const person of input.draftPeople) {
    const name = trimmed(person.name);
    const draftId = trimmed(person._draftId);
    if (!name && !draftId) continue;
    const id = draftPersonNodeId(person, archiveIds);
    const existing = nodeById.get(id);
    if (existing) {
      // 同一个人被草稿引用多次：更新档案的标记合并到已经存在的档案节点上。
      if (archiveIds.has(id)) existing.haloed = true;
      if (!existing.name && name) existing.name = name;
      continue;
    }
    addNode({ id, name, isNew: !archiveIds.has(id), haloed: false, circles: [] });
  }

  const isArchiveNode = (id: string) => archiveIds.has(id);
  const nodes = [...nodeById.values()].sort((a, b) => {
    const archiveOrder = Number(!isArchiveNode(a.id)) - Number(!isArchiveNode(b.id));
    if (archiveOrder !== 0) return archiveOrder;
    if (isArchiveNode(a.id)) return a.id.localeCompare(b.id);
    const byName = a.name.localeCompare(b.name);
    return byName !== 0 ? byName : a.id.localeCompare(b.id);
  });

  const edges: DraftGraphEdge[] = [];
  const seenArchiveIds = new Set<string>();
  for (const relation of input.archiveRelations) {
    if (relation.fromId === relation.toId) continue;
    if (!nodeById.has(relation.fromId) || !nodeById.has(relation.toId)) continue;
    if (seenArchiveIds.has(relation.id)) continue;
    seenArchiveIds.add(relation.id);
    edges.push({
      id: relation.id,
      from: relation.fromId,
      to: relation.toId,
      label: relation.label ?? "",
      isNew: false,
    });
  }

  const seenDraftEdges = new Set<string>();
  for (const relation of input.draftRelations) {
    const endpoints = resolveDraftRelationEndpoints(relation, input.draftPeople, nodes);
    if (!endpoints) continue;
    const label = relation.label ?? "";
    const key = `${endpoints.from}\u0000${endpoints.to}\u0000${label}`;
    if (seenDraftEdges.has(key)) continue;
    seenDraftEdges.add(key);
    edges.push({
      id: `draft:${endpoints.from}->${endpoints.to}:${label}`,
      from: endpoints.from,
      to: endpoints.to,
      label,
      isNew: true,
    });
  }

  const draftNameCounts = new Map<string, number>();
  for (const person of input.draftPeople) {
    const name = trimmed(person.name);
    if (name) draftNameCounts.set(name, (draftNameCounts.get(name) ?? 0) + 1);
  }
  const draftIdToNodeId = new Map<string, string>();
  for (const person of input.draftPeople) {
    const draftId = trimmed(person._draftId);
    if (!draftId || draftIdToNodeId.has(draftId)) continue;
    const id = draftPersonNodeId(person, archiveIds);
    if (nodeById.has(id)) draftIdToNodeId.set(draftId, id);
  }

  const resolveMemberNodeId = (rawPersonId: string): string | null => {
    const personId = trimmed(rawPersonId);
    if (!personId) return null;
    const byDraftId = draftIdToNodeId.get(personId);
    if (byDraftId) return byDraftId;
    if (nodeById.has(personId)) return personId;
    if (draftNameCounts.get(personId) === 1) {
      const person = input.draftPeople.find((item) => trimmed(item.name) === personId);
      if (person) {
        const id = draftPersonNodeId(person, archiveIds);
        if (nodeById.has(id)) return id;
      }
    }
    return null;
  };

  const memberIdsByCircle = new Map<string, string[]>();
  for (const membership of input.memberships) {
    if (membership.source === "computed") continue;
    const nodeId = resolveMemberNodeId(membership.personId);
    if (!nodeId) continue;
    const memberIds = memberIdsByCircle.get(membership.collectionId) ?? [];
    if (!memberIds.includes(nodeId)) memberIds.push(nodeId);
    memberIdsByCircle.set(membership.collectionId, memberIds);
  }

  const circleByKey = new Map<string, { key: string; label: string }>();
  for (const circle of input.circles) {
    // 同一个圈层可能同时来自档案和这次草稿（改圈层的情况），后出现的草稿名覆盖档案名。
    circleByKey.set(circle.id, { key: circle.id, label: trimmed(circle.name) });
  }

  const circles = [...circleByKey.values()]
    .map((circle) => ({
      ...circle,
      memberIds: memberIdsByCircle.get(circle.key) ?? [],
    }))
    .filter((circle) => circle.memberIds.length > 0);

  for (const circle of circles) {
    if (!circle.label) continue;
    for (const memberId of circle.memberIds) {
      const node = nodeById.get(memberId);
      if (!node || node.circles.length >= 3 || node.circles.includes(circle.label)) continue;
      node.circles.push(circle.label);
    }
  }

  return { nodes, edges, circles };
}
