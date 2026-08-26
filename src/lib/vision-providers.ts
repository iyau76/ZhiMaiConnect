export type ProviderKind = "lovable" | "ollama" | "openai";

export interface ProviderPreset {
  id: string;
  name: string;
  kind: ProviderKind;
  /** Ollama: http://localhost:11434 · OpenAI 兼容: https://api.deepseek.com/v1 */
  baseUrl: string;
  model: string;
  apiKey: string;
  /** 通过「看图审查」验证过能读图 */
  visionVerified?: boolean;
  visionCheckedAt?: number;
  /** 这个接口带语音转写（/audio/transcriptions），可用于录音 */
  audioCapable?: boolean;
}

/** 能不能读图：Lovable 内置模型都支持；其它必须通过审查才算数 */
export function supportsVision(preset: ProviderPreset) {
  if (preset.kind === "lovable") return true;
  return preset.visionVerified === true;
}

/** 能不能转写音频：Lovable 内置支持；自定义接口需手动标记 */
export function supportsAudio(preset: ProviderPreset) {
  if (preset.kind === "lovable") return true;
  return preset.kind === "openai" && Boolean(preset.baseUrl) && preset.audioCapable === true;
}

export function assertVision(preset: ProviderPreset) {
  if (supportsVision(preset)) return;
  throw new Error(
    `辅助模型「${preset.name}」还没有通过看图审查，不能用来分析图片。请到「模型」里点“审查看图能力”，或换一个多模态模型。`,
  );
}

export function assertAudio(preset: ProviderPreset) {
  if (supportsAudio(preset)) return;
  throw new Error(
    `辅助模型「${preset.name}」没有标记为支持语音转写，不能用来处理录音。请到「模型」里勾选“支持语音转写”，或改用 Lovable AI。`,
  );
}


export const LOVABLE_MODELS = [
  { id: "google/gemini-3.6-flash", label: "Gemini 3.6 Flash（推荐，快且看图强）" },
  { id: "google/gemini-3.1-pro-preview", label: "Gemini 3.1 Pro（更强推理，较慢）" },
  { id: "google/gemini-3.1-flash-lite", label: "Gemini 3.1 Flash Lite（最省）" },
  { id: "openai/gpt-5.4", label: "GPT-5.4" },
  { id: "openai/gpt-5.4-mini", label: "GPT-5.4 Mini" },
] as const;

export const KIND_LABEL: Record<ProviderKind, string> = {
  lovable: "Lovable AI（内置，免配置）",
  ollama: "Ollama（本地）",
  openai: "OpenAI 兼容接口",
};

/** 这些接口是纯文本模型，看不了图 —— 界面上要提示用户 */
export const TEXT_ONLY_HINTS = ["deepseek", "moonshot", "qwen-plus", "qwen-turbo"];

export function looksTextOnly(preset: ProviderPreset) {
  if (preset.kind !== "openai") return false;
  const haystack = `${preset.baseUrl} ${preset.model}`.toLowerCase();
  return TEXT_ONLY_HINTS.some((hint) => haystack.includes(hint));
}

export function createPreset(kind: ProviderKind): ProviderPreset {
  const base: ProviderPreset = {
    id: crypto.randomUUID(),
    name: KIND_LABEL[kind],
    kind,
    baseUrl: "",
    model: "",
    apiKey: "",
  };
  if (kind === "lovable") return { ...base, name: "Lovable AI", model: LOVABLE_MODELS[0].id };
  if (kind === "ollama")
    return { ...base, name: "本地 Ollama", baseUrl: "http://localhost:11434", model: "llava" };
  return {
    ...base,
    name: "自定义接口",
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
  };
}

export const DEFAULT_PRESETS: ProviderPreset[] = [
  {
    id: "builtin-lovable",
    name: "Lovable AI",
    kind: "lovable",
    baseUrl: "",
    model: LOVABLE_MODELS[0].id,
    apiKey: "",
  },
  {
    id: "builtin-ollama",
    name: "本地 Ollama · llava",
    kind: "ollama",
    baseUrl: "http://localhost:11434",
    model: "llava",
    apiKey: "",
  },
];

export interface ChatTurn {
  role: "user" | "assistant";
  text: string;
  image?: string;
}
