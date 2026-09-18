/**
 * 关系网几何：确定性两层布局。
 *
 * 第一层只放「成员集合」（圈层或拓扑社区）的虚拟锚点：有共同成员的集合互相靠近，
 * 没有交集的分量彼此留出余量；锚点只是计算辅助，不是人物，也不是新圈层。
 * 第二层放人物：一个人被拉向「它所属各集合锚点的平均位置」，再靠节点碰撞、关系弹簧
 * 和有限次迭代找到位置。属于多个集合的人落在几个锚点之间，不会被复制成多个节点。
 *
 * 全程不随机：初始位置用黄金角点列，重合时用节点 ID 哈希出的固定方向，迭代轮数固定。
 * 同样的输入（含排序、迭代次数、画布比例）必须得到同样的坐标。
 *
 * 不分组时没有锚点，人物用同一套种子 + 关系弹簧 + 碰撞排布，不再围成一个大圆。
 */

import type { GraphBounds } from "./graph-camera";

/** 节点之间的最小视觉间距（世界单位） */
export const GRAPH_NODE_SPACING = 90;
/** 关系弹簧的目标显示长度 */
export const GRAPH_LINK_LENGTH = 95;
/** 两个集合锚点的基准间距系数 */
export const GRAPH_ANCHOR_SPACING = 85;
/** 人物相对集合锚点的回位刚度（属于多个集合时按数量分摊） */
export const GRAPH_MEMBER_STIFFNESS = 0.036;
/** 圈层模式下关系弹簧很弱，避免为缩短一条边把集合拖成一团 */
export const GRAPH_LINK_STIFFNESS_GROUPED = 0.003;
export const GRAPH_LINK_STIFFNESS_PLAIN = 0.025;
export const GRAPH_ANCHOR_TICKS = 90;
export const GRAPH_NODE_TICKS = 150;
/** 布局结果量化精度：便于测试与「同输入同输出」断言 */
export const GRAPH_QUANTUM = 1024;
/** 自适应布局的宽高比范围，超出范围按边界取值 */
export const GRAPH_ASPECT_RANGE = { min: 0.6, max: 2.6 } as const;

export type GraphAspectClass = "wide" | "tall";
export const GRAPH_ASPECT_BY_CLASS: Record<GraphAspectClass, number> = { wide: 2.2, tall: 0.75 };

export function graphAspectClass(width: number, height: number): GraphAspectClass {
  if (!Number.isFinite(width) || !Number.isFinite(height) || height <= 0) return "wide";
  return width / height >= 1.15 ? "wide" : "tall";
}

export interface GraphLayoutNodeInput {
  id: string;
}

export interface GraphLayoutGroupInput {
  id: string;
  /** 按调用方给定的稳定顺序；这里只用来求交集与占用面积 */
  memberIds: string[];
}

export interface GraphLayoutOptions {
  /** 成员集合；不分组时传空数组或省略 */
  groups?: GraphLayoutGroupInput[];
  /** 几何弹簧用的无向连接（例如已确认的人物关系）；只是可读性约束，不是事实 */
  links?: Array<[string, string]>;
  /** 画布宽高比；横屏 / 竖屏是两套确定的布局类别 */
  aspect?: number;
  /** 用户拖动固定过的世界坐标 */
  pins?: Record<string, { x: number; y: number }>;
  /** 迭代轮数，固定值保证确定性 */
  iterations?: number;
}

export interface GraphLayoutNode {
  id: string;
  x: number;
  y: number;
}

export interface GraphLayoutGroupPlacement {
  id: string;
  memberIds: string[];
  /** 锚点位置，世界坐标 */
  x: number;
  y: number;
  /** 该集合的参考半径，用于估占用面积；包络形状由 set-contours 另行计算 */
  radius: number;
}

export interface GraphLayoutResult {
  nodes: GraphLayoutNode[];
  groups: GraphLayoutGroupPlacement[];
  /** 节点包围盒，已留出节点半径与包络余量 */
  bounds: GraphBounds;
  aspect: number;
}

const goldenAngle = Math.PI * (3 - Math.sqrt(5));
const rounded = (value: number) => Math.round(value * GRAPH_QUANTUM) / GRAPH_QUANTUM;

function compareId(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** FNV-1a：把稳定 ID 变成一个固定方向，用来打破完全重合的退化情况 */
function direction(id: string): [number, number] {
  let value = 2166136261;
  for (let index = 0; index < id.length; index += 1) {
    value = Math.imul(value ^ id.charCodeAt(index), 16777619);
  }
  const angle = ((value >>> 0) / 4294967296) * Math.PI * 2;
  return [Math.cos(angle), Math.sin(angle)];
}

/** 黄金角点列：第 index 个点的seed位置，按宽高比拉伸成二维面积分布 */
function seedPoint(index: number, spacing: number, aspect: number): [number, number] {
  const radius = spacing * Math.sqrt(index + 0.5);
  const safeAspect = Math.max(0.2, aspect);
  return [
    (radius * Math.cos(index * goldenAngle) * Math.sqrt(safeAspect)) / 1.4,
    (radius * Math.sin(index * goldenAngle)) / (Math.sqrt(safeAspect) * 1.4),
  ];
}

function clampAspect(aspect: number) {
  return Math.max(GRAPH_ASPECT_RANGE.min, Math.min(GRAPH_ASPECT_RANGE.max, aspect));
}

/**
 * 把用户拖动固定过的坐标盖到已有布局上。
 * 拖动时只走这一条路径：自动几何已经算完，不必为了一次移动重跑迭代。
 * 边界仍取自动布局的边界，所以拖动不会让镜头跟着跑。
 */
export function applyGraphPins(
  layout: GraphLayoutResult,
  pins?: Record<string, { x: number; y: number }>,
): GraphLayoutResult {
  if (!pins || !Object.keys(pins).length) return layout;
  return {
    ...layout,
    nodes: layout.nodes.map((node) => {
      const pin = pins[node.id];
      return pin ? { id: node.id, x: pin.x, y: pin.y } : node;
    }),
  };
}

export function layoutRelationGraph(
  nodes: GraphLayoutNodeInput[],
  options: GraphLayoutOptions = {},
): GraphLayoutResult {
  const aspect = clampAspect(options.aspect ?? GRAPH_ASPECT_BY_CLASS.wide);
  const sortedNodes = [...nodes].sort((left, right) => compareId(left.id, right.id));
  const nodeCount = sortedNodes.length;
  const base: GraphLayoutResult = {
    nodes: sortedNodes.map((node) => ({ id: node.id, x: 0, y: 0 })),
    groups: [],
    bounds: { x: 0, y: 0, width: 0, height: 0 },
    aspect,
  };
  if (!nodeCount) return base;

  const nodeIndexById = new Map(sortedNodes.map((node, index) => [node.id, index]));
  const groups = (options.groups ?? [])
    .map((group) => ({
      id: group.id,
      memberIds: group.memberIds.filter((id) => nodeIndexById.has(id)),
    }))
    .filter((group) => group.memberIds.length > 0)
    .sort((left, right) => compareId(left.id, right.id));

  const groupIndexById = new Map(groups.map((group, index) => [group.id, index]));
  const groupsOfNode = sortedNodes.map((node) =>
    groups
      .map((group, index) => (group.memberIds.includes(node.id) ? index : -1))
      .filter((index) => index >= 0),
  );

  // 共享成员的集合属于同一个连通分量；分量只是计算批次，不会变成新的圈层。
  const unionRoots = groups.map((_, index) => index);
  const findRoot = (index: number): number => {
    let current = index;
    while (unionRoots[current] !== current) current = unionRoots[current];
    return current;
  };
  for (const nodeGroups of groupsOfNode) {
    for (const groupIndex of nodeGroups.slice(1)) {
      unionRoots[findRoot(groupIndex)] = findRoot(nodeGroups[0]);
    }
  }
  const componentOfGroup = groups.map((_, index) => findRoot(index));
  const rankOfGroup: number[] = [];
  {
    const seen = new Map<number, number>();
    for (const component of componentOfGroup) {
      const next = seen.get(component) ?? 0;
      rankOfGroup.push(next);
      seen.set(component, next + 1);
    }
  }
  const componentOfNode = groupsOfNode.map((nodeGroups, index) =>
    nodeGroups.length ? componentOfGroup[nodeGroups[0]] : groups.length + index,
  );

  // 成员集合的锚点：先按分量摆种子位置，再做有限次确定性优化。
  const memberCountByGroup = groups.map((group) => group.memberIds.length);
  const anchorX = new Float64Array(groups.length);
  const anchorY = new Float64Array(groups.length);
  const anchorRadius = memberCountByGroup.map((count) => 32 + 18 * Math.sqrt(count));
  for (let index = 0; index < groups.length; index += 1) {
    [anchorX[index], anchorY[index]] = seedPoint(rankOfGroup[index], GRAPH_ANCHOR_SPACING, aspect);
  }
  const overlapCount = (left: number, right: number) => {
    let count = 0;
    for (const memberId of groups[left].memberIds) {
      if (groups[right].memberIds.includes(memberId)) count += 1;
    }
    return count;
  };

  for (let tick = 0; tick < GRAPH_ANCHOR_TICKS; tick += 1) {
    const dx = new Float64Array(groups.length);
    const dy = new Float64Array(groups.length);
    for (let left = 0; left < groups.length; left += 1) {
      const [seedX, seedY] = seedPoint(rankOfGroup[left], GRAPH_ANCHOR_SPACING, aspect);
      dx[left] += (seedX - anchorX[left]) * 0.008;
      dy[left] += (seedY - anchorY[left]) * 0.008;
      for (let right = left + 1; right < groups.length; right += 1) {
        if (componentOfGroup[left] !== componentOfGroup[right]) continue;
        let vx = anchorX[right] - anchorX[left];
        let vy = anchorY[right] - anchorY[left];
        let distance = Math.hypot(vx, vy);
        if (distance < 1e-8) {
          [vx, vy] = direction(`${groups[left].id}|${groups[right].id}`);
          distance = 1;
        }
        const overlap = overlapCount(left, right);
        const union = memberCountByGroup[left] + memberCountByGroup[right] - overlap;
        const similarity = union > 0 ? overlap / union : 0;
        // 有共同成员的集合允许靠得更近，让交叠区域出现；没有交集的只保持刚好不重叠。
        const target =
          (anchorRadius[left] + anchorRadius[right]) * (overlap ? 0.8 - 0.25 * similarity : 1.03);
        let force = 0;
        if (overlap) force = (distance - target) * 0.09;
        else if (distance < target) force = (distance - target) * 0.09;
        dx[left] += (vx / distance) * force;
        dy[left] += (vy / distance) * force;
        dx[right] -= (vx / distance) * force;
        dy[right] -= (vy / distance) * force;
      }
    }
    for (let index = 0; index < groups.length; index += 1) {
      anchorX[index] += dx[index];
      anchorY[index] += dy[index];
    }
  }

  // 人物的目标位置：所属集合锚点的平均（多归属不增加总刚度），无归属的人单独散点。
  const x = new Float64Array(nodeCount);
  const y = new Float64Array(nodeCount);
  const targetX = new Float64Array(nodeCount);
  const targetY = new Float64Array(nodeCount);
  const duplicateRank = new Map<string, number>();
  for (let index = 0; index < nodeCount; index += 1) {
    const nodeGroups = groupsOfNode[index];
    if (nodeGroups.length) {
      let sumX = 0;
      let sumY = 0;
      for (const groupIndex of nodeGroups) {
        sumX += anchorX[groupIndex];
        sumY += anchorY[groupIndex];
      }
      targetX[index] = sumX / nodeGroups.length;
      targetY[index] = sumY / nodeGroups.length;
    } else {
      [targetX[index], targetY[index]] = seedPoint(index, 35, aspect);
    }
    const key = nodeGroups.join("\u0000");
    const rank = duplicateRank.get(key) ?? 0;
    duplicateRank.set(key, rank + 1);
    const [offsetX, offsetY] = seedPoint(rank, 22, 1);
    x[index] = targetX[index] + offsetX;
    y[index] = targetY[index] + offsetY;
  }

  // 连接：忽略自环，同一对人只贡献一次几何弹簧（渲染层仍保留每条事实）。
  const linkPairs = new Set<string>();
  const links: Array<[number, number]> = [];
  for (const [fromId, toId] of [...(options.links ?? [])].sort((left, right) =>
    compareId(`${left[0]}\u0000${left[1]}`, `${right[0]}\u0000${right[1]}`),
  )) {
    const from = nodeIndexById.get(fromId);
    const to = nodeIndexById.get(toId);
    if (from === undefined || to === undefined || from === to) continue;
    const key = from < to ? `${from}|${to}` : `${to}|${from}`;
    if (linkPairs.has(key)) continue;
    if (groups.length && componentOfNode[from] !== componentOfNode[to]) continue;
    linkPairs.add(key);
    links.push(from < to ? [from, to] : [to, from]);
  }

  const iterationCount = options.iterations ?? GRAPH_NODE_TICKS;
  const linkStiffness = groups.length ? GRAPH_LINK_STIFFNESS_GROUPED : GRAPH_LINK_STIFFNESS_PLAIN;
  for (let tick = 0; tick < iterationCount; tick += 1) {
    const dx = new Float64Array(nodeCount);
    const dy = new Float64Array(nodeCount);
    const cooling = 0.45 + 0.55 * (1 - tick / iterationCount);
    for (let left = 0; left < nodeCount; left += 1) {
      const stiffness = groupsOfNode[left].length
        ? GRAPH_MEMBER_STIFFNESS
        : groups.length
          ? 0.009
          : 0.018;
      dx[left] += (targetX[left] - x[left]) * stiffness;
      dy[left] += (targetY[left] - y[left]) * stiffness;
      for (let right = left + 1; right < nodeCount; right += 1) {
        if (groups.length && componentOfNode[left] !== componentOfNode[right]) continue;
        let vx = x[right] - x[left];
        let vy = y[right] - y[left];
        const distanceSquared = vx * vx + vy * vy;
        if (distanceSquared > GRAPH_NODE_SPACING * GRAPH_NODE_SPACING) continue;
        let distance = Math.sqrt(distanceSquared);
        if (distance < 1e-8) {
          [vx, vy] = direction(`${sortedNodes[left].id}|${sortedNodes[right].id}`);
          distance = 1;
        }
        const strength = (GRAPH_NODE_SPACING - distance) * 0.18;
        dx[left] -= (vx / distance) * strength;
        dy[left] -= (vy / distance) * strength;
        dx[right] += (vx / distance) * strength;
        dy[right] += (vy / distance) * strength;
      }
    }
    for (const [left, right] of links) {
      const vx = x[right] - x[left];
      const vy = y[right] - y[left];
      const distance = Math.max(1e-8, Math.hypot(vx, vy));
      const force = (distance - GRAPH_LINK_LENGTH) * linkStiffness;
      dx[left] += (vx / distance) * force;
      dy[left] += (vy / distance) * force;
      dx[right] -= (vx / distance) * force;
      dy[right] -= (vy / distance) * force;
    }
    for (let index = 0; index < nodeCount; index += 1) {
      const length = Math.hypot(dx[index], dy[index]);
      const step = Math.min(1, 12 / Math.max(1e-8, length)) * cooling;
      x[index] += dx[index] * step;
      y[index] += dy[index] * step;
    }
  }

  // 分组模式：按连通分量做确定性棚架打包，尽量填满画布比例，不再围成一个环。
  if (groups.length) {
    const buckets = new Map<number, number[]>();
    for (let index = 0; index < nodeCount; index += 1) {
      const component = componentOfNode[index];
      const bucket = buckets.get(component) ?? [];
      bucket.push(index);
      buckets.set(component, bucket);
    }
    const boxPadding = 70;
    const boxes = [...buckets.entries()]
      .map(([component, indices]) => {
        const minX = Math.min(...indices.map((index) => x[index]));
        const minY = Math.min(...indices.map((index) => y[index]));
        return {
          key: String(component),
          indices,
          minX,
          minY,
          width: Math.max(1, ...indices.map((index) => x[index] - minX)) + boxPadding,
          height: Math.max(1, ...indices.map((index) => y[index] - minY)) + boxPadding,
        };
      })
      .sort((left, right) => right.height - left.height || compareId(left.key, right.key));

    let best: {
      score: number;
      placements: Array<{ box: (typeof boxes)[number]; left: number; top: number }>;
    } | null = null;
    const maxWidth = Math.max(...boxes.map((box) => box.width));
    const sumWidth = boxes.reduce((sum, box) => sum + box.width, 0);
    for (let trial = 0; trial < 24; trial += 1) {
      const limit = maxWidth + ((sumWidth - maxWidth) * trial) / 23;
      let left = 0;
      let top = 0;
      let rowHeight = 0;
      let width = 0;
      const placements: Array<{ box: (typeof boxes)[number]; left: number; top: number }> = [];
      for (const box of boxes) {
        if (left && left + box.width > limit) {
          top += rowHeight;
          left = 0;
          rowHeight = 0;
        }
        placements.push({ box, left, top });
        width = Math.max(width, left + box.width);
        left += box.width;
        rowHeight = Math.max(rowHeight, box.height);
      }
      const height = top + rowHeight;
      const score =
        width * height * (1 + 0.65 * Math.abs(Math.log(width / Math.max(1, height) / aspect)));
      if (!best || score < best.score) best = { score, placements };
    }
    const componentOffsets = new Map<number, { x: number; y: number }>();
    for (const { box, left, top } of best?.placements ?? []) {
      const dx = left + boxPadding / 2 - box.minX;
      const dy = top + boxPadding / 2 - box.minY;
      componentOffsets.set(Number(box.key), { x: dx, y: dy });
      for (const index of box.indices) {
        x[index] += dx;
        y[index] += dy;
      }
    }
    // 锚点跟着它所在的分量一起平移，否则返回的锚点还停在被打包之前的位置。
    for (let index = 0; index < groups.length; index += 1) {
      const offset = componentOffsets.get(componentOfGroup[index]);
      if (!offset) continue;
      anchorX[index] += offset.x;
      anchorY[index] += offset.y;
    }
  }

  // 手动固定优先于自动几何；固定点不参与重新排布，也不会被静默丢弃。
  // 自适应边界只取自动落点：拖动节点不该让相机跟着跑。
  const placed = { x: [...x], y: [...y] };
  for (let index = 0; index < nodeCount; index += 1) {
    const pin = options.pins?.[sortedNodes[index].id];
    if (!pin) continue;
    x[index] = pin.x;
    y[index] = pin.y;
  }

  const placements: GraphLayoutNode[] = sortedNodes.map((node, index) => ({
    id: node.id,
    x: rounded(x[index]),
    y: rounded(y[index]),
  }));
  const groupPlacements: GraphLayoutGroupPlacement[] = groups.map((group, index) => ({
    id: group.id,
    memberIds: [...group.memberIds].sort(compareId),
    x: rounded(anchorX[index]),
    y: rounded(anchorY[index]),
    radius: anchorRadius[index],
  }));

  const xs = placed.x;
  const ys = placed.y;
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const margin = 40;
  return {
    nodes: placements,
    groups: groupPlacements,
    bounds: {
      x: minX - margin,
      y: minY - margin,
      width: Math.max(1, maxX - minX) + margin * 2,
      height: Math.max(1, maxY - minY) + margin * 2,
    },
    aspect,
  };
}
