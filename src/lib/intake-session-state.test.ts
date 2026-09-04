import { describe, expect, it } from "vitest";

import {
  intakeCheckpointResumeMode,
  parseIntakeSessionState,
  type IntakeSessionState,
} from "./intake-session-state";
import { createIntakeCommitIntent } from "./intake-commit-intent";

function checkpoint(nextAction: "understand" | "classify_collections" | "compile" | "complete") {
  return {
    version: 1 as const,
    sourceRunId: "run-1",
    requestRevision: "request-1",
    archiveRevision: "archive-1",
    providerRevision: "provider-1",
    nextAction,
    collectionClassifications: [],
    completedBatchKeys: [],
    budgetLimits: {
      maxRounds: 12,
      maxToolCalls: 32,
      maxInputTokens: 120_000,
      maxOutputTokens: 24_000,
      maxWallTimeMs: 300_000,
    },
    consumedBudget: {
      rounds: 0,
      toolCalls: 0,
      inputTokens: { total: 0, actual: 0, estimated: 0 },
      outputTokens: { total: 0, actual: 0, estimated: 0 },
    },
    savedAt: 100,
  };
}

describe("intake session state", () => {
  it("restores one well-formed durable intake projection", () => {
    const state: IntakeSessionState = {
      version: 1,
      runId: "run-1",
      phase: "suspended",
      checkpoint: checkpoint("classify_collections"),
      trace: [{ kind: "status", text: "DISCOVER", at: 100 }],
      extra: null,
      pendingProposalRefs: [],
      receiptRefs: [],
      updatedAt: 100,
    };

    expect(parseIntakeSessionState(state)).toEqual(state);
    expect(parseIntakeSessionState({ ...state, runId: "other-run" })).toBeUndefined();
  });

  it("selects the next executor from the typed checkpoint", () => {
    expect(intakeCheckpointResumeMode(checkpoint("understand"))).toBe("model");
    expect(intakeCheckpointResumeMode(checkpoint("classify_collections"))).toBe("model");
    expect(intakeCheckpointResumeMode(checkpoint("compile"))).toBe("execution");
    expect(intakeCheckpointResumeMode(checkpoint("complete"))).toBe("execution");
  });

  it("keeps a write-ahead commit intent only while its proposal is pending", () => {
    const commitIntent = createIntakeCommitIntent({
      decisionId: "intake-decision:run-1",
      proposalRef: "intake-draft:run-1",
      expectedArchiveRevision: 2,
      batch: {},
      receipt: {
        id: "batch-1",
        committedAt: 100,
        createdPersonIds: [],
        createdRelationIds: [],
        createdEvidenceIds: [],
        createdEventIds: [],
        createdReminderIds: [],
        previousPeople: [],
        previousEvents: [],
      },
      summary: {
        createdPeople: 0,
        updatedPeople: 0,
        facts: 0,
        relations: 0,
        createdEvents: 0,
        updatedEvents: 0,
        reminders: 0,
        evidence: 0,
      },
    });
    const state: IntakeSessionState = {
      version: 1,
      runId: "run-1",
      phase: "awaiting_approval",
      checkpoint: checkpoint("complete"),
      trace: [],
      extra: null,
      pendingProposalRefs: [commitIntent.proposalRef],
      receiptRefs: [],
      commitIntent,
      updatedAt: 100,
    };

    expect(parseIntakeSessionState(state)?.commitIntent).toEqual(commitIntent);
    expect(parseIntakeSessionState({ ...state, pendingProposalRefs: [] })).toBeUndefined();
  });
});
