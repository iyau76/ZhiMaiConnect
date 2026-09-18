/**
 * 圈层包络：把「一个人属于哪几个圈层」画成可以重叠的平滑外形。
 *
 * 画出来的区域严格等于「成员凸包 + 四周 padding 的扩张」（渲染时用等宽的圆角描边实现），
 * 于是一条判断规则同时管住两件事：
 *   成员节点中心一定在包络里；非成员节点中心必须离包络足够远。
 *
 * 凸包会误包站在成员围成的多边形内部的人。这种时候不做「看起来差不多」的平滑，
 * 而是把这一层切成几段同色轮廓，逐段复验；最坏情况退到每个成员一个小外形。
 * 分片比把别人圈进「亲属圈」诚实，也保证拖动几个点不会改变任何人的归属。
 */

/** 成员节点符号半径，与布局里的世界半径一致 */
export const CONTOUR_NODE_RADIUS = 16;
/** 成员符号之外的额外余量 */
export const CONTOUR_PADDING = 6;
/** 非成员符号与包络之间要求留出的间隔 */
export const CONTOUR_CLEARANCE = 2;
/** 递归拆分的最大层数，超出就逐个成员分片 */
export const CONTOUR_MAX_SPLIT_DEPTH = 4;

export interface SetContourInput {
  id: string;
  memberIds: string[];
}

export interface SetContourPoint {
  id: string;
  x: number;
  y: number;
}

export type SetContourFragmentKind = "dot" | "capsule" | "hull";

export interface SetContourFragment {
  /** SVG path：点用整圆，两点用线段（圆头描边成胶囊），三点以上用凸包多边形 */
  path: string;
  kind: SetContourFragmentKind;
  memberIds: string[];
  /** 生成 path 的多边形，供校验与命中测试使用 */
  points: Array<{ x: number; y: number }>;
}

export interface SetContour {
  id: string;
  fragments: SetContourFragment[];
  /** 渲染时的扩张半径：描边宽度的一半 */
  padding: number;
  /** 全部片段都通过成员/非成员校验 */
  valid: boolean;
  strategy: "hull" | "split" | "fragment" | "none";
  /** 校验失败的节点 ID，供测试与降级提示使用 */
  violations: string[];
}

export interface SetContourOptions {
  nodeRadius?: number;
  padding?: number;
  clearance?: number;
  maxSplitDepth?: number;
}

type Point = { x: number; y: number };

function compareId(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

const round = (value: number) => Math.round(value * 100) / 100;

/** Andrew 单调链凸包；共线点只保留端点 */
export function convexHull(points: Point[]): Point[] {
  const sorted = [...points].sort((left, right) => left.x - right.x || left.y - right.y);
  if (sorted.length <= 2) return sorted;
  const cross = (origin: Point, a: Point, b: Point) =>
    (a.x - origin.x) * (b.y - origin.y) - (a.y - origin.y) * (b.x - origin.x);
  const lower: Point[] = [];
  for (const point of sorted) {
    while (
      lower.length > 1 &&
      cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0
    ) {
      lower.pop();
    }
    lower.push(point);
  }
  const upper: Point[] = [];
  for (const point of [...sorted].reverse()) {
    while (
      upper.length > 1 &&
      cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0
    ) {
      upper.pop();
    }
    upper.push(point);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

function distanceToSegment(point: Point, start: Point, end: Point) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared < 1e-12) return Math.hypot(point.x - start.x, point.y - start.y);
  const ratio = Math.max(
    0,
    Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared),
  );
  return Math.hypot(point.x - (start.x + ratio * dx), point.y - (start.y + ratio * dy));
}

/** 射线法判断点是否落在多边形内部（一、二元退化情形一律为 false） */
export function pointInPolygon(point: Point, polygon: Point[]) {
  if (polygon.length < 3) return false;
  let inside = false;
  for (
    let index = 0, previous = polygon.length - 1;
    index < polygon.length;
    previous = index, index += 1
  ) {
    const current = polygon[index];
    const before = polygon[previous];
    if (
      current.y > point.y !== before.y > point.y &&
      point.x <
        ((before.x - current.x) * (point.y - current.y)) / (before.y - current.y) + current.x
    ) {
      inside = !inside;
    }
  }
  return inside;
}

/** 点到多边形边界的距离（含退化的一元、二元情形） */
export function distanceToPolygon(point: Point, polygon: Point[]) {
  if (!polygon.length) return Number.POSITIVE_INFINITY;
  if (polygon.length === 1) return Math.hypot(point.x - polygon[0].x, point.y - polygon[0].y);
  let best = Number.POSITIVE_INFINITY;
  for (let index = 0; index < polygon.length; index += 1) {
    const start = polygon[index];
    const end = polygon[(index + 1) % polygon.length];
    if (polygon.length === 2 && index === 1) break;
    best = Math.min(best, distanceToSegment(point, start, end));
  }
  return best;
}

/**
 * 点到「填充区域」的距离：区域内部为 0，外部取到边界的距离。
 * 渲染出来的包络 = 多边形填充 + 半宽 padding 的圆角描边，
 * 所以一条 distanceToRegion ≤ padding 就同时覆盖了填充和扩张。
 */
export function distanceToRegion(point: Point, polygon: Point[]) {
  if (pointInPolygon(point, polygon)) return 0;
  return distanceToPolygon(point, polygon);
}

function pathFor(polygon: Point[], kind: SetContourFragmentKind, padding: number) {
  if (kind === "dot") {
    const { x, y } = polygon[0];
    return `M ${round(x - padding)} ${round(y)} a ${padding} ${padding} 0 1 0 ${padding * 2} 0 a ${padding} ${padding} 0 1 0 ${-padding * 2} 0 Z`;
  }
  const head = `M ${round(polygon[0].x)} ${round(polygon[0].y)}`;
  const rest = polygon
    .slice(1)
    .map((point) => `L ${round(point.x)} ${round(point.y)}`)
    .join(" ");
  return rest ? `${head} ${rest}${kind === "hull" ? " Z" : ""}` : head;
}

interface ContourContext {
  pointsById: Map<string, Point>;
  visible: SetContourPoint[];
  padding: number;
  nodeRadius: number;
  clearance: number;
  maxSplitDepth: number;
}

function validate(
  context: ContourContext,
  memberIds: string[],
  polygon: Point[],
  _kind: SetContourFragmentKind,
) {
  const violations: string[] = [];
  const memberSet = new Set(memberIds);
  for (const personId of memberIds) {
    const point = context.pointsById.get(personId);
    if (!point) continue;
    // 成员自己一定落在多边形上；留在这里是为了在退化数据下也能报出漏包。
    if (distanceToRegion(point, polygon) > context.padding) violations.push(personId);
  }
  const limit = context.padding + context.nodeRadius + context.clearance;
  for (const point of context.visible) {
    if (memberSet.has(point.id)) continue;
    if (distanceToRegion(point, polygon) <= limit) violations.push(point.id);
  }
  return violations;
}

/** 按主方向把成员切成两半，保证递归结果与输入顺序无关 */
function splitMembers(memberIds: string[], pointsById: Map<string, Point>) {
  const withPoints = memberIds
    .map((id) => ({ id, point: pointsById.get(id) }))
    .filter((item): item is { id: string; point: Point } => Boolean(item.point));
  if (withPoints.length < 2) return [withPoints.map((item) => item.id)];
  const centerX = withPoints.reduce((sum, item) => sum + item.point.x, 0) / withPoints.length;
  const centerY = withPoints.reduce((sum, item) => sum + item.point.y, 0) / withPoints.length;
  let xx = 0;
  let xy = 0;
  let yy = 0;
  for (const item of withPoints) {
    const dx = item.point.x - centerX;
    const dy = item.point.y - centerY;
    xx += dx * dx;
    xy += dx * dy;
    yy += dy * dy;
  }
  // 主方向：协方差矩阵最大特征值对应的方向（退化时默认水平）
  const angle =
    Math.abs(xy) < 1e-9 ? (xx >= yy ? 0 : Math.PI / 2) : 0.5 * Math.atan2(2 * xy, xx - yy);
  const axis = { x: Math.cos(angle), y: Math.sin(angle) };
  const sorted = [...withPoints].sort(
    (left, right) =>
      left.point.x * axis.x +
        left.point.y * axis.y -
        (right.point.x * axis.x + right.point.y * axis.y) || compareId(left.id, right.id),
  );
  const half = Math.ceil(sorted.length / 2);
  return [sorted.slice(0, half).map((item) => item.id), sorted.slice(half).map((item) => item.id)];
}

function buildFragments(
  context: ContourContext,
  memberIds: string[],
  depth: number,
): SetContourFragment[] {
  const ordered = [...memberIds].sort(compareId);
  const points = ordered
    .map((id) => context.pointsById.get(id))
    .filter((point): point is Point => Boolean(point));
  if (!points.length) return [];

  const hull = convexHull(points);
  const kind: SetContourFragmentKind =
    hull.length === 1 ? "dot" : hull.length === 2 ? "capsule" : "hull";
  if (!validate(context, ordered, hull, kind).length) {
    return [{ path: pathFor(hull, kind, context.padding), kind, memberIds: ordered, points: hull }];
  }
  // 拆到不能再拆（只剩一个成员）或到达层数上限：每个成员一个小外形，
  // 保留同一圈层 ID，绝不放宽到误包别人。
  if (ordered.length <= 1 || depth >= context.maxSplitDepth) {
    return ordered
      .map((id) => ({ id, point: context.pointsById.get(id) }))
      .filter((item): item is { id: string; point: Point } => Boolean(item.point))
      .map((item) => ({
        path: pathFor([item.point], "dot", context.padding),
        kind: "dot" as const,
        memberIds: [item.id],
        points: [item.point],
      }));
  }
  return splitMembers(ordered, context.pointsById).flatMap((half) =>
    buildFragments(context, half, depth + 1),
  );
}

export function buildSetContours(
  groups: SetContourInput[],
  points: SetContourPoint[],
  options: SetContourOptions = {},
): SetContour[] {
  const nodeRadius = options.nodeRadius ?? CONTOUR_NODE_RADIUS;
  const padding = options.padding ?? nodeRadius + CONTOUR_PADDING;
  const context: ContourContext = {
    pointsById: new Map(points.map((point) => [point.id, { x: point.x, y: point.y }])),
    visible: [...points].sort((left, right) => compareId(left.id, right.id)),
    padding,
    nodeRadius,
    clearance: options.clearance ?? CONTOUR_CLEARANCE,
    maxSplitDepth: options.maxSplitDepth ?? CONTOUR_MAX_SPLIT_DEPTH,
  };

  return [...groups]
    .sort((left, right) => compareId(left.id, right.id))
    .map((group) => {
      const memberIds = [...new Set(group.memberIds)]
        .filter((id) => context.pointsById.has(id))
        .sort(compareId);
      if (!memberIds.length) {
        return {
          id: group.id,
          fragments: [],
          padding,
          valid: true,
          strategy: "none" as const,
          violations: [],
        };
      }
      const fragments = buildFragments(context, memberIds, 0);
      const violations: string[] = [];
      for (const fragment of fragments) {
        violations.push(...validate(context, fragment.memberIds, fragment.points, fragment.kind));
      }
      const strategy: SetContour["strategy"] =
        fragments.length === 1 && fragments[0].kind === "hull"
          ? "hull"
          : fragments.length === memberIds.length && fragments.every((item) => item.kind === "dot")
            ? "fragment"
            : "split";
      return {
        id: group.id,
        fragments,
        padding,
        valid: violations.length === 0,
        strategy,
        violations: [...new Set(violations)],
      };
    });
}

/** 点到某一层包络的距离；≤ padding 就是落在包络里 */
export function contourDistance(contour: SetContour, point: Point) {
  if (!contour.fragments.length) return Number.POSITIVE_INFINITY;
  return Math.min(...contour.fragments.map((fragment) => distanceToRegion(point, fragment.points)));
}

/** 成员中心必须在包络内，非成员中心必须离包络至少一个符号半径 */
export function contourVerdict(
  contour: SetContour,
  point: Point,
  nodeRadius = CONTOUR_NODE_RADIUS,
) {
  const distance = contourDistance(contour, point);
  if (distance <= contour.padding) return "inside" as const;
  if (distance <= contour.padding + nodeRadius) return "touching" as const;
  return "outside" as const;
}
