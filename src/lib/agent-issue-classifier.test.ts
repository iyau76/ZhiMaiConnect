import { describe, expect, it } from "vitest";

import { AgentDeadlineExceededError } from "./agent-deadline";
import { classifyAgentIssue } from "./agent-issue-classifier";
import { ModelRetryExhaustedError, ModelTransportError } from "./model-transport-resilience";

describe("classifyAgentIssue", () => {
  it("classifies typed and generic transient model failures as transport", () => {
    expect(
      classifyAgentIssue(new ModelTransportError("unavailable", 503, "UPSTREAM_UNAVAILABLE"), {
        phase: "model",
      }),
    ).toMatchObject({ category: "transport", code: "UPSTREAM_UNAVAILABLE" });
    expect(
      classifyAgentIssue(new ModelRetryExhaustedError(3, new ModelTransportError("gateway", 502)), {
        phase: "model",
      }),
    ).toMatchObject({ category: "transport", code: "HTTP_502" });
    expect(classifyAgentIssue(new Error("upstream timed out"), { phase: "model" })).toMatchObject({
      category: "transport",
    });
  });

  it("uses the owning boundary for the four non-transport categories", () => {
    expect(
      classifyAgentIssue(new AgentDeadlineExceededError(50), { phase: "model" }).category,
    ).toBe("budget");
    expect(classifyAgentIssue("history clipped", { phase: "context" }).category).toBe(
      "context_omission",
    );
    expect(classifyAgentIssue(new Error("invalid JSON"), { phase: "contract" }).category).toBe(
      "contract",
    );
    expect(
      classifyAgentIssue(new Error("revision conflict"), { phase: "transaction" }).category,
    ).toBe("transaction");
  });

  it("carries the stable transaction-to-run link without retaining another error object", () => {
    expect(
      classifyAgentIssue(new Error("commit failed"), {
        phase: "transaction",
        operation: "commit",
        sourceRunId: "run-1",
      }),
    ).toEqual({
      category: "transaction",
      phase: "transaction",
      message: "commit failed",
      operation: "commit",
      sourceRunId: "run-1",
    });
  });

  it("classifies unknown model and tool failures as contract failures", () => {
    expect(classifyAgentIssue(new Error("cannot parse reply"), { phase: "model" }).category).toBe(
      "contract",
    );
    expect(classifyAgentIssue(new Error("unknown tool"), { phase: "tool" }).category).toBe(
      "contract",
    );
  });

  it("keeps the nearer tool boundary classification when runtime observes the same rejection", () => {
    const writeFailure = new Error("archive revision conflict");
    expect(classifyAgentIssue(writeFailure, { phase: "transaction" }).category).toBe("transaction");
    expect(classifyAgentIssue(writeFailure, { phase: "tool" })).toMatchObject({
      category: "transaction",
      phase: "transaction",
    });

    const validationFailure = new Error("invalid tool input");
    classifyAgentIssue(validationFailure, { phase: "contract" });
    expect(classifyAgentIssue(validationFailure, { phase: "tool" }).category).toBe("contract");
  });
});
