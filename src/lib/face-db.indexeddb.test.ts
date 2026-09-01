import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  LifeEventRecord,
  PersonRecord,
  RelationAssertionRecord,
  RelationRecord,
  ReminderRecord,
} from "./face-db";

const DB_NAME = "openglass-faces";
const EXPECTED_STORES = [
  "appMeta",
  "caseEvents",
  "collectionMemberships",
  "collections",
  "derivedRelations",
  "evidence",
  "lifeEvents",
  "persons",
  "projects",
  "referralPolicies",
  "relationAssertions",
  "relationEvidenceLinks",
  "relationViewPreferences",
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
  it("creates a fresh version 12 database with every object store", async () => {
    const { facesDb } = await import("./face-db");

    await expect(facesDb.listPersons()).resolves.toEqual([]);

    const database = await openRawDatabase();
    expect(database.version).toBe(12);
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
    expect(upgradedDatabase.version).toBe(12);
    expect(Array.from(upgradedDatabase.objectStoreNames)).toEqual(EXPECTED_STORES);
    upgradedDatabase.close();
  });

  it("repairs legacy closeness values during the v12 migration", async () => {
    const legacyDatabase = await openRawDatabase(1, (database, transaction) => {
      const store = database.createObjectStore("persons", { keyPath: "id" });
      store.put({ ...person("decimal"), profile: { closeness: 3.6 } });
      store.put({ ...person("too-high"), profile: { closeness: 999 } });
      store.put({ ...person("not-finite"), profile: { closeness: Number.NaN } });
      transaction.objectStore("persons");
    });
    legacyDatabase.close();

    const { facesDb } = await import("./face-db");
    const migrated = await facesDb.listPersons();
    expect(migrated.find((item) => item.id === "decimal")?.profile?.closeness).toBe(4);
    expect(migrated.find((item) => item.id === "too-high")?.profile?.closeness).toBe(5);
    expect(migrated.find((item) => item.id === "not-finite")?.profile).not.toHaveProperty(
      "closeness",
    );

    const database = await openRawDatabase();
    expect(database.version).toBe(12);
    database.close();
  });

  it("migrates explicit assertions and drops unverifiable legacy derived ghosts", async () => {
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
    ]);
    await expect(facesDb.listDerivedRelations()).resolves.toEqual([]);
  });
});

describe("facesDb people and relations", () => {
  it("enforces canonical closeness at every person persistence boundary", async () => {
    const { facesDb } = await import("./face-db");
    await facesDb.putPerson({ ...person("direct"), profile: { closeness: 0 } });
    await facesDb.putRelationshipBatch({
      persons: [{ ...person("relationship-batch"), profile: { closeness: 2.6 } }],
    });
    await facesDb.applyArchiveMutationBatch({
      persons: [{ ...person("archive-batch"), profile: { closeness: Number.NaN } }],
    });
    await expect(facesDb.listPersons()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "direct", profile: { closeness: 1 } }),
        expect.objectContaining({ id: "relationship-batch", profile: { closeness: 3 } }),
        expect.objectContaining({ id: "archive-batch", profile: {} }),
      ]),
    );
    await facesDb.replaceArchiveSnapshot({
      persons: [
        { ...person("restore-low"), profile: { closeness: -100 } },
        { ...person("restore-high"), profile: { closeness: 999 } },
      ],
      relationAssertions: [],
      relationEvidenceLinks: [],
      relationViewPreferences: [],
      referralPolicies: [],
      collections: [],
      collectionMemberships: [],
      evidence: [],
      caseEvents: [],
      tasks: [],
      projects: [],
      lifeEvents: [],
      reminders: [],
    });

    const stored = await facesDb.listPersons();
    expect(stored).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "restore-low", profile: { closeness: 1 } }),
        expect.objectContaining({ id: "restore-high", profile: { closeness: 5 } }),
      ]),
    );
    expect(
      stored.every((item) => {
        const value = item.profile?.closeness;
        return value === undefined || (Number.isInteger(value) && value >= 1 && value <= 5);
      }),
    ).toBe(true);
  });

  it("uses an atomic compare-and-swap write for person edits", async () => {
    const { facesDb, personRecordRevision } = await import("./face-db");
    const original = { ...person("cas"), note: "opened" };
    await facesDb.putPerson(original);

    await expect(
      facesDb.compareAndSwapPerson(
        { ...original, note: "first save", updatedAt: 2 },
        personRecordRevision(original),
      ),
    ).resolves.toMatchObject({ status: "saved", person: { note: "first save" } });

    const firstSave = (await facesDb.listPersons())[0];
    await facesDb.putPerson({ ...firstSave, note: "concurrent save", updatedAt: 3 });
    await expect(
      facesDb.compareAndSwapPerson(
        { ...firstSave, note: "stale overwrite", updatedAt: 4 },
        personRecordRevision(firstSave),
      ),
    ).resolves.toMatchObject({ status: "conflict", current: { note: "concurrent save" } });
    await expect(facesDb.listPersons()).resolves.toEqual([
      expect.objectContaining({ note: "concurrent save" }),
    ]);

    const current = (await facesDb.listPersons())[0];
    await facesDb.deletePerson(current.id);
    await expect(
      facesDb.compareAndSwapPerson(
        { ...current, note: "must not resurrect" },
        personRecordRevision(current),
      ),
    ).resolves.toEqual({ status: "missing" });
    await expect(facesDb.listPersons()).resolves.toEqual([]);
  });

  it("deletes a selected sighting set in one batch without touching unselected rows", async () => {
    const { facesDb } = await import("./face-db");
    for (const id of ["first", "second", "keep"]) {
      await facesDb.addSighting({
        id,
        personId: null,
        name: id,
        distance: 1,
        thumb: "",
        at: id === "first" ? 3 : id === "second" ? 2 : 1,
      });
    }

    await facesDb.deleteSightings(["first", "second", "first"]);

    await expect(facesDb.listSightings()).resolves.toEqual([
      expect.objectContaining({ id: "keep" }),
    ]);
  });

  it("reads and replaces the complete durable archive without leaving mixed-state rows", async () => {
    const { facesDb } = await import("./face-db");
    const oldPerson = person("old");
    await facesDb.putPerson(oldPerson);
    await facesDb.putEvidence({
      id: "old-evidence",
      kind: "note",
      title: "旧证据",
      text: "旧内容",
      linkedPersonIds: [oldPerson.id],
      createdAt: 1,
    });
    await facesDb.putCaseEvent({
      id: "old-case",
      at: 1,
      title: "旧事件",
      personIds: [oldPerson.id],
      evidenceIds: ["old-evidence"],
      createdAt: 1,
    });
    await facesDb.addSighting({
      id: "runtime-sighting",
      personId: oldPerson.id,
      name: oldPerson.name,
      distance: 0,
      thumb: "",
      at: 1,
    });

    await expect(facesDb.readArchiveSnapshot()).resolves.toMatchObject({
      persons: [{ id: "old" }],
      evidence: [{ id: "old-evidence" }],
      caseEvents: [{ id: "old-case" }],
    });

    const newPerson = person("new", 2);
    await facesDb.replaceArchiveSnapshot({
      persons: [newPerson],
      relationAssertions: [],
      relationEvidenceLinks: [],
      relationViewPreferences: [],
      referralPolicies: [],
      collections: [],
      collectionMemberships: [],
      evidence: [],
      caseEvents: [],
      tasks: [],
      projects: [],
      lifeEvents: [],
      reminders: [],
    });

    await expect(facesDb.readArchiveSnapshot()).resolves.toMatchObject({
      persons: [{ id: "new" }],
      relationAssertions: [],
      evidence: [],
      caseEvents: [],
    });
    await expect(facesDb.listSightings()).resolves.toEqual([
      expect.objectContaining({ id: "runtime-sighting", personId: null }),
    ]);
  });

  it("rejects an invalid archive replacement before changing current data", async () => {
    const { facesDb } = await import("./face-db");
    const current = person("current");
    await facesDb.putPerson(current);

    await expect(
      facesDb.replaceArchiveSnapshot({
        persons: [person("replacement")],
        relationAssertions: [],
        relationEvidenceLinks: [],
        relationViewPreferences: [],
        referralPolicies: [],
        collections: [],
        collectionMemberships: [
          {
            id: "dangling",
            collectionId: "missing",
            personId: "replacement",
            source: "manual",
            createdAt: 1,
          },
        ],
        evidence: [],
        caseEvents: [],
        tasks: [],
        projects: [],
        lifeEvents: [],
        reminders: [],
      }),
    ).rejects.toThrow(/不存在的集合/);
    await expect(facesDb.listPersons()).resolves.toEqual([current]);
  });

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
    await expect(facesDb.listRelations()).resolves.toEqual([
      expect.objectContaining({
        ...original,
        recordType: "assertion",
        predicate: "friend_of",
        evidenceMode: "explicit",
      }),
    ]);

    const updated = { ...original, label: "classmate", updatedAt: 2 };
    await facesDb.putRelation(updated);
    await expect(facesDb.listRelations()).resolves.toEqual([
      expect.objectContaining({ ...updated, predicate: "classmate_of" }),
    ]);

    await facesDb.deleteRelation(original.id);
    await expect(facesDb.listRelations()).resolves.toEqual([]);
  });

  it("rejects attempts to persist a derived projection as a fact", async () => {
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
    await expect(facesDb.putRelation(derived)).rejects.toThrow("不能作为事实写入");
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
      expect.objectContaining(relation("keep-me", "person-2", "person-3")),
    ]);
  });

  it("prunes orphan assertions and rebuilds the projection", async () => {
    const { facesDb } = await import("./face-db");
    await Promise.all([
      facesDb.putPerson(person("a")),
      facesDb.putPerson(person("b")),
      facesDb.putPerson(person("c")),
    ]);
    await facesDb.putRelation(relation("orphan-base", "missing", "b"));

    await expect(facesDb.pruneOrphanRelations()).resolves.toBe(1);
    await expect(facesDb.listRelationAssertions()).resolves.toEqual([]);
    await expect(facesDb.listDerivedRelations()).resolves.toEqual([]);
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

describe("v10 relationship assertion and projection stores", () => {
  const assertion = (
    id: string,
    fromId: string,
    toId: string,
    label: string,
    predicate: RelationAssertionRecord["predicate"] = "parent_of",
  ): RelationAssertionRecord => ({
    id,
    recordType: "assertion",
    fromId,
    toId,
    predicate,
    qualifiers: predicate === "parent_of" ? { lineage: "blood" } : {},
    label,
    direction: "ontology",
    evidence: { mode: "source_claim", basis: `原文：${label}`, sourceIds: [] },
    validity: { status: "active" },
    confidence: 0.96,
    confirmationStatus: "confirmed",
    createdAt: 1,
    updatedAt: 1,
  });

  it("keeps assertions and deterministic derived projections in separate stores", async () => {
    const { facesDb } = await import("./face-db");
    await facesDb.putRelationshipBatch({
      persons: [person("grandmother"), person("mother"), person("child")],
      assertions: [
        assertion("a1", "grandmother", "mother", "母女"),
        assertion("a2", "mother", "child", "母子"),
      ],
    });

    await expect(facesDb.listRelationAssertions()).resolves.toHaveLength(2);
    await expect(facesDb.listDerivedRelations()).resolves.toEqual([
      expect.objectContaining({
        recordType: "derived",
        fromId: "grandmother",
        toId: "child",
        predicate: "grandparent_of",
        supportingRelationIds: ["a1", "a2"],
      }),
    ]);
    await expect(facesDb.listRelationshipViews()).resolves.toHaveLength(3);
  });

  it("rebuilds instead of invalidating stale sibling projections", async () => {
    const { facesDb } = await import("./face-db");
    await facesDb.putRelationshipBatch({
      assertions: [
        assertion("father-a", "father", "a", "父子"),
        assertion("father-b", "father", "b", "父女"),
      ],
    });
    expect((await facesDb.listDerivedRelations()).map((row) => row.predicate)).toContain(
      "sibling_of",
    );

    await facesDb.putRelationshipBatch({
      assertions: [
        assertion("mother-a", "mother-a", "a", "母子"),
        assertion("mother-b", "mother-b", "b", "母女"),
      ],
    });
    const rebuilt = await facesDb.listDerivedRelations();
    expect(rebuilt.some((row) => row.predicate === "sibling_of")).toBe(false);
    expect(rebuilt).toEqual(
      expect.arrayContaining([expect.objectContaining({ predicate: "half_sibling_of" })]),
    );
  });

  it("allows independent evidence assertions for the same projected fact", async () => {
    const { facesDb } = await import("./face-db");
    await facesDb.putRelationshipBatch({
      assertions: [
        assertion("source-one", "a", "b", "同事", "colleague_of"),
        {
          ...assertion("source-two", "a", "b", "同事", "colleague_of"),
          createdAt: 2,
          updatedAt: 2,
        },
      ],
    });
    await expect(facesDb.listRelationAssertions()).resolves.toHaveLength(2);
  });

  it("changes display policy without rewriting assertion source or timestamps", async () => {
    const { facesDb } = await import("./face-db");
    const original = assertion("fact", "a", "b", "同事", "colleague_of");
    await facesDb.putRelationshipBatch({ assertions: [original] });
    await facesDb.putRelationViewPreference({
      id: "fact",
      subjectId: "fact",
      visibility: "hidden",
      updatedAt: 99,
    });
    await expect(facesDb.listRelationAssertions()).resolves.toEqual([original]);
    await expect(facesDb.listRelationshipViews({ includeDerived: false })).resolves.toEqual([
      expect.objectContaining({ id: "fact", visibility: "hidden", updatedAt: 1 }),
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
    const demoPeople = (await facesDb.listPersons()).filter((item) =>
      item.id.startsWith("demo-zhimai-"),
    );
    const demoCollections = (await facesDb.listCollections()).filter((item) =>
      item.id.startsWith("demo-zhimai-"),
    );
    const demoMemberships = (await facesDb.listCollectionMemberships()).filter((item) =>
      item.id.startsWith("demo-zhimai-"),
    );
    const demoRelations = (await facesDb.listRelationAssertions()).filter((item) =>
      item.id.startsWith("demo-zhimai-"),
    );
    const demoEvents = (await facesDb.listLifeEvents()).filter((item) =>
      item.id.startsWith("demo-zhimai-"),
    );
    expect(demoPeople).toHaveLength(50);
    expect(demoPeople.every((item) => item.profile?.circle === undefined)).toBe(true);
    expect(demoCollections).toHaveLength(6);
    expect(demoCollections.map((item) => [item.name, item.kind])).toEqual(
      expect.arrayContaining([
        ["大学同学", "relationship_circle"],
        ["家人", "relationship_circle"],
        ["知行实验室", "relationship_circle"],
        ["亲戚", "relationship_circle"],
        ["校园摄影社", "relationship_circle"],
        ["校友社群", "relationship_circle"],
      ]),
    );
    expect(demoMemberships).toHaveLength(50);
    expect(new Set(demoMemberships.map((item) => item.personId))).toEqual(
      new Set(demoPeople.map((item) => item.id)),
    );
    const relationshipCircleIds = new Set(
      demoCollections.filter((item) => item.kind === "relationship_circle").map((item) => item.id),
    );
    expect(
      new Set(
        demoMemberships
          .filter((item) => relationshipCircleIds.has(item.collectionId))
          .map((item) => item.personId),
      ),
    ).toEqual(new Set(demoPeople.map((item) => item.id)));
    expect(demoRelations).toHaveLength(80);
    expect(demoRelations.map((item) => item.label)).not.toContain("同圈伙伴");
    expect([...new Set(demoRelations.map((item) => item.predicate))]).toEqual(
      expect.arrayContaining([
        "parent_of",
        "spouse_of",
        "sibling_of",
        "cousin_of",
        "roommate_of",
        "classmate_of",
        "reports_to",
        "manages",
        "collaborates_with",
      ]),
    );
    expect(demoRelations.filter((item) => item.confirmationStatus === "pending")).toEqual([
      expect.objectContaining({ label: "可能认识", confidence: 0.62 }),
    ]);
    expect(demoRelations).toContainEqual(
      expect.objectContaining({
        label: "前室友",
        validity: expect.objectContaining({ status: "ended" }),
      }),
    );
    expect(demoEvents).toHaveLength(25);
    expect(new Set(demoEvents.map((item) => item.precision ?? "day"))).toEqual(
      new Set(["day", "month", "year", "range"]),
    );

    await loadDemoData();
    await expect(getDemoDataStatus()).resolves.toEqual({ people: 50, relations: 80 });
    await expect(facesDb.listLifeEvents()).resolves.toHaveLength(25);
    await expect(facesDb.listReminders()).resolves.toHaveLength(3);
    await expect(facesDb.listCollections()).resolves.toHaveLength(6);
    await expect(facesDb.listCollectionMemberships()).resolves.toHaveLength(50);
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
    const userCollection = {
      id: "user-collection",
      name: "用户集合",
      kind: "context" as const,
      createdAt: 1,
      updatedAt: 1,
    };
    const userMembership = {
      id: "user-membership",
      collectionId: userCollection.id,
      personId: firstUser.id,
      source: "manual" as const,
      createdAt: 1,
    };
    await Promise.all([
      facesDb.putPerson(firstUser),
      facesDb.putPerson(secondUser),
      facesDb.putRelation(userRelation),
      facesDb.putLifeEvent(userEvent),
      facesDb.putReminder(userReminder),
      facesDb.putCollection(userCollection),
      facesDb.putCollectionMembership(userMembership),
    ]);
    await loadDemoData();

    await clearDemoData();

    await expect(getDemoDataStatus()).resolves.toEqual({ people: 0, relations: 0 });
    await expect(facesDb.listPersons()).resolves.toEqual([firstUser, secondUser]);
    await expect(facesDb.listRelations()).resolves.toEqual([expect.objectContaining(userRelation)]);
    await expect(facesDb.listLifeEvents()).resolves.toEqual([userEvent]);
    await expect(facesDb.listReminders()).resolves.toEqual([userReminder]);
    await expect(facesDb.listCollections()).resolves.toEqual([userCollection]);
    await expect(facesDb.listCollectionMemberships()).resolves.toEqual([userMembership]);
  });
});
