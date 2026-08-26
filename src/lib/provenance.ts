/** 信息来源溯源：每条写入库的数据都要标明它是从哪来的 */

import { getLang } from "./i18n";

export type SourceKind =
  /** 人工手动录入 */
  | "manual"
  /** AI 从材料里抽取/整理 */
  | "ai"
  /** 摄像头人脸识别 */
  | "camera"
  /** 录音转写 */
  | "audio"
  /** 声纹比对 */
  | "voice"
  /** 文件导入 */
  | "import"
  /** 联网检索（预留） */
  | "web";

export interface Provenance {
  kind: SourceKind;
  /** 人类可读说明：办案人、文件名、模型名、设备地址等 */
  detail?: string;
  /** 关联记录 id（证据 id / 到访 id） */
  ref?: string;
  at: number;
}

export function makeSource(kind: SourceKind, detail?: string, ref?: string): Provenance {
  return { kind, detail: detail?.trim() || undefined, ref, at: Date.now() };
}

const LABELS: Record<SourceKind, { zh: string; en: string }> = {
  manual: { zh: "人工录入", en: "Manual entry" },
  ai: { zh: "AI 抽取", en: "AI extracted" },
  camera: { zh: "摄像头", en: "Camera" },
  audio: { zh: "录音转写", en: "Transcript" },
  voice: { zh: "声纹比对", en: "Voiceprint" },
  import: { zh: "文件导入", en: "Imported" },
  web: { zh: "联网检索", en: "Web search" },
};

export function sourceLabel(kind: SourceKind): string {
  return LABELS[kind]?.[getLang()] ?? kind;
}

/** 可靠性提示：AI / 声纹属于推断结果，不能直接当证据 */
export function isInferred(kind: SourceKind) {
  return kind === "ai" || kind === "voice" || kind === "web";
}

export function formatSource(source?: Provenance) {
  if (!source) return getLang() === "en" ? "Source unrecorded" : "来源未标注";
  const time = new Date(source.at).toLocaleString();
  return [sourceLabel(source.kind), source.detail, time].filter(Boolean).join(" · ");
}
