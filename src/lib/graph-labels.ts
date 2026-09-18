/**
 * 屏幕空间标签放置：字号固定成 CSS px，位置随相机移动。
 *
 * 名字放不下时宁可不显示，也不缩小字号或者盖住别人；选中、搜索命中和键盘焦点
 * 永远优先。算法是确定性的贪心：按优先级与稳定 ID 排序，逐个尝试 8 个候选位置。
 */

export interface ScreenLabelItem {
  id: string;
  /** 节点在屏幕上的位置 */
  x: number;
  y: number;
  text: string;
  /** 候选位置与节点中心的距离，通常取节点屏幕半径 + 少量间距 */
  offset?: number;
  /** 越小越先放；同一优先级按 id 排序 */
  priority?: number;
}

export interface ScreenLabelBox {
  id: string;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** 命中的候选序号，用于轻微平移时的位置延续 */
  candidate: number;
}

export interface ScreenRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PlaceScreenLabelsOptions {
  items: ScreenLabelItem[];
  /** 视口尺寸（CSS px） */
  width: number;
  height: number;
  /** 文字宽度测量，由调用方用真实字体测量后传入 */
  measure: (text: string) => number;
  fontSize?: number;
  /** 视口四周留白 */
  margin?: number;
  /** 已被占用的矩形：节点符号、工具栏、图例等 */
  obstacles?: ScreenRect[];
  /** 上一次的候选序号，轻微平移或缩放时优先沿用，避免闪烁 */
  previous?: Record<string, number>;
  /**
   * 只接受前 N 个候选位（8 个候选依次是下、上、右、左、四个斜向）。
   * 人多时收紧上限：宁可少显示几个名字，也不把标签甩到离节点很远的地方。
   */
  maxCandidateIndex?: number;
  /**
   * 被标注的节点之间至少留出的屏幕距离。
   * 密的地方自动少显示几个名字；放大以后间距变大，名字自己回来。
   * 优先级为负的项（选中、搜索命中、集合标题）不受这条限制。
   */
  minAnchorDistance?: number;
}

export interface PlaceScreenLabelsResult {
  placed: ScreenLabelBox[];
  hidden: string[];
  candidates: Record<string, number>;
}

const DEFAULT_FONT_SIZE = 12;
const DEFAULT_MARGIN = 4;
const BOX_PADDING_X = 4;
const BOX_PADDING_Y = 3;

function intersects(a: ScreenRect, b: ScreenRect) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

function measureTextWidth(measure: (text: string) => number, text: string) {
  const width = measure(text);
  return Number.isFinite(width) && width > 0 ? width : text.length * DEFAULT_FONT_SIZE;
}

/** 八个候选位置：下、上、右、左，然后是四个斜向。 */
function candidateRects(
  item: ScreenLabelItem,
  width: number,
  height: number,
  offset: number,
): ScreenRect[] {
  const halfWidth = width / 2;
  return [
    { x: item.x - halfWidth, y: item.y + offset, width, height },
    { x: item.x - halfWidth, y: item.y - offset - height, width, height },
    { x: item.x + offset, y: item.y - height / 2, width, height },
    { x: item.x - offset - width, y: item.y - height / 2, width, height },
    { x: item.x + offset * 0.7, y: item.y + offset * 0.7, width, height },
    { x: item.x - offset * 0.7 - width, y: item.y + offset * 0.7, width, height },
    { x: item.x + offset * 0.7, y: item.y - offset * 0.7 - height, width, height },
    { x: item.x - offset * 0.7 - width, y: item.y - offset * 0.7 - height, width, height },
  ];
}

/**
 * 用真实字体测量文字宽度。画布测量不可用时退化成按字数估算，
 * 这样服务端渲染、无 Canvas 的测试环境也不会崩。
 */
export function createTextMeasurer(fontFamily: string) {
  let context: CanvasRenderingContext2D | null | undefined;
  return (text: string, fontSize: number) => {
    if (context === undefined) {
      try {
        context = document.createElement("canvas").getContext("2d");
      } catch {
        context = null;
      }
    }
    if (!context) return text.length * fontSize * 0.95;
    context.font = `${fontSize}px ${fontFamily}`;
    return context.measureText(text).width;
  };
}

export function placeScreenLabels(options: PlaceScreenLabelsOptions): PlaceScreenLabelsResult {
  const fontSize = options.fontSize ?? DEFAULT_FONT_SIZE;
  const margin = options.margin ?? DEFAULT_MARGIN;
  const height = fontSize + BOX_PADDING_Y * 2;
  const placedBoxes: ScreenRect[] = [...(options.obstacles ?? [])];
  const placed: ScreenLabelBox[] = [];
  const hidden: string[] = [];
  const candidates: Record<string, number> = {};
  const labelledAnchors: Array<{ x: number; y: number }> = [];

  const items = [...options.items].sort(
    (left, right) =>
      (left.priority ?? 0) - (right.priority ?? 0) ||
      (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
  );

  for (const item of items) {
    const minAnchorDistance = options.minAnchorDistance ?? 0;
    if (
      minAnchorDistance > 0 &&
      (item.priority ?? 0) >= 0 &&
      labelledAnchors.some(
        (anchor) => Math.hypot(anchor.x - item.x, anchor.y - item.y) < minAnchorDistance,
      )
    ) {
      hidden.push(item.id);
      continue;
    }
    const width = measureTextWidth(options.measure, item.text) + BOX_PADDING_X * 2;
    const offset = item.offset ?? fontSize + 4;
    const rects = candidateRects(item, width, height, offset);
    const order = rects.map((_, index) => index);
    const previousIndex = options.previous?.[item.id];
    if (previousIndex !== undefined && previousIndex >= 0 && previousIndex < rects.length) {
      order.splice(order.indexOf(previousIndex), 1);
      order.unshift(previousIndex);
    }
    let chosen = -1;
    const limit = Math.min(options.maxCandidateIndex ?? rects.length - 1, rects.length - 1);
    for (const index of order) {
      if (index > limit) continue;
      const rect = rects[index];
      if (rect.x < margin || rect.y < margin) continue;
      if (rect.x + rect.width > options.width - margin) continue;
      if (rect.y + rect.height > options.height - margin) continue;
      if (placedBoxes.some((box) => intersects(box, rect))) continue;
      chosen = index;
      placedBoxes.push(rect);
      break;
    }
    if (chosen < 0) {
      hidden.push(item.id);
      continue;
    }
    const rect = rects[chosen];
    candidates[item.id] = chosen;
    labelledAnchors.push({ x: item.x, y: item.y });
    placed.push({
      id: item.id,
      text: item.text,
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      candidate: chosen,
    });
  }

  return { placed, hidden, candidates };
}
