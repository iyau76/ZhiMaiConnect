import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it, vi } from "vitest";
import { compileSemanticIntakePlan } from "./intake-semantic-compiler";
import { decodeSemanticPersonChanges } from "./intake-draft";
import { compileIntakeCollections } from "./intake-collections";
import { formatEventTime } from "./fuzzy-date";
import { createArchiveV2, archiveRestorePlan } from "./archive-data";

const snapshot = {
  persons: [],
  relations: [],
  events: [],
  collections: [],
  collectionMemberships: [],
};
const tasks = [
  {
    id: "person-a",
    domain: "person",
    intent: "create",
    target: { kind: "person", name: "许星" },
    changes: { title: "店长", birthday: "09-12", interests: ["咖啡"] },
  },
  {
    id: "circle-a",
    domain: "collection",
    intent: "organize",
    target: { kind: "collection", name: "读书会", collectionKind: "relationship_circle" },
    memberships: [{ people: { kind: "person", name: "许星" }, action: "add" }],
  },
  {
    id: "event-a",
    domain: "event",
    intent: "create",
    target: { kind: "event", title: "书店讨论" },
    changes: {
      date: "2026-09-08",
      timeText: "下午3点",
      people: [{ kind: "person", name: "许星" }],
    },
  },
];

describe("intake user experience regressions", () => {
  it("retains unmodelled event and reminder attributes as editable detail instead of losing the item", () => {
    const compiled = compileSemanticIntakePlan({
      candidate: {
        version: 1,
        type: "semantic_plan",
        tasks: [
          {
            ...tasks[2],
            changes: {
              date: "2026-09-08",
              timeText: "下午3点",
              detail: "讨论策展",
              location: "青禾书店",
            },
          },
          {
            id: "reminder",
            domain: "reminder",
            intent: "create",
            target: { kind: "reminder", title: "准备海报" },
            changes: { due: "2026-09-07", supplies: ["胶带", "展架"] },
          },
        ],
      },
      snapshot,
    });
    expect(compiled.issues).toEqual([]);
    expect(compiled.draft.events?.[0]).toMatchObject({
      title: "书店讨论",
      timeText: "下午3点",
      detail: "讨论策展\n待整理字段：location：青禾书店",
    });
    expect(compiled.draft.reminders?.[0].detail).toContain("展架");
  });
  it("adds a member to a pending circle without replacing its previous people or ID", () => {
    const first = compileSemanticIntakePlan({
      candidate: { version: 1, type: "semantic_plan", tasks },
      snapshot,
    });
    const second = compileSemanticIntakePlan({
      candidate: {
        version: 1,
        type: "semantic_plan",
        tasks: [
          {
            id: "person-b",
            domain: "person",
            intent: "create",
            target: { kind: "person", name: "顾桥" },
            changes: {},
          },
          {
            ...tasks[1],
            id: "circle-b",
            memberships: [{ people: { kind: "person", name: "顾桥" }, action: "add" }],
          },
        ],
      },
      snapshot: { ...snapshot, workspace: first.draft },
    });
    expect(second.issues).toEqual([]);
    expect(second.draft.collections).toHaveLength(1);
    expect(second.draft.collections?.[0].targetCollectionId).toBe(
      first.draft.collections?.[0].targetCollectionId,
    );
    expect(second.draft.collections?.[0].memberships.map((member) => member.person).sort()).toEqual(
      ["许星", "顾桥"],
    );
  });
  it("keeps known people and new drafts in one existing circle, and restores previous memberships on undo", async () => {
    vi.resetModules();
    Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: new IDBFactory() });
    const { facesDb } = await import("./face-db");
    const collection = {
      id: "existing-circle",
      name: "读书会",
      kind: "relationship_circle" as const,
      color: "#123456",
      createdAt: 1,
      updatedAt: 1,
    };
    const oldMember = {
      id: "original-membership",
      collectionId: collection.id,
      personId: "old-person",
      source: "manual" as const,
      createdAt: 1,
    };
    const person = (id: string, name: string) => ({
      id,
      name,
      note: "",
      descriptors: [],
      thumb: "",
      createdAt: 1,
    });
    const people = [person("old-person", "周舟"), person("known-person", "林荷")];
    await facesDb.applyArchiveMutationBatch({
      persons: people,
      collections: [collection],
      collectionMemberships: [oldMember],
    });
    const compiled = compileSemanticIntakePlan({
      candidate: {
        version: 1,
        type: "semantic_plan",
        tasks: [
          tasks[0],
          {
            ...tasks[1],
            memberships: [
              { people: { kind: "person", name: "许星" }, action: "add" },
              { people: { kind: "person", name: "林荷" }, action: "add" },
              { people: { kind: "person", name: "周舟" }, action: "remove" },
            ],
          },
        ],
      },
      snapshot: {
        ...snapshot,
        persons: people,
        collections: [collection],
        collectionMemberships: [oldMember],
      },
    });
    expect(compiled.issues).toEqual([]);
    expect(compiled.draft.collections?.[0].targetCollectionId).toBe(collection.id);
    const result = compileIntakeCollections({
      drafts: compiled.draft.collections!,
      collections: [collection],
      memberships: [oldMember],
      resolvePerson: (member) => member.personId ?? "new-person",
      now: 2,
    });
    await facesDb.applyArchiveMutationBatch({
      ...result.forward,
      persons: [person("new-person", "许星")],
    });
    expect(
      (await facesDb.listCollectionMemberships()).map((member) => member.personId).sort(),
    ).toEqual(["known-person", "new-person"]);
    await facesDb.applyArchiveMutationBatch(result.undo);
    expect(await facesDb.listCollectionMemberships()).toEqual([oldMember]);
    expect(await facesDb.listCollections()).toEqual([collection]);
  });

  it("preserves unknown and invalid attributes through the fact channel without losing the person", () => {
    const result = decodeSemanticPersonChanges({ title: "店长", unknownField: { a: 1 }, age: 25 });
    expect(result.changes).toEqual({ title: "店长" });
    expect(result.facts).toEqual([
      { key: "待整理字段：unknownField", value: '{"a":1}' },
      { key: "待整理字段：age", value: "25" },
    ]);
    const compiled = compileSemanticIntakePlan({
      candidate: { version: 1, type: "semantic_plan", tasks },
      snapshot,
    });
    expect(compiled.issues).toEqual([]);
    expect(compiled.draft.people?.[0]).toMatchObject({
      name: "许星",
      title: "店长",
      birthday: "09-12",
    });
    expect(compiled.draft.facts?.[0]).toMatchObject({
      personDraftId: "draft:person:person-a",
      value: '["咖啡"]',
    });
    expect(compiled.draft.events?.[0]).toMatchObject({
      timeText: "下午3点",
      peopleDraftIds: ["draft:person:person-a"],
    });
    expect(compiled.draft.collections?.[0].memberships[0]).toMatchObject({
      personDraftId: "draft:person:person-a",
      action: "add",
    });
    expect(compiled.proposal).toBeUndefined();
  });

  it("commits new people and circle members together, restores time from backup, and undoes the circle", async () => {
    vi.resetModules();
    Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: new IDBFactory() });
    const { facesDb } = await import("./face-db");
    const { rollbackIntakeBatch } = await import("./intake-undo");
    const compiled = compileSemanticIntakePlan({
      candidate: { version: 1, type: "semantic_plan", tasks },
      snapshot,
    });
    const collections = compileIntakeCollections({
      drafts: compiled.draft.collections!,
      collections: [],
      memberships: [],
      resolvePerson: () => "person-final",
      now: 1,
    });
    const event = {
      id: "event-final",
      date: "2026-09-08",
      timeText: "下午3点",
      title: "书店讨论",
      personIds: ["person-final"],
      createdAt: 1,
    };
    await facesDb.applyArchiveMutationBatch({
      ...collections.forward,
      persons: [
        { id: "person-final", name: "许星", note: "", descriptors: [], thumb: "", createdAt: 1 },
      ],
      lifeEvents: [event],
    });
    expect((await facesDb.listCollectionMemberships())[0].personId).toBe("person-final");
    const archive = createArchiveV2(await facesDb.readArchiveSnapshot());
    const restored = archiveRestorePlan(JSON.stringify(archive));
    expect(restored.records.lifeEvents[0].timeText).toBe("下午3点");
    expect(formatEventTime(restored.records.lifeEvents[0])).toContain("下午3点");
    await rollbackIntakeBatch({
      id: "receipt",
      committedAt: 1,
      createdPersonIds: ["person-final"],
      createdRelationIds: [],
      createdEvidenceIds: [],
      createdEventIds: ["event-final"],
      createdReminderIds: [],
      previousPeople: [],
      collectionUndo: collections.undo,
    });
    expect(await facesDb.listCollections()).toEqual([]);
    expect(await facesDb.listCollectionMemberships()).toEqual([]);
  });

  it("does not commit circle membership when its person draft is unresolved", () => {
    const compiled = compileSemanticIntakePlan({
      candidate: { version: 1, type: "semantic_plan", tasks },
      snapshot,
    });
    expect(() =>
      compileIntakeCollections({
        drafts: compiled.draft.collections!,
        collections: [],
        memberships: [],
        resolvePerson: () => undefined,
        now: 1,
      }),
    ).toThrow("请先确认圈层");
  });
});
