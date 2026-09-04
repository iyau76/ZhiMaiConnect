import {
  facesDb,
  type ArchiveMutationDecisionApplyResult,
  type ArchiveMutationWriteBatch,
} from "./face-db";
import type { IntakeUndoBatch } from "./intake-undo";

export const INTAKE_COMMIT_INTENT_VERSION = 1 as const;

export interface IntakeCommitSummary {
  createdPeople: number;
  updatedPeople: number;
  facts: number;
  relations: number;
  createdEvents: number;
  updatedEvents: number;
  reminders: number;
  evidence: number;
}

/**
 * Exact local write selected by one user approval. It is checkpointed before
 * IndexedDB changes, so a reload can replay the same stable record IDs without
 * asking the model again or manufacturing a second batch.
 */
export interface IntakeCommitIntent {
  version: typeof INTAKE_COMMIT_INTENT_VERSION;
  decisionId: string;
  proposalRef: string;
  expectedArchiveRevision: number;
  batch: ArchiveMutationWriteBatch;
  receipt: IntakeUndoBatch;
  summary: IntakeCommitSummary;
}

export function createIntakeCommitIntent(input: Omit<IntakeCommitIntent, "version">) {
  return structuredClone({
    version: INTAKE_COMMIT_INTENT_VERSION,
    ...input,
  }) satisfies IntakeCommitIntent;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function parseIntakeCommitIntent(value: unknown): IntakeCommitIntent | undefined {
  if (
    !isRecord(value) ||
    value.version !== INTAKE_COMMIT_INTENT_VERSION ||
    typeof value.decisionId !== "string" ||
    !value.decisionId.trim() ||
    typeof value.proposalRef !== "string" ||
    !value.proposalRef.trim() ||
    !Number.isInteger(value.expectedArchiveRevision) ||
    Number(value.expectedArchiveRevision) < 0 ||
    !isRecord(value.batch) ||
    !isRecord(value.receipt) ||
    !isRecord(value.summary)
  ) {
    return undefined;
  }
  const summary = value.summary;
  if (
    [
      "createdPeople",
      "updatedPeople",
      "facts",
      "relations",
      "createdEvents",
      "updatedEvents",
      "reminders",
      "evidence",
    ].some((key) => !Number.isInteger(summary[key]) || Number(summary[key]) < 0)
  ) {
    return undefined;
  }
  return structuredClone(value) as unknown as IntakeCommitIntent;
}

export interface IntakeCommitRepository {
  applyArchiveMutationBatchOnce(
    batch: ArchiveMutationWriteBatch,
    guard: { decisionId: string; expectedRevision: number },
  ): Promise<ArchiveMutationDecisionApplyResult>;
  hasAppliedArchiveMutationDecision(decisionId: string): Promise<boolean>;
}

/** The decision marker and archive rows share one IndexedDB transaction. */
export async function executeIntakeCommitIntent(
  intent: IntakeCommitIntent,
  repository: IntakeCommitRepository = facesDb,
) {
  try {
    return await repository.applyArchiveMutationBatchOnce(intent.batch, {
      decisionId: intent.decisionId,
      expectedRevision: intent.expectedArchiveRevision,
    });
  } catch (error) {
    if (await repository.hasAppliedArchiveMutationDecision(intent.decisionId)) {
      return "already_applied" as const;
    }
    throw error;
  }
}
