import { describe, expect, it, vi } from "vitest";

import {
  AgentDeadlineExceededError,
  AgentOperationAbortedError,
  createAgentDeadline,
  withAgentDeadline,
} from "./agent-deadline";

describe("agent deadline", () => {
  it("actively rejects an operation that ignores cancellation", async () => {
    vi.useFakeTimers();
    try {
      const pending = withAgentDeadline(() => new Promise<never>(() => undefined), {
        timeoutMs: 25,
      });
      const assertion = expect(pending).rejects.toBeInstanceOf(AgentDeadlineExceededError);
      await vi.advanceTimersByTimeAsync(25);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("composes parent cancellation and preserves its reason", async () => {
    const parent = new AbortController();
    const pending = withAgentDeadline(
      (signal) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
      { timeoutMs: 1_000, signals: [parent.signal] },
    );
    const assertion = expect(pending).rejects.toMatchObject({
      name: "AgentOperationAbortedError",
      cause: "user_cancelled",
    });
    parent.abort(new AgentOperationAbortedError("user_cancelled"));

    await assertion;
  });

  it("disposes timers and listeners after a successful operation", async () => {
    vi.useFakeTimers();
    try {
      let operationSignal: AbortSignal | undefined;
      await expect(
        withAgentDeadline(
          (signal) => {
            operationSignal = signal;
            return "done";
          },
          { timeoutMs: 10 },
        ),
      ).resolves.toBe("done");
      await vi.advanceTimersByTimeAsync(20);
      expect(operationSignal?.aborted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports remaining wall time", () => {
    let now = 100;
    const deadline = createAgentDeadline({ timeoutMs: 50, now: () => now });
    now = 125;
    expect(deadline.remainingMs()).toBe(25);
    deadline.dispose();
  });
});
