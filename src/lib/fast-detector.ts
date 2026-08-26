/** MediaPipe BlazeFace 短距检测器：WASM + SIMD，CPU 上单帧 10~30ms */

const WASM_ROOT = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.0/wasm";
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite";

type Detector = import("@mediapipe/tasks-vision").FaceDetector;

let detectorPromise: Promise<Detector | null> | null = null;

export function loadFastDetector() {
  detectorPromise ??= (async () => {
    try {
      const vision = await import("@mediapipe/tasks-vision");
      const fileset = await vision.FilesetResolver.forVisionTasks(WASM_ROOT);
      return await vision.FaceDetector.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" },
        runningMode: "IMAGE",
        minDetectionConfidence: 0.4,
      });
    } catch {
      // GPU 不可用或加载失败时退回 CPU，再失败就交给 face-api 兜底
      try {
        const vision = await import("@mediapipe/tasks-vision");
        const fileset = await vision.FilesetResolver.forVisionTasks(WASM_ROOT);
        return await vision.FaceDetector.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: MODEL_URL, delegate: "CPU" },
          runningMode: "IMAGE",
          minDetectionConfidence: 0.4,
        });
      } catch {
        return null;
      }
    }
  })();
  detectorPromise.catch(() => {
    detectorPromise = null;
  });
  return detectorPromise;
}

export interface FastBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 返回原图坐标系下的人脸框；检测器不可用时返回 null（调用方走兜底） */
export async function fastDetect(
  source: HTMLImageElement | HTMLCanvasElement,
): Promise<FastBox[] | null> {
  const detector = await loadFastDetector();
  if (!detector) return null;
  const result = detector.detect(source as unknown as HTMLImageElement);
  return result.detections
    .map((d) => d.boundingBox)
    .filter(Boolean)
    .map((b) => ({
      x: b!.originX,
      y: b!.originY,
      width: b!.width,
      height: b!.height,
    }));
}
