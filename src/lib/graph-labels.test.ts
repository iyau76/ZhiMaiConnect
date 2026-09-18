import { describe, expect, it } from "vitest";
import { placeScreenLabels } from "./graph-labels";

const measure = (text: string) => text.length * 10;

describe("placeScreenLabels", () => {
  it("空间足够时全部显示", () => {
    const result = placeScreenLabels({
      items: [
        { id: "a", x: 100, y: 100, text: "甲" },
        { id: "b", x: 400, y: 300, text: "乙" },
      ],
      width: 600,
      height: 400,
      measure,
    });
    expect(result.placed.map((label) => label.id).sort()).toEqual(["a", "b"]);
    expect(result.hidden).toEqual([]);
  });

  it("放不下的名字隐藏而不是缩小字号", () => {
    const result = placeScreenLabels({
      items: Array.from({ length: 8 }, (_, index) => ({
        id: `p${index}`,
        x: 300 + (index % 2),
        y: 200 + (index % 2),
        text: "同一个位置",
      })),
      width: 600,
      height: 400,
      measure,
    });
    expect(result.placed.length).toBeLessThan(8);
    expect(result.placed.length + result.hidden.length).toBe(8);
  });

  it("优先级高的先占位，且同优先级按 id 稳定排序", () => {
    const items = [
      { id: "b", x: 200, y: 200, text: "乙" },
      { id: "a", x: 200, y: 200, text: "甲" },
      { id: "c", x: 200, y: 200, text: "丙", priority: -1 },
    ];
    const result = placeScreenLabels({ items, width: 600, height: 400, measure });
    expect(result.placed[0].id).toBe("c");
    const reordered = placeScreenLabels({
      items: [...items].reverse(),
      width: 600,
      height: 400,
      measure,
    });
    expect(reordered.placed).toEqual(result.placed);
  });

  it("首选位置被占时改放到别的候选位", () => {
    const result = placeScreenLabels({
      items: [{ id: "a", x: 100, y: 200, text: "甲" }],
      width: 400,
      height: 300,
      measure,
      // 正好占住“下方”这个首选位置
      obstacles: [{ x: 60, y: 210, width: 80, height: 30 }],
    });
    const box = result.placed[0];
    expect(box).toBeDefined();
    expect(box.y).toBeLessThan(200);
    expect(box.x).toBeGreaterThanOrEqual(4);
  });

  it("收紧候选位上限时，宁可不显示也不把名字甩远", () => {
    // 字号 12、测量宽 10 → 盒 18×18，offset 16；下面四个矩形正好占住下/上/右/左
    const blockers = [
      { x: 90, y: 215, width: 20, height: 20 },
      { x: 90, y: 165, width: 20, height: 20 },
      { x: 115, y: 190, width: 20, height: 20 },
      { x: 65, y: 190, width: 20, height: 20 },
    ];
    const loosely = placeScreenLabels({
      items: [{ id: "a", x: 100, y: 200, text: "甲" }],
      width: 400,
      height: 300,
      measure,
      obstacles: blockers,
    });
    expect(loosely.placed).toHaveLength(1);
    expect(loosely.placed[0].candidate).toBeGreaterThan(3);

    const strictly = placeScreenLabels({
      items: [{ id: "a", x: 100, y: 200, text: "甲" }],
      width: 400,
      height: 300,
      measure,
      obstacles: blockers,
      maxCandidateIndex: 3,
    });
    expect(strictly.placed).toHaveLength(0);
    expect(strictly.hidden).toEqual(["a"]);
  });

  it("密的地方自动少显示名字，放大后（间距变大）又回来", () => {
    const dense = [
      { id: "a", x: 100, y: 100, text: "甲" },
      { id: "b", x: 130, y: 100, text: "乙" },
      { id: "c", x: 160, y: 100, text: "丙" },
    ];
    const thinned = placeScreenLabels({
      items: dense,
      width: 600,
      height: 300,
      measure,
      minAnchorDistance: 58,
    });
    expect(thinned.placed.length).toBeLessThan(3);
    expect(thinned.placed.length + thinned.hidden.length).toBe(3);

    // 相机放大后同一批人之间的屏幕距离变大，名字全部回来
    const spread = dense.map((item) => ({ ...item, x: item.x * 2 }));
    const restored = placeScreenLabels({
      items: spread,
      width: 600,
      height: 300,
      measure,
      minAnchorDistance: 58,
    });
    expect(restored.placed).toHaveLength(3);
  });

  it("选中与集合标题不受密度限制，但普通名字要让位", () => {
    const result = placeScreenLabels({
      items: [
        { id: "a", x: 100, y: 100, text: "甲" },
        { id: "b", x: 110, y: 100, text: "乙", priority: -100 },
        { id: "g", x: 120, y: 100, text: "圈层", priority: -50 },
      ],
      width: 600,
      height: 300,
      measure,
      minAnchorDistance: 58,
    });
    expect(result.placed.map((label) => label.id).sort()).toEqual(["b", "g"]);
    expect(result.hidden).toEqual(["a"]);
  });

  it("沿用上一次的候选序号，避免轻微平移时闪动", () => {
    const items = [{ id: "a", x: 300, y: 200, text: "甲" }];
    const first = placeScreenLabels({ items, width: 600, height: 400, measure });
    const moved = [{ id: "a", x: 304, y: 200, text: "甲" }];
    const second = placeScreenLabels({
      items: moved,
      width: 600,
      height: 400,
      measure,
      previous: first.candidates,
    });
    expect(second.placed[0].candidate).toBe(first.placed[0].candidate);

    const blockers = placeScreenLabels({
      items,
      width: 600,
      height: 400,
      measure,
      previous: first.candidates,
      obstacles: first.placed.map((label) => ({ ...label, x: label.x, y: label.y })),
    });
    expect(blockers.placed[0]?.candidate ?? -1).not.toBe(first.placed[0].candidate);
  });
});
