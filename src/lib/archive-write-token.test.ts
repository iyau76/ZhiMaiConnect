import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";
import { vi } from "vitest";

import type { CollectionMembershipRecord, MeetingBriefRecord, PersonRecord } from "./face-db";

function useFreshIndexedDb() {
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: new IDBFactory(),
    writable: true,
  });
  Object.defineProperty(globalThis, "IDBKeyRange", {
    configurable: true,
    value: IDBKeyRange,
    writable: true,
  });
}

beforeEach(() => {
  vi.resetModules();
  useFreshIndexedDb();
});

const person = (id: string): PersonRecord => ({
  id,
  name: `合成人物${id}`,
  note: "",
  descriptors: [],
  thumb: "",
  createdAt: 1,
});

const membership = (id: string, collectionId: string): CollectionMembershipRecord => ({
  id,
  collectionId,
  personId: "p1",
  source: "manual",
  createdAt: 1,
});

async function seedLibrary() {
  const { facesDb } = await import("./face-db");
  await facesDb.applyArchiveMutationBatch({
    persons: [person("p1")],
    collections: [
      { id: "c1", name: "示例圈层", kind: "relationship_circle", createdAt: 1, updatedAt: 1 },
    ],
    collectionMemberships: [membership("m1", "c1")],
  });
}

async function batchDeleteMembership(receiptId: string) {
  const { facesDb } = await import("./face-db");
  await facesDb.applyArchiveMutationBatch({ deleteCollectionMembershipIds: ["m1"] }, receiptId);
}

async function readMemberships() {
  const { facesDb } = await import("./face-db");
  return facesDb.listCollectionMemberships();
}

describe("archive write tokens disambiguate deletions during undo", () => {
  it("restores a membership deleted by the batch when nothing else touched it", async () => {
    await seedLibrary();
    await batchDeleteMembership("receipt:plain");
    expect(await readMemberships()).toHaveLength(0);

    const { facesDb } = await import("./face-db");
    const conflicts = await facesDb.undoArchiveMutation("receipt:plain");
    expect(conflicts).toEqual([]);
    expect((await readMemberships()).map((row) => row.id)).toEqual(["m1"]);
  });

  it("keeps the membership absent when the user re-added and re-deleted it afterwards", async () => {
    await seedLibrary();
    await batchDeleteMembership("receipt:aba");

    // 用户随后重新加入同 ID 成员，又自行删除——状态回到“不存在”，但写入者已易主。
    const { facesDb } = await import("./face-db");
    await facesDb.putCollectionMembership({ ...membership("m1", "c1"), source: "ai_approved" });
    await facesDb.applyArchiveMutationBatch({ deleteCollectionMembershipIds: ["m1"] });

    const conflicts = await facesDb.undoArchiveMutation("receipt:aba");
    expect(conflicts).toEqual([{ kind: "collectionMemberships", id: "m1", reason: "deleted" }]);
    expect(await readMemberships()).toEqual([]);
  });

  it("keeps the user's newer membership content when re-added after the batch delete", async () => {
    await seedLibrary();
    await batchDeleteMembership("receipt:modified");
    const { facesDb } = await import("./face-db");
    await facesDb.putCollectionMembership({
      ...membership("m1", "c1"),
      source: "manual",
      createdAt: 99,
    });

    const conflicts = await facesDb.undoArchiveMutation("receipt:modified");
    expect(conflicts).toEqual([{ kind: "collectionMemberships", id: "m1", reason: "modified" }]);
    expect((await readMemberships())[0].createdAt).toBe(99);
  });

  it("refuses instead of guessing when a legacy receipt lacks write tokens", async () => {
    await seedLibrary();
    await batchDeleteMembership("receipt:legacy");
    // 手工抹去收据里的令牌，模拟旧版本写入的收据。
    await stripReceiptTokens("receipt:legacy");

    const { facesDb } = await import("./face-db");
    const conflicts = await facesDb.undoArchiveMutation("receipt:legacy");
    expect(conflicts).toEqual([
      { kind: "collectionMemberships", id: "m1", reason: "missing_receipt" },
    ]);
    expect(await readMemberships()).toEqual([]);
  });
});

async function stripReceiptTokens(receiptId: string) {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("openglass-faces");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("appMeta", "readwrite");
    const store = tx.objectStore("appMeta");
    const request = store.get(`archiveUndoReceipt:${receiptId}`);
    request.onsuccess = () => {
      const receipt = request.result as { changes?: Array<{ tokenAfter?: string }> };
      for (const change of receipt.changes ?? []) delete change.tokenAfter;
      store.put(receipt);
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  db.close();
}

describe("meeting brief sources join the undo dependency closure", () => {
  const briefRef = {
    id: "brief-1",
    seriesId: "series-1",
    personId: "p1",
    personName: "合成人物p1",
    title: "见面简报（合成）",
    sourceRevision: "rev-1",
    sourceRefs: [
      { kind: "person", id: "p1", revision: "r1" },
      { kind: "event", id: "e1", revision: "r2" },
    ] as MeetingBriefRecord["sourceRefs"],
    content: {
      profile: [],
      recentEvents: [
        {
          text: "合成事件行",
          sources: [{ kind: "event", id: "e1", revision: "r2" }],
        },
      ],
      openItems: [],
      relatedPeople: [],
      talkingPoints: [],
      gaps: [],
    },
    createdAt: 3,
  } as unknown as MeetingBriefRecord;

  it("keeps the event a saved brief still references when undoing the intake", async () => {
    const { facesDb } = await import("./face-db");
    await facesDb.applyArchiveMutationBatch(
      {
        persons: [person("p1")],
        lifeEvents: [{ id: "e1", title: "简报引用的事件", date: "2026-06-01", createdAt: 2 }],
      },
      "receipt:brief",
    );
    await facesDb.putMeetingBrief(briefRef);

    // 批次把事件替换成更新版；简报仍引用同一 ID。
    await facesDb.applyArchiveMutationBatch({
      lifeEvents: [
        { id: "e1", title: "批次更新后的事件", date: "2026-06-02", createdAt: 2, updatedAt: 5 },
      ],
    });

    const conflicts = await facesDb.undoArchiveMutation("receipt:brief");
    // 事件在批次之后又被独立更新 → 按冲突保留新版；人物被简报引用 → 保留。
    expect(conflicts).toEqual([
      { kind: "event", id: "e1", reason: "modified" },
      { kind: "person", id: "p1", reason: "referenced" },
    ]);
    const [event] = await facesDb.listLifeEvents();
    expect(event.id).toBe("e1");
    expect(event.title).toBe("批次更新后的事件");
  });

  it("still removes an intake-created event that no brief references", async () => {
    const { facesDb } = await import("./face-db");
    await facesDb.applyArchiveMutationBatch(
      {
        persons: [person("p1")],
        lifeEvents: [{ id: "e2", title: "未被引用的事件", date: "2026-06-01", createdAt: 2 }],
      },
      "receipt:unref",
    );
    const conflicts = await facesDb.undoArchiveMutation("receipt:unref");
    expect(conflicts).toEqual([]);
    await expect(facesDb.listLifeEvents()).resolves.toEqual([]);
  });
});
