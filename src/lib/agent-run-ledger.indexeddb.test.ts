import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  AgentCheckpointBudgetRecord,
  CreateAgentRunInput,
  PutMutationReceiptInput,
} from "./agent-run-ledger";
import type { ArchiveMutationPlan, ArchiveMutationSnapshot } from "./archive-mutation-plan";
import type {
  MutationCommitDecisionIntent,
  MutationCommitReceipt,
} from "./mutation-commit-coordinator";

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
    id: "run-idb-1",
    threadId: "thread-idb-1",
    ordinal: 1,
    agentName: "assistant",
    entrypoint: "models.ask",
    title: "Persistent run",
    request: { question: "Who should I contact?" },
    providerRef: { presetId: "provider", model: "model" },
    includeArchive: true,
    budget: BUDGET,
    resumable: true,
    ...overrides,
  };
}

const plan: ArchiveMutationPlan = {
  version: 1,
  id: "plan-1",
  title: "Create a follow-up task",
  reason: "The user approved this follow-up",
  createdAt: 100,
  operations: [
    {
      id: "operation-1",
      kind: "create_task",
      targetId: "task-1",
      reason: "Keep the agreed follow-up visible",
      expectedRevision: null,
      replacement: {
        title: "Follow up",
        detail: null,
        assignee: null,
        personIds: [],
        priority: "normal",
        due: null,
      },
    },
  ],
};

const emptySnapshot: ArchiveMutationSnapshot = {
  persons: [],
  assertions: [],
  derivedRelations: [],
  evidenceLinks: [],
  evidence: [],
  caseEvents: [],
  viewPreferences: [],
  referralPolicies: [],
  lifeEvents: [],
  reminders: [],
  tasks: [],
  projects: [],
  collections: [],
  collectionMemberships: [],
};

function commitReceipt(
  decisionId: string,
  proposalIds: string[],
  overrides: Partial<MutationCommitReceipt> = {},
): MutationCommitReceipt {
  return {
    id: `receipt:${decisionId}`,
    planId: plan.id,
    proposalIds,
    authorizationMode: "standard",
    signature: { signer: "user", signedAt: 110 },
    committedAt: 110,
    operationIds: ["operation-1"],
    diff: [],
    checkpoint: { id: `checkpoint:${decisionId}`, createdAt: 100, snapshot: emptySnapshot },
    ...overrides,
  };
}

function commitIntent(decisionId: string, proposalIds: string[], receipt: MutationCommitReceipt) {
  return {
    version: 1,
    decisionId,
    kind: "committed",
    proposalIds,
    plan,
    beforeFingerprint: "before",
    afterFingerprint: "after",
    archiveRevision: 0,
    receipt,
  } satisfies MutationCommitDecisionIntent;
}

beforeEach(() => {
  vi.resetModules();
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: new IDBFactory(),
    writable: true,
  });
});

describe("IndexedDbAgentRunLedgerRepository", () => {
  it("atomically creates the first lease and checkpoint", async () => {
    const { IndexedDbAgentRunLedgerRepository } = await import("./agent-run-ledger");
    const repository = new IndexedDbAgentRunLedgerRepository({ now: () => 100 });
    const started = await repository.startClaimedRun({
      run: { ...runInput(), ordinal: undefined },
      ownerId: "browser-a",
      leaseDurationMs: 1_000,
      checkpoint: {
        id: "first-checkpoint",
        kind: "awaiting_model",
        status: "active",
        nextAction: { kind: "invoke_model" },
        state: { question: "Who should I contact?" },
        observationIds: [],
        dependencyRefs: [{ scope: "archive", version: 1 }],
        budget: { ...CHECKPOINT_BUDGET, rounds: 0, toolCalls: 0 },
      },
    });

    const reloaded = new IndexedDbAgentRunLedgerRepository({ now: () => 200 });
    await expect(reloaded.getRun(started.run.id)).resolves.toMatchObject({
      status: "running",
      ordinal: 1,
      revision: 1,
      latestCheckpointId: "first-checkpoint",
      lease: { ownerId: "browser-a", epoch: 1, expiresAt: 1_100 },
    });
    await expect(reloaded.getCheckpoint("first-checkpoint")).resolves.toMatchObject({
      runId: started.run.id,
      afterSequence: 0,
    });
  });

  it("persists one atomic run boundary across repository instances", async () => {
    const { IndexedDbAgentRunLedgerRepository } = await import("./agent-run-ledger");
    const first = new IndexedDbAgentRunLedgerRepository({ now: () => 100 });
    const created = await first.createRun(runInput());
    const claimed = await first.claimRun({
      runId: created.id,
      ownerId: "tab-a",
      expectedRevision: created.revision,
      leaseDurationMs: 1_000,
    });
    await first.append({
      runId: created.id,
      expectedRevision: claimed.run.revision,
      lease: claimed.lease,
      events: [
        {
          kind: "tool_result",
          status: "succeeded",
          invocationId: "invocation-1",
          payload: { private: "source text" },
          redact: () => ({ observationRef: "observation-1" }),
        },
      ],
      observations: [
        {
          id: "observation-1",
          invocationId: "invocation-1",
          toolName: "get_profiles",
          callFingerprint: "get_profiles:person-1",
          args: { ids: ["person-1"] },
          result: [{ id: "person-1", name: "Person one" }],
          dependencyRefs: [{ scope: "persons", id: "person-1", version: 1 }],
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
        dependencyRefs: [{ scope: "persons", id: "person-1", version: 1 }],
        budget: CHECKPOINT_BUDGET,
      },
    });

    const reloaded = new IndexedDbAgentRunLedgerRepository({ now: () => 200 });
    await expect(reloaded.getRun(created.id)).resolves.toMatchObject({
      id: created.id,
      nextSequence: 2,
      latestCheckpointId: "checkpoint-1",
    });
    await expect(reloaded.listEvents(created.id)).resolves.toMatchObject([
      { sequence: 1, payload: { observationRef: "observation-1" } },
    ]);
    await expect(reloaded.listObservations(created.id)).resolves.toHaveLength(1);
    await expect(reloaded.getCheckpoint("checkpoint-1")).resolves.toMatchObject({
      afterSequence: 1,
      observationIds: ["observation-1"],
    });
  });

  it("rolls back an invalid append and fences stale executors", async () => {
    let now = 10;
    const { IndexedDbAgentRunLedgerRepository } = await import("./agent-run-ledger");
    const repository = new IndexedDbAgentRunLedgerRepository({ now: () => now });
    const created = await repository.createRun(runInput());
    const first = await repository.claimRun({
      runId: created.id,
      ownerId: "tab-a",
      expectedRevision: created.revision,
      leaseDurationMs: 10,
    });

    await expect(
      repository.append({
        runId: created.id,
        expectedRevision: first.run.revision,
        lease: first.lease,
        events: [{ kind: "validation", status: "succeeded" }],
        checkpoint: {
          id: "invalid-checkpoint",
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
    await expect(repository.listEvents(created.id)).resolves.toEqual([]);

    now = 25;
    const second = await repository.claimRun({
      runId: created.id,
      ownerId: "tab-b",
      expectedRevision: first.run.revision,
      leaseDurationMs: 10,
    });
    await expect(
      repository.append({
        runId: created.id,
        expectedRevision: second.run.revision,
        lease: first.lease,
        events: [{ kind: "validation", status: "succeeded" }],
      }),
    ).rejects.toMatchObject({ code: "LEASE_LOST" });
  });

  it("rejects credentials before writing and deletes dependent rows", async () => {
    const { IndexedDbAgentRunLedgerRepository } = await import("./agent-run-ledger");
    const repository = new IndexedDbAgentRunLedgerRepository({ now: () => 100 });
    await expect(
      repository.createRun(runInput({ request: { apiKey: "sk-never-persist-this" } })),
    ).rejects.toMatchObject({ code: "CREDENTIAL_PRESENT" });

    const created = await repository.createRun(runInput());
    const claimed = await repository.claimRun({
      runId: created.id,
      ownerId: "tab-a",
      expectedRevision: created.revision,
      leaseDurationMs: 100,
    });
    await expect(
      repository.append({
        runId: created.id,
        expectedRevision: claimed.run.revision,
        lease: claimed.lease,
        events: [
          {
            kind: "model_request",
            payload: { authorization: "Bearer forbidden" },
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "CREDENTIAL_PRESENT" });
    await expect(repository.deleteRun(created.id)).resolves.toBe(true);
    await expect(repository.getRun(created.id)).resolves.toBeUndefined();
  });
});

describe("IndexedDbMutationRecordRepository", () => {
  it("persists proposals and receipts independently from execution logs", async () => {
    const { IndexedDbMutationRecordRepository } = await import("./agent-run-ledger");
    const repository = new IndexedDbMutationRecordRepository({ now: () => 100 });
    const changes: string[] = [];
    const unsubscribe = repository.subscribe((change) => changes.push(change.kind));
    await repository.putProposal({
      id: "proposal-1",
      plan,
      enqueuedAt: 90,
      sourceRunId: "run-idb-1",
    });
    await expect(repository.listProposals({ status: "pending" })).resolves.toMatchObject([
      { id: "proposal-1", sourceRunId: "run-idb-1", updatedAt: 100 },
    ]);
    const receipt = commitReceipt("approve-1", ["proposal-1"], {
      id: "receipt-1",
      sourceRunId: "run-idb-1",
    });

    await repository.claimProposalDecision({
      proposalIds: ["proposal-1"],
      decisionId: "approve-1",
      decisionKind: "committed",
      intent: commitIntent("approve-1", ["proposal-1"], receipt),
      claimedAt: 105,
    });
    await repository.settleProposalDecision({
      proposalIds: ["proposal-1"],
      decisionId: "approve-1",
      decisionKind: "committed",
      decidedAt: 110,
      receipt,
    });
    unsubscribe();

    const reloaded = new IndexedDbMutationRecordRepository({ now: () => 200 });
    await expect(
      reloaded.listProposals({ sourceRunId: "run-idb-1", status: "committed" }),
    ).resolves.toMatchObject([{ id: "proposal-1", receiptId: "receipt-1" }]);
    await expect(reloaded.listReceipts({ sourceRunId: "run-idb-1" })).resolves.toMatchObject([
      { id: "receipt-1", proposalIds: ["proposal-1"] },
    ]);
    expect(changes).toEqual([
      "proposal_saved",
      "proposal_saved",
      "proposal_saved",
      "receipt_saved",
    ]);
  });

  it("allows only one competing approval or rejection to claim a proposal", async () => {
    const { IndexedDbMutationRecordRepository } = await import("./agent-run-ledger");
    const firstTab = new IndexedDbMutationRecordRepository({ now: () => 120 });
    const secondTab = new IndexedDbMutationRecordRepository({ now: () => 120 });
    await firstTab.putProposal({ id: "proposal-race", plan, enqueuedAt: 100 });

    const outcomes = await Promise.allSettled([
      firstTab.claimProposalDecision({
        proposalIds: ["proposal-race"],
        decisionId: "approve-in-first-tab",
        decisionKind: "committed",
        intent: commitIntent(
          "approve-in-first-tab",
          ["proposal-race"],
          commitReceipt("approve-in-first-tab", ["proposal-race"]),
        ),
        claimedAt: 120,
      }),
      secondTab.claimProposalDecision({
        proposalIds: ["proposal-race"],
        decisionId: "reject-in-second-tab",
        decisionKind: "discarded",
        claimedAt: 120,
      }),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    expect(rejected).toMatchObject({
      reason: { code: "PROPOSAL_DECISION_CONFLICT" },
    });
    const stored = await firstTab.getProposal("proposal-race");
    expect(stored?.status).toBe("pending");
    expect(stored?.decisionId).toMatch(/^(approve-in-first-tab|reject-in-second-tab)$/);
    expect(stored?.revision).toBe(1);
  });

  it("never stores credentials in proposal or receipt payloads", async () => {
    const { IndexedDbMutationRecordRepository } = await import("./agent-run-ledger");
    const repository = new IndexedDbMutationRecordRepository();
    await expect(
      repository.putProposal({
        id: "unsafe-proposal",
        plan: {
          ...plan,
          reason: "api_key=sk-never-persist-this",
        },
        enqueuedAt: 100,
      }),
    ).rejects.toMatchObject({ code: "CREDENTIAL_PRESENT" });
    const unsafeReceipt: PutMutationReceiptInput = {
      id: "unsafe-receipt",
      planId: plan.id,
      proposalIds: ["unsafe-proposal"],
      authorizationMode: "standard",
      signature: { signer: "user", signedAt: 100 },
      committedAt: 100,
      operationIds: ["operation-1"],
      diff: [],
      checkpoint: {
        id: "unsafe-checkpoint",
        createdAt: 100,
        snapshot: {
          ...emptySnapshot,
          persons: [
            {
              id: "person-with-secret",
              name: "Person",
              note: "",
              descriptors: [],
              thumb: "",
              profile: { extra: { apiKey: "AIzaSy-never-persist-this-key" } },
              createdAt: 100,
            },
          ],
        },
      },
    };
    await expect(repository.putReceipt(unsafeReceipt)).rejects.toMatchObject({
      code: "CREDENTIAL_PRESENT",
    });
    await expect(repository.listProposals()).resolves.toEqual([]);
    await expect(repository.listReceipts()).resolves.toEqual([]);
  });
});
