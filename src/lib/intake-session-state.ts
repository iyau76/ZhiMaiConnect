import type { IngestCandidate } from "./intake-draft";
import type { IntakeAgentCheckpoint, IntakeAgentResult } from "./intake-agent";
import type { IntakeJobTrace } from "./intake-job";
import type { SemanticIntakeIssue, SemanticIntakeTaskSnapshot } from "./intake-task-state";
import type { IntakeUndoBatch } from "./intake-undo";
import { parseIntakeCommitIntent, type IntakeCommitIntent } from "./intake-commit-intent";

export const INTAKE_THREAD_ID = "intake:default";
export const INTAKE_SESSION_STATE_VERSION = 1 as const;

export type IntakeSessionPhase =
  "running" | "suspended" | "awaiting_approval" | "committed" | "rejected" | "failed";

export interface IntakeReviewSnapshot {
  draft?: IngestCandidate;
  resolutionIssues: SemanticIntakeIssue[];
  intakeState: SemanticIntakeTaskSnapshot;
  sourceRunId: string;
  proposalEntryId?: string;
}

/**
 * One durable projection for the intake UI. Source text remains in the intake
 * draft store; its immutable revision lives in the Agent checkpoint.
 */
export interface IntakeSessionState {
  version: typeof INTAKE_SESSION_STATE_VERSION;
  runId: string;
  phase: IntakeSessionPhase;
  checkpoint: IntakeAgentCheckpoint;
  trace: IntakeJobTrace[];
  extra: string | null;
  pendingProposalRefs: string[];
  receiptRefs: string[];
  commitIntent?: IntakeCommitIntent;
  intakeReceipt?: IntakeUndoBatch;
  review?: IntakeReviewSnapshot;
  updatedAt: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isTrace(value: unknown): value is IntakeJobTrace {
  return (
    isRecord(value) &&
    typeof value.text === "string" &&
    typeof value.at === "number" &&
    ["status", "model", "tool", "check", "done", "error"].includes(String(value.kind))
  );
}

function isCheckpoint(value: unknown): value is IntakeAgentCheckpoint {
  return (
    isRecord(value) &&
    value.version === 1 &&
    typeof value.sourceRunId === "string" &&
    typeof value.requestRevision === "string" &&
    typeof value.archiveRevision === "string" &&
    typeof value.providerRevision === "string" &&
    ["understand", "classify_collections", "compile", "complete"].includes(
      String(value.nextAction),
    ) &&
    Array.isArray(value.collectionClassifications) &&
    Array.isArray(value.completedBatchKeys) &&
    isRecord(value.budgetLimits) &&
    isRecord(value.consumedBudget)
  );
}

/** Parse once at the persistence boundary; UI consumers do not invent defaults. */
export function parseIntakeSessionState(value: unknown): IntakeSessionState | undefined {
  if (
    !isRecord(value) ||
    value.version !== INTAKE_SESSION_STATE_VERSION ||
    typeof value.runId !== "string" ||
    !["running", "suspended", "awaiting_approval", "committed", "rejected", "failed"].includes(
      String(value.phase),
    ) ||
    !isCheckpoint(value.checkpoint) ||
    !Array.isArray(value.trace) ||
    !value.trace.every(isTrace) ||
    !Array.isArray(value.pendingProposalRefs) ||
    !value.pendingProposalRefs.every((item) => typeof item === "string") ||
    !Array.isArray(value.receiptRefs) ||
    !value.receiptRefs.every((item) => typeof item === "string") ||
    (value.extra !== null && typeof value.extra !== "string") ||
    typeof value.updatedAt !== "number"
  ) {
    return undefined;
  }
  if (value.runId !== value.checkpoint.sourceRunId) return undefined;
  if (value.commitIntent !== undefined) {
    const commitIntent = parseIntakeCommitIntent(value.commitIntent);
    if (!commitIntent || !value.pendingProposalRefs.includes(commitIntent.proposalRef)) {
      return undefined;
    }
  }
  if (value.intakeReceipt !== undefined && !isRecord(value.intakeReceipt)) return undefined;
  if (value.review !== undefined) {
    if (
      !isRecord(value.review) ||
      (value.review.draft !== undefined && !isRecord(value.review.draft)) ||
      !Array.isArray(value.review.resolutionIssues) ||
      !isRecord(value.review.intakeState) ||
      typeof value.review.sourceRunId !== "string" ||
      (value.review.proposalEntryId !== undefined &&
        typeof value.review.proposalEntryId !== "string")
    ) {
      return undefined;
    }
  }
  return structuredClone(value) as unknown as IntakeSessionState;
}

export function intakeCheckpointResumeMode(
  checkpoint: IntakeAgentCheckpoint,
): "model" | "execution" {
  return checkpoint.nextAction === "understand" || checkpoint.nextAction === "classify_collections"
    ? "model"
    : "execution";
}

export function reviewSnapshotFromResult(input: {
  result: IntakeAgentResult;
  draft: IngestCandidate;
  runId: string;
  proposalEntryId?: string;
}): IntakeReviewSnapshot {
  return {
    draft: structuredClone(input.draft),
    resolutionIssues: structuredClone(input.result.resolutionIssues),
    intakeState: structuredClone(input.result.intakeState),
    sourceRunId: input.runId,
    ...(input.proposalEntryId ? { proposalEntryId: input.proposalEntryId } : {}),
  };
}
