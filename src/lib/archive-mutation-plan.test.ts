import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  CollectionRecord,
  LifeEventRecord,
  PersonRecord,
  ProjectRecord,
  RelationAssertionRecord,
  ReminderRecord,
  TaskRecord,
} from "./face-db";

function useFreshIndexedDb() {
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: new IDBFactory(),
    writable: true,
  });
}

function person(id: string, name = id): PersonRecord {
  return {
    id,
    name,
    note: "",
    profile: { title: "旧职位", org: "旧公司", tags: ["旧标签"] },
    descriptors: [],
    thumb: "",
    createdAt: 1,
    updatedAt: 1,
  };
}

function assertion(id: string, fromId: string, toId: string): RelationAssertionRecord {
  return {
    id,
    recordType: "assertion",
    fromId,
    toId,
    predicate: "colleague_of",
    qualifiers: { temporalStatus: "current" },
    label: "同事",
    direction: "ontology",
    note: "现在同组",
    evidence: { mode: "source_claim", basis: "原文：两人是同事", sourceIds: [] },
    validity: { status: "active" },
    confidence: 0.95,
    confirmationStatus: "confirmed",
    createdAt: 1,
    updatedAt: 1,
  };
}

beforeEach(() => {
  vi.resetModules();
  useFreshIndexedDb();
});

describe("archive mutation plan contract", () => {
  it("rejects unknown keys and ambiguous set/clear changes", async () => {
    const {
      archiveMutationPlanSchema,
      archiveRecordRevision,
      personMutationPatchSchema,
      relationReplacementSchema,
    } = await import("./archive-mutation-plan");

    expect(() =>
      personMutationPatchSchema.parse({
        set: { note: "新备注" },
        clear: ["note"],
      }),
    ).toThrow(/同时/);
    expect(() =>
      archiveMutationPlanSchema.parse({
        version: 1,
        id: "plan",
        title: "修改",
        reason: "测试",
        createdAt: 1,
        operations: [
          {
            id: "op",
            kind: "update_person",
            targetId: "a",
            reason: "测试",
            precondition: { expectedRevision: archiveRecordRevision(person("a")) },
            changes: { set: { note: "新备注", hiddenField: "bad" } },
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      relationReplacementSchema.parse({
        label: "前同事",
        predicate: "colleague_of",
        qualifiers: { temporalStatus: "current" },
        direction: "ontology",
        note: null,
        evidence: { mode: "source_claim", basis: "用户说明", sourceIds: [] },
        validity: { status: "ended", validFrom: null, validTo: null },
        confidence: 1,
        confirmationStatus: "confirmed",
      }),
    ).toThrow();
  });

  it("uses a content revision instead of trusting timestamps", async () => {
    const { archiveRecordRevision } = await import("./archive-mutation-plan");
    const original = person("a");
    const changed = { ...original, name: "改名", updatedAt: original.updatedAt };
    expect(archiveRecordRevision(original)).not.toBe(archiveRecordRevision(changed));
    expect(archiveRecordRevision(original)).toBe(
      archiveRecordRevision({
        updatedAt: 1,
        createdAt: 1,
        thumb: "",
        descriptors: [],
        profile: { tags: ["旧标签"], org: "旧公司", title: "旧职位" },
        note: "",
        name: "a",
        id: "a",
      }),
    );
  });
});

describe("archive mutation plan integration", () => {
  it("applies person, relation, event and collection edits in one approved plan", async () => {
    const { facesDb } = await import("./face-db");
    const {
      applyArchiveMutationPlan,
      createArchiveMutationPlan,
      createOrganizeCollectionOperation,
      createSupersedeRelationOperation,
      createUpdateEventOperation,
      createUpdatePersonOperation,
      loadArchiveMutationSnapshot,
    } = await import("./archive-mutation-plan");

    const alice = person("alice", "唐悦");
    const bob = person("bob", "周宁");
    const oldRelation = assertion("relation-old", alice.id, bob.id);
    const event: LifeEventRecord = {
      id: "dinner",
      date: "2026-09-01",
      title: "团队聚餐",
      personIds: [alice.id, bob.id],
      createdAt: 1,
      updatedAt: 1,
    };
    const collection: CollectionRecord = {
      id: "fiction",
      name: "亲戚",
      kind: "context",
      createdAt: 1,
      updatedAt: 1,
    };
    await facesDb.putRelationshipBatch({
      persons: [alice, bob],
      assertions: [oldRelation],
      lifeEvents: [event],
    });
    await facesDb.putCollection(collection);

    const snapshot = await loadArchiveMutationSnapshot();
    const relationReplacement = {
      label: "前同事",
      predicate: "colleague_of" as const,
      qualifiers: {},
      direction: "ontology" as const,
      note: null,
      evidence: {
        mode: "source_claim" as const,
        basis: "用户说明：现在是前同事",
        sourceIds: [],
      },
      validity: { status: "ended" as const, validFrom: null, validTo: null },
      confidence: 1,
      confirmationStatus: "confirmed" as const,
    };
    const plan = createArchiveMutationPlan(
      {
        title: "批量整理档案",
        reason: "用户在同一轮修正了人物、关系、事件和圈层",
        operations: [
          createUpdatePersonOperation(snapshot, {
            id: "op-person",
            personId: alice.id,
            reason: "升职",
            changes: {
              set: { profile: { title: "品牌总监" } },
              unset: ["profile.org"],
              clear: ["profile.tags"],
            },
          }),
          createSupersedeRelationOperation(snapshot, {
            id: "op-relation",
            newAssertionId: "relation-new",
            assertionId: oldRelation.id,
            reason: "同事关系已经结束",
            replacement: relationReplacement,
          }),
          createUpdateEventOperation(snapshot, {
            id: "op-event",
            eventId: event.id,
            reason: "聚餐改期",
            changes: { set: { date: "2026-09-02" } },
          }),
          createOrganizeCollectionOperation(snapshot, {
            id: "op-circle",
            collectionId: collection.id,
            reason: "将红楼梦人物归入虚构语境",
            replacement: { name: "虚构", kind: "context", color: null },
            memberships: [{ personId: bob.id, action: "add" }],
          }),
        ],
      },
      { id: "plan-batch", createdAt: 2 },
    );

    const result = await applyArchiveMutationPlan(plan, { now: 10 });
    expect(result.operationIds).toEqual(["op-person", "op-relation", "op-event", "op-circle"]);
    expect(result.diff).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "profile.title", after: "品牌总监" }),
        expect.objectContaining({ field: "relation.label", after: "前同事" }),
        expect.objectContaining({ field: "event.date", after: "2026-09-02" }),
        expect.objectContaining({ field: "collection.name", after: "虚构" }),
      ]),
    );

    const updatedPerson = (await facesDb.listPersons()).find((row) => row.id === alice.id)!;
    expect(updatedPerson.profile).toMatchObject({ title: "品牌总监", tags: [] });
    expect(updatedPerson.profile).not.toHaveProperty("org");
    const history = await facesDb.listRelationAssertions();
    expect(history).toHaveLength(2);
    expect(history.find((row) => row.id === "relation-old")).toEqual(oldRelation);
    expect(history.find((row) => row.id === "relation-new")).toMatchObject({
      label: "前同事",
      supersedesAssertionId: "relation-old",
      validity: { status: "ended" },
    });
    await expect(facesDb.listCurrentRelationAssertions()).resolves.toEqual([
      expect.objectContaining({ id: "relation-new" }),
    ]);
    await expect(facesDb.listLifeEvents()).resolves.toEqual([
      expect.objectContaining({ id: "dinner", date: "2026-09-02" }),
    ]);
    await expect(facesDb.listCollections()).resolves.toEqual([
      expect.objectContaining({ id: "fiction", name: "虚构" }),
    ]);
    await expect(facesDb.listCollectionMemberships()).resolves.toEqual([
      expect.objectContaining({ collectionId: "fiction", personId: "bob" }),
    ]);
  });

  it("rejects the whole plan when any target changed after proposal creation", async () => {
    const { facesDb } = await import("./face-db");
    const {
      applyArchiveMutationPlan,
      createArchiveMutationPlan,
      createUpdateEventOperation,
      createUpdatePersonOperation,
      loadArchiveMutationSnapshot,
    } = await import("./archive-mutation-plan");
    const alice = person("alice", "唐悦");
    const event: LifeEventRecord = {
      id: "event",
      date: "2026-09-01",
      title: "聚餐",
      createdAt: 1,
      updatedAt: 1,
    };
    await facesDb.putRelationshipBatch({ persons: [alice], lifeEvents: [event] });
    const snapshot = await loadArchiveMutationSnapshot();
    const plan = createArchiveMutationPlan({
      title: "修改",
      reason: "并发测试",
      operations: [
        createUpdatePersonOperation(snapshot, {
          personId: alice.id,
          reason: "改备注",
          changes: { set: { note: "来自计划" } },
        }),
        createUpdateEventOperation(snapshot, {
          eventId: event.id,
          reason: "改日期",
          changes: { set: { date: "2026-09-02" } },
        }),
      ],
    });
    await facesDb.putPerson({ ...alice, note: "用户刚刚手改", updatedAt: 2 });

    await expect(applyArchiveMutationPlan(plan, { now: 10 })).rejects.toThrow(/已变化/);
    await expect(facesDb.listLifeEvents()).resolves.toEqual([event]);
  });

  it("previews every delete dependency and does not leave empty linked records", async () => {
    const { facesDb } = await import("./face-db");
    const {
      applyArchiveMutationPlan,
      collectionMembershipId,
      createArchiveMutationPlan,
      createDeletePersonOperation,
      loadArchiveMutationSnapshot,
    } = await import("./archive-mutation-plan");
    const alice = person("alice", "唐悦");
    const bob = person("bob", "周宁");
    const oldRelation = assertion("relation", alice.id, bob.id);
    const event: LifeEventRecord = {
      id: "event",
      date: "2026-09-01",
      title: "只和唐悦相关的事件",
      personIds: [alice.id],
      createdAt: 1,
    };
    const reminder: ReminderRecord = {
      id: "reminder",
      title: "提醒唐悦",
      personIds: [alice.id],
      done: false,
      createdAt: 1,
    };
    const task: TaskRecord = {
      id: "task",
      title: "联系唐悦",
      personIds: [alice.id],
      priority: "normal",
      status: "todo",
      createdAt: 1,
    };
    const project: ProjectRecord = {
      id: "project",
      title: "唐悦负责的事务",
      ownerId: alice.id,
      ownerName: alice.name,
      memberIds: [alice.id, bob.id],
      status: "active",
      priority: "normal",
      createdAt: 1,
      updatedAt: 1,
    };
    const collection: CollectionRecord = {
      id: "work",
      name: "工作",
      kind: "context",
      createdAt: 1,
      updatedAt: 1,
    };
    const evidence = {
      id: "evidence",
      kind: "note" as const,
      title: "共同材料",
      text: "唐悦和周宁均在材料中",
      linkedPersonIds: [alice.id, bob.id],
      entities: [
        { type: "person", value: alice.name, personId: alice.id },
        { type: "person", value: bob.name, personId: bob.id },
      ],
      createdAt: 1,
    };
    const caseEvent = {
      id: "case-event",
      at: 1,
      title: "共同案件事件",
      personIds: [alice.id, bob.id],
      evidenceIds: [evidence.id],
      createdAt: 1,
    };
    await facesDb.putRelationshipBatch({
      persons: [alice, bob],
      assertions: [oldRelation],
      evidence: [evidence],
      lifeEvents: [event],
      reminders: [reminder],
    });
    await facesDb.putCaseEvent(caseEvent);
    await facesDb.putTask(task);
    await facesDb.putProject(project);
    await facesDb.putCollection(collection);
    await facesDb.putCollectionMembership({
      id: collectionMembershipId(collection.id, alice.id),
      collectionId: collection.id,
      personId: alice.id,
      source: "manual",
      createdAt: 1,
    });

    const snapshot = await loadArchiveMutationSnapshot();
    const operation = createDeletePersonOperation(snapshot, {
      id: "delete-alice",
      personId: alice.id,
      reason: "用户明确要求删除",
    });
    expect(operation.resolutions).toEqual(
      expect.arrayContaining([
        { kind: "relation_assertion", targetId: "relation", action: "delete" },
        { kind: "life_event", targetId: "event", action: "delete" },
        { kind: "reminder", targetId: "reminder", action: "delete" },
        { kind: "task", targetId: "task", action: "delete" },
        { kind: "case_event", targetId: "case-event", action: "detach" },
        { kind: "evidence", targetId: "evidence", action: "detach" },
        expect.objectContaining({ kind: "project", targetId: "project", action: "delete" }),
        expect.objectContaining({ kind: "collection_membership", action: "delete" }),
      ]),
    );
    const plan = createArchiveMutationPlan({
      title: "删除唐悦",
      reason: "连同依赖一起处理",
      operations: [operation],
    });
    await applyArchiveMutationPlan(plan, { now: 10 });

    expect((await facesDb.listPersons()).map((row) => row.id)).toEqual([bob.id]);
    await expect(facesDb.listRelationAssertions()).resolves.toEqual([]);
    await expect(facesDb.listLifeEvents()).resolves.toEqual([]);
    await expect(facesDb.listReminders()).resolves.toEqual([]);
    await expect(facesDb.listTasks()).resolves.toEqual([]);
    await expect(facesDb.listProjects()).resolves.toEqual([]);
    await expect(facesDb.listCollectionMemberships()).resolves.toEqual([]);
    await expect(facesDb.listEvidence()).resolves.toEqual([
      expect.objectContaining({
        id: evidence.id,
        linkedPersonIds: [bob.id],
        entities: [
          expect.objectContaining({ value: alice.name, personId: undefined }),
          expect.objectContaining({ value: bob.name, personId: bob.id }),
        ],
      }),
    ]);
    await expect(facesDb.listCaseEvents()).resolves.toEqual([
      expect.objectContaining({ id: caseEvent.id, personIds: [bob.id] }),
    ]);
  });

  it("supports an explicit project reassignment instead of leaving it ownerless", async () => {
    const { facesDb } = await import("./face-db");
    const {
      applyArchiveMutationPlan,
      createArchiveMutationPlan,
      createDeletePersonOperation,
      loadArchiveMutationSnapshot,
    } = await import("./archive-mutation-plan");
    const alice = person("alice", "唐悦");
    const bob = person("bob", "周宁");
    await facesDb.putRelationshipBatch({ persons: [alice, bob] });
    await facesDb.putProject({
      id: "project",
      title: "发布会",
      ownerId: alice.id,
      ownerName: alice.name,
      memberIds: [alice.id],
      status: "active",
      priority: "high",
      createdAt: 1,
      updatedAt: 1,
    });
    const snapshot = await loadArchiveMutationSnapshot();
    const base = createDeletePersonOperation(snapshot, {
      personId: alice.id,
      reason: "删除并改派",
    });
    const operation = {
      ...base,
      resolutions: base.resolutions.map((resolution) =>
        resolution.kind === "project"
          ? {
              ...resolution,
              action: "reassign" as const,
              replacementPersonId: bob.id,
            }
          : resolution,
      ),
    };
    const plan = createArchiveMutationPlan({
      title: "删除并改派",
      reason: "保留事务",
      operations: [operation],
    });
    await applyArchiveMutationPlan(plan, { now: 10 });
    await expect(facesDb.listProjects()).resolves.toEqual([
      expect.objectContaining({ ownerId: bob.id, ownerName: bob.name, memberIds: [bob.id] }),
    ]);
  });

  it("invalidates a delete preview when a new dependency appears", async () => {
    const { facesDb } = await import("./face-db");
    const {
      applyArchiveMutationPlan,
      createArchiveMutationPlan,
      createDeletePersonOperation,
      loadArchiveMutationSnapshot,
    } = await import("./archive-mutation-plan");
    const alice = person("alice", "唐悦");
    await facesDb.putRelationshipBatch({ persons: [alice] });
    const snapshot = await loadArchiveMutationSnapshot();
    const plan = createArchiveMutationPlan({
      title: "删除唐悦",
      reason: "并发依赖测试",
      operations: [
        createDeletePersonOperation(snapshot, {
          personId: alice.id,
          reason: "用户明确要求删除",
        }),
      ],
    });
    await facesDb.putReminder({
      id: "late-reminder",
      title: "稍后联系唐悦",
      personIds: [alice.id],
      done: false,
      createdAt: 2,
    });

    await expect(applyArchiveMutationPlan(plan, { now: 10 })).rejects.toThrow(/依赖|重新预览/);
    expect((await facesDb.listPersons()).map((row) => row.id)).toContain(alice.id);
    expect((await facesDb.listReminders()).map((row) => row.id)).toContain("late-reminder");
  });

  it("rejects editing a disposable derived relationship", async () => {
    const { createSupersedeRelationOperation } = await import("./archive-mutation-plan");
    const snapshot = {
      persons: [person("a"), person("b")],
      assertions: [],
      derivedRelations: [
        {
          id: "derived",
          recordType: "derived" as const,
          fromId: "a",
          toId: "b",
          predicate: "sibling_of" as const,
          qualifiers: {},
          label: "兄弟姐妹",
          confidence: 0.7,
          ruleId: "test",
          ruleVersion: 1,
          supportingRelationIds: ["fact-a", "fact-b"],
          explanation: "共同父母",
        },
      ],
      evidenceLinks: [],
      evidence: [],
      caseEvents: [],
      viewPreferences: [],
      referralPolicies: [],
      lifeEvents: [],
      reminders: [],
      tasks: [],
      projects: [],
      collections: [],
      collectionMemberships: [],
    };
    expect(() =>
      createSupersedeRelationOperation(snapshot, {
        assertionId: "derived",
        reason: "直接修改",
      }),
    ).toThrow(/支持事实/);
  });
});
