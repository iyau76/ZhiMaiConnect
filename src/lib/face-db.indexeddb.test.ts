import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { LifeEventRecord, PersonRecord, RelationRecord, ReminderRecord } from "./face-db";

const DB_NAME = "openglass-faces";
const EXPECTED_STORES = [
  "caseEvents",
  "evidence",
  "lifeEvents",
  "persons",
  "projects",
  "relations",
  "reminders",
  "sightings",
  "tasks",
  "voiceprints",
];

function useFreshIndexedDb() {
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: new IDBFactory(),
    writable: true,
  });
}

function openRawDatabase(
  version?: number,
  upgrade?: (database: IDBDatabase, transaction: IDBTransaction) => void,
) {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request =
      version === undefined ? indexedDB.open(DB_NAME) : indexedDB.open(DB_NAME, version);
    request.onupgradeneeded = () => {
      if (request.transaction) upgrade?.(request.result, request.transaction);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function person(id: string, createdAt = 1): PersonRecord {
  return {
    id,
    name: `Person ${id}`,
    note: "",
    descriptors: [],
    thumb: "",
    createdAt,
  };
}

function relation(id: string, fromId: string, toId: string): RelationRecord {
  return {
    id,
    fromId,
    toId,
    label: "friend",
    createdAt: 1,
  };
}

beforeEach(() => {
  vi.resetModules();
  useFreshIndexedDb();
});

describe("facesDb schema", () => {
  it("creates a fresh version 9 database with every object store", async () => {
    const { facesDb } = await import("./face-db");

    await expect(facesDb.listPersons()).resolves.toEqual([]);

    const database = await openRawDatabase();
    expect(database.version).toBe(9);
    expect(Array.from(database.objectStoreNames)).toEqual(EXPECTED_STORES);
    database.close();
  });

  it("upgrades a legacy database without dropping existing people", async () => {
    const legacyPerson = person("legacy-person", 42);
    const legacyDatabase = await openRawDatabase(1, (database, transaction) => {
      database.createObjectStore("persons", { keyPath: "id" });
      transaction.objectStore("persons").put(legacyPerson);
    });
    legacyDatabase.close();

    const { facesDb } = await import("./face-db");
    await expect(facesDb.listPersons()).resolves.toEqual([legacyPerson]);

    const upgradedDatabase = await openRawDatabase();
    expect(upgradedDatabase.version).toBe(9);
    expect(Array.from(upgradedDatabase.objectStoreNames)).toEqual(EXPECTED_STORES);
    upgradedDatabase.close();
  });

  it("backfills conservative relationship policies while upgrading from version 8", async () => {
    const legacyDatabase = await openRawDatabase(8, (database, transaction) => {
      const store = database.createObjectStore("relations", { keyPath: "id" });
      store.put({
        id: "derived",
        fromId: "a",
        toId: "b",
        label: "兄弟",
        basis: "推断依据：同为甲之子",
        createdAt: 1,
      });
      store.put({
        id: "explicit",
        fromId: "a",
        toId: "c",
        label: "母子",
        basis: "原文：甲的儿子是丙",
        createdAt: 2,
      });
      transaction.objectStore("relations");
    });
    legacyDatabase.close();

    const { facesDb } = await import("./face-db");
    await expect(facesDb.listRelations()).resolves.toEqual([
      expect.objectContaining({
        id: "explicit",
        evidenceMode: "explicit",
        visibility: "auto",
        recommendationPolicy: "allow",
      }),
      expect.objectContaining({
        id: "derived",
        evidenceMode: "inferred",
        visibility: "auto",
        recommendationPolicy: "allow",
      }),
    ]);
  });
});

describe("facesDb people and relations", () => {
  it("creates, reads, updates, and deletes a person", async () => {
    const { facesDb } = await import("./face-db");
    const original = person("person-1");

    await facesDb.putPerson(original);
    await expect(facesDb.listPersons()).resolves.toEqual([original]);

    const updated = { ...original, name: "Updated person", updatedAt: 2 };
    await facesDb.putPerson(updated);
    await expect(facesDb.listPersons()).resolves.toEqual([updated]);

    await facesDb.deletePerson(original.id);
    await expect(facesDb.listPersons()).resolves.toEqual([]);
  });

  it("creates, reads, updates, and deletes a relation", async () => {
    const { facesDb } = await import("./face-db");
    const original = relation("relation-1", "person-1", "person-2");

    await facesDb.putRelation(original);
    await expect(facesDb.listRelations()).resolves.toEqual([original]);

    const updated = { ...original, label: "classmate", updatedAt: 2 };
    await facesDb.putRelation(updated);
    await expect(facesDb.listRelations()).resolves.toEqual([updated]);

    await facesDb.deleteRelation(original.id);
    await expect(facesDb.listRelations()).resolves.toEqual([]);
  });

  it("marks derived relations for review when their supporting relation changes", async () => {
    const { facesDb } = await import("./face-db");
    const base = relation("base", "person-1", "person-2");
    const derived: RelationRecord = {
      ...relation("derived", "person-1", "person-3"),
      evidenceMode: "inferred",
      confirmationStatus: "confirmed",
      recommendationPolicy: "allow",
      derivedFromRelationIds: [base.id],
    };
    await facesDb.putRelation(base);
    await facesDb.putRelation(derived);

    await facesDb.putRelation({ ...base, label: "updated relationship" });

    await expect(facesDb.listRelations()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: derived.id,
          confirmationStatus: "pending",
          recommendationPolicy: "avoid",
          note: expect.stringContaining("基础关系已变更"),
        }),
      ]),
    );
  });

  it("deleting a person cascades only relations connected to that person", async () => {
    const { facesDb } = await import("./face-db");
    await Promise.all([
      facesDb.putPerson(person("person-1", 3)),
      facesDb.putPerson(person("person-2", 2)),
      facesDb.putPerson(person("person-3", 1)),
    ]);
    await Promise.all([
      facesDb.putRelation(relation("remove-me", "person-1", "person-2")),
      facesDb.putRelation(relation("keep-me", "person-2", "person-3")),
    ]);

    await facesDb.deletePerson("person-1");

    await expect(facesDb.listPersons()).resolves.toEqual([
      person("person-2", 2),
      person("person-3", 1),
    ]);
    await expect(facesDb.listRelations()).resolves.toEqual([
      relation("keep-me", "person-2", "person-3"),
    ]);
  });

  it("invalidates dependents when pruning an orphaned supporting relation", async () => {
    const { facesDb } = await import("./face-db");
    await Promise.all([
      facesDb.putPerson(person("a")),
      facesDb.putPerson(person("b")),
      facesDb.putPerson(person("c")),
    ]);
    await facesDb.putRelation(relation("orphan-base", "missing", "b"));
    await facesDb.putRelation({
      ...relation("derived", "a", "c"),
      evidenceMode: "inferred",
      confirmationStatus: "confirmed",
      recommendationPolicy: "allow",
      derivedFromRelationIds: ["orphan-base"],
    });

    await expect(facesDb.pruneOrphanRelations()).resolves.toBe(1);
    await expect(facesDb.listRelations()).resolves.toEqual([
      expect.objectContaining({
        id: "derived",
        confirmationStatus: "pending",
        recommendationPolicy: "avoid",
      }),
    ]);
  });

  it("detaches a deleted person from every retained record in one operation", async () => {
    const { facesDb } = await import("./face-db");
    await facesDb.putPerson(person("remove"));
    await Promise.all([
      facesDb.addSighting({
        id: "s",
        personId: "remove",
        name: "snapshot",
        distance: 0,
        thumb: "",
        at: 1,
      }),
      facesDb.putVoiceprint({
        id: "v",
        personId: "remove",
        name: "snapshot",
        vector: [],
        durationMs: 1,
        createdAt: 1,
      }),
      facesDb.putEvidence({
        id: "e",
        kind: "note",
        title: "evidence",
        text: "text",
        linkedPersonIds: ["remove"],
        entities: [{ type: "person", value: "snapshot", personId: "remove" }],
        createdAt: 1,
      }),
      facesDb.putLifeEvent({
        id: "life",
        date: "2026-08-28",
        title: "event",
        personIds: ["remove"],
        createdAt: 1,
      }),
      facesDb.putReminder({
        id: "reminder",
        title: "reminder",
        personIds: ["remove"],
        done: false,
        createdAt: 1,
      }),
      facesDb.putTask({
        id: "task",
        title: "task",
        personIds: ["remove"],
        priority: "normal",
        status: "todo",
        createdAt: 1,
      }),
      facesDb.putProject({
        id: "project",
        title: "project",
        ownerId: "remove",
        memberIds: ["remove"],
        priority: "normal",
        status: "active",
        createdAt: 1,
      }),
    ]);

    await facesDb.deletePerson("remove");

    await expect(facesDb.listSightings()).resolves.toEqual([
      expect.objectContaining({ id: "s", personId: null }),
    ]);
    await expect(facesDb.listVoiceprints()).resolves.toEqual([
      expect.objectContaining({ id: "v", personId: null }),
    ]);
    await expect(facesDb.listEvidence()).resolves.toEqual([
      expect.objectContaining({
        id: "e",
        linkedPersonIds: [],
        entities: [expect.not.objectContaining({ personId: "remove" })],
      }),
    ]);
    await expect(facesDb.listLifeEvents()).resolves.toEqual([
      expect.objectContaining({ id: "life", personIds: [] }),
    ]);
    await expect(facesDb.listReminders()).resolves.toEqual([
      expect.objectContaining({ id: "reminder", personIds: [] }),
    ]);
    await expect(facesDb.listTasks()).resolves.toEqual([
      expect.objectContaining({ id: "task", personIds: [] }),
    ]);
    await expect(facesDb.listProjects()).resolves.toEqual([
      expect.objectContaining({ id: "project", ownerId: null, memberIds: [] }),
    ]);
  });
});

describe("facesDb life events and reminders", () => {
  it("supports life-event CRUD", async () => {
    const { facesDb } = await import("./face-db");
    const original: LifeEventRecord = {
      id: "event-1",
      date: "2026-08-26",
      title: "Meet a friend",
      createdAt: 1,
    };

    await facesDb.putLifeEvent(original);
    await expect(facesDb.listLifeEvents()).resolves.toEqual([original]);

    const updated = { ...original, detail: "Bring the photo album" };
    await facesDb.putLifeEvent(updated);
    await expect(facesDb.listLifeEvents()).resolves.toEqual([updated]);

    await facesDb.deleteLifeEvent(original.id);
    await expect(facesDb.listLifeEvents()).resolves.toEqual([]);
  });

  it("supports reminder CRUD", async () => {
    const { facesDb } = await import("./face-db");
    const original: ReminderRecord = {
      id: "reminder-1",
      title: "Send a message",
      done: false,
      createdAt: 1,
    };

    await facesDb.putReminder(original);
    await expect(facesDb.listReminders()).resolves.toEqual([original]);

    const updated = { ...original, done: true };
    await facesDb.putReminder(updated);
    await expect(facesDb.listReminders()).resolves.toEqual([updated]);

    await facesDb.deleteReminder(original.id);
    await expect(facesDb.listReminders()).resolves.toEqual([]);
  });
});

describe("competition demo data", () => {
  it("loads exactly 50 people and 80 relations and remains idempotent", async () => {
    const { facesDb } = await import("./face-db");
    const { getDemoDataStatus, loadDemoData } = await import("./demo-data");

    await expect(loadDemoData()).resolves.toMatchObject({ people: 50, relations: 80, events: 25 });
    await expect(getDemoDataStatus()).resolves.toEqual({ people: 50, relations: 80 });
    await expect(facesDb.listLifeEvents()).resolves.toHaveLength(25);
    await expect(facesDb.listReminders()).resolves.toHaveLength(3);

    await loadDemoData();
    await expect(getDemoDataStatus()).resolves.toEqual({ people: 50, relations: 80 });
    await expect(facesDb.listLifeEvents()).resolves.toHaveLength(25);
    await expect(facesDb.listReminders()).resolves.toHaveLength(3);
  });

  it("clears only demo records and preserves user-owned records", async () => {
    const { facesDb } = await import("./face-db");
    const { clearDemoData, getDemoDataStatus, loadDemoData } = await import("./demo-data");
    const firstUser = person("user-person-1", 2);
    const secondUser = person("user-person-2", 1);
    const userRelation = relation("user-relation", firstUser.id, secondUser.id);
    const userEvent: LifeEventRecord = {
      id: "user-event",
      date: "2026-08-26",
      title: "User event",
      createdAt: 1,
    };
    const userReminder: ReminderRecord = {
      id: "user-reminder",
      title: "User reminder",
      done: false,
      createdAt: 1,
    };
    await Promise.all([
      facesDb.putPerson(firstUser),
      facesDb.putPerson(secondUser),
      facesDb.putRelation(userRelation),
      facesDb.putLifeEvent(userEvent),
      facesDb.putReminder(userReminder),
    ]);
    await loadDemoData();

    await clearDemoData();

    await expect(getDemoDataStatus()).resolves.toEqual({ people: 0, relations: 0 });
    await expect(facesDb.listPersons()).resolves.toEqual([firstUser, secondUser]);
    await expect(facesDb.listRelations()).resolves.toEqual([userRelation]);
    await expect(facesDb.listLifeEvents()).resolves.toEqual([userEvent]);
    await expect(facesDb.listReminders()).resolves.toEqual([userReminder]);
  });
});
