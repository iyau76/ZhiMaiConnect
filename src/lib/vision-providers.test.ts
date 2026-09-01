import { describe, expect, it } from "vitest";

import {
  DEFAULT_PRESETS,
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
});
