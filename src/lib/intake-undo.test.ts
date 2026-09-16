import { IDBFactory, IDBKeyRange, IDBObjectStore } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LifeEventRecord, PersonRecord, RelationAssertionRecord } from "./face-db";
import type { IntakeUndoBatch } from "./intake-undo";

const person = (id = "p", note = "before"): PersonRecord => ({
  id,
  name: `合成人物${id}`,
  note,
  descriptors: [],
  thumb: "",
  createdAt: 1,
});
const event = (id = "e", title = "before"): LifeEventRecord => ({
  id,
  title,
  date: "2026-06-01",
  createdAt: 1,
});
const batch = (id = "batch"): IntakeUndoBatch => ({
  id,
  committedAt: 1,
  createdPersonIds: [],
  createdRelationIds: [],
  createdEvidenceIds: [],
  createdEventIds: [],
  createdReminderIds: [],
  previousPeople: [],
});
const assertion = (): RelationAssertionRecord => ({
  id: "r",
  recordType: "assertion",
  fromId: "p",
  toId: "q",
  predicate: "parent_of",
  qualifiers: {},
  label: "父女",
  direction: "ontology",
  evidence: { mode: "manual", sourceIds: [] },
  validity: { status: "active" },
  confirmationStatus: "confirmed",
  createdAt: 1,
  updatedAt: 1,
});
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

describe("transactional intake undo", () => {
  it("returns null without a batch", async () => {
    const { undoLatestIntakeBatch } = await import("./intake-undo");
    expect(await undoLatestIntakeBatch()).toBeNull();
  });
  it("captures actual before/after rows and restores a complete multi-store batch", async () => {
    const { facesDb } = await import("./face-db");
    const { rememberIntakeBatch, getLatestIntakeBatch, undoLatestIntakeBatch } =
      await import("./intake-undo");
    await facesDb.putPerson(person());
    await facesDb.putLifeEvent(event());
    await facesDb.applyArchiveMutationBatch(
      {
        persons: [person("p", "intake"), person("q")],
        assertions: [assertion()],
        lifeEvents: [event("e", "intake"), { ...event("created"), personIds: ["q"] }],
        reminders: [{ id: "rem", title: "合成提醒", done: false, personIds: ["q"], createdAt: 1 }],
        evidence: [
          { id: "source", kind: "note", title: "合成材料", text: "合成内容", createdAt: 1 },
        ],
        evidenceLinks: [{ id: "link", assertionId: "r", evidenceId: "source", createdAt: 1 }],
      },
      "batch",
    );
    rememberIntakeBatch(batch());
    expect(getLatestIntakeBatch()?.id).toBe("batch");
    expect((await undoLatestIntakeBatch())?.conflicts).toEqual([]);
    expect(await facesDb.listPersons()).toEqual([person()]);
    expect(await facesDb.listLifeEvents()).toEqual([event()]);
    expect(await facesDb.listRelations()).toEqual([]);
    expect(await facesDb.listReminders()).toEqual([]);
    expect(await facesDb.listEvidence()).toEqual([]);
    expect(await facesDb.listRelationEvidenceLinks()).toEqual([]);
    expect(getLatestIntakeBatch()).toBeNull();
  });
  it("keeps changed content even when the timestamp is unchanged", async () => {
    const { facesDb } = await import("./face-db");
    await facesDb.putPerson(person());
    await facesDb.putLifeEvent(event());
    await facesDb.applyArchiveMutationBatch(
      { persons: [person("p", "intake")], lifeEvents: [event("e", "intake")] },
      "batch",
    );
    await facesDb.putPerson(person("p", "manual phone"));
    await facesDb.putLifeEvent(event("e", "manual title"));
    expect(await facesDb.undoArchiveMutation("batch")).toEqual([
      { kind: "person", id: "p", reason: "modified" },
      { kind: "event", id: "e", reason: "modified" },
    ]);
    expect((await facesDb.listPersons())[0].note).toBe("manual phone");
    expect((await facesDb.listLifeEvents())[0].title).toBe("manual title");
  });
  it("does not recapture a manual edit or deletion immediately after commit", async () => {
    const { facesDb } = await import("./face-db");
    await facesDb.putPerson(person());
    await facesDb.putLifeEvent(event());
    await facesDb.applyArchiveMutationBatch(
      { persons: [person("p", "intake")], lifeEvents: [event("e", "intake")] },
      "batch",
    );
    await facesDb.deletePerson("p");
    await facesDb.putLifeEvent(event("e", "manual"));
    expect(await facesDb.undoArchiveMutation("batch")).toEqual([
      { kind: "person", id: "p", reason: "deleted" },
      { kind: "event", id: "e", reason: "modified" },
    ]);
    expect(await facesDb.listPersons()).toEqual([]);
    expect((await facesDb.listLifeEvents())[0].title).toBe("manual");
  });
  it("preserves the person needed by a protected event, without detaching personIds", async () => {
    const { facesDb } = await import("./face-db");
    const original = { ...event(), personIds: ["p"] };
    await facesDb.applyArchiveMutationBatch(
      { persons: [person()], lifeEvents: [original] },
      "batch",
    );
    await facesDb.putLifeEvent({ ...original, title: "manual" });
    expect(await facesDb.undoArchiveMutation("batch")).toEqual([
      { kind: "event", id: "e", reason: "modified" },
      { kind: "person", id: "p", reason: "referenced" },
    ]);
    expect(await facesDb.listPersons()).toEqual([person()]);
    expect(await facesDb.listLifeEvents()).toEqual([{ ...original, title: "manual" }]);
  });
  it("keeps dependencies referenced by records created after approval", async () => {
    const { facesDb } = await import("./face-db");
    await facesDb.applyArchiveMutationBatch({ persons: [person()] }, "batch");
    await facesDb.putLifeEvent({ ...event(), personIds: ["p"] });
    expect(await facesDb.undoArchiveMutation("batch")).toEqual([
      { kind: "person", id: "p", reason: "referenced" },
    ]);
    expect((await facesDb.listLifeEvents())[0].personIds).toEqual(["p"]);
  });
  it("protects completed reminders and their newly created result events", async () => {
    const { facesDb } = await import("./face-db");
    const reminder = { id: "rem", title: "合成提醒", done: false, personIds: ["p"], createdAt: 1 };
    await facesDb.applyArchiveMutationBatch(
      { persons: [person()], reminders: [reminder] },
      "batch",
    );
    await facesDb.putLifeEvent({ ...event(), personIds: ["p"] });
    await facesDb.putReminder({ ...reminder, done: true, completionEventId: "e" });
    expect(await facesDb.undoArchiveMutation("batch")).toEqual([
      { kind: "reminders", id: "rem", reason: "modified" },
      { kind: "person", id: "p", reason: "referenced" },
    ]);
    expect((await facesDb.listReminders())[0].done).toBe(true);
  });
  it("protects edited assertions and the people/evidence they need", async () => {
    const { facesDb } = await import("./face-db");
    await facesDb.applyArchiveMutationBatch(
      { persons: [person(), person("q")], assertions: [assertion()] },
      "batch",
    );
    await facesDb.putRelationAssertion({ ...assertion(), note: "manual correction" });
    const conflicts = await facesDb.undoArchiveMutation("batch");
    expect(conflicts).toHaveLength(3);
    expect((await facesDb.listRelationAssertions())[0].note).toBe("manual correction");
    expect(await facesDb.listPersons()).toHaveLength(2);
  });
  it("keeps a collection adopted by a later membership", async () => {
    const { facesDb } = await import("./face-db");
    const collection = {
      id: "c",
      name: "合成圈层",
      kind: "relationship_circle" as const,
      createdAt: 1,
      updatedAt: 1,
    };
    await facesDb.applyArchiveMutationBatch({ collections: [collection] }, "batch");
    await facesDb.putPerson(person());
    await facesDb.putCollectionMembership({
      id: "m",
      collectionId: "c",
      personId: "p",
      source: "manual",
      createdAt: 2,
    });
    expect(await facesDb.undoArchiveMutation("batch")).toEqual([
      { kind: "collections", id: "c", reason: "referenced" },
    ]);
    expect(await facesDb.listCollections()).toEqual([collection]);
  });
  it("does not restore a deleted membership when its person was independently deleted", async () => {
    const { facesDb } = await import("./face-db");
    await facesDb.putPerson(person());
    await facesDb.putCollection({
      id: "c",
      name: "合成圈层",
      kind: "relationship_circle",
      createdAt: 1,
      updatedAt: 1,
    });
    await facesDb.putCollectionMembership({
      id: "m",
      collectionId: "c",
      personId: "p",
      source: "manual",
      createdAt: 1,
    });
    await facesDb.applyArchiveMutationBatch({ deleteCollectionMembershipIds: ["m"] }, "batch");
    await facesDb.deletePerson("p");
    expect(await facesDb.undoArchiveMutation("batch")).toEqual([
      { kind: "collectionMemberships", id: "m", reason: "missing_dependency" },
    ]);
    expect(await facesDb.listCollectionMemberships()).toEqual([]);
  });
  it("persists protection through a real commit intent and module/session reload", async () => {
    const { facesDb } = await import("./face-db");
    const { createIntakeCommitIntent, executeIntakeCommitIntent } =
      await import("./intake-commit-intent");
    await facesDb.putPerson(person());
    const intent = createIntakeCommitIntent({
      decisionId: "decision",
      proposalRef: "proposal",
      expectedArchiveRevision: await facesDb.getArchiveMutationRevision(),
      batch: { persons: [person("p", "intake")] },
      receipt: batch(),
      summary: {
        createdPeople: 0,
        updatedPeople: 1,
        facts: 0,
        relations: 0,
        createdEvents: 0,
        updatedEvents: 0,
        reminders: 0,
        evidence: 0,
      },
    });
    const persisted = JSON.stringify(intent.receipt); // Saved before commit, like the UI checkpoint.
    expect(await executeIntakeCommitIntent(intent)).toBe("applied");
    await facesDb.putPerson(person("p", "manual"));
    vi.resetModules();
    const { rememberIntakeBatch, undoLatestIntakeBatch } = await import("./intake-undo");
    rememberIntakeBatch(JSON.parse(persisted));
    expect((await undoLatestIntakeBatch())?.conflicts).toEqual([
      { kind: "person", id: "p", reason: "modified" },
    ]);
    expect((await facesDb.listPersons())[0].note).toBe("manual");
  });
  it("never falls back to an unconditional legacy rollback", async () => {
    const { facesDb } = await import("./face-db");
    const { rememberIntakeBatch, undoLatestIntakeBatch } = await import("./intake-undo");
    await facesDb.putPerson(person("p", "manual"));
    rememberIntakeBatch({
      ...batch(),
      previousPeople: [person()],
      committedPeople: [person("p", "intake")],
    });
    expect((await undoLatestIntakeBatch())?.conflicts[0].reason).toBe("missing_receipt");
    expect((await facesDb.listPersons())[0].note).toBe("manual");
  });
  it("replayed undo/commit are no-ops instead of reviving reverted records", async () => {
    const { facesDb } = await import("./face-db");
    await facesDb.applyArchiveMutationBatch({ persons: [person()] }, "batch");
    expect(await facesDb.undoArchiveMutation("batch")).toEqual([]);
    await facesDb.applyArchiveMutationBatch({ persons: [person()] }, "batch");
    expect(await facesDb.undoArchiveMutation("batch")).toEqual([]);
    expect(await facesDb.listPersons()).toEqual([]);
  });
  it("an aborted commit leaves neither partial facts nor undo permission", async () => {
    const { facesDb } = await import("./face-db");
    await expect(
      facesDb.applyArchiveMutationBatch(
        { persons: [person()], assertions: [{ ...assertion(), toId: "p" }] },
        "batch",
      ),
    ).rejects.toThrow();
    expect(await facesDb.listPersons()).toEqual([]);
    expect(await facesDb.undoArchiveMutation("batch")).toEqual([
      { kind: "batch", id: "batch", reason: "missing_receipt" },
    ]);
  });
});

it("an aborted undo leaves every row and its receipt unchanged, then can retry", async () => {
  const { facesDb } = await import("./face-db");
  await facesDb.putPerson(person());
  await facesDb.putLifeEvent(event());
  await facesDb.applyArchiveMutationBatch(
    { persons: [person("p", "intake")], lifeEvents: [event("e", "intake")] },
    "atomic-undo",
  );
  const put = IDBObjectStore.prototype.put;
  const spy = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (
    this: IDBObjectStore,
    value,
    key,
  ) {
    const request = put.call(this, value, key);
    if (this.name === "lifeEvents")
      request.addEventListener("success", () => this.transaction.abort());
    return request;
  });
  await expect(facesDb.undoArchiveMutation("atomic-undo")).rejects.toThrow();
  spy.mockRestore();
  expect((await facesDb.listPersons())[0].note).toBe("intake");
  expect((await facesDb.listLifeEvents())[0].title).toBe("intake");
  expect(await facesDb.undoArchiveMutation("atomic-undo")).toEqual([]);
  expect(await facesDb.listPersons()).toEqual([person()]);
  expect(await facesDb.listLifeEvents()).toEqual([event()]);
});

it("a full archive replacement invalidates old undo authority", async () => {
  const { facesDb } = await import("./face-db");
  await facesDb.applyArchiveMutationBatch({ persons: [person()] }, "before-restore");
  await facesDb.replaceArchiveSnapshot(await facesDb.readArchiveSnapshot());
  expect(await facesDb.undoArchiveMutation("before-restore")).toEqual([
    { kind: "batch", id: "before-restore", reason: "missing_receipt" },
  ]);
  expect(await facesDb.listPersons()).toEqual([person()]);
});
