import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LifeEventRecord } from "./face-db";
import { recordRevision } from "./record-revision";
const original: LifeEventRecord = {
  id: "event",
  date: "2026-06-01",
  title: "合成旧标题",
  createdAt: 1,
};
beforeEach(() => {
  vi.resetModules();
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
});
describe("event compare-and-swap persistence", () => {
  it("retries the same create decision exactly once", async () => {
    const { facesDb } = await import("./face-db");
    expect(await facesDb.compareAndSwapLifeEvent(original, null, "save")).toEqual({
      status: "saved",
    });
    expect(await facesDb.compareAndSwapLifeEvent(original, null, "save")).toEqual({
      status: "already_saved",
    });
    expect(await facesDb.listLifeEvents()).toEqual([original]);
  });
  it("rejects every stale retry, even with equal timestamps", async () => {
    const { facesDb } = await import("./face-db");
    await facesDb.putLifeEvent(original);
    const baseline = recordRevision(original);
    const manual = { ...original, title: "合成外部修改" };
    await facesDb.putLifeEvent(manual);
    for (let attempt = 0; attempt < 3; attempt++) {
      expect(
        (
          await facesDb.compareAndSwapLifeEvent(
            { ...original, title: "迟到修改" },
            baseline,
            `save-${attempt}`,
          )
        ).status,
      ).toBe("conflict");
      await facesDb.listLifeEvents();
    }
    expect(await facesDb.listLifeEvents()).toEqual([manual]);
  });
  it("serializes two competing writes in the database (one winner)", async () => {
    const { facesDb } = await import("./face-db");
    await facesDb.putLifeEvent(original);
    const baseline = recordRevision(original);
    const results = await Promise.all([
      facesDb.compareAndSwapLifeEvent({ ...original, title: "甲" }, baseline, "first"),
      facesDb.compareAndSwapLifeEvent({ ...original, title: "乙" }, baseline, "second"),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(["conflict", "saved"]);
  });
  it("does not resurrect a deleted event", async () => {
    const { facesDb } = await import("./face-db");
    await facesDb.putLifeEvent(original);
    await facesDb.deleteLifeEvent(original.id);
    expect(
      await facesDb.compareAndSwapLifeEvent(original, recordRevision(original), "save"),
    ).toEqual({ status: "missing" });
    expect(await facesDb.listLifeEvents()).toEqual([]);
  });
  it("does not overwrite a later edit when replaying a lost completion reply", async () => {
    const { facesDb } = await import("./face-db");
    await facesDb.compareAndSwapLifeEvent(original, null, "save");
    const manual = { ...original, title: "后来修改" };
    await facesDb.putLifeEvent(manual);
    expect((await facesDb.compareAndSwapLifeEvent(original, null, "save")).status).toBe(
      "already_saved",
    );
    expect(await facesDb.listLifeEvents()).toEqual([manual]);
  });
});
