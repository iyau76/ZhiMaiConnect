import { describe, expect, it, vi } from "vitest";

import {
  DurableRunResumeError,
  beginDurableAgentRun,
  cancelDurableAgentRun,
  continueDurableAgentRun,
} from "./durable-agent-run";
import { MemoryAgentRunLedgerRepository } from "./agent-run-ledger";

const budget = {
  maxRounds: 12,
  maxToolCalls: 32,
  maxInputTokens: 120_000,
  maxOutputTokens: 24_000,
  maxWallTimeMs: 300_000,
};

function baseInput(repository: MemoryAgentRunLedgerRepository) {
  return {
    repository,
    threadId: "assistant:default",
    agentName: "assistant",
    entrypoint: "models.ask",
    title: "问一问：谁适合拍照",
    request: { question: "谁适合拍照" },
    providerRef: { presetId: "deepseek", kind: "openai", model: "model" },
    includeArchive: true,
    budget,
    archiveVersion: "archive:v1",
  };
}

describe("durable Agent run", () => {
  it("persists the initial intent checkpoint in the same operation that starts the run", async () => {
    const repository = new MemoryAgentRunLedgerRepository({ now: () => 100 });
    const recorder = await beginDurableAgentRun({
      ...baseInput(repository),
      ownerId: "browser-a",
      initialCheckpoint: (runId) => ({
        kind: "awaiting_model",
        status: "active",
        nextAction: { kind: "invoke_model" },
        state: { sourceRunId: runId, question: "谁适合拍照" },
        observationIds: [],
        dependencyRefs: [{ scope: "archive", version: "archive:v1" }],
        budget: {
          rounds: 0,
          toolCalls: 0,
          inputTokens: { total: 0, actual: 0, estimated: 0 },
          outputTokens: { total: 0, actual: 0, estimated: 0 },
        },
      }),
    });

    const run = await repository.getRun(recorder.runId);
    const checkpoint = await repository.getCheckpoint(run!.latestCheckpointId!);
    expect(run).toMatchObject({ status: "running", revision: 1 });
    expect(checkpoint?.state).toEqual({
      sourceRunId: recorder.runId,
      question: "谁适合拍照",
    });
    await recorder.settle({ status: "cancelled", state: { reason: "test complete" } });
  });

  it("renews the active lease while a model call is in flight and stops after settlement", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(100);
      const repository = new MemoryAgentRunLedgerRepository({ now: Date.now });
      const recorder = await beginDurableAgentRun({
        ...baseInput(repository),
        ownerId: "browser-a",
        leaseDurationMs: 3_000,
        heartbeatIntervalMs: 1_000,
        now: Date.now,
      });
      expect((await repository.getRun(recorder.runId))?.lease?.expiresAt).toBe(3_100);

      await vi.advanceTimersByTimeAsync(1_000);
      await recorder.flush();
      expect((await repository.getRun(recorder.runId))?.lease?.expiresAt).toBe(4_100);

      await recorder.settle({ status: "completed", state: { answer: "唐悦" } });
      const settledRevision = (await repository.getRun(recorder.runId))!.revision;
      await vi.advanceTimersByTimeAsync(3_000);
      expect((await repository.getRun(recorder.runId))?.revision).toBe(settledRevision);
    } finally {
      vi.useRealTimers();
    }
  });

  it("streams events and observations, then continues the same suspended run", async () => {
    let clock = 100;
    const repository = new MemoryAgentRunLedgerRepository({ now: () => clock++ });
    const first = await beginDurableAgentRun({
      ...baseInput(repository),
      now: () => clock++,
      ownerId: "tab-a",
    });

    first.record({
      kind: "tool_call",
      status: "started",
      round: 1,
      toolName: "search_profiles",
      invocationId: "call-1",
      payload: { query: "摄影" },
    });
    first.record({
      kind: "validation",
      status: "succeeded",
      round: 1,
      toolName: "search_profiles",
      invocationId: "call-1",
      payload: { reason: "input_valid" },
    });
    first.record({
      kind: "tool_result",
      status: "succeeded",
      round: 1,
      toolName: "search_profiles",
      invocationId: "call-1",
      payload: { results: [{ id: "person-1", name: "唐悦" }], nextCursor: "page-2" },
    });
    first.record({
      kind: "finalize",
      status: "blocked",
      round: 2,
      payload: { reason: "suspended" },
    });
    await first.settle({
      status: "suspended",
      checkpointKind: "awaiting_model",
      nextAction: "invoke_model",
      resumable: true,
      state: { checkpoint: { nextRound: 2 }, turns: ["保留这轮对话"] },
      dependencyRefs: [{ scope: "archive", version: "archive:v1" }],
    });

    const suspendedRun = (await repository.listRuns())[0];
    expect(suspendedRun.status).toBe("suspended");
    expect(await repository.listEvents(suspendedRun.id)).toHaveLength(4);
    expect(await repository.listObservations(suspendedRun.id)).toMatchObject([
      {
        id: `${suspendedRun.id}:observation:call-1`,
        cursor: "page-2",
        dependencyRefs: [
          {
            scope: "tool:search_profiles",
            id: "person-1",
            version: "archive:v1",
            fields: ["name"],
          },
        ],
      },
    ]);

    const resumed = await beginDurableAgentRun({
      ...baseInput(repository),
      resumeRunId: suspendedRun.id,
      resumeMode: "model",
      now: () => clock++,
      ownerId: "tab-b",
    });
    resumed.record({
      kind: "model_request",
      status: "started",
      round: 2,
      payload: { prompt: "使用已取得结果回答" },
    });
    resumed.record({
      kind: "model_response",
      status: "succeeded",
      round: 2,
      payload: { response: "唐悦" },
    });
    resumed.record({
      kind: "finalize",
      status: "succeeded",
      round: 2,
      payload: { reason: "completed" },
    });
    await resumed.settle({ status: "completed", state: { turns: ["最终回答"] } });

    const events = await repository.listEvents(suspendedRun.id);
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(new Set(events.map((event) => event.id)).size).toBe(events.length);
    expect(await repository.listObservations(suspendedRun.id)).toHaveLength(1);
    expect((await repository.getRun(suspendedRun.id))?.status).toBe("completed");
  });

  it("prevents a second tab from taking an active run lease", async () => {
    const repository = new MemoryAgentRunLedgerRepository({ now: () => 100 });
    const first = await beginDurableAgentRun({
      ...baseInput(repository),
      ownerId: "tab-a",
    });
    await first.flush();
    const run = (await repository.listRuns())[0];

    await expect(
      beginDurableAgentRun({
        ...baseInput(repository),
        resumeRunId: run.id,
        resumeMode: "cancel",
        ownerId: "tab-b",
      }),
    ).rejects.toMatchObject({ code: "LEASE_HELD" });
  });

  it("persists a resumable checkpoint before network work without settling the run", async () => {
    const repository = new MemoryAgentRunLedgerRepository({ now: () => 100 });
    const recorder = await beginDurableAgentRun({
      ...baseInput(repository),
      ownerId: "tab-a",
    });

    await recorder.checkpoint({
      checkpointKind: "awaiting_model",
      nextAction: "invoke_model",
      state: { turns: ["谁适合拍照", "正在分析"] },
      dependencyRefs: [{ scope: "archive", version: "archive:v1" }],
    });

    const run = await repository.getRun(recorder.runId);
    const checkpoint = await repository.getCheckpoint(run!.latestCheckpointId!);
    expect(run).toMatchObject({ status: "running", resumable: true });
    expect(run?.lease?.ownerId).toBe("tab-a");
    expect(checkpoint).toMatchObject({
      kind: "awaiting_model",
      status: "active",
      nextAction: { kind: "invoke_model" },
      state: { turns: ["谁适合拍照", "正在分析"] },
      budget: { rounds: 0, toolCalls: 0 },
    });
  });

  it("lets the same browser session reclaim a running safe checkpoint after reload", async () => {
    const repository = new MemoryAgentRunLedgerRepository({ now: () => 100 });
    const first = await beginDurableAgentRun({
      ...baseInput(repository),
      ownerId: "tab-a",
    });
    first.record({
      kind: "model_request",
      status: "started",
      round: 1,
      payload: { phase: "UNDERSTAND" },
    });
    await first.settle({
      status: "running",
      checkpointKind: "awaiting_model",
      nextAction: "invoke_model",
      resumable: true,
      state: { nextAction: "understand" },
      dependencyRefs: [{ scope: "archive", version: "archive:v1" }],
    });

    const run = (await repository.listRuns())[0];
    const resumed = await beginDurableAgentRun({
      ...baseInput(repository),
      resumeRunId: run.id,
      resumeMode: "model",
      ownerId: "tab-a",
    });

    expect(resumed.runId).toBe(run.id);
    expect((await repository.getRun(run.id))?.status).toBe("running");
  });

  it("resumes a local execution checkpoint without relabelling it as a model call", async () => {
    const repository = new MemoryAgentRunLedgerRepository({ now: () => 100 });
    const first = await beginDurableAgentRun({
      ...baseInput(repository),
      ownerId: "tab-a",
    });
    await first.settle({
      status: "running",
      checkpointKind: "safe_boundary",
      nextAction: "execute_tool",
      resumable: true,
      state: { nextAction: "compile" },
      dependencyRefs: [{ scope: "archive", version: "archive:v1" }],
    });

    const run = (await repository.listRuns())[0];
    const resumed = await beginDurableAgentRun({
      ...baseInput(repository),
      resumeRunId: run.id,
      resumeMode: "execution",
      ownerId: "tab-a",
    });

    expect(resumed.runId).toBe(run.id);
  });

  it("records a later user decision and receipt on the original proposal run", async () => {
    let clock = 200;
    const repository = new MemoryAgentRunLedgerRepository({ now: () => clock++ });
    const original = await beginDurableAgentRun({
      ...baseInput(repository),
      now: () => clock++,
      ownerId: "tab-a",
    });
    original.record({
      kind: "proposal",
      status: "succeeded",
      payload: { proposalId: "proposal-1" },
    });
    await original.settle({
      status: "awaiting_approval",
      checkpointKind: "awaiting_approval",
      nextAction: "await_approval",
      proposalRefs: ["proposal-1"],
      state: { turns: ["等待用户批准"] },
    });

    await continueDurableAgentRun({
      repository,
      runId: original.runId,
      archiveVersion: "archive:v2",
      ownerId: "tab-b",
      events: [
        {
          kind: "approval",
          status: "succeeded",
          payload: { proposalIds: ["proposal-1"], signer: "user" },
        },
        {
          kind: "commit",
          status: "succeeded",
          payload: { receiptId: "receipt-1", operationCount: 2 },
        },
      ],
      settle: {
        status: "completed",
        state: { turns: ["已批准并执行"] },
        proposalRefs: ["proposal-1"],
        receiptRefs: ["receipt-1"],
        dependencyRefs: [{ scope: "archive", version: "archive:v2" }],
      },
    });

    const run = await repository.getRun(original.runId);
    expect(run).toMatchObject({
      status: "completed",
      resumable: false,
      proposalRefs: ["proposal-1"],
      receiptRefs: ["receipt-1"],
    });
    expect(await repository.listRuns({ threadId: "assistant:default" })).toHaveLength(1);
    expect((await repository.listEvents(original.runId)).map((event) => event.kind)).toEqual([
      "proposal",
      "approval",
      "commit",
    ]);
  });

  it("redacts a pasted Gemini key from resumable state and tool observations", async () => {
    const repository = new MemoryAgentRunLedgerRepository();
    const recorder = await beginDurableAgentRun({
      ...baseInput(repository),
      ownerId: "tab-a",
    });
    const key = `AIza${"A".repeat(32)}`;
    recorder.record({
      kind: "tool_call",
      status: "started",
      toolName: "search_profiles",
      invocationId: "call-secret",
      payload: { query: `用户误贴了 ${key}` },
    });
    recorder.record({
      kind: "tool_result",
      status: "succeeded",
      toolName: "search_profiles",
      invocationId: "call-secret",
      payload: { note: `不要保存 ${key}` },
    });
    const settled = await recorder.settle({
      status: "suspended",
      checkpointKind: "awaiting_model",
      nextAction: "invoke_model",
      state: { turns: [{ role: "user", text: key }] },
    });

    const persisted = JSON.stringify({
      checkpoint: settled.checkpoint,
      observations: await repository.listObservations(recorder.runId),
    });
    expect(persisted).not.toContain(key);
    expect(persisted).toContain("[REDACTED]");
  });

  it("rejects a stale model checkpoint before claiming it and can retire the resume action", async () => {
    let clock = 300;
    const repository = new MemoryAgentRunLedgerRepository({ now: () => clock++ });
    const original = await beginDurableAgentRun({
      ...baseInput(repository),
      ownerId: "tab-a",
      now: () => clock++,
    });
    await original.settle({
      status: "suspended",
      checkpointKind: "awaiting_model",
      nextAction: "invoke_model",
      resumable: true,
      state: { turns: ["等待恢复"] },
      dependencyRefs: [{ scope: "archive", version: "archive:v1" }],
    });

    await expect(
      beginDurableAgentRun({
        ...baseInput(repository),
        archiveVersion: "archive:v2",
        resumeRunId: original.runId,
        resumeMode: "model",
        ownerId: "tab-b",
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<DurableRunResumeError>>({ code: "ARCHIVE_CHANGED" }),
    );
    expect((await repository.getRun(original.runId))?.status).toBe("suspended");

    await cancelDurableAgentRun({
      repository,
      runId: original.runId,
      archiveVersion: "archive:v2",
      reason: "archive_changed",
      state: { turns: ["档案已变化，请重新发送"], suspendedRequest: null },
      ownerId: "tab-b",
    });
    const retired = await repository.getRun(original.runId);
    expect(retired).toMatchObject({ status: "cancelled", resumable: false });
    const latestCheckpoint = await repository.getCheckpoint(retired!.latestCheckpointId!);
    expect(latestCheckpoint?.state).toMatchObject({ suspendedRequest: null });
  });

  it("binds model continuation to the original provider configuration", async () => {
    const repository = new MemoryAgentRunLedgerRepository();
    const original = await beginDurableAgentRun({ ...baseInput(repository), ownerId: "tab-a" });
    await original.settle({
      status: "suspended",
      checkpointKind: "awaiting_model",
      nextAction: "invoke_model",
      resumable: true,
      state: { turns: [] },
      dependencyRefs: [{ scope: "archive", version: "archive:v1" }],
    });

    await expect(
      beginDurableAgentRun({
        ...baseInput(repository),
        providerRef: { presetId: "other", kind: "openai", model: "other-model" },
        resumeRunId: original.runId,
        resumeMode: "model",
        ownerId: "tab-b",
      }),
    ).rejects.toMatchObject({ code: "PROVIDER_CHANGED" });
  });
});
