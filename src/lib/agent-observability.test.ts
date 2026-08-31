import { beforeEach, describe, expect, it } from "vitest";

import {
  clearVolatileAgentRuns,
  listVolatileAgentRuns,
  resolveSavedAgentBudget,
  saveAgentRunBestEffort,
} from "./agent-observability";

describe("agent observability fallbacks", () => {
  beforeEach(clearVolatileAgentRuns);

  it("uses the caller's preset when browser settings storage is unavailable", () => {
    expect(resolveSavedAgentBudget("quick").maxRounds).toBe(3);
  });

  it("keeps a run in memory when persistent storage is unavailable", () => {
    const run = {
      id: "run-1",
      title: "私人标题",
      status: "completed" as const,
      steps: [
        {
          id: "step-1",
          kind: "model" as const,
          input: { prompt: "私人问题" },
        },
      ],
    };
    const events = [
      {
        id: "run-1:1",
        runId: "run-1",
        sequence: 1,
        at: 1,
        kind: "model_request" as const,
        status: "started" as const,
        payload: { prompt: "私人问题" },
      },
    ];
    const result = saveAgentRunBestEffort(run, events);
    expect(result.stored).toBe(false);
    const [entry] = listVolatileAgentRuns();
    expect(entry.run.id).toBe("run-1");
    expect(JSON.stringify(entry)).not.toContain("私人问题");
    expect(entry.run.title).toBe("[PRIVATE_PAYLOAD_HIDDEN]");
    expect(entry.events[0]?.payload).toBe("[PRIVATE_PAYLOAD_HIDDEN]");
  });
});
