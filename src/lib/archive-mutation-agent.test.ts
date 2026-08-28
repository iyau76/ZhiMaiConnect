import { describe, expect, it } from "vitest";

import { createAgentMutationPlan } from "./archive-mutation-agent";
import type { ArchiveMutationSnapshot } from "./archive-mutation-plan";
import type { PersonRecord, RelationAssertionRecord } from "./face-db";

function person(id: string, name: string): PersonRecord {
  return {
    id,
    name,
    note: "",
    descriptors: [],
    thumb: "",
    createdAt: 1,
    updatedAt: 1,
  };
}

function assertion(): RelationAssertionRecord {
  return {
    id: "relation-1",
    recordType: "assertion",
    fromId: "tang",
    toId: "zhou",
    predicate: "colleague_of",
    qualifiers: { temporalStatus: "current" },
    label: "同事",
    direction: "ontology",
    evidence: { mode: "manual", sourceIds: [] },
    validity: { status: "active" },
    confirmationStatus: "confirmed",
    createdAt: 1,
    updatedAt: 1,
  };
}

function snapshot(): ArchiveMutationSnapshot {
  return {
    persons: [person("tang", "唐悦"), person("zhou", "周宁")],
    assertions: [assertion()],
    derivedRelations: [],
    evidenceLinks: [],
    evidence: [],
    caseEvents: [],
    viewPreferences: [],
    referralPolicies: [],
    lifeEvents: [
      {
        id: "event-1",
        date: "2026-09-01",
        title: "团队聚餐",
        personIds: ["tang", "zhou"],
        createdAt: 1,
      },
    ],
    reminders: [],
    tasks: [],
    projects: [],
    collections: [
      {
        id: "collection-relatives",
        name: "亲戚",
        kind: "relationship_circle",
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    collectionMemberships: [
      {
        id: "collection-relatives\u0000tang",
        collectionId: "collection-relatives",
        personId: "tang",
        source: "manual",
        createdAt: 1,
      },
    ],
  };
}

describe("createAgentMutationPlan", () => {
  it("turns a multi-domain request into one validated atomic plan", () => {
    const result = createAgentMutationPlan(
      {
        title: "同步唐悦与周宁的最新情况",
        reason: "用户明确更正了三项资料",
        operations: [
          {
            kind: "update_person",
            personId: "tang",
            reason: "唐悦已升职",
            changes: { set: { profile: { title: "品牌总监" } } },
          },
          {
            kind: "update_relation",
            relationId: "relation-1",
            reason: "两人现在是前同事",
            changes: { label: "前同事" },
          },
          {
            kind: "update_event",
            eventId: "event-1",
            reason: "聚餐改期",
            changes: { set: { date: "2026-09-02" } },
          },
        ],
      },
      snapshot(),
      { id: "plan-1", createdAt: 10 },
    );

    expect(result.plan.operations.map((operation) => operation.kind)).toEqual([
      "update_person",
      "supersede_relation",
      "update_event",
    ]);
    const relation = result.plan.operations[1];
    expect(relation).toMatchObject({
      kind: "supersede_relation",
      replacement: {
        label: "前同事",
        predicate: "colleague_of",
        validity: { status: "ended" },
      },
    });
    expect(result.diff).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "profile.title", after: "品牌总监" }),
        expect.objectContaining({ field: "relation.label", after: "前同事" }),
        expect.objectContaining({ field: "event.date", after: "2026-09-02" }),
      ]),
    );
  });

  it("renames a collection without overwriting a person's relationship field", () => {
    const result = createAgentMutationPlan(
      {
        title: "整理红楼梦人物圈层",
        reason: "这些人物属于虚构角色",
        operations: [
          {
            kind: "organize_collection",
            collectionId: "collection-relatives",
            reason: "把错误圈层改为虚构",
            replacement: { name: "虚构", kind: "context" },
          },
        ],
      },
      snapshot(),
    );
    expect(result.plan.operations[0]).toMatchObject({
      kind: "organize_collection",
      targetId: "collection-relatives",
      replacement: { name: "虚构", kind: "context" },
    });
    expect(result.diff).toContainEqual(
      expect.objectContaining({ field: "collection.name", before: "亲戚", after: "虚构" }),
    );
  });

  it("coordinates shared dependencies when an agent proposes deleting several people", () => {
    const result = createAgentMutationPlan(
      {
        title: "删除两份测试档案",
        reason: "用户明确要求一起删除",
        operations: [
          { kind: "delete_person", personId: "tang", reason: "删除唐悦" },
          { kind: "delete_person", personId: "zhou", reason: "删除周宁" },
        ],
      },
      snapshot(),
    );
    const deleteOperations = result.plan.operations.filter(
      (operation) => operation.kind === "delete_person",
    );
    expect(deleteOperations).toHaveLength(2);
    expect(
      deleteOperations.flatMap((operation) =>
        operation.kind === "delete_person"
          ? operation.resolutions.filter((resolution) => resolution.targetId === "event-1")
          : [],
      ),
    ).toMatchObject([
      { kind: "life_event", action: "delete" },
      { kind: "life_event", action: "delete" },
    ]);
    expect(result.diff.filter((row) => row.targetId === "event-1")).toHaveLength(1);
  });
});
