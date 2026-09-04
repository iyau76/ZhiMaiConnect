import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { MemoryAgentRunRecorder, projectAgentRun } from "./agent-run-log";
import {
  AGENT_BUDGET_PRESETS,
  AgentRuntime,
  ContextBudget,
  estimateAgentTokens,
  nextAgentModelTurn,
  resolveAgentBudget,
  type AgentBudget,
} from "./agent-runtime";
import { AgentToolRegistry } from "./agent-tool-registry";
import { ModelRetryExhaustedError, ModelTransportError } from "./model-transport-resilience";

const SMALL_BUDGET: AgentBudget = {
  maxRounds: 2,
  maxToolCalls: 1,
  maxInputTokens: 100,
  maxOutputTokens: 100,
  maxWallTimeMs: 1_000,
};

describe("ContextBudget", () => {
  it("exposes validated quick, standard and deep presets", () => {
    expect(Object.keys(AGENT_BUDGET_PRESETS)).toEqual(["quick", "standard", "deep"]);
    expect(resolveAgentBudget("deep").maxRounds).toBeGreaterThan(
      resolveAgentBudget("standard").maxRounds,
    );
    expect(() => resolveAgentBudget({ ...SMALL_BUDGET, maxRounds: 1.5 })).toThrow();
  });

  it("returns a finalize reason instead of throwing when a limit is reached", () => {
    const budget = new ContextBudget({ ...SMALL_BUDGET, maxRounds: 1 });

    expect(budget.claimModelRound({ value: 8, source: "actual" }).status).toBe("continue");
    expect(budget.claimModelRound({ value: 8, source: "estimated" })).toMatchObject({
      status: "finalize",
      reason: "max_rounds",
    });
    expect(budget.snapshot().inputTokens).toEqual({ total: 8, actual: 8, estimated: 0 });
  });

  it("tracks token provenance and wall-clock exhaustion independently", () => {
    let now = 10;
    const tokenBudget = new ContextBudget(
      { ...SMALL_BUDGET, maxOutputTokens: 5 },
      { now: () => now },
    );
    expect(tokenBudget.recordModelOutput({ value: 2, source: "actual" }).status).toBe("continue");
    expect(tokenBudget.recordModelOutput({ value: 3, source: "estimated" })).toMatchObject({
      status: "finalize",
      reason: "max_output_tokens",
    });
    expect(tokenBudget.snapshot().outputTokens).toEqual({
      total: 5,
      actual: 2,
      estimated: 3,
    });

    const wallBudget = new ContextBudget(SMALL_BUDGET, { now: () => now });
    now = 1_010;
    expect(wallBudget.checkpoint()).toMatchObject({
      status: "finalize",
      reason: "max_wall_time",
    });
  });

  it("does not consume a call that would exceed the input budget", () => {
    const budget = new ContextBudget({ ...SMALL_BUDGET, maxInputTokens: 5 });
    expect(budget.claimModelRound({ value: 6, source: "estimated" })).toMatchObject({
      status: "finalize",
      reason: "max_input_tokens",
    });
    expect(budget.snapshot()).toMatchObject({ rounds: 0, inputTokens: { total: 0 } });
  });

  it("derives tool availability and the reserved final turn from the live ledger", () => {
    const budget = new ContextBudget(SMALL_BUDGET);

    expect(nextAgentModelTurn(budget.snapshot())).toEqual({
      absoluteRound: 1,
      maxRounds: 2,
      remainingRounds: 2,
      finalOnly: false,
    });
    budget.claimModelRound({ value: 1, source: "actual" });
    expect(nextAgentModelTurn(budget.snapshot())).toEqual({
      absoluteRound: 2,
      maxRounds: 2,
      remainingRounds: 1,
      finalOnly: true,
    });
    budget.claimModelRound({ value: 1, source: "actual" });
    expect(nextAgentModelTurn(budget.snapshot())).toBeNull();
  });
});

describe("AgentRuntime", () => {
  it("coordinates rounds, tools, logs and a budget finalization without an if-else executor", async () => {
    const registry = new AgentToolRegistry<{ prefix: string }>();
    registry.register({
      name: "lookup",
      label: "查询",
      description: "查询一条资料",
      permission: "public_read",
      input: z.object({ query: z.string() }).strict(),
      handler: ({ query }, { services }) => `${services.prefix}:${query}`,
    });
    const recorder = new MemoryAgentRunRecorder({ runId: "runtime-run", now: () => 100 });
    const runtime = new AgentRuntime({
      registry,
      services: { prefix: "result" },
      permissions: ["public_read"],
      budget: SMALL_BUDGET,
      recorder,
      now: () => 100,
    });

    expect(
      runtime.beginModelRound({
        payload: { prompt: "查人物" },
        tokens: { value: 5, source: "actual" },
      }),
    ).toMatchObject({ status: "continue", round: 1 });
    expect(
      runtime.completeModelRound({
        payload: { tool: "lookup" },
        tokens: { value: 2, source: "estimated" },
      }),
    ).toMatchObject({ status: "continue" });

    await expect(runtime.executeTool("lookup", { query: "贾母" })).resolves.toMatchObject({
      status: "ok",
      value: "result:贾母",
    });
    await expect(runtime.executeTool("lookup", { query: "宝玉" })).resolves.toMatchObject({
      status: "finalize",
      reason: "max_tool_calls",
    });

    expect(recorder.events().map((event) => event.kind)).toEqual([
      "model_request",
      "model_response",
      "tool_call",
      "validation",
      "tool_result",
      "budget",
      "finalize",
    ]);
    expect(recorder.tokenTotals()).toEqual({
      input: { total: 5, actual: 5, estimated: 0 },
      output: { total: 2, actual: 0, estimated: 2 },
    });
    const inspectorRun = projectAgentRun(recorder.events(), { id: recorder.runId });
    expect(inspectorRun.steps.filter((step) => step.kind === "tool")).toHaveLength(1);
    expect(inspectorRun.steps.find((step) => step.kind === "tool")).toMatchObject({
      input: { query: "贾母" },
      output: "result:贾母",
    });
    expect(inspectorRun.tokenUsage).toMatchObject({
      provenance: "mixed",
      estimated: true,
      actualCount: 5,
      estimatedCount: 2,
    });
  });

  it("finalizes an aborted run before dispatching a tool", async () => {
    const controller = new AbortController();
    const registry = new AgentToolRegistry();
    const runtime = new AgentRuntime({
      registry,
      services: undefined,
      signal: controller.signal,
      budget: SMALL_BUDGET,
    });
    controller.abort();

    await expect(runtime.executeTool("missing", {})).resolves.toMatchObject({
      status: "finalize",
      reason: "aborted",
    });
  });

  it("marks local token fallback as estimated", () => {
    expect(estimateAgentTokens("中文abcd")).toEqual({ value: 3, source: "estimated" });
  });

  it("retries transient 5xx and timeout failures inside one logical model round", async () => {
    const recorder = new MemoryAgentRunRecorder({ runId: "retry-run" });
    const invoke = vi
      .fn<() => Promise<{ value: string }>>()
      .mockRejectedValueOnce(new ModelTransportError("upstream unavailable", 503))
      .mockRejectedValueOnce(new Error("upstream timed out"))
      .mockResolvedValueOnce({ value: "done" });
    const runtime = new AgentRuntime({
      registry: new AgentToolRegistry(),
      services: undefined,
      budget: SMALL_BUDGET,
      recorder,
      modelRetry: { maxAttempts: 3, delaysMs: [0, 0] },
    });

    await expect(
      runtime.runModelRound({ payload: "prompt", tokens: { value: 1, source: "actual" } }, invoke),
    ).resolves.toMatchObject({ status: "ok", value: "done" });

    expect(invoke).toHaveBeenCalledTimes(3);
    expect(runtime.contextBudget.snapshot().rounds).toBe(1);
    expect(recorder.events().filter((event) => event.kind === "model_request")).toHaveLength(1);
    expect(recorder.events().filter((event) => event.kind === "model_response")).toHaveLength(1);
    const retryEvents = recorder
      .events()
      .filter(
        (event) =>
          event.kind === "validation" &&
          (event.payload as { status?: string } | undefined)?.status === "transport_retry",
      );
    expect(retryEvents).toHaveLength(2);
    expect(retryEvents.every((event) => event.issueCategory === "transport")).toBe(true);
  });

  it("treats an empty model response as retryable transport failure", async () => {
    const invoke = vi
      .fn<() => Promise<{ value: string; payload: { response: string } }>>()
      .mockResolvedValueOnce({ value: "   ", payload: { response: "   " } })
      .mockResolvedValueOnce({ value: "usable", payload: { response: "usable" } });
    const runtime = new AgentRuntime({
      registry: new AgentToolRegistry(),
      services: undefined,
      budget: SMALL_BUDGET,
      modelRetry: { maxAttempts: 2, delaysMs: [0] },
    });

    await expect(runtime.runModelRound({ payload: "prompt" }, invoke)).resolves.toMatchObject({
      status: "ok",
      value: "usable",
    });
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(runtime.contextBudget.snapshot().rounds).toBe(1);
  });

  it("returns typed exhaustion without consuming another logical round", async () => {
    const invoke = vi.fn(() => Promise.reject(new ModelTransportError("unavailable", 503)));
    const runtime = new AgentRuntime({
      registry: new AgentToolRegistry(),
      services: undefined,
      budget: SMALL_BUDGET,
      modelRetry: { maxAttempts: 2, delaysMs: [0] },
    });

    const result = await runtime.runModelRound({ payload: "prompt" }, invoke);

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error).toBeInstanceOf(ModelRetryExhaustedError);
      expect((result.error as ModelRetryExhaustedError).attempts).toBe(2);
      expect(result.issue.category).toBe("transport");
    }
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(runtime.contextBudget.snapshot().rounds).toBe(1);
  });

  it("returns the same contract or transaction category recorded by the owning boundary", async () => {
    const modelRecorder = new MemoryAgentRunRecorder({ runId: "contract-model" });
    const modelRuntime = new AgentRuntime({
      registry: new AgentToolRegistry(),
      services: undefined,
      budget: SMALL_BUDGET,
      recorder: modelRecorder,
    });
    const modelResult = await modelRuntime.runModelRound({ payload: "prompt" }, () =>
      Promise.reject(new Error("response violates declared schema")),
    );
    expect(modelResult).toMatchObject({
      status: "failed",
      issue: { category: "contract", phase: "model" },
    });
    expect(modelRecorder.events().find((event) => event.kind === "model_response")).toMatchObject({
      status: "failed",
      issueCategory: "contract",
    });

    const registry = new AgentToolRegistry();
    registry.register({
      name: "commit_archive",
      label: "提交档案",
      description: "提交一份已经批准的档案变更",
      permission: "write",
      input: z.object({ proposalId: z.string().min(1) }).strict(),
      handler: () => {
        throw new Error("archive revision conflict");
      },
    });
    const toolRecorder = new MemoryAgentRunRecorder({ runId: "transaction-tool" });
    const toolRuntime = new AgentRuntime({
      registry,
      services: undefined,
      permissions: ["write"],
      budget: SMALL_BUDGET,
      recorder: toolRecorder,
    });
    const toolResult = await toolRuntime.executeTool("commit_archive", { proposalId: "p1" });
    expect(toolResult).toMatchObject({
      status: "failed",
      issue: { category: "transaction", phase: "transaction" },
    });
    expect(toolRecorder.events().find((event) => event.kind === "tool_result")).toMatchObject({
      status: "failed",
      issueCategory: "transaction",
    });
  });

  it("actively finalizes hanging model and tool operations at maxWallTime", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      const modelRuntime = new AgentRuntime({
        registry: new AgentToolRegistry(),
        services: undefined,
        budget: { ...SMALL_BUDGET, maxWallTimeMs: 20 },
      });
      const modelResult = modelRuntime.runModelRound(
        { payload: "hang", tokens: { value: 1, source: "actual" } },
        () => new Promise<never>(() => undefined),
      );
      const modelAssertion = expect(modelResult).resolves.toMatchObject({
        status: "finalize",
        reason: "max_wall_time",
      });
      await vi.advanceTimersByTimeAsync(20);
      await modelAssertion;

      vi.setSystemTime(100);
      const registry = new AgentToolRegistry();
      registry.register({
        name: "hang",
        label: "悬挂工具",
        description: "用于验证主动截止",
        permission: "public_read",
        input: z.object({}).strict(),
        handler: () => new Promise<never>(() => undefined),
      });
      const toolRuntime = new AgentRuntime({
        registry,
        services: undefined,
        budget: { ...SMALL_BUDGET, maxWallTimeMs: 20 },
      });
      const toolResult = toolRuntime.executeTool("hang", {});
      const toolAssertion = expect(toolResult).resolves.toMatchObject({
        status: "finalize",
        reason: "max_wall_time",
      });
      await vi.advanceTimersByTimeAsync(20);
      await toolAssertion;
      expect(
        toolRuntime.recorder.events().find((event) => event.kind === "tool_result"),
      ).toMatchObject({ status: "failed" });
    } finally {
      vi.useRealTimers();
    }
  });
});
