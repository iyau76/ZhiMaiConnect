import { describe, expect, it } from "vitest";

import { MemoryAgentRunRecorder, projectAgentRun, redactAgentPayload } from "./agent-run-log";
import { ModelTransportError } from "./model-transport-resilience";

describe("agent run log", () => {
  it("redacts credentials and direct identifiers in bounded payloads", () => {
    const source: Record<string, unknown> = {
      apiKey: "sk-this-must-never-appear",
      nested: {
        authorization: "Bearer abc.def.ghi",
        note: "联系 me@example.com 或 13800138000",
      },
    };
    source.self = source;

    const redacted = redactAgentPayload(source) as Record<string, unknown>;
    const serialized = JSON.stringify(redacted);

    expect(serialized).not.toContain("this-must-never-appear");
    expect(serialized).not.toContain("abc.def.ghi");
    expect(serialized).not.toContain("me@example.com");
    expect(serialized).not.toContain("13800138000");
    expect(serialized).toContain("[CIRCULAR]");
  });

  it("keeps transport diagnostics while redacting the error message", () => {
    const error = new ModelTransportError("请求失败（503）", 503, "UPSTREAM_REJECTED", {
      clientRequestId: "client-42",
      edgeRequestId: "edge-42",
      upstreamStatus: 503,
      providerCode: "overloaded",
    });

    expect(redactAgentPayload(error)).toEqual({
      name: "ModelTransportError",
      message: "请求失败（503）",
      status: 503,
      code: "UPSTREAM_REJECTED",
      diagnostics: {
        clientRequestId: "client-42",
        edgeRequestId: "edge-42",
        upstreamStatus: 503,
        providerCode: "overloaded",
      },
    });
  });

  it("records ordered events with explicit actual and estimated token totals", () => {
    let now = 1_000;
    const recorder = new MemoryAgentRunRecorder({
      runId: "run-1",
      now: () => now++,
    });

    recorder.record({
      kind: "model_request",
      status: "started",
      round: 1,
      payload: { prompt: "hello" },
      usage: { input: { value: 12, source: "actual" } },
    });
    recorder.record({
      kind: "model_response",
      status: "succeeded",
      round: 1,
      payload: { answer: "world", private: "remove me" },
      redact: (payload) => ({ ...(payload as object), private: "[TOOL_REDACTED]" }),
      usage: { output: { value: 7, source: "estimated" } },
    });

    expect(recorder.events().map((event) => event.sequence)).toEqual([1, 2]);
    expect(recorder.events()[1]?.payload).toMatchObject({ private: "[TOOL_REDACTED]" });
    expect(recorder.tokenTotals()).toEqual({
      input: { total: 12, actual: 12, estimated: 0 },
      output: { total: 7, actual: 0, estimated: 7 },
    });
    expect(projectAgentRun(recorder.events(), { id: recorder.runId }).tokenUsage).toMatchObject({
      total: 19,
      estimated: true,
      provenance: "mixed",
      actualCount: 12,
      estimatedCount: 7,
    });
  });

  it("pairs a tool call and result into one inspector step", () => {
    const recorder = new MemoryAgentRunRecorder({ runId: "tool-run" });
    recorder.record({
      kind: "tool_call",
      status: "started",
      round: 1,
      toolName: "lookup",
      invocationId: "call-1",
      at: 10,
      payload: { query: "贾母" },
    });
    recorder.record({
      kind: "validation",
      status: "succeeded",
      round: 1,
      toolName: "lookup",
      invocationId: "call-1",
      at: 11,
      payload: { reason: "input_valid" },
    });
    recorder.record({
      kind: "tool_result",
      status: "succeeded",
      round: 1,
      toolName: "lookup",
      invocationId: "call-1",
      at: 16,
      durationMs: 6,
      payload: { names: ["贾母"] },
    });

    const view = projectAgentRun(recorder.events(), { id: recorder.runId });
    const toolSteps = view.steps.filter((step) => step.kind === "tool");

    expect(toolSteps).toHaveLength(1);
    expect(toolSteps[0]).toMatchObject({
      id: "tool-run:1",
      status: "completed",
      toolName: "lookup",
      input: { query: "贾母" },
      output: { names: ["贾母"] },
      startedAt: 10,
      endedAt: 16,
      durationMs: 6,
    });
    expect(toolSteps[0]?.validation).toMatchObject({
      status: "completed",
      output: { reason: "input_valid" },
    });
    expect(view.steps.find((step) => step.kind === "validation")).toBeUndefined();
  });

  it("pairs each model request and response into one closed round without changing the ledger", () => {
    const recorder = new MemoryAgentRunRecorder({ runId: "model-run" });
    recorder.record({
      kind: "model_request",
      status: "started",
      round: 1,
      at: 10,
      payload: { prompt: "first" },
    });
    recorder.record({
      kind: "model_response",
      status: "succeeded",
      round: 1,
      at: 18,
      payload: { response: "done" },
    });
    recorder.record({
      kind: "model_request",
      status: "started",
      round: 2,
      at: 20,
      payload: { prompt: "second" },
    });
    recorder.record({
      kind: "model_response",
      status: "failed",
      round: 2,
      at: 25,
      payload: { name: "Error", message: "503" },
    });

    const events = recorder.events();
    const view = projectAgentRun(events, { id: recorder.runId });

    expect(events).toHaveLength(4);
    expect(view.steps).toHaveLength(2);
    expect(view.steps[0]).toMatchObject({
      id: "model-run:1",
      round: 1,
      kind: "model",
      status: "completed",
      title: "model_round",
      input: { prompt: "first" },
      output: { response: "done" },
      startedAt: 10,
      endedAt: 18,
      durationMs: 8,
    });
    expect(view.steps[1]).toMatchObject({
      id: "model-run:3",
      round: 2,
      status: "failed",
      durationMs: 5,
    });
  });

  it("projects ledger events into the existing inspector contract", () => {
    const recorder = new MemoryAgentRunRecorder({ runId: "run-2", now: () => 42 });
    recorder.record({ kind: "proposal", status: "succeeded", round: 2, payload: { id: "p1" } });
    recorder.record({
      kind: "finalize",
      status: "blocked",
      payload: { reason: "max_tool_calls" },
    });

    const view = projectAgentRun(recorder.events(), { id: recorder.runId, title: "测试运行" });

    expect(view.status).toBe("budget_exceeded");
    expect(view.rounds).toBe(2);
    expect(view.steps.map((step) => step.kind)).toEqual(["proposal", "system"]);
  });
});
