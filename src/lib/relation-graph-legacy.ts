/**
 * 原版关系网几何：按「成员组合」分区 + 环套环布局。
 *
 * 新版（多重成员包络 + 紧凑布局）还在验证阶段，所以这段实现继续保留：
 * 用户默认看到的就是这里画出来的图，面板里的「原版／新版」开关负责切换。
 * 两个版本共用圈层这一份事实（collections / memberships），差别只在显示链路。
 */

import type { CollectionMembershipRecord, CollectionRecord, PersonRecord } from "./face-db";

export const DEFAULT_GRAPH_MIN_EDGE = 150;

export interface GraphPoint {
  x: number;
  y: number;
}

export interface RingLayout {
  /** 最外圈的半径 */
  radius: number;
  /** 以原点为中心的相对坐标 */
  points: GraphPoint[];
}

/** 环形排布时，为了让相邻两点至少隔开 minEdge 所需的半径 */
export function ringRadiusFor(count: number, minEdge: number) {
  if (count <= 1) return 0;
  return Math.max(minEdge * 0.6, minEdge / (2 * Math.sin(Math.PI / count)));
}

/** 人多时不再把圆周越撑越大，改成多层同心环。 */
export function layeredRingPoints(count: number, minEdge = DEFAULT_GRAPH_MIN_EDGE): RingLayout {
  if (count <= 24) {
    const radius = ringRadiusFor(count, minEdge);
    return {
      radius,
      points: Array.from({ length: count }, (_, index) => {
        const angle = (index / Math.max(count, 1)) * Math.PI * 2 - Math.PI / 2;
        return count === 1
          ? { x: 0, y: 0 }
          : { x: radius * Math.cos(angle), y: radius * Math.sin(angle) };
      }),
    };
  }
  const ringStep = 170;
  const points: GraphPoint[] = [];
  let ring = 1;
  while (points.length < count) {
    const radius = ring * ringStep;
    const capacity = Math.max(8, Math.floor((Math.PI * 2 * radius) / minEdge));
    const take = Math.min(capacity, count - points.length);
    for (let index = 0; index < take; index += 1) {
      const angle = (index / take) * Math.PI * 2 - Math.PI / 2 + (ring % 2 ? 0 : Math.PI / take);
      points.push({ x: radius * Math.cos(angle), y: radius * Math.sin(angle) });
    }
    ring += 1;
  }
  return { radius: (ring - 1) * ringStep, points };
}

export interface RingGraphNodeInput {
  id: string;
  /** 空字符串表示不分组 */
  groupKey?: string;
}

export interface RingGraphGroupInput {
  key: string;
  label: string;
}

export interface RingGraphNodePlacement {
  id: string;
  groupKey: string;
  x: number;
  y: number;
}

export interface RingGraphClusterPlacement {
  key: string;
  label: string;
  x: number;
  y: number;
  r: number;
}

export interface RingGraphLayout {
  size: number;
  nodes: RingGraphNodePlacement[];
  clusters: RingGraphClusterPlacement[];
}

/**
 * 圈层簇的圆心和半径可能被调用方按实际落点改写（拖动之后），
 * 所以这里返回的是可继续编辑的普通对象。
 */
export function layoutRingGraph(
  nodes: RingGraphNodeInput[],
  groups: RingGraphGroupInput[] = [],
  minEdge = DEFAULT_GRAPH_MIN_EDGE,
): RingGraphLayout {
  const grouped = groups.length > 0 && nodes.some((node) => (node.groupKey ?? "") !== "");
  if (!grouped) {
    const layout = layeredRingPoints(nodes.length, minEdge);
    const size = 2 * (layout.radius + 74);
    const center = size / 2;
    return {
      size,
      nodes: nodes.map((node, index) => {
        const point = layout.points[index] ?? { x: 0, y: 0 };
        return { id: node.id, groupKey: "", x: center + point.x, y: center + point.y };
      }),
      clusters: [],
    };
  }

  const membersByKey = new Map<string, RingGraphNodeInput[]>();
  for (const node of nodes) {
    const key = node.groupKey ?? "";
    membersByKey.set(key, [...(membersByKey.get(key) ?? []), node]);
  }
  const buckets = groups
    .map((group) => ({ ...group, members: membersByKey.get(group.key) ?? [] }))
    .filter((bucket) => bucket.members.length > 0);
  const inner = buckets.map((bucket) => layeredRingPoints(bucket.members.length, minEdge));
  const maxR = Math.max(...inner.map((layout) => layout.radius + 52), 120);
  // 多个圈层时，各簇均匀分布在一个更大的环上，彼此不重叠
  const ringRadius =
    buckets.length > 1 ? Math.max(maxR * 1.6, (maxR + 30) / Math.sin(Math.PI / buckets.length)) : 0;
  const size = 2 * (ringRadius + maxR + 56);
  const center = size / 2;

  const placements: RingGraphNodePlacement[] = [];
  const clusters: RingGraphClusterPlacement[] = [];
  buckets.forEach((bucket, bucketIndex) => {
    const angle = (bucketIndex / buckets.length) * Math.PI * 2 - Math.PI / 2;
    const cx = center + ringRadius * Math.cos(angle);
    const cy = center + ringRadius * Math.sin(angle);
    clusters.push({
      key: bucket.key,
      label: bucket.label,
      x: cx,
      y: cy,
      r: inner[bucketIndex].radius + 52,
    });
    bucket.members.forEach((node, index) => {
      const point = inner[bucketIndex].points[index] ?? { x: 0, y: 0 };
      placements.push({ id: node.id, groupKey: bucket.key, x: cx + point.x, y: cy + point.y });
    });
  });

  return { size, nodes: placements, clusters };
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

/**
 * 原版圈层范围的不规则平滑外形：形状跟着成员的实际位置流动变形。
 * 同一个 key 与同一批位置必须得到同一条路径（种子只来自 key）。
 */
export function blobPathFor(
  cx: number,
  cy: number,
  r: number,
  seedText: string,
  members: GraphPoint[],
) {
  let seed = 0;
  for (const ch of seedText) seed = (seed * 31 + ch.charCodeAt(0)) % 100000;
  const steps = 14;
  const pts: Array<[number, number]> = [];
  const offsets = members.map((member) => {
    const dx = member.x - cx;
    const dy = member.y - cy;
    return { dist: Math.hypot(dx, dy), angle: Math.atan2(dy, dx) };
  });
  for (let index = 0; index < steps; index += 1) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    const wobble = 0.88 + (seed / 2147483648) * 0.2;
    const angle = (index / steps) * Math.PI * 2;
    // 该方向上离得最远的成员把边界"顶"出去，形成随节点流动的形状
    let reach = r * 0.62;
    for (const off of offsets) {
      let diff = Math.abs(angle - off.angle) % (Math.PI * 2);
      if (diff > Math.PI) diff = Math.PI * 2 - diff;
      const pull = Math.exp(-((diff / 0.95) ** 2));
      reach = Math.max(reach, (off.dist + 56) * pull + r * 0.5 * (1 - pull));
    }
    const rad = reach * wobble;
    pts.push([cx + rad * Math.cos(angle), cy + rad * Math.sin(angle)]);
  }
  // Catmull-Rom → 三次贝塞尔，得到闭合的平滑曲线
  let path = `M ${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
  for (let index = 0; index < steps; index += 1) {
    const p0 = pts[(index - 1 + steps) % steps];
    const p1 = pts[index];
    const p2 = pts[(index + 1) % steps];
    const p3 = pts[(index + 2) % steps];
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    path += ` C ${c1[0].toFixed(1)} ${c1[1].toFixed(1)}, ${c2[0].toFixed(1)} ${c2[1].toFixed(1)}, ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
  }
  return `${path} Z`;
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
