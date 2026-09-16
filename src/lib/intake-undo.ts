import { facesDb, type LifeEventRecord, type PersonRecord } from "./face-db";
import type { IntakeCollectionUndo } from "./intake-collections";

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
  /**
   * 提交完成时触及记录的实际版本。撤销用它区分“录入自己的写入”与“批准后的
   * 人工修改”：只有当前版本仍等于提交时版本，才允许回滚或删除。跨会话恢复的
   * 批次没有这份快照，退回无条件回滚的旧语义。
   */
  committedPeople?: PersonRecord[];
  committedEvents?: LifeEventRecord[];
  collectionUndo?: IntakeCollectionUndo;
}

export interface IntakeRollbackConflict {
  kind: "person" | "event";
  id: string;
  reason: "modified" | "deleted";
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

function revisionOf(record: { updatedAt?: number; createdAt: number }) {
  return record.updatedAt ?? record.createdAt;
}

/**
 * 在提交成功后读取触及记录的当前版本，作为撤销时识别后续人工修改的基准。
 */
export async function attachCommittedIntakeSnapshots(batch: IntakeUndoBatch) {
  const personIds = new Set([
    ...batch.previousPeople.map((person) => person.id),
    ...batch.createdPersonIds,
  ]);
  const eventIds = new Set([
    ...(batch.previousEvents ?? []).map((event) => event.id),
    ...batch.createdEventIds,
  ]);
  const [people, events] = await Promise.all([facesDb.listPersons(), facesDb.listLifeEvents()]);
  batch.committedPeople = people.filter((person) => personIds.has(person.id));
  batch.committedEvents = events.filter((event) => eventIds.has(event.id));
}

/**
 * Roll back a concrete batch, including a batch that failed before it was
 * checkpointed. 返回因后续修改而保留新值的记录：撤销只撤回本批次自己的写入，
 * 不覆盖批准之后的人工修改。
 */
export async function rollbackIntakeBatch(
  batch: IntakeUndoBatch,
): Promise<IntakeRollbackConflict[]> {
  const conflicts: IntakeRollbackConflict[] = [];
  const [people, events] = await Promise.all([facesDb.listPersons(), facesDb.listLifeEvents()]);
  const personById = new Map(people.map((person) => [person.id, person]));
  const eventById = new Map(events.map((event) => [event.id, event]));
  const committedPerson = new Map((batch.committedPeople ?? []).map((p) => [p.id, p]));
  const committedEvent = new Map((batch.committedEvents ?? []).map((e) => [e.id, e]));

  // 录入新建、但批准后又被人工修改的记录：保留新值，不随批次删除。
  const createdPersonIds = batch.createdPersonIds.filter((id) => {
    const current = personById.get(id);
    const committed = committedPerson.get(id);
    if (current && committed && revisionOf(current) !== revisionOf(committed)) {
      conflicts.push({ kind: "person", id, reason: "modified" });
      return false;
    }
    return true;
  });
  const createdEventIds = batch.createdEventIds.filter((id) => {
    const current = eventById.get(id);
    const committed = committedEvent.get(id);
    if (current && committed && revisionOf(current) !== revisionOf(committed)) {
      conflicts.push({ kind: "event", id, reason: "modified" });
      return false;
    }
    return true;
  });

  // 旧值回滚仅在该记录仍等于提交时版本时进行；人工改过或已删除的保留现状。
  const previousPeople = batch.previousPeople.filter((person) => {
    const committed = committedPerson.get(person.id);
    if (!committed) return true;
    const current = personById.get(person.id);
    if (!current) {
      conflicts.push({ kind: "person", id: person.id, reason: "deleted" });
      return false;
    }
    if (revisionOf(current) !== revisionOf(committed)) {
      conflicts.push({ kind: "person", id: person.id, reason: "modified" });
      return false;
    }
    return true;
  });
  const previousEvents = (batch.previousEvents ?? []).filter((event) => {
    const committed = committedEvent.get(event.id);
    if (!committed) return true;
    const current = eventById.get(event.id);
    if (!current) {
      conflicts.push({ kind: "event", id: event.id, reason: "deleted" });
      return false;
    }
    if (revisionOf(current) !== revisionOf(committed)) {
      conflicts.push({ kind: "event", id: event.id, reason: "modified" });
      return false;
    }
    return true;
  });

  if (batch.collectionUndo) await facesDb.applyArchiveMutationBatch(batch.collectionUndo);
  // Remove dependent records before people. deletePerson also prunes relations,
  // but the explicit order keeps rollback deterministic when a batch updates an
  // existing person instead of only creating new people.
  await facesDb.putRelationshipBatch({
    deleteAssertionIds: batch.createdRelationIds,
  });
  await Promise.all(batch.createdEvidenceIds.map((id) => facesDb.deleteEvidence(id)));
  await Promise.all(createdEventIds.map((id) => facesDb.deleteLifeEvent(id)));
  await Promise.all(batch.createdReminderIds.map((id) => facesDb.deleteReminder(id)));
  await Promise.all(createdPersonIds.map((id) => facesDb.deletePerson(id)));
  await Promise.all(previousPeople.map((person) => facesDb.putPerson(person)));
  await Promise.all(previousEvents.map((event) => facesDb.putLifeEvent(event)));
  return conflicts;
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
