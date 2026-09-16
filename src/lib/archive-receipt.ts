import { recordRevision } from "./record-revision";

const APP_META_STORE = "appMeta";
const ARCHIVE_WRITE_TOKEN_PREFIX = "archiveWriteToken:";

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
  /**
   * 提交完成时该行的写入令牌。删除对删除的比对只认令牌：内容都为空时，
   * 只有令牌还能证明“这次不存在”是否仍属于本批次的写入。旧收据没有令牌
   * 时按不可验证处理，不做猜测性恢复。
   */
  tokenAfter?: string;
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
const writeTokenRowId = (store: string, id: string) =>
  `${ARCHIVE_WRITE_TOKEN_PREFIX}${store}:${id}`;
const keyOf = (store: string, id: string) => JSON.stringify([store, id]);
const kindOf = (store: ArchiveUndoStore) =>
  store === "persons" ? "person" : store === "lifeEvents" ? "event" : store;

/**
 * 每次 put/delete 都会为 (store, id) 写入一个唯一令牌；删除后令牌行保留，
 * 作为墓碑记录该行最后一次写入者。令牌只需唯一，不需要有序。安装后本事务
 * 内对这些存储的写入都会自动更新令牌；APP_META 必须已在事务的存储列表中。
 */
export function trackArchiveWriteTokens(tx: IDBTransaction) {
  const tracked = new Set<string>(ARCHIVE_UNDO_STORES);
  const rawObjectStore = tx.objectStore.bind(tx);
  const wrappedStores = new Map<string, IDBObjectStore>();
  const bump = (store: string, id: unknown) => {
    if (typeof id !== "string" || !id) return;
    tx.objectStore(APP_META_STORE).put({
      id: writeTokenRowId(store, id),
      value: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    });
  };
  const access = (name: string) => {
    if (!tracked.has(name)) return rawObjectStore(name);
    let wrapped = wrappedStores.get(name);
    if (!wrapped) {
      const raw = rawObjectStore(name);
      wrapped = new Proxy(raw, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver);
          if (prop !== "put" && prop !== "delete") {
            return typeof value === "function"
              ? (value as (...fnArgs: unknown[]) => unknown).bind(target)
              : value;
          }
          const write = value as (...fnArgs: unknown[]) => IDBRequest;
          return (...args: unknown[]) => {
            if (prop === "put") bump(name, (args[0] as { id?: unknown })?.id ?? args[1]);
            else bump(name, args[0]);
            return write.apply(target, args);
          };
        },
      });
      wrappedStores.set(name, wrapped);
    }
    return wrapped;
  };
  Object.defineProperty(tx, "objectStore", { value: access, configurable: true });
}

/** 事务内读取全部写入令牌，键与 planArchiveUndo 的行键一致。 */
export function readArchiveWriteTokens(
  tx: IDBTransaction,
  done: (tokens: Map<string, string>) => void,
) {
  const tokens = new Map<string, string>();
  const cursor = tx
    .objectStore(APP_META_STORE)
    .openCursor(
      IDBKeyRange.bound(ARCHIVE_WRITE_TOKEN_PREFIX, `${ARCHIVE_WRITE_TOKEN_PREFIX}\uffff`),
    );
  cursor.onsuccess = () => {
    const current = cursor.result;
    if (!current) {
      done(tokens);
      return;
    }
    const rowId = String(current.key).slice(ARCHIVE_WRITE_TOKEN_PREFIX.length);
    const separator = rowId.indexOf(":");
    if (separator > 0) {
      const token = (current.value as { value?: string } | undefined)?.value;
      tokens.set(keyOf(rowId.slice(0, separator), rowId.slice(separator + 1)), String(token ?? ""));
    }
    current.continue();
  };
}

/** 完整替换归档后旧令牌随旧收据一并清除，不能误用于新库。 */
export function purgeArchiveWriteTokens(tx: IDBTransaction) {
  const cursor = tx
    .objectStore(APP_META_STORE)
    .openCursor(
      IDBKeyRange.bound(ARCHIVE_WRITE_TOKEN_PREFIX, `${ARCHIVE_WRITE_TOKEN_PREFIX}\uffff`),
    );
  cursor.onsuccess = () => {
    const current = cursor.result;
    if (!current) return;
    current.delete();
    current.continue();
  };
}

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
  const barrier = tx.objectStore(APP_META_STORE).get("kinshipProjectionVersion");
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
      const meta = tx.objectStore(APP_META_STORE);
      let remaining = changes.length;
      const putReceipt = () =>
        meta.put({
          id: archiveUndoReceiptId(id),
          version: 1,
          status: "committed",
          changes,
        } satisfies ArchiveUndoReceipt);
      if (!remaining) {
        putReceipt();
        return;
      }
      for (const change of changes) {
        const tokenRequest = meta.get(writeTokenRowId(change.store, change.id));
        tokenRequest.onsuccess = () => {
          change.tokenAfter = (tokenRequest.result as { value?: string } | undefined)?.value;
          if (--remaining === 0) putReceipt();
        };
        tokenRequest.onerror = () => {
          if (--remaining === 0) putReceipt();
        };
      }
    });
}

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
  if (store === "meetingBriefs") {
    // 简报的 sourceRefs 与逐行 sources 指向真实记录；撤销不得删掉后来产物
    // 仍要点击的来源。推导关系引用解析到支持它的事实断言，投影行本身可重建。
    const refSeen = new Set<string>();
    const pushRef = (kind: unknown, id: unknown) => {
      if (typeof id !== "string" || !id) return;
      const target =
        kind === "person"
          ? "persons"
          : kind === "relation_assertion"
            ? "relationAssertions"
            : kind === "relation_projection"
              ? "derivedRelations"
              : kind === "event"
                ? "lifeEvents"
                : kind === "reminder"
                  ? "reminders"
                  : kind === "task"
                    ? "tasks"
                    : null;
      if (!target) return;
      const key = keyOf(target, id);
      if (refSeen.has(key)) return;
      refSeen.add(key);
      refs.push(key);
      if (target === "derivedRelations") {
        const derived = current.derivedRelations.find((edge) => edge.id === id);
        for (const support of (derived?.supportingRelationIds as string[] | undefined) ?? []) {
          const supportKey = keyOf("relationAssertions", support);
          if (!refSeen.has(supportKey)) {
            refSeen.add(supportKey);
            refs.push(supportKey);
          }
        }
      }
    };
    if (Array.isArray(row.sourceRefs)) {
      for (const ref of row.sourceRefs as Array<{ kind?: unknown; id?: unknown }>) {
        pushRef(ref?.kind, ref?.id);
      }
    }
    const content = row.content as Record<string, unknown> | undefined;
    if (content) {
      for (const section of Object.values(content)) {
        if (!Array.isArray(section)) continue;
        for (const line of section as Array<{ sources?: unknown }>) {
          if (!Array.isArray(line?.sources)) continue;
          for (const ref of line.sources as Array<{ kind?: unknown; id?: unknown }>) {
            pushRef(ref?.kind, ref?.id);
          }
        }
      }
    }
  }
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
 * 删除对删除的歧义由写入令牌消解：内容与令牌都仍属于本批次才允许恢复。
 */
export function planArchiveUndo(
  receipt: ArchiveUndoReceipt,
  current: ArchiveRows,
  tokens?: Map<string, string>,
) {
  const rows = new Map<string, ArchiveRow>();
  for (const store of ARCHIVE_UNDO_STORES) {
    for (const row of current[store]) rows.set(keyOf(store, row.id), row);
  }
  const pending = new Map<string, ArchiveRowChange>();
  const conflicts: ArchiveUndoConflict[] = [];
  for (const change of receipt.changes) {
    const key = keyOf(change.store, change.id);
    const now = rows.get(key) ?? null;
    if (change.after === null && now === null) {
      const tokenNow = tokens?.get(key);
      if (
        change.tokenAfter === undefined ||
        tokenNow === undefined ||
        tokenNow !== change.tokenAfter
      ) {
        conflicts.push({
          kind: kindOf(change.store),
          id: change.id,
          reason:
            change.tokenAfter === undefined || tokenNow === undefined
              ? "missing_receipt"
              : "deleted",
        });
      } else {
        pending.set(key, change);
      }
    } else if (recordRevision(now) !== recordRevision(change.after)) {
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
