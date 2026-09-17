import { describe, expect, it } from "vitest";

import {
  DEFAULT_PRESETS,
  DEEPSEEK_DEFAULT_MODEL,
  DEEPSEEK_OPENAI_BASE_URL,
  FREE_TIER_PRESET,
  FREE_TIER_PRESET_ID,
  FREE_TIER_RELAY_URL,
  GEMINI_DEFAULT_MODEL,
  GEMINI_OPENAI_BASE_URL,
  isFreeTierPreset,
  isLocalEndpoint,
  migrateLegacyProviderPresets,
  supportsAudio,
  supportsVision,
  withFreeTierPreset,
} from "./vision-providers";

describe("vision provider presets", () => {
  it("puts OpenAI compatibility first and configures current Gemini Flash", () => {
    expect(DEFAULT_PRESETS.map((preset) => preset.kind)).toEqual(["openai", "gemini"]);
    expect(DEFAULT_PRESETS[1]).toMatchObject({
      baseUrl: GEMINI_OPENAI_BASE_URL,
      model: GEMINI_DEFAULT_MODEL,
    });
    expect(GEMINI_DEFAULT_MODEL).toBe("gemini-3.7-flash");
    expect(supportsVision(DEFAULT_PRESETS[1]!)).toBe(true);
    expect(DEFAULT_PRESETS[0]).toMatchObject({
      baseUrl: DEEPSEEK_OPENAI_BASE_URL,
      model: DEEPSEEK_DEFAULT_MODEL,
    });
  });

  it("keeps the official free tier first without a credential the client has to hold", () => {
    expect(isFreeTierPreset(FREE_TIER_PRESET)).toBe(true);
    expect(FREE_TIER_PRESET.apiKey).toBe("");
    expect(FREE_TIER_PRESET.baseUrl).toBe(FREE_TIER_RELAY_URL);
    // 中转按有没有图片自己挑模型，所以带图任务不该被「未验证看图能力」拦下。
    expect(supportsVision(FREE_TIER_PRESET)).toBe(true);
    // 免费额度只覆盖文字与图片，录音仍需要用户自己的接口。
    expect(supportsAudio(FREE_TIER_PRESET)).toBe(false);
  });

  it("always restores the authoritative free tier and never lets it be dropped", () => {
    const stale = {
      ...FREE_TIER_PRESET,
      name: "被改过的名字",
      baseUrl: "https://old.example.com",
      apiKey: "leftover",
    };
    const merged = withFreeTierPreset([
      { ...DEFAULT_PRESETS[0]! },
      stale,
      { ...DEFAULT_PRESETS[1]! },
    ]);

    expect(merged.map((preset) => preset.id)).toEqual([
      FREE_TIER_PRESET_ID,
      DEFAULT_PRESETS[0]!.id,
      DEFAULT_PRESETS[1]!.id,
    ]);
    expect(merged[0]).toEqual(FREE_TIER_PRESET);
    expect(merged.filter((preset) => isFreeTierPreset(preset))).toHaveLength(1);
  });

  it("classifies local inference endpoints without a vendor kind", () => {
    expect(isLocalEndpoint({ baseUrl: "http://localhost:11434/v1" })).toBe(true);
    expect(isLocalEndpoint({ baseUrl: "http://127.0.0.1:1234/v1" })).toBe(true);
    expect(isLocalEndpoint({ baseUrl: "http://192.168.1.8:8080/v1" })).toBe(true);
    expect(isLocalEndpoint({ baseUrl: "https://ai.example.com/v1" })).toBe(false);
    expect(isLocalEndpoint({ baseUrl: "" })).toBe(false);
  });

  it("removes legacy Lovable presets and preserves user-compatible endpoints", () => {
    const migrated = migrateLegacyProviderPresets([
      { id: "legacy", kind: "lovable", name: "Lovable AI", model: "old" },
      {
        id: "private",
        kind: "openai",
        name: "私有接口",
        baseUrl: "https://ai.example.com/v1",
        model: "private-model",
        apiKey: "",
      },
    ]);

    expect(migrated.some((preset) => (preset as { kind: string }).kind === "lovable")).toBe(false);
    expect(migrated[0]?.id).toBe("private");
    expect(migrated.some((preset) => preset.kind === "gemini")).toBe(true);
  });

  it("converts legacy Ollama presets to local OpenAI-compatible endpoints", () => {
    const migrated = migrateLegacyProviderPresets([
      {
        id: "desk-ollama",
        kind: "ollama",
        name: "办公室 Ollama",
        baseUrl: "http://localhost:11434",
        model: "llava",
        apiKey: "",
        visionVerified: true,
      },
      {
        id: "lan-ollama",
        kind: "ollama",
        name: "内网 Ollama",
        baseUrl: "http://192.168.1.8:11434/v1",
        model: "qwen2.5vl",
        apiKey: "",
      },
    ]);

    const desk = migrated.find((preset) => preset.id === "desk-ollama");
    expect(desk).toMatchObject({
      kind: "openai",
      baseUrl: "http://localhost:11434/v1",
      model: "llava",
      visionVerified: true,
    });
    expect(isLocalEndpoint(desk!)).toBe(true);
    expect(migrated.find((preset) => preset.id === "lan-ollama")).toMatchObject({
      kind: "openai",
      baseUrl: "http://192.168.1.8:11434/v1",
    });
  });

  it("normalizes former default provider names without overwriting custom names", () => {
    const migrated = migrateLegacyProviderPresets([
      { ...DEFAULT_PRESETS[0], name: "自定义接口" },
      { ...DEFAULT_PRESETS[1], name: "Gemini兼容接口" },
    ]);

    expect(migrated.map((preset) => preset.name)).toEqual(["OpenAI 兼容接口", "Gemini 兼容接口"]);
  });

  it("migrates the retired official DeepSeek alias without changing private endpoints", () => {
    const migrated = migrateLegacyProviderPresets([
      { ...DEFAULT_PRESETS[0], model: "deepseek-chat" },
      {
        ...DEFAULT_PRESETS[0],
        id: "private-deepseek-alias",
        baseUrl: "https://gateway.example.com/v1",
        model: "deepseek-chat",
      },
    ]);

    expect(migrated.find((preset) => preset.id === "builtin-openai")?.model).toBe(
      DEEPSEEK_DEFAULT_MODEL,
    );
    expect(migrated.find((preset) => preset.id === "private-deepseek-alias")?.model).toBe(
      "deepseek-chat",
    );
  });
});
