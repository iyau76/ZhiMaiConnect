export type ProviderKind = "openai" | "gemini" | "ollama";

export interface ProviderPreset {
  id: string;
  name: string;
  kind: ProviderKind;
  /** Ollama 或 OpenAI 兼容接口的 API 基址。 */
  baseUrl: string;
  model: string;
  apiKey: string;
  /** 通过“看图审查”验证过能够读取图片。 */
  visionVerified?: boolean;
  visionCheckedAt?: number;
  /** 接口实现了 OpenAI `/audio/transcriptions` 协议。 */
  audioCapable?: boolean;
}

export const GEMINI_OPENAI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai";
export const GEMINI_DEFAULT_MODEL = "gemini-3.7-flash";
export const DEEPSEEK_OPENAI_BASE_URL = "https://api.deepseek.com/v1";
export const DEEPSEEK_DEFAULT_MODEL = "deepseek-v4-flash";

export const KIND_LABEL: Record<ProviderKind, string> = {
  openai: "OpenAI 兼容接口",
  gemini: "Gemini 兼容接口",
  ollama: "Ollama（本地）",
};

export function isCloudProvider(preset: ProviderPreset) {
  return preset.kind === "openai" || preset.kind === "gemini";
}

function isOfficialGeminiPreset(preset: ProviderPreset) {
  if (preset.kind !== "gemini") return false;
  try {
    return (
      new URL(preset.baseUrl).toString().replace(/\/+$/, "") === GEMINI_OPENAI_BASE_URL &&
      preset.model.trim() === GEMINI_DEFAULT_MODEL
    );
  } catch {
    return false;
  }
}

export function supportsVision(preset: ProviderPreset) {
  return isOfficialGeminiPreset(preset) || preset.visionVerified === true;
}

export function supportsAudio(preset: ProviderPreset) {
  return preset.kind === "openai" && Boolean(preset.baseUrl) && preset.audioCapable === true;
}

export function assertVision(preset: ProviderPreset) {
  if (supportsVision(preset)) return;
  throw new Error(
    `辅助模型“${preset.name}”还没有通过看图审查，不能用来分析图片。请到“模型配置”里点击“审查看图能力”，或换一个多模态模型。`,
  );
}

export function assertAudio(preset: ProviderPreset) {
  if (supportsAudio(preset)) return;
  throw new Error(
    `模型配置“${preset.name}”未启用 OpenAI 兼容语音转写。请换用支持 /audio/transcriptions 的接口并启用语音转写。`,
  );
}

/** 这些常见模型通常只处理文本；界面据此提醒用户先做看图审查。 */
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
  if (kind === "gemini") {
    return {
      ...base,
      baseUrl: GEMINI_OPENAI_BASE_URL,
      model: GEMINI_DEFAULT_MODEL,
    };
  }
  if (kind === "ollama") {
    return {
      ...base,
      name: "本地 Ollama",
      baseUrl: "http://localhost:11434",
      model: "llava",
    };
  }
  return {
    ...base,
    baseUrl: DEEPSEEK_OPENAI_BASE_URL,
    model: DEEPSEEK_DEFAULT_MODEL,
  };
}

export const DEFAULT_PRESETS: ProviderPreset[] = [
  {
    id: "builtin-openai",
    name: "OpenAI 兼容接口",
    kind: "openai",
    baseUrl: DEEPSEEK_OPENAI_BASE_URL,
    model: DEEPSEEK_DEFAULT_MODEL,
    apiKey: "",
  },
  {
    id: "builtin-gemini",
    name: "Gemini 兼容接口",
    kind: "gemini",
    baseUrl: GEMINI_OPENAI_BASE_URL,
    model: GEMINI_DEFAULT_MODEL,
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

function cloneDefault(kind: ProviderKind): ProviderPreset {
  const preset = DEFAULT_PRESETS.find((item) => item.kind === kind);
  if (!preset) throw new Error(`缺少 ${kind} 默认配置`);
  return { ...preset };
}

/**
 * 将旧版 Lovable 模型配置一次性迁移到新的 provider 契约。
 * 只在配置版本升级时调用，避免用户主动删除的配置在下次启动时重新出现。
 */
export function migrateLegacyProviderPresets(value: unknown): ProviderPreset[] {
  const source = Array.isArray(value) ? value : [];
  const retained = source
    .filter((item): item is ProviderPreset => {
      if (!item || typeof item !== "object") return false;
      const kind = (item as { kind?: unknown }).kind;
      return kind === "openai" || kind === "gemini" || kind === "ollama";
    })
    .map((preset) => {
      const name = preset.name.trim();
      let model = preset.model;
      try {
        if (
          preset.kind === "openai" &&
          new URL(preset.baseUrl).hostname === "api.deepseek.com" &&
          model.trim() === "deepseek-chat"
        ) {
          model = DEEPSEEK_DEFAULT_MODEL;
        }
      } catch {
        // Invalid custom URLs remain editable in the UI; connection testing reports the error.
      }
      if (preset.kind === "openai" && (name === "自定义接口" || name === "OpenAI兼容接口")) {
        return { ...preset, name: KIND_LABEL.openai, model };
      }
      if (preset.kind === "gemini" && name.replace(/\s+/gu, "") === "Gemini兼容接口") {
        return { ...preset, name: KIND_LABEL.gemini, model };
      }
      return model === preset.model ? preset : { ...preset, model };
    });

  const openai = retained.filter((item) => item.kind === "openai");
  const gemini = retained.filter((item) => item.kind === "gemini");
  const ollama = retained.filter((item) => item.kind === "ollama");
  return [
    ...(openai.length ? openai : [cloneDefault("openai")]),
    ...(gemini.length ? gemini : [cloneDefault("gemini")]),
    ...ollama,
  ];
}

export interface ChatTurn {
  role: "user" | "assistant";
  text: string;
  image?: string;
}
