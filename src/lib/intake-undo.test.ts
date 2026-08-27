import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  EvidenceRecord,
  LifeEventRecord,
  PersonRecord,
  RelationRecord,
  ReminderRecord,
} from "./face-db";

function useFreshIndexedDb() {
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: new IDBFactory(),
    writable: true,
  });
}

beforeEach(() => {
  vi.resetModules();
  useFreshIndexedDb();
});

describe("latest intake rollback", () => {
  it("removes every record created by the batch and restores updated people", async () => {
    const { facesDb } = await import("./face-db");
    const { getLatestIntakeBatch, rememberIntakeBatch, undoLatestIntakeBatch } =
      await import("./intake-undo");
    const before: PersonRecord = {
      id: "existing",
      name: "Existing",
      note: "before",
      descriptors: [],
      thumb: "",
      createdAt: 1,
    };
    const created: PersonRecord = {
      ...before,
      id: "created",
      name: "Created",
    };
    const relation: RelationRecord = {
      id: "relation",
      fromId: before.id,
      toId: created.id,
      label: "friend",
      createdAt: 2,
    };
    const evidence: EvidenceRecord = {
      id: "evidence",
      kind: "note",
      title: "note",
      text: "structured excerpt",
      createdAt: 2,
    };
    const event: LifeEventRecord = {
      id: "event",
      date: "2026-08-26",
      title: "event",
      personIds: [before.id, created.id],
      createdAt: 2,
    };
    const reminder: ReminderRecord = {
      id: "reminder",
      title: "reminder",
      personIds: [created.id],
      done: false,
      createdAt: 2,
    };

    await facesDb.putPerson({ ...before, note: "after", updatedAt: 2 });
    await facesDb.putPerson(created);
    await facesDb.putRelation(relation);
    await facesDb.putEvidence(evidence);
    await facesDb.putLifeEvent(event);
    await facesDb.putReminder(reminder);
    rememberIntakeBatch({
      id: "batch",
      committedAt: 2,
      createdPersonIds: [created.id],
      createdRelationIds: [relation.id],
      createdEvidenceIds: [evidence.id],
      createdEventIds: [event.id],
      createdReminderIds: [reminder.id],
      previousPeople: [before],
    });

    expect(getLatestIntakeBatch()?.id).toBe("batch");
    await expect(undoLatestIntakeBatch()).resolves.toMatchObject({ id: "batch" });
    await expect(facesDb.listPersons()).resolves.toEqual([before]);
    await expect(facesDb.listRelations()).resolves.toEqual([]);
    await expect(facesDb.listEvidence()).resolves.toEqual([]);
    await expect(facesDb.listLifeEvents()).resolves.toEqual([]);
    await expect(facesDb.listReminders()).resolves.toEqual([]);
    expect(getLatestIntakeBatch()).toBeNull();
  });

  it("returns null when there is no intake batch to undo", async () => {
    const { undoLatestIntakeBatch } = await import("./intake-undo");
    await expect(undoLatestIntakeBatch()).resolves.toBeNull();
  });
});
