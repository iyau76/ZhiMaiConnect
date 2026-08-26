/** 人脸检测 / 特征提取，全部在浏览器本地跑（MediaPipe BlazeFace + face-api.js） */

import { fastDetect, loadFastDetector } from "./fast-detector";

const MODEL_URL = "https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.15/model";

type FaceApi = typeof import("@vladmandic/face-api");

let apiPromise: Promise<FaceApi> | null = null;

export function loadFaceEngine(onProgress?: (text: string) => void) {

  if (apiPromise) return apiPromise;
  apiPromise = (async () => {
    onProgress?.("正在下载人脸模型…");
    const faceapi = await import("@vladmandic/face-api");
    const tf = faceapi.tf as unknown as {
      setBackend: (name: string) => Promise<boolean>;
      ready: () => Promise<void>;
    };
    await tf.setBackend("webgl").catch(() => tf.setBackend("cpu"));
    await tf.ready();

    // 并行：BlazeFace 检测器（快路）+ face-api 的关键点/特征网（识别）
    await Promise.all([
      loadFastDetector(),
      faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
      faceapi.nets.faceLandmark68TinyNet.loadFromUri(MODEL_URL),
      faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL),
    ]);


    // 预热：先跑一张空图，把 WebGL kernel 编译提前做掉，第一次识别就不会卡好几秒
    try {
      const warm = document.createElement("canvas");
      warm.width = 320;
      warm.height = 320;
      await faceapi.detectAllFaces(
        warm as never,
        new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 }) as never,
      );
    } catch {
      /* 预热失败不影响使用 */
    }

    onProgress?.("模型就绪");
    return faceapi;
  })();
  apiPromise.catch(() => {
    apiPromise = null;
  });
  return apiPromise;
}

let ssdReady: Promise<void> | null = null;
function ensureSsd(faceapi: FaceApi) {
  ssdReady ??= faceapi.nets.ssdMobilenetv1.loadFromUri(MODEL_URL).then(() => undefined);
  return ssdReady;
}


export interface DetectedFace {
  box: { x: number; y: number; width: number; height: number };
  descriptor: number[];
  thumb: string;
}

function loadImage(dataUrl: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("画面解析失败"));
    image.src = dataUrl;
  });
}

function cropThumb(image: HTMLImageElement, box: DetectedFace["box"]) {
  const pad = box.width * 0.25;
  const x = Math.max(0, box.x - pad);
  const y = Math.max(0, box.y - pad);
  const w = Math.min(image.naturalWidth - x, box.width + pad * 2);
  const h = Math.min(image.naturalHeight - y, box.height + pad * 2);
  const canvas = document.createElement("canvas");
  canvas.width = 112;
  canvas.height = 112;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  ctx.drawImage(image, x, y, w, h, 0, 0, 112, 112);
  return canvas.toDataURL("image/jpeg", 0.8);
}

/** 让出主线程一帧，避免连续推理把页面卡死 */
function yieldToUi() {
  return new Promise<void>((resolve) => {
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 0);
  });
}

/** 大图先缩到长边 512，推理量再降一档 */
function toWorkImage(src: HTMLImageElement) {
  const max = 512;
  const long = Math.max(src.naturalWidth, src.naturalHeight);
  if (long <= max) return { source: src as HTMLImageElement | HTMLCanvasElement, scale: 1 };
  const scale = max / long;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(src.naturalWidth * scale);
  canvas.height = Math.round(src.naturalHeight * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) return { source: src as HTMLImageElement | HTMLCanvasElement, scale: 1 };
  ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
  return { source: canvas as HTMLImageElement | HTMLCanvasElement, scale };
}

/** 从一帧 data URL 里检测所有人脸：快路优先，检到就立刻收工 */
export async function detectFaces(dataUrl: string): Promise<{
  faces: DetectedFace[];
  width: number;
  height: number;
}> {
  const faceapi = await loadFaceEngine();
  const image = await loadImage(dataUrl);
  const { source: work, scale } = toWorkImage(image);

  /** 过曝画面：压亮度 + 拉对比度后再试一次 */
  function enhance(src: HTMLImageElement | HTMLCanvasElement) {
    const w = "naturalWidth" in src ? src.naturalWidth : src.width;
    const h = "naturalHeight" in src ? src.naturalHeight : src.height;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return src;
    ctx.filter = "brightness(0.72) contrast(1.6)";
    ctx.drawImage(src as CanvasImageSource, 0, 0, w, h);
    return canvas;
  }

  type Result = { detection: { box: DetectedFace["box"] }; descriptor: Float32Array };
  const results: Result[] = [];

  // —— 快路：MediaPipe BlazeFace 定位（WASM/GPU，单帧十几毫秒），只对裁下来的小图做特征提取
  try {
    let boxes = await fastDetect(work);
    if (!boxes?.length) {
      // 人脸偏小（短距模型漏检）时，放大一倍再试一次，仍然只要一百毫秒左右
      const workW0 = "naturalWidth" in work ? work.naturalWidth : work.width;
      const workH0 = "naturalHeight" in work ? work.naturalHeight : work.height;
      const up = document.createElement("canvas");
      up.width = workW0 * 2;
      up.height = workH0 * 2;
      const upCtx = up.getContext("2d");
      if (upCtx) {
        upCtx.drawImage(work as CanvasImageSource, 0, 0, up.width, up.height);
        const upBoxes = await fastDetect(up);
        boxes =
          upBoxes?.map((b) => ({
            x: b.x / 2,
            y: b.y / 2,
            width: b.width / 2,
            height: b.height / 2,
          })) ?? null;

      }
    }
    if (boxes && boxes.length) {

      const workW = "naturalWidth" in work ? work.naturalWidth : work.width;
      const workH = "naturalHeight" in work ? work.naturalHeight : work.height;
      for (const b of boxes) {
        const pad = Math.max(b.width, b.height) * 0.35;
        const sx = Math.max(0, b.x - pad);
        const sy = Math.max(0, b.y - pad);
        const sw = Math.min(workW - sx, b.width + pad * 2);
        const sh = Math.min(workH - sy, b.height + pad * 2);
        if (sw < 24 || sh < 24) continue;
        const crop = document.createElement("canvas");
        crop.width = 224;
        crop.height = 224;
        const ctx = crop.getContext("2d");
        if (!ctx) continue;
        ctx.drawImage(work as CanvasImageSource, sx, sy, sw, sh, 0, 0, 224, 224);
        // eslint-disable-next-line no-await-in-loop
        const single = (await faceapi
          .detectSingleFace(
            crop as never,
            new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.15 }) as never,
          )
          .withFaceLandmarks(true)
          .withFaceDescriptor()) as unknown as { descriptor: Float32Array } | undefined;
        const descriptor =
          single?.descriptor ??
          ((await faceapi.computeFaceDescriptor(crop as never)) as unknown as Float32Array);
        if (!descriptor) continue;
        results.push({ detection: { box: { x: b.x, y: b.y, width: b.width, height: b.height } }, descriptor });
      }
      if (results.length) {
        return {
          width: image.naturalWidth,
          height: image.naturalHeight,
          faces: results.map((result) => {
            const box = {
              x: result.detection.box.x / scale,
              y: result.detection.box.y / scale,
              width: result.detection.box.width / scale,
              height: result.detection.box.height / scale,
            };
            return { box, descriptor: Array.from(result.descriptor), thumb: cropThumb(image, box) };
          }),
        };
      }
    }
  } catch {
    /* 快路失败就走下面的 face-api 兜底 */
  }



  function iou(a: DetectedFace["box"], b: DetectedFace["box"]) {
    const x1 = Math.max(a.x, b.x);
    const y1 = Math.max(a.y, b.y);
    const x2 = Math.min(a.x + a.width, b.x + b.width);
    const y2 = Math.min(a.y + a.height, b.y + b.height);
    const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    if (!inter) return 0;
    return inter / (a.width * a.height + b.width * b.height - inter);
  }

  let enhanced: HTMLImageElement | HTMLCanvasElement | null = null;
  const passes: Array<
    () => Promise<{ source: HTMLImageElement | HTMLCanvasElement; options: unknown }>
  > = [
    // 兜底 1：Tiny 小输入，便宜
    async () => ({
      source: work,
      options: new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.3 }),
    }),
    // 兜底 2：过曝/逆光时压亮度再来一次，仍然是便宜的 Tiny
    async () => ({
      source: (enhanced ??= enhance(work)),
      options: new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.25 }),
    }),
    // 兜底 3：最后才动用 SSD（体积大、最慢），到这里才按需下载
    async () => {
      await ensureSsd(faceapi);
      return {
        source: work,
        options: new faceapi.SsdMobilenetv1Options({ minConfidence: 0.2, maxResults: 10 }),
      };

    },
  ];

  for (let i = 0; i < passes.length; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const { source, options } = await passes[i]();
    // eslint-disable-next-line no-await-in-loop
    const found = (await faceapi
      .detectAllFaces(source as never, options as never)
      .withFaceLandmarks(true)
      .withFaceDescriptors()) as unknown as Result[];
    for (const item of found) {
      if (results.some((existing) => iou(existing.detection.box, item.detection.box) > 0.35)) continue;
      results.push(item);
    }
    // 检到人脸立刻收工，后面的增强重试只服务于「一无所获」的情况
    if (results.length > 0) break;
    // eslint-disable-next-line no-await-in-loop
    await yieldToUi();
  }


  return {
    width: image.naturalWidth,
    height: image.naturalHeight,
    faces: results.map((result) => {
      const box = {
        x: result.detection.box.x / scale,
        y: result.detection.box.y / scale,
        width: result.detection.box.width / scale,
        height: result.detection.box.height / scale,
      };
      return { box, descriptor: Array.from(result.descriptor), thumb: cropThumb(image, box) };
    }),
  };
}


export function distance(a: number[], b: number[]) {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += (a[i] - b[i]) ** 2;
  return Math.sqrt(sum);
}

/** 在人员库里找最接近的一个人 */
export function findMatch(
  descriptor: number[],
  people: Array<{ id: string; name: string; descriptors: number[][] }>,
  threshold: number,
) {
  let best: { id: string; name: string; distance: number } | null = null;
  for (const person of people) {
    for (const sample of person.descriptors) {
      const d = distance(descriptor, sample);
      if (!best || d < best.distance) best = { id: person.id, name: person.name, distance: d };
    }
  }
  if (!best) return null;
  return best.distance <= threshold ? best : { ...best, id: "", name: "" };
}
