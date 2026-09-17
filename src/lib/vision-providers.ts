export type ProviderKind = "openai" | "gemini";

export interface ProviderPreset {
  id: string;
  name: string;
  kind: ProviderKind;
  /** OpenAI 兼容接口的 API 基址；本机地址会直连、不经过云端。 */
  baseUrl: string;
  model: string;
  apiKey: string;
  /** 通过“看图审查”验证过能够读取图片。 */
  visionVerified?: boolean;
  visionCheckedAt?: number;
  /** 接口实现了 OpenAI `/audio/transcriptions` 协议。 */
  audioCapable?: boolean;
}

/** Stable identity for resuming a run without persisting the credential itself. */
export function providerPresetFingerprint(preset: ProviderPreset) {
  const canonical = JSON.stringify({
    kind: preset.kind,
    baseUrl: preset.baseUrl.replace(/\/+$/, ""),
    model: preset.model.trim(),
  });
  let hash = 2166136261;
  for (const character of canonical) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `${canonical.length}:${(hash >>> 0).toString(36)}`;
}

export const GEMINI_OPENAI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai";
export const GEMINI_DEFAULT_MODEL = "gemini-3.7-flash";
export const DEEPSEEK_OPENAI_BASE_URL = "https://api.deepseek.com/v1";
export const DEEPSEEK_DEFAULT_MODEL = "deepseek-v4-flash";

export const KIND_LABEL: Record<ProviderKind, string> = {
  openai: "OpenAI 兼容接口",
  gemini: "Gemini 兼容接口",
};

/** 本机或局域网内的推理服务（Ollama、LM Studio 等）由设备直连，数据不出本机。 */
export function isLocalEndpoint(preset: Pick<ProviderPreset, "baseUrl">) {
  let hostname: string;
  try {
    hostname = new URL(preset.baseUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") return true;
  return (
    /^10\.\d+\.\d+\.\d+$/.test(hostname) ||
    /^192\.168\.\d+\.\d+$/.test(hostname) ||
    /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(hostname)
  );
}

export function isCloudProvider(preset: ProviderPreset) {
  return !isLocalEndpoint(preset);
}

/**
 * 免费体验档的服务地址。客户端不持有任何模型密钥，请求打到这台中转，
 * 由中转用服务端凭据调用免费模型。换机器时改这一行即可。
 */
export const FREE_TIER_RELAY_URL = "https://u714136-b2a6-8e038495.westc.seetacloud.com:8443";
export const FREE_TIER_PRESET_ID = "zhimai-free-tier";

/**
 * 免费档在界面上是一套配置，但它不写密钥也不让改地址：用哪个模型由服务端按
 * 有没有图片自己挑。`visionVerified` 直接置真，因为中转一定会把带图的请求
 * 送去多模态模型，不需要用户再点一次「审查看图能力」。
 */
export const FREE_TIER_PRESET: ProviderPreset = {
  id: FREE_TIER_PRESET_ID,
  name: "知脉免费体验",
  kind: "openai",
  baseUrl: FREE_TIER_RELAY_URL,
  model: "服务端自动选择",
  apiKey: "",
  visionVerified: true,
};

export function isFreeTierPreset(preset: Pick<ProviderPreset, "id">) {
  return preset.id === FREE_TIER_PRESET_ID;
}

/**
 * 免费档固定排在第一位，并且每次加载都换成上面那份权威定义，
 * 免得用户本地残留的旧地址或旧名字把一个内置档位改坏。
 */
export function withFreeTierPreset(presets: ProviderPreset[]): ProviderPreset[] {
  const rest = presets.filter((preset) => !isFreeTierPreset(preset));
  return [FREE_TIER_PRESET, ...rest];
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
  if (isFreeTierPreset(preset)) {
    throw new Error(
      "免费体验不包含语音转写。录音仍然留在本页，配置一套自己的模型之后回来就能转写。",
    );
  }
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
      // 旧版 Ollama 专用配置转为 OpenAI 兼容接口：本机直连 /v1，能力与密钥标记原样保留。
      if ((preset as { kind?: string }).kind === "ollama") {
        const base = preset.baseUrl.replace(/\/+$/, "");
        return {
          ...preset,
          kind: "openai" as const,
          baseUrl: /\/v\d+$/.test(base) ? base : `${base}/v1`,
        };
      }
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
  return [
    ...(openai.length ? openai : [cloneDefault("openai")]),
    ...(gemini.length ? gemini : [cloneDefault("gemini")]),
  ];
}

export interface ChatTurn {
  role: "user" | "assistant";
  text: string;
  image?: string;
}
