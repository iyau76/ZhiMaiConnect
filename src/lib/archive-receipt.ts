import { recordRevision } from "./record-revision";

export const ARCHIVE_UNDO_STORES = [
  "persons",
  "relationAssertions",
  "relationEvidenceLinks",
  "relationViewPreferences",
  "referralPolicies",
  "collections",
  "collectionMemberships",
  "evidence",
  "caseEvents",
  "tasks",
  "projects",
  "lifeEvents",
  "reminders",
  "meetingBriefs",
  "sightings",
  "voiceprints",
  "relations",
  "derivedRelations",
] as const;
export type ArchiveUndoStore = (typeof ARCHIVE_UNDO_STORES)[number];
export type ArchiveRow = { id: string; [key: string]: unknown };
export type ArchiveRows = Record<ArchiveUndoStore, ArchiveRow[]>;
export interface ArchiveRowChange {
  store: ArchiveUndoStore;
  id: string;
  before: ArchiveRow | null;
  after: ArchiveRow | null;
}
export interface ArchiveUndoConflict {
  kind: string;
  id: string;
  reason: "modified" | "deleted" | "referenced" | "missing_dependency" | "missing_receipt";
}
export interface ArchiveUndoReceipt {
  id: string;
  version: 1;
  status: "committed" | "undone";
  changes: ArchiveRowChange[];
  conflicts?: ArchiveUndoConflict[];
}
export const archiveUndoReceiptId = (id: string) => `archiveUndoReceipt:${id}`;

/** Queue all reads synchronously; the last IDB success callback keeps the transaction active. */
export function readArchiveTransactionRows(tx: IDBTransaction, done: (rows: ArchiveRows) => void) {
  const rows = {} as ArchiveRows;
  let remaining: number = ARCHIVE_UNDO_STORES.length;
  for (const store of ARCHIVE_UNDO_STORES) {
    const request = tx.objectStore(store).getAll();
    request.onsuccess = () => {
      rows[store] = request.result as ArchiveRow[];
      if (--remaining === 0) done(rows);
    };
  }
}

/** Called after queuing the mutation. The barrier waits for its pruning callbacks too. */
export function captureArchiveReceipt(tx: IDBTransaction, id: string, before: ArchiveRows) {
  const barrier = tx.objectStore("appMeta").get("kinshipProjectionVersion");
  barrier.onsuccess = () =>
    readArchiveTransactionRows(tx, (after) => {
      const changes: ArchiveRowChange[] = [];
      for (const store of ARCHIVE_UNDO_STORES) {
        // Derived edges are rebuilt, never restored as facts.
        if (store === "derivedRelations") continue;
        const oldRows = new Map(before[store].map((row) => [row.id, row]));
        const newRows = new Map(after[store].map((row) => [row.id, row]));
        for (const recordId of new Set([...oldRows.keys(), ...newRows.keys()])) {
          const previous = oldRows.get(recordId) ?? null;
          const next = newRows.get(recordId) ?? null;
          if (recordRevision(previous) !== recordRevision(next)) {
            changes.push({ store, id: recordId, before: previous, after: next });
          }
        }
      }
      tx.objectStore("appMeta").put({
        id: archiveUndoReceiptId(id),
        version: 1,
        status: "committed",
        changes,
      } satisfies ArchiveUndoReceipt);
    });
}

const keyOf = (store: string, id: string) => JSON.stringify([store, id]);
const kindOf = (store: ArchiveUndoStore) =>
  store === "persons" ? "person" : store === "lifeEvents" ? "event" : store;

/** Enumerate structural references only; display names and historical source prose are not IDs. */
function references(store: ArchiveUndoStore, row: ArchiveRow, current: ArchiveRows): string[] {
  const refs: string[] = [];
  const add = (target: string, id: unknown) => {
    if (typeof id === "string" && id) refs.push(keyOf(target, id));
  };
  const many = (target: string, ids: unknown) => {
    if (Array.isArray(ids)) ids.forEach((id) => add(target, id));
  };
  if (["lifeEvents", "reminders", "tasks", "caseEvents"].includes(store)) {
    many("persons", row.personIds);
  }
  if (store === "reminders") add("lifeEvents", row.completionEventId);
  if (store === "caseEvents") many("evidence", row.evidenceIds);
  if (store === "projects") {
    add("persons", row.ownerId);
    many("persons", row.memberIds);
  }
  if (["sightings", "voiceprints", "meetingBriefs"].includes(store)) add("persons", row.personId);
  if (store === "voiceprints") add("evidence", row.evidenceId);
  if (["relationAssertions", "relations"].includes(store)) {
    add("persons", row.fromId);
    add("persons", row.toId);
    add("relationAssertions", row.supersedesAssertionId);
    const evidence = row.evidence as { sourceIds?: string[] } | undefined;
    many("evidence", evidence?.sourceIds);
  }
  if (store === "relationEvidenceLinks") {
    add("relationAssertions", row.assertionId);
    add("evidence", row.evidenceId);
  }
  if (["relationViewPreferences", "referralPolicies"].includes(store)) {
    const derived = current.derivedRelations.find((edge) => edge.id === row.subjectId);
    if (derived) many("relationAssertions", derived.supportingRelationIds);
    else add("relationAssertions", row.subjectId);
  }
  if (store === "collectionMemberships") {
    add("persons", row.personId);
    add("collections", row.collectionId);
  }
  if (store === "evidence") {
    many("persons", row.linkedPersonIds);
    if (Array.isArray(row.entities)) {
      for (const entity of row.entities as Array<{ personId?: string }>)
        add("persons", entity.personId);
    }
  }
  return refs;
}

/**
 * Revert only our exact writes. Fixed-point dependency checks preserve both later edits
 * and the people/evidence/collections those edits still need. Never cascade-detach them.
 */
export function planArchiveUndo(receipt: ArchiveUndoReceipt, current: ArchiveRows) {
  const rows = new Map<string, ArchiveRow>();
  for (const store of ARCHIVE_UNDO_STORES) {
    for (const row of current[store]) rows.set(keyOf(store, row.id), row);
  }
  const pending = new Map<string, ArchiveRowChange>();
  const conflicts: ArchiveUndoConflict[] = [];
  for (const change of receipt.changes) {
    const key = keyOf(change.store, change.id);
    const now = rows.get(key) ?? null;
    if (recordRevision(now) !== recordRevision(change.after)) {
      conflicts.push({
        kind: kindOf(change.store),
        id: change.id,
        reason: now ? "modified" : "deleted",
      });
    } else {
      pending.set(key, change);
    }
  }
  const keep = (key: string, reason: ArchiveUndoConflict["reason"]) => {
    const change = pending.get(key);
    if (!change) return;
    pending.delete(key);
    conflicts.push({ kind: kindOf(change.store), id: change.id, reason });
  };
  let changed: boolean;
  do {
    changed = false;
    const finalRows = new Map(rows);
    for (const [key, change] of pending) {
      if (change.before) finalRows.set(key, change.before);
      else finalRows.delete(key);
    }
    for (const [key, row] of finalRows) {
      const [store] = JSON.parse(key) as [ArchiveUndoStore, string];
      if (store === "derivedRelations") continue;
      for (const target of references(store, row, current)) {
        if (finalRows.has(target)) continue;
        // A retained row needs an object we were about to delete: keep that object.
        if (pending.get(target)?.before === null) {
          keep(target, "referenced");
          changed = true;
        } else if (pending.has(key)) {
          // A restored old row would reference an independently deleted object.
          keep(key, "missing_dependency");
          changed = true;
          break;
        }
      }
    }
  } while (changed);
  return { changes: [...pending.values()], conflicts };
}
