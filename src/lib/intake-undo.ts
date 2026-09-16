import { facesDb, type LifeEventRecord, type PersonRecord } from "./face-db";
import type { ArchiveUndoConflict } from "./archive-receipt";
import type { IntakeCollectionUndo } from "./intake-collections";

export interface IntakeUndoBatch {
  id: string;
  committedAt: number;
  /** ID of the transactionally persisted before/after receipt. */
  undoReceiptId?: string;
  createdPersonIds: string[];
  createdRelationIds: string[];
  createdEvidenceIds: string[];
  createdEventIds: string[];
  createdReminderIds: string[];
  /** Only structured records that existed before the intake are retained. */
  previousPeople: PersonRecord[];
  /** Events overwritten by an approved update, kept for one-step rollback. */
  previousEvents?: LifeEventRecord[];
  /** @deprecated Legacy snapshot fields are readable, but cannot authorize an undo. */
  committedPeople?: PersonRecord[];
  committedEvents?: LifeEventRecord[];
  collectionUndo?: IntakeCollectionUndo;
}

export type IntakeRollbackConflict = ArchiveUndoConflict;

let latestBatch: IntakeUndoBatch | null = null;

/**
 * Keep one in-memory rollback checkpoint. It deliberately does not use
 * localStorage/sessionStorage so an intake's previous structured values do not
 * create another persistent copy outside IndexedDB.
 */
export function rememberIntakeBatch(batch: IntakeUndoBatch) {
  latestBatch = structuredClone(batch);
}

export function getLatestIntakeBatch(): IntakeUndoBatch | null {
  return latestBatch ? structuredClone(latestBatch) : null;
}

export function clearLatestIntakeBatch() {
  latestBatch = null;
}

/** Legacy receipts without a transactional snapshot are non-destructive. */
export async function rollbackIntakeBatch(
  batch: IntakeUndoBatch,
): Promise<IntakeRollbackConflict[]> {
  return facesDb.undoArchiveMutation(batch.undoReceiptId ?? batch.id);
}

export async function undoLatestIntakeBatch(): Promise<{
  batch: IntakeUndoBatch;
  conflicts: IntakeRollbackConflict[];
} | null> {
  const batch = latestBatch;
  if (!batch) return null;
  const conflicts = await rollbackIntakeBatch(batch);
  latestBatch = null;
  return { batch: structuredClone(batch), conflicts };
}
