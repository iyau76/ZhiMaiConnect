import { describe, expect, it } from "vitest";

import {
  DEFAULT_PRESETS,
  DEEPSEEK_DEFAULT_MODEL,
  DEEPSEEK_OPENAI_BASE_URL,
  GEMINI_DEFAULT_MODEL,
  GEMINI_OPENAI_BASE_URL,
  migrateLegacyProviderPresets,
  supportsVision,
} from "./vision-providers";

describe("vision provider presets", () => {
  it("puts OpenAI compatibility first and configures current Gemini Flash", () => {
    expect(DEFAULT_PRESETS.map((preset) => preset.kind)).toEqual(["openai", "gemini", "ollama"]);
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
      DEFAULT_PRESETS[2],
    ]);

    expect(migrated.some((preset) => (preset as { kind: string }).kind === "lovable")).toBe(false);
    expect(migrated[0]?.id).toBe("private");
    expect(migrated.some((preset) => preset.kind === "gemini")).toBe(true);
    expect(migrated.some((preset) => preset.kind === "ollama")).toBe(true);
  });

  it("normalizes former default provider names without overwriting custom names", () => {
    const migrated = migrateLegacyProviderPresets([
      { ...DEFAULT_PRESETS[0], name: "自定义接口" },
      { ...DEFAULT_PRESETS[1], name: "Gemini兼容接口" },
      { ...DEFAULT_PRESETS[2], name: "办公室 Ollama" },
    ]);

    expect(migrated.map((preset) => preset.name)).toEqual([
      "OpenAI 兼容接口",
      "Gemini 兼容接口",
      "办公室 Ollama",
    ]);
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
