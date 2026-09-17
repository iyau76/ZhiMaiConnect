import { describe, expect, it } from "vitest";

import {
  MODEL_PRESETS_KEY,
  SAVED_API_KEYS_KEY,
  SESSION_API_KEYS_KEY,
  applySessionApiKeys,
  hasSavedApiKey,
  loadSavedModelPresets,
  saveModelPresets,
  saveSessionApiKeys,
} from "./model-preset-storage";
import { DEFAULT_PRESETS, FREE_TIER_PRESET_ID } from "./vision-providers";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
}

describe("model preset storage", () => {
  it("offers the official free tier first even for browsers that never saved a preset", () => {
    const presets = loadSavedModelPresets(memoryStorage());

    expect(presets[0]!.id).toBe(FREE_TIER_PRESET_ID);
    // 免费档不需要密钥，所以它不能出现在任何密钥表里。
    expect(presets[0]!.apiKey).toBe("");
    expect(presets.map((preset) => preset.id)).toContain("builtin-openai");
  });

  it("keeps edited keys in the current session until the user explicitly saves", () => {
    const local = memoryStorage();
    const session = memoryStorage();
    const configured = DEFAULT_PRESETS.map((preset, index) => ({
      ...preset,
      apiKey: index === 0 ? "session-key" : "",
    }));

    saveSessionApiKeys(session, configured);
    expect(local.getItem(SAVED_API_KEYS_KEY)).toBeNull();
    expect(session.getItem(SESSION_API_KEYS_KEY)).toContain("session-key");
    expect(
      applySessionApiKeys(loadSavedModelPresets(local), session).find(
        (preset) => preset.id === "builtin-openai",
      )?.apiKey,
    ).toBe("session-key");
  });

  it("persists API keys only after save and keeps them outside preset metadata", () => {
    const local = memoryStorage();
    const configured = DEFAULT_PRESETS.map((preset, index) => ({
      ...preset,
      apiKey: index === 0 ? "saved-key" : "",
    }));

    saveModelPresets(local, configured);

    expect(local.getItem(MODEL_PRESETS_KEY)).not.toContain("saved-key");
    expect(local.getItem(SAVED_API_KEYS_KEY)).toContain("saved-key");
    expect(hasSavedApiKey(local)).toBe(true);
    expect(
      loadSavedModelPresets(local).find((preset) => preset.id === "builtin-openai")?.apiKey,
    ).toBe("saved-key");
  });
});
