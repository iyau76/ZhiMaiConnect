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
      version: 2,
      profile: "standard",
      authorizationMode: "standard",
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
      version: 2,
      profile: "custom",
      customBudget: CUSTOM_BUDGET,
      authorizationMode: "standard",
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

  it("rehydrates the selected deep preset as the complete active budget", () => {
    const storage = new MemoryStorage();
    new LocalAgentSettingsStore({ storage, now: () => 7 }).selectPreset("deep");

    const rebuilt = new LocalAgentSettingsStore({ storage });
    expect(rebuilt.load()).toMatchObject({ profile: "deep", updatedAt: 7 });
    expect(rebuilt.resolveBudget()).toEqual(rebuilt.presets().deep);
  });

  it("falls back from corrupt settings and can reset persisted state", () => {
    const storage = new MemoryStorage();
    storage.setItem("zhimai.agent-settings.v1", "not-json");
    const store = new LocalAgentSettingsStore({ storage });
    expect(store.load().profile).toBe("standard");

    store.selectPreset("quick");
    expect(store.reset()).toEqual({
      version: 2,
      profile: "standard",
      authorizationMode: "standard",
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

  it("migrates v1 settings to v2 with standard authorization", () => {
    const storage = new MemoryStorage();
    storage.setItem(
      "zhimai.agent-settings.v1",
      JSON.stringify({
        version: 1,
        profile: "deep",
        savePrivatePayload: true,
        updatedAt: 12,
      }),
    );
    const store = new LocalAgentSettingsStore({ storage, now: () => 34 });

    expect(store.load()).toMatchObject({
      version: 2,
      profile: "deep",
      authorizationMode: "standard",
      savePrivatePayload: true,
      updatedAt: 12,
    });
    expect(storage.getItem("zhimai.agent-settings.v1")).toBeNull();
    expect(storage.getItem("zhimai.agent-settings.v2")).not.toBeNull();
  });

  it("stores authorization independently from the run budget", () => {
    const storage = new MemoryStorage();
    const store = new LocalAgentSettingsStore({ storage, now: () => 99 });
    store.selectPreset("quick");

    expect(store.setAuthorizationMode("cautious")).toMatchObject({
      profile: "quick",
      authorizationMode: "cautious",
      updatedAt: 99,
    });
  });
});
