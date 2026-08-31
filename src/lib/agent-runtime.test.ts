import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { MemoryAgentRunRecorder, projectAgentRun } from "./agent-run-log";
import {
  AGENT_BUDGET_PRESETS,
  AgentRuntime,
  ContextBudget,
  estimateAgentTokens,
  resolveAgentBudget,
  type AgentBudget,
} from "./agent-runtime";
import { AgentToolRegistry } from "./agent-tool-registry";

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
