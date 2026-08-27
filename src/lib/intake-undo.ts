import { facesDb, type LifeEventRecord, type PersonRecord } from "./face-db";

export interface IntakeUndoBatch {
  id: string;
  committedAt: number;
  createdPersonIds: string[];
  createdRelationIds: string[];
  createdEvidenceIds: string[];
  createdEventIds: string[];
  createdReminderIds: string[];
  /** Only structured records that existed before the intake are retained. */
  previousPeople: PersonRecord[];
  /** Events overwritten by an approved update, kept for one-step rollback. */
  previousEvents?: LifeEventRecord[];
}

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

export async function undoLatestIntakeBatch(): Promise<IntakeUndoBatch | null> {
  const batch = latestBatch;
  if (!batch) return null;

  // Remove dependent records before people. deletePerson also prunes relations,
  // but the explicit order keeps rollback deterministic when a batch updates an
  // existing person instead of only creating new people.
  await Promise.all(batch.createdRelationIds.map((id) => facesDb.deleteRelation(id)));
  await Promise.all(batch.createdEvidenceIds.map((id) => facesDb.deleteEvidence(id)));
  await Promise.all(batch.createdEventIds.map((id) => facesDb.deleteLifeEvent(id)));
  await Promise.all(batch.createdReminderIds.map((id) => facesDb.deleteReminder(id)));
  await Promise.all(batch.createdPersonIds.map((id) => facesDb.deletePerson(id)));
  await Promise.all(batch.previousPeople.map((person) => facesDb.putPerson(person)));
  await Promise.all((batch.previousEvents ?? []).map((event) => facesDb.putLifeEvent(event)));

  latestBatch = null;
  return structuredClone(batch);
}
