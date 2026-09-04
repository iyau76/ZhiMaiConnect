import { describe, expect, it } from "vitest";

import type { AgentRunEventInput } from "./agent-run-log";
import {
  AgentRunLedgerConflictError,
  MemoryAgentRunLedgerRepository,
  type AgentCheckpointBudgetRecord,
  type CreateAgentRunInput,
} from "./agent-run-ledger";

const BUDGET = {
  maxRounds: 7,
  maxToolCalls: 16,
  maxInputTokens: 60_000,
  maxOutputTokens: 12_000,
  maxWallTimeMs: 180_000,
};

const CHECKPOINT_BUDGET: AgentCheckpointBudgetRecord = {
  rounds: 1,
  toolCalls: 1,
  inputTokens: { total: 100, actual: 0, estimated: 100 },
  outputTokens: { total: 20, actual: 0, estimated: 20 },
};

function runInput(overrides: Partial<CreateAgentRunInput> = {}): CreateAgentRunInput {
  return {
    id: "run-1",
    threadId: "thread-1",
    ordinal: 1,
    agentName: "assistant",
    entrypoint: "models.ask",
    title: "问一问",
    request: { question: "这周应该联系谁？" },
    providerRef: { presetId: "deepseek", model: "deepseek-chat" },
    includeArchive: true,
    budget: BUDGET,
    resumable: true,
    ...overrides,
  };
}

function toolEvents(): AgentRunEventInput[] {
  return [
    {
      kind: "tool_call",
      status: "started",
      round: 1,
      toolName: "get_profiles",
      invocationId: "invoke-1",
      payload: { ids: ["person-1"] },
    },
    {
      kind: "tool_result",
      status: "succeeded",
      round: 1,
      toolName: "get_profiles",
      invocationId: "invoke-1",
      payload: { observationRef: "observation-1", count: 1 },
    },
  ];
}

async function claimedRepository(now: () => number = () => 100) {
  const repository = new MemoryAgentRunLedgerRepository({ now });
  const created = await repository.createRun(runInput());
  const claimed = await repository.claimRun({
    runId: created.id,
    ownerId: "tab-a",
    expectedRevision: created.revision,
    leaseDurationMs: 1_000,
  });
  return { repository, ...claimed };
}

describe("MemoryAgentRunLedgerRepository", () => {
  it("atomically starts a claimed run with its first checkpoint", async () => {
    const repository = new MemoryAgentRunLedgerRepository({ now: () => 100 });
    const { run, lease, checkpoint } = await repository.startClaimedRun({
      run: {
        ...runInput(),
        ordinal: undefined,
      },
      ownerId: "browser-a",
      leaseDurationMs: 1_000,
      checkpoint: {
        id: "initial-checkpoint",
        kind: "awaiting_model",
        status: "active",
        nextAction: { kind: "invoke_model" },
        state: { prompt: "这周应该联系谁？" },
        observationIds: [],
        dependencyRefs: [{ scope: "archive", version: "v1" }],
        budget: { ...CHECKPOINT_BUDGET, rounds: 0, toolCalls: 0 },
      },
    });

    expect(run).toMatchObject({
      status: "running",
      ordinal: 1,
      revision: 1,
      latestCheckpointId: "initial-checkpoint",
      lease: { ownerId: "browser-a", epoch: 1, expiresAt: 1_100 },
    });
    expect(lease).toEqual({ runId: run.id, ownerId: "browser-a", epoch: 1 });
    expect(checkpoint).toMatchObject({
      id: "initial-checkpoint",
      runId: run.id,
      afterSequence: 0,
    });
  });

  it("leaves no partial run when an initial checkpoint is invalid", async () => {
    const repository = new MemoryAgentRunLedgerRepository();
    await expect(
      repository.startClaimedRun({
        run: runInput(),
        ownerId: "browser-a",
        leaseDurationMs: 1_000,
        checkpoint: {
          kind: "awaiting_model",
          status: "active",
          nextAction: { kind: "invoke_model" },
          state: {},
          observationIds: ["missing-observation"],
          dependencyRefs: [],
          budget: CHECKPOINT_BUDGET,
        },
      }),
    ).rejects.toMatchObject({ code: "INVALID_REFERENCE" });
    await expect(repository.listRuns()).resolves.toEqual([]);
  });

  it("atomically appends events, an observation and a checkpoint without storing steps", async () => {
    const { repository, run, lease } = await claimedRepository();

    const appended = await repository.append({
      runId: run.id,
      expectedRevision: run.revision,
      lease,
      events: toolEvents(),
      observations: [
        {
          id: "observation-1",
          invocationId: "invoke-1",
          toolName: "get_profiles",
          callFingerprint: "get_profiles:person-1",
          args: { ids: ["person-1"] },
          result: [{ id: "person-1", name: "唐悦" }],
          dependencyRefs: [{ scope: "persons", id: "person-1", version: 3 }],
          obtainedAt: 100,
        },
      ],
      checkpoint: {
        id: "checkpoint-1",
        kind: "safe_boundary",
        status: "active",
        nextAction: { kind: "invoke_model" },
        state: { nextRound: 2 },
        observationIds: ["observation-1"],
        dependencyRefs: [{ scope: "persons", id: "person-1", version: 3 }],
        budget: CHECKPOINT_BUDGET,
      },
    });

    expect(appended.events.map((event) => [event.id, event.sequence])).toEqual([
      ["run-1:1", 1],
      ["run-1:2", 2],
    ]);
    expect(appended.run).not.toHaveProperty("steps");
    expect(appended.run.latestCheckpointId).toBe("checkpoint-1");
    expect((await repository.listEvents(run.id)).map((event) => event.kind)).toEqual([
      "tool_call",
      "tool_result",
    ]);
    expect(await repository.listObservations(run.id)).toHaveLength(1);
    expect(await repository.listCheckpoints(run.id)).toMatchObject([
      { id: "checkpoint-1", afterSequence: 2, observationIds: ["observation-1"] },
    ]);
  });

  it("does not partially commit when a checkpoint references a missing observation", async () => {
    const { repository, run, lease } = await claimedRepository();

    await expect(
      repository.append({
        runId: run.id,
        expectedRevision: run.revision,
        lease,
        events: toolEvents(),
        checkpoint: {
          id: "bad-checkpoint",
          kind: "safe_boundary",
          status: "active",
          nextAction: { kind: "invoke_model" },
          state: {},
          observationIds: ["missing"],
          dependencyRefs: [],
          budget: CHECKPOINT_BUDGET,
        },
      }),
    ).rejects.toMatchObject({ code: "INVALID_REFERENCE" });

    expect(await repository.listEvents(run.id)).toEqual([]);
    expect(await repository.listCheckpoints(run.id)).toEqual([]);
    expect((await repository.getRun(run.id))?.revision).toBe(run.revision);
  });

  it("uses revision CAS and lease epochs to fence concurrent executors", async () => {
    let now = 10;
    const repository = new MemoryAgentRunLedgerRepository({ now: () => now });
    const created = await repository.createRun(runInput());
    const first = await repository.claimRun({
      runId: created.id,
      ownerId: "tab-a",
      expectedRevision: created.revision,
      leaseDurationMs: 10,
    });

    await expect(
      repository.claimRun({
        runId: created.id,
        ownerId: "tab-b",
        expectedRevision: created.revision,
        leaseDurationMs: 10,
      }),
    ).rejects.toMatchObject({ code: "REVISION_MISMATCH" });

    now = 25;
    const second = await repository.claimRun({
      runId: created.id,
      ownerId: "tab-b",
      expectedRevision: first.run.revision,
      leaseDurationMs: 10,
    });
    expect(second.lease.epoch).toBeGreaterThan(first.lease.epoch);

    await expect(
      repository.append({
        runId: created.id,
        expectedRevision: second.run.revision,
        lease: first.lease,
        events: [{ kind: "validation", status: "succeeded" }],
      }),
    ).rejects.toMatchObject({ code: "LEASE_LOST" });

    await expect(
      repository.append({
        runId: created.id,
        expectedRevision: second.run.revision,
        lease: second.lease,
        events: [{ kind: "validation", status: "succeeded" }],
      }),
    ).resolves.toMatchObject({ run: { revision: second.run.revision + 1 } });
  });

  it("renews and releases only the current lease", async () => {
    let now = 100;
    const { repository, run, lease } = await claimedRepository(() => now);
    now = 200;
    const renewed = await repository.renewLease({
      lease,
      expectedRevision: run.revision,
      leaseDurationMs: 500,
    });
    expect(renewed.run.lease?.expiresAt).toBe(700);

    const released = await repository.releaseLease({
      lease,
      expectedRevision: renewed.run.revision,
    });
    expect(released.lease).toBeUndefined();
    await expect(
      repository.releaseLease({ lease, expectedRevision: released.revision }),
    ).rejects.toMatchObject({ code: "LEASE_LOST" });
  });

  it("releases the lease when waiting for approval and keeps proposal and receipt refs unique", async () => {
    const { repository, run, lease } = await claimedRepository();
    const appended = await repository.append({
      runId: run.id,
      expectedRevision: run.revision,
      lease,
      events: [{ kind: "proposal", status: "succeeded", payload: { proposalRef: "p-1" } }],
      checkpoint: {
        id: "approval-checkpoint",
        kind: "awaiting_approval",
        status: "active",
        nextAction: { kind: "await_approval", payload: { proposalRef: "p-1" } },
        state: {},
        observationIds: [],
        dependencyRefs: [],
        budget: CHECKPOINT_BUDGET,
      },
      transition: {
        status: "awaiting_approval",
        proposalRefs: ["p-1", "p-1"],
        receiptRefs: ["receipt-1", "receipt-1"],
      },
    });

    expect(appended.run.lease).toBeUndefined();
    expect(appended.run.proposalRefs).toEqual(["p-1"]);
    expect(appended.run.receiptRefs).toEqual(["receipt-1"]);
  });

  it.each([
    { request: { apiKey: "sk-never-store-this" } },
    { request: { nested: { authorization: "Bearer secret-token" } } },
  ])("rejects credentials before creating a run: $request", async (override) => {
    const repository = new MemoryAgentRunLedgerRepository();
    await expect(repository.createRun(runInput(override))).rejects.toBeInstanceOf(
      AgentRunLedgerConflictError,
    );
    expect(await repository.listRuns()).toEqual([]);
  });

  it("rejects credentials from events without advancing the ledger", async () => {
    const { repository, run, lease } = await claimedRepository();
    await expect(
      repository.append({
        runId: run.id,
        expectedRevision: run.revision,
        lease,
        events: [
          {
            kind: "model_request",
            status: "started",
            payload: { api_key: "sk-never-store-this" },
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "CREDENTIAL_PRESENT" });
    expect(await repository.listEvents(run.id)).toEqual([]);
  });

  it("runs an event redactor before cloning and never persists the function", async () => {
    const { repository, run, lease } = await claimedRepository();
    const appended = await repository.append({
      runId: run.id,
      expectedRevision: run.revision,
      lease,
      events: [
        {
          kind: "model_request",
          status: "started",
          payload: { prompt: "private source material" },
          redact: () => ({ prompt: "[REDACTED]" }),
        },
      ],
    });

    expect(appended.events).toMatchObject([{ payload: { prompt: "[REDACTED]" } }]);
    expect(appended.events[0]).not.toHaveProperty("redact");
  });

  it("deletes one run with its dependent records and can clear the ledger", async () => {
    const repository = new MemoryAgentRunLedgerRepository({ now: () => 10 });
    const first = await repository.createRun(runInput());
    const firstClaim = await repository.claimRun({
      runId: first.id,
      ownerId: "tab-a",
      expectedRevision: first.revision,
      leaseDurationMs: 100,
    });
    await repository.append({
      runId: first.id,
      expectedRevision: firstClaim.run.revision,
      lease: firstClaim.lease,
      observations: [
        {
          id: "delete-observation",
          invocationId: "delete-invocation",
          toolName: "get_profiles",
          callFingerprint: "get_profiles:delete",
          args: {},
          result: {},
          dependencyRefs: [],
          obtainedAt: 10,
        },
      ],
      checkpoint: {
        id: "delete-checkpoint",
        kind: "safe_boundary",
        status: "active",
        nextAction: { kind: "finalize" },
        state: {},
        observationIds: ["delete-observation"],
        dependencyRefs: [],
        budget: CHECKPOINT_BUDGET,
      },
    });
    await repository.createRun(runInput({ id: "run-2", ordinal: 2 }));

    await expect(repository.deleteRun(first.id)).resolves.toBe(true);
    await expect(repository.deleteRun(first.id)).resolves.toBe(false);
    await expect(repository.getRun("run-2")).resolves.toBeDefined();
    await repository.clear();
    await expect(repository.listRuns()).resolves.toEqual([]);
  });

  it("publishes committed changes and returns detached copies", async () => {
    const repository = new MemoryAgentRunLedgerRepository({ now: () => 10 });
    const changes: string[] = [];
    const unsubscribe = repository.subscribe((change) => changes.push(change.kind));
    const created = await repository.createRun(runInput());
    const loaded = await repository.getRun(created.id);
    loaded!.proposalRefs.push("external-mutation");
    expect((await repository.getRun(created.id))?.proposalRefs).toEqual([]);

    await repository.claimRun({
      runId: created.id,
      ownerId: "tab-a",
      expectedRevision: created.revision,
      leaseDurationMs: 100,
    });
    unsubscribe();
    await repository.createRun(runInput({ id: "run-2", ordinal: 2 }));

    expect(changes).toEqual(["run_created", "run_claimed"]);
  });
});
