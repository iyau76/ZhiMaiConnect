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
    const run = { id: "run-1", status: "completed" as const, steps: [] };
    const result = saveAgentRunBestEffort(run, []);
    expect(result.stored).toBe(false);
    expect(listVolatileAgentRuns().map((entry) => entry.run.id)).toEqual(["run-1"]);
  });
});
