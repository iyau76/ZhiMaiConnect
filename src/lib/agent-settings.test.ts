import { describe, expect, it } from "vitest";

import { LocalAgentSettingsStore } from "./agent-settings";
import type { AgentKeyValueStorage } from "./agent-run-store";

class MemoryStorage implements AgentKeyValueStorage {
  readonly values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }

  removeItem(key: string) {
    this.values.delete(key);
  }
}

const CUSTOM_BUDGET = {
  maxRounds: 9,
  maxToolCalls: 18,
  maxInputTokens: 55_000,
  maxOutputTokens: 9_000,
  maxWallTimeMs: 180_000,
};

describe("LocalAgentSettingsStore", () => {
  it("defaults to standard and persists quick/standard/deep selection", () => {
    const storage = new MemoryStorage();
    const store = new LocalAgentSettingsStore({ storage, now: () => 123 });

    expect(store.load()).toEqual({
      version: 1,
      profile: "standard",
      savePrivatePayload: false,
      updatedAt: 0,
    });
    expect(store.resolveBudget()).toEqual(store.presets().standard);

    store.selectPreset("quick");
    expect(new LocalAgentSettingsStore({ storage }).load()).toMatchObject({
      profile: "quick",
      updatedAt: 123,
    });
    expect(store.resolveBudget().maxRounds).toBe(store.presets().quick.maxRounds);
  });

  it("validates and resolves a complete advanced custom budget", () => {
    const storage = new MemoryStorage();
    const store = new LocalAgentSettingsStore({ storage, now: () => 456 });

    expect(store.saveCustomBudget(CUSTOM_BUDGET)).toEqual({
      version: 1,
      profile: "custom",
      customBudget: CUSTOM_BUDGET,
      savePrivatePayload: false,
      updatedAt: 456,
    });
    expect(store.resolveBudget()).toEqual(CUSTOM_BUDGET);
    expect(() => store.saveCustomBudget({ ...CUSTOM_BUDGET, maxToolCalls: -1 })).toThrow();
    expect(store.resolveBudget()).toEqual(CUSTOM_BUDGET);
  });

  it("retains a custom budget when temporarily selecting a preset", () => {
    const storage = new MemoryStorage();
    const store = new LocalAgentSettingsStore({ storage, now: () => 1 });
    store.saveCustomBudget(CUSTOM_BUDGET);
    store.selectPreset("deep");

    expect(store.load()).toMatchObject({
      profile: "deep",
      customBudget: CUSTOM_BUDGET,
    });
    expect(store.resolveBudget()).toEqual(store.presets().deep);
  });

  it("falls back from corrupt settings and can reset persisted state", () => {
    const storage = new MemoryStorage();
    storage.setItem("zhimai.agent-settings.v1", "not-json");
    const store = new LocalAgentSettingsStore({ storage });
    expect(store.load().profile).toBe("standard");

    store.selectPreset("quick");
    expect(store.reset()).toEqual({
      version: 1,
      profile: "standard",
      savePrivatePayload: false,
      updatedAt: 0,
    });
    expect(storage.values.size).toBe(0);
  });

  it("requires an explicit setting before persisted logs may keep archive text", () => {
    const storage = new MemoryStorage();
    const store = new LocalAgentSettingsStore({ storage, now: () => 789 });
    expect(store.load().savePrivatePayload).toBe(false);
    expect(store.setSavePrivatePayload(true)).toMatchObject({
      savePrivatePayload: true,
      updatedAt: 789,
    });
    store.selectPreset("deep");
    expect(store.load().savePrivatePayload).toBe(true);
  });
});
