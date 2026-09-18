import { describe, expect, it } from "vitest";
import {
  DEFAULT_FIT_PADDING,
  MAX_FIT_SCALE,
  absoluteZoomLimits,
  boundsOfPoints,
  expandBounds,
  fitCamera,
  panCamera,
  screenPoint,
  screenToWorldLength,
  unionBounds,
  worldPoint,
  zoomCamera,
} from "./graph-camera";

describe("boundsOfPoints", () => {
  it("包住所有点并按 padding 外扩", () => {
    expect(
      boundsOfPoints(
        [
          { x: 10, y: 20 },
          { x: -5, y: 40 },
        ],
        5,
      ),
    ).toEqual({
      x: -10,
      y: 15,
      width: 25,
      height: 30,
    });
  });

  it("空点集退化成零矩形", () => {
    expect(boundsOfPoints([])).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });
});

describe("expandBounds / unionBounds", () => {
  it("外扩与合并", () => {
    expect(expandBounds({ x: 0, y: 0, width: 10, height: 10 }, 2)).toEqual({
      x: -2,
      y: -2,
      width: 14,
      height: 14,
    });
    expect(
      unionBounds([
        { x: 0, y: 0, width: 10, height: 10 },
        { x: 20, y: -10, width: 10, height: 10 },
      ]),
    ).toEqual({ x: 0, y: -10, width: 30, height: 20 });
  });
});

describe("fitCamera", () => {
  it("把内容居中放进容器", () => {
    const camera = fitCamera({ x: 0, y: 0, width: 200, height: 100 }, 400, 300, 20);
    expect(camera).not.toBeNull();
    // 高度受限：(300-40)/100 = 2.6 → 被 MAX_FIT_SCALE 截到 1.6
    expect(camera!.scale).toBe(MAX_FIT_SCALE);
    const center = screenPoint({ x: 100, y: 50 }, camera!);
    expect(center.x).toBeCloseTo(200, 6);
    expect(center.y).toBeCloseTo(150, 6);
  });

  it("窄容器按宽度适配", () => {
    const camera = fitCamera({ x: 0, y: 0, width: 1000, height: 100 }, 600, 400, 50);
    expect(camera!.scale).toBeCloseTo((600 - 100) / 1000, 6);
    expect(screenPoint({ x: 500, y: 50 }, camera!).x).toBeCloseTo(300, 6);
  });

  it("容器太小或尺寸非法时返回 null", () => {
    expect(fitCamera({ x: 0, y: 0, width: 10, height: 10 }, 40, 400, 42)).toBeNull();
    expect(fitCamera({ x: 0, y: 0, width: 10, height: 10 }, Number.NaN, 400)).toBeNull();
  });

  it("单点内容不会被放大到荒唐比例", () => {
    const camera = fitCamera({ x: 5, y: 5, width: 0, height: 0 }, 1000, 800, 20);
    expect(camera!.scale).toBe(MAX_FIT_SCALE);
    expect(screenPoint({ x: 5, y: 5 }, camera!)).toEqual({ x: 500, y: 400 });
  });
});

describe("zoomCamera", () => {
  const limits = { minScale: 0.5, maxScale: 2 };

  it("以锚点为不动点缩放", () => {
    const camera = { scale: 1, x: 0, y: 0 };
    const anchored = zoomCamera(camera, 1.5, { x: 100, y: 50 }, limits);
    expect(anchored.scale).toBeCloseTo(1.5, 6);
    expect(screenPoint(worldPoint({ x: 100, y: 50 }, camera), anchored)).toEqual({
      x: 100,
      y: 50,
    });
  });

  it("到达上下限后不再变化", () => {
    expect(zoomCamera({ scale: 2, x: 0, y: 0 }, 2, { x: 0, y: 0 }, limits)).toEqual({
      scale: 2,
      x: 0,
      y: 0,
    });
    expect(zoomCamera({ scale: 0.5, x: 0, y: 0 }, 0.5, { x: 0, y: 0 }, limits)).toEqual({
      scale: 0.5,
      x: 0,
      y: 0,
    });
  });
});

describe("坐标换算", () => {
  const camera = { scale: 2, x: 30, y: -10 };

  it("屏幕与世界可以互相还原", () => {
    const world = { x: 12.5, y: -3.25 };
    const screen = screenPoint(world, camera);
    expect(screen).toEqual({ x: 55, y: -16.5 });
    expect(worldPoint(screen, camera)).toEqual(world);
  });

  it("屏幕长度换算成世界长度", () => {
    expect(screenToWorldLength(100, camera)).toBe(50);
  });

  it("平移只改偏移", () => {
    expect(panCamera(camera, 5, 7)).toEqual({ scale: 2, x: 35, y: -3 });
  });

  it("相对倍率换算成绝对范围", () => {
    expect(absoluteZoomLimits(0.5)).toEqual({ minScale: 0.2, maxScale: 2 });
    expect(absoluteZoomLimits(Number.NaN)).toEqual({ minScale: 0.4, maxScale: 4 });
    expect(DEFAULT_FIT_PADDING).toBeGreaterThan(0);
  });
});
