import { describe, expect, it, vi } from "vitest";

import { agentRunOwnerStorageKey, loadOrCreateAgentRunOwnerId } from "./agent-run-owner";

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

describe("Agent run owner", () => {
  it("does not generate random IDs at Worker module initialization", async () => {
    vi.resetModules();
    const random = vi.spyOn(crypto, "randomUUID");
    const module = await import("./agent-run-owner");
    expect(random).not.toHaveBeenCalled();
    const owner = module.browserAgentRunOwnerId();
    expect(owner).toMatch(/^runtime:/);
    expect(module.browserAgentRunOwnerId()).toBe(owner);
    expect(random).toHaveBeenCalledTimes(1);
    random.mockRestore();
  });
  it("keeps one fenced owner across browser restarts", () => {
    const local = new MemoryStorage();
    const first = loadOrCreateAgentRunOwnerId(local);
    const reopened = loadOrCreateAgentRunOwnerId(local);

    expect(first).toMatch(/^browser:/);
    expect(reopened).toBe(first);
    expect(local.getItem(agentRunOwnerStorageKey)).toBe(first);
  });

  it("migrates the prior tab owner once", () => {
    const local = new MemoryStorage();
    const session = new MemoryStorage();
    session.setItem("zhimai:assistant-run-owner", "tab:existing");

    expect(loadOrCreateAgentRunOwnerId(local, session)).toBe("tab:existing");
    expect(local.getItem(agentRunOwnerStorageKey)).toBe("tab:existing");
  });
});
