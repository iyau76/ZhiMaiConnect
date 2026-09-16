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
    const previousEvent: LifeEventRecord = {
      id: "previous-event",
      date: "2026-08-25",
      title: "before event",
      createdAt: 1,
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
    await facesDb.putLifeEvent({ ...previousEvent, title: "after event", updatedAt: 2 });
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
      previousEvents: [previousEvent],
    });

    expect(getLatestIntakeBatch()?.id).toBe("batch");
    await expect(undoLatestIntakeBatch()).resolves.toMatchObject({
      batch: { id: "batch" },
      conflicts: [],
    });
    await expect(facesDb.listPersons()).resolves.toEqual([before]);
    await expect(facesDb.listRelations()).resolves.toEqual([]);
    await expect(facesDb.listEvidence()).resolves.toEqual([]);
    await expect(facesDb.listLifeEvents()).resolves.toEqual([previousEvent]);
    await expect(facesDb.listReminders()).resolves.toEqual([]);
    expect(getLatestIntakeBatch()).toBeNull();
  });

  it("returns null when there is no intake batch to undo", async () => {
    const { undoLatestIntakeBatch } = await import("./intake-undo");
    await expect(undoLatestIntakeBatch()).resolves.toBeNull();
  });

  it("keeps manual edits made after the commit instead of overwriting them", async () => {
    const { facesDb } = await import("./face-db");
    const { rememberIntakeBatch, undoLatestIntakeBatch } = await import("./intake-undo");
    const committedPerson: PersonRecord = {
      id: "existing",
      name: "Existing",
      note: "intake wrote this",
      descriptors: [],
      thumb: "",
      createdAt: 1,
      updatedAt: 10,
    };
    const userEdited: PersonRecord = {
      ...committedPerson,
      note: "user changed the phone",
      updatedAt: 20,
    };
    const createdCommitted: PersonRecord = {
      id: "created",
      name: "Created",
      note: "",
      descriptors: [],
      thumb: "",
      createdAt: 10,
    };
    const committedEvent: LifeEventRecord = {
      id: "event",
      date: "2026-08-26",
      title: "intake event",
      createdAt: 5,
      updatedAt: 10,
    };
    const createdEventCommitted: LifeEventRecord = {
      id: "created-event",
      date: "2026-08-27",
      title: "intake created event",
      createdAt: 10,
    };

    // 提交后的库状态 + 用户随后的手工修改
    await facesDb.putPerson(committedPerson);
    await facesDb.putPerson(createdCommitted);
    await facesDb.putLifeEvent(committedEvent);
    await facesDb.putLifeEvent(createdEventCommitted);
    await facesDb.putPerson(userEdited);
    await facesDb.putLifeEvent({
      ...committedEvent,
      title: "user renamed the event",
      updatedAt: 21,
    });

    rememberIntakeBatch({
      id: "batch",
      committedAt: 10,
      createdPersonIds: [createdCommitted.id],
      createdRelationIds: [],
      createdEvidenceIds: [],
      createdEventIds: [createdEventCommitted.id],
      createdReminderIds: [],
      previousPeople: [{ ...committedPerson, note: "before intake", updatedAt: undefined }],
      previousEvents: [{ ...committedEvent, title: "before intake", updatedAt: undefined }],
      committedPeople: [committedPerson, createdCommitted],
      committedEvents: [committedEvent, createdEventCommitted],
    });

    const undone = await undoLatestIntakeBatch();
    expect(undone?.conflicts).toEqual([
      { kind: "person", id: "existing", reason: "modified" },
      { kind: "event", id: "event", reason: "modified" },
    ]);
    const people = await facesDb.listPersons();
    expect(people.find((person) => person.id === "existing")?.note).toBe("user changed the phone");
    // 未被人工修改的新建记录仍随批次删除
    expect(people.find((person) => person.id === "created")).toBeUndefined();
    const [event] = await facesDb.listLifeEvents();
    expect(event.title).toBe("user renamed the event");
  });

  it("does not resurrect a person the user deleted after the commit", async () => {
    const { facesDb } = await import("./face-db");
    const { rememberIntakeBatch, undoLatestIntakeBatch } = await import("./intake-undo");
    const committed: PersonRecord = {
      id: "existing",
      name: "Existing",
      note: "intake wrote this",
      descriptors: [],
      thumb: "",
      createdAt: 1,
      updatedAt: 10,
    };
    await facesDb.putPerson(committed);
    await facesDb.deletePerson(committed.id);
    rememberIntakeBatch({
      id: "batch",
      committedAt: 10,
      createdPersonIds: [],
      createdRelationIds: [],
      createdEvidenceIds: [],
      createdEventIds: [],
      createdReminderIds: [],
      previousPeople: [{ ...committed, note: "before intake", updatedAt: undefined }],
      committedPeople: [committed],
    });

    const undone = await undoLatestIntakeBatch();
    expect(undone?.conflicts).toEqual([{ kind: "person", id: "existing", reason: "deleted" }]);
    await expect(facesDb.listPersons()).resolves.toEqual([]);
  });
});
