/**
 * 关系图的相机：世界坐标 → 屏幕坐标的唯一换算处。
 *
 * SVG 的 viewBox 直接使用容器的 CSS 像素尺寸，于是画布单位就是屏幕单位：
 * 世界里的几何经过相机变换落到屏幕上，文字则直接用 CSS px 绘制，不再随世界缩放变小。
 * 这里只有纯算术，不读 DOM，方便单测和确定性验证。
 */

export interface GraphCamera {
  /** 世界 1 单位对应多少 CSS px */
  scale: number;
  /** 世界原点在屏幕上的位置 */
  x: number;
  y: number;
}

export interface GraphBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface GraphPoint {
  x: number;
  y: number;
}

/** 计算适应内容时四周留出的屏幕余量（CSS px） */
export const DEFAULT_FIT_PADDING = 42;

/** 单点或近似单点时，避免把内容放大到荒唐的比例 */
export const MAX_FIT_SCALE = 1.6;

export function boundsOfPoints(points: GraphPoint[], padding = 0): GraphBounds {
  if (!points.length) return { x: 0, y: 0, width: 0, height: 0 };
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return {
    x: minX - padding,
    y: minY - padding,
    width: maxX - minX + padding * 2,
    height: maxY - minY + padding * 2,
  };
}

export function expandBounds(bounds: GraphBounds, padding: number): GraphBounds {
  return {
    x: bounds.x - padding,
    y: bounds.y - padding,
    width: bounds.width + padding * 2,
    height: bounds.height + padding * 2,
  };
}

export function unionBounds(items: GraphBounds[]): GraphBounds {
  if (!items.length) return { x: 0, y: 0, width: 0, height: 0 };
  const minX = Math.min(...items.map((item) => item.x));
  const minY = Math.min(...items.map((item) => item.y));
  const maxX = Math.max(...items.map((item) => item.x + item.width));
  const maxY = Math.max(...items.map((item) => item.y + item.height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** 空图或容器太小时返回 null，调用方保留上一帧相机，不要画出错位的内容。 */
export function fitCamera(
  bounds: GraphBounds,
  width: number,
  height: number,
  padding = DEFAULT_FIT_PADDING,
): GraphCamera | null {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  if (width <= padding * 2 || height <= padding * 2) return null;
  const contentWidth = Math.max(1, bounds.width);
  const contentHeight = Math.max(1, bounds.height);
  const scale = Math.min(
    MAX_FIT_SCALE,
    Math.min((width - padding * 2) / contentWidth, (height - padding * 2) / contentHeight),
  );
  if (!Number.isFinite(scale) || scale <= 0) return null;
  return {
    scale,
    x: width / 2 - scale * (bounds.x + bounds.width / 2),
    y: height / 2 - scale * (bounds.y + bounds.height / 2),
  };
}

/** 以屏幕上的一点为锚缩放；anchor 用屏幕坐标，缩放后该点的世界位置保持不动。 */
export function zoomCamera(
  camera: GraphCamera,
  factor: number,
  anchor: GraphPoint,
  limits: { minScale: number; maxScale: number },
): GraphCamera {
  if (!Number.isFinite(factor) || factor <= 0) return camera;
  const scale = Math.min(limits.maxScale, Math.max(limits.minScale, camera.scale * factor));
  if (scale === camera.scale) return camera;
  const ratio = scale / camera.scale;
  return {
    scale,
    x: anchor.x - (anchor.x - camera.x) * ratio,
    y: anchor.y - (anchor.y - camera.y) * ratio,
  };
}

export function screenPoint(point: GraphPoint, camera: GraphCamera): GraphPoint {
  return { x: point.x * camera.scale + camera.x, y: point.y * camera.scale + camera.y };
}

export function worldPoint(point: GraphPoint, camera: GraphCamera): GraphPoint {
  return { x: (point.x - camera.x) / camera.scale, y: (point.y - camera.y) / camera.scale };
}

/** 移动相机（屏幕像素增量） */
export function panCamera(camera: GraphCamera, dx: number, dy: number): GraphCamera {
  return { scale: camera.scale, x: camera.x + dx, y: camera.y + dy };
}

/** 屏幕上的长度换算成世界长度，用于拖动节点等编辑操作。 */
export function screenToWorldLength(length: number, camera: GraphCamera) {
  return length / camera.scale;
}

export interface RelativeZoomLimits {
  /** 相对「适应内容」倍率的缩放范围，1 表示刚好适应 */
  min: number;
  max: number;
}

export const DEFAULT_ZOOM_LIMITS: RelativeZoomLimits = { min: 0.4, max: 4 };

export function absoluteZoomLimits(fitScale: number, limits = DEFAULT_ZOOM_LIMITS) {
  const safe = Number.isFinite(fitScale) && fitScale > 0 ? fitScale : 1;
  return { minScale: safe * limits.min, maxScale: safe * limits.max };
}
