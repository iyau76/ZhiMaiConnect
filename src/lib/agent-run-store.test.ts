import { describe, expect, it } from "vitest";

import { MemoryAgentRunRecorder, projectAgentRun } from "./agent-run-log";
import { LocalAgentRunStore, type AgentKeyValueStorage } from "./agent-run-store";

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

  serialized() {
    return [...this.values.values()].join("\n");
  }
}

function createRun(id: string, at: number, secret = "私人问题") {
  const recorder = new MemoryAgentRunRecorder({ runId: id, now: () => at });
  recorder.record({
    kind: "model_request",
    status: "started",
    round: 1,
    payload: { text: secret, apiKey: "sk-never-persist-this-key" },
  });
  recorder.record({
    kind: "model_response",
    status: "succeeded",
    round: 1,
    payload: { answer: `${secret}的回答` },
  });
  recorder.record({ kind: "finalize", status: "succeeded", payload: { reason: "completed" } });
  const events = recorder.events();
  return {
    run: projectAgentRun(events, { id, title: secret }),
    events,
  };
}

describe("LocalAgentRunStore", () => {
  it("hides free text by default while retaining the complete event structure", () => {
    const storage = new MemoryStorage();
    const store = new LocalAgentRunStore({ storage, now: () => 100 });
    const { run, events } = createRun("run-private", 90, "不要落盘的原文");

    store.save(run, events);
    const saved = store.get(run.id)!;

    expect(saved.privatePayload).toBe(false);
    expect(saved.events).toHaveLength(events.length);
    expect(saved.events.map((event) => event.kind)).toEqual(events.map((event) => event.kind));
    expect(saved.events[0]?.payload).toBe("[PRIVATE_PAYLOAD_HIDDEN]");
    expect(saved.run.title).toBe("[PRIVATE_PAYLOAD_HIDDEN]");
    expect(storage.serialized()).not.toContain("不要落盘的原文");
    expect(storage.serialized()).not.toContain("never-persist-this-key");
  });

  it("persists explicitly enabled private payload only after mandatory secret redaction", () => {
    const storage = new MemoryStorage();
    const store = new LocalAgentRunStore({ storage, now: () => 100 });
    const { run, events } = createRun("run-opt-in", 90, "允许保存的原文");
    const untrustedEvents = events.map((event, index) =>
      index === 0
        ? {
            ...event,
            payload: {
              text: "允许保存的原文",
              apiKey: "sk-raw-key-bypassed-recorder",
              authorization: "Bearer raw.authorization.token",
            },
          }
        : event,
    );

    store.save(run, untrustedEvents, { privatePayload: true });
    const saved = store.get(run.id)!;

    expect(saved.privatePayload).toBe(true);
    expect(JSON.stringify(saved)).toContain("允许保存的原文");
    expect(storage.serialized()).not.toContain("never-persist-this-key");
    expect(storage.serialized()).not.toContain("raw-key-bypassed-recorder");
    expect(storage.serialized()).not.toContain("raw.authorization.token");
    expect(storage.serialized()).toContain("[REDACTED]");
  });

  it("keeps only the newest configured runs and expires old entries", () => {
    const storage = new MemoryStorage();
    let now = 0;
    const store = new LocalAgentRunStore({
      storage,
      maxRuns: 2,
      maxAgeMs: 100,
      now: () => now,
    });

    ["run-1", "run-2", "run-3"].forEach((id, index) => {
      now = index * 10;
      const { run, events } = createRun(id, now);
      store.save(run, events);
    });
    expect(store.list().map((entry) => entry.id)).toEqual(["run-3", "run-2"]);

    now = 200;
    expect(store.list()).toEqual([]);
    expect(storage.serialized()).toBe("");
  });

  it("supports reading, removing and clearing runs without exposing mutable storage state", () => {
    const storage = new MemoryStorage();
    const store = new LocalAgentRunStore({ storage, now: () => 100 });
    const first = createRun("run-1", 90);
    const second = createRun("run-2", 90);
    store.save(first.run, first.events);
    store.save(second.run, second.events);

    const loaded = store.get("run-1")!;
    loaded.events.length = 0;
    expect(store.get("run-1")?.events).toHaveLength(first.events.length);

    store.remove("run-1");
    expect(store.get("run-1")).toBeUndefined();
    store.clear();
    expect(store.list()).toEqual([]);
  });
});
