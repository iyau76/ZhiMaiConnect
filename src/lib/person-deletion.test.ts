import { describe, expect, it } from "vitest";

import type { ArchiveMutationRepository, ArchiveMutationSnapshot } from "./archive-mutation-plan";
import {
  applyPersonDeletionPlan,
  previewPeopleDeletion,
  previewPersonDeletion,
} from "./person-deletion";

function snapshot(): ArchiveMutationSnapshot {
  return {
    persons: [
      { id: "a", name: "甲", note: "", descriptors: [], thumb: "", createdAt: 1 },
      { id: "b", name: "乙", note: "", descriptors: [], thumb: "", createdAt: 1 },
    ],
    assertions: [
      {
        id: "r1",
        recordType: "assertion",
        fromId: "a",
        toId: "b",
        predicate: "friend_of",
        qualifiers: {},
        label: "朋友",
        direction: "ontology",
        evidence: { mode: "manual", sourceIds: [] },
        validity: { status: "active" },
        confirmationStatus: "confirmed",
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    derivedRelations: [],
    evidenceLinks: [],
    evidence: [
      {
        id: "evidence",
        kind: "note",
        title: "共同记录",
        text: "甲与乙参加活动",
        linkedPersonIds: ["a", "b"],
        entities: [
          { type: "person", value: "甲", personId: "a" },
          { type: "person", value: "乙", personId: "b" },
        ],
        createdAt: 1,
      },
    ],
    caseEvents: [{ id: "case", at: 1, title: "共同案件事件", personIds: ["a", "b"], createdAt: 1 }],
    viewPreferences: [],
    referralPolicies: [],
    lifeEvents: [
      { id: "solo", date: "2026-01-01", title: "只和甲", personIds: ["a"], createdAt: 1 },
      { id: "shared", date: "2026-01-02", title: "甲乙", personIds: ["a", "b"], createdAt: 1 },
    ],
    reminders: [],
    tasks: [],
    projects: [],
    collections: [{ id: "c", name: "朋友", kind: "context", createdAt: 1, updatedAt: 1 }],
    collectionMemberships: [
      { id: "c\u0000a", collectionId: "c", personId: "a", source: "manual", createdAt: 1 },
    ],
  };
}

function repository(data: ArchiveMutationSnapshot): ArchiveMutationRepository {
  return {
    listPersons: async () => data.persons,
    listRelationAssertions: async () => data.assertions,
    listDerivedRelations: async () => data.derivedRelations,
    listRelationEvidenceLinks: async () => data.evidenceLinks,
    listEvidence: async () => data.evidence,
    listCaseEvents: async () => data.caseEvents,
    listRelationViewPreferences: async () => data.viewPreferences,
    listReferralPolicies: async () => data.referralPolicies,
    listLifeEvents: async () => data.lifeEvents,
    listReminders: async () => data.reminders,
    listTasks: async () => data.tasks,
    listProjects: async () => data.projects,
    listCollections: async () => data.collections,
    listCollectionMemberships: async () => data.collectionMemberships,
    applyArchiveMutationBatch: async () => undefined,
  };
}

describe("person deletion preview", () => {
  it("distinguishes deleted and detached dependencies before approval", async () => {
    const result = await previewPersonDeletion("a", repository(snapshot()));
    expect(result.impact).toMatchObject({
      factRelationsDeleted: 1,
      collectionMembershipsRemoved: 1,
      recordsDeleted: 1,
      recordsDetached: 3,
    });
  });

  it("previews and applies shared dependencies as one atomic multi-person plan", async () => {
    const data = snapshot();
    data.reminders = [
      {
        id: "shared-reminder",
        title: "共同提醒",
        personIds: ["a", "b"],
        done: false,
        createdAt: 1,
      },
    ];
    data.tasks = [
      {
        id: "shared-task",
        title: "共同待办",
        personIds: ["a", "b"],
        priority: "normal",
        status: "todo",
        createdAt: 1,
      },
    ];
    const capture: {
      batch?: Parameters<ArchiveMutationRepository["applyArchiveMutationBatch"]>[0];
    } = {};
    const repo = {
      ...repository(data),
      applyArchiveMutationBatch: async (
        batch: Parameters<ArchiveMutationRepository["applyArchiveMutationBatch"]>[0],
      ) => {
        capture.batch = batch;
      },
    };

    const result = await previewPeopleDeletion(["a", "b"], repo);
    expect(result.impact).toMatchObject({
      personNames: ["甲", "乙"],
      factRelationsDeleted: 1,
      recordsDeleted: 4,
      recordsDetached: 2,
    });
    await applyPersonDeletionPlan(result.plan, repo);
    expect(capture.batch).toMatchObject({
      deletePersonIds: ["a", "b"],
      deleteAssertionIds: ["r1"],
      deleteLifeEventIds: expect.arrayContaining(["solo", "shared"]),
      deleteReminderIds: ["shared-reminder"],
      deleteTaskIds: ["shared-task"],
    });
    expect(capture.batch?.evidence).toMatchObject([{ id: "evidence", linkedPersonIds: [] }]);
    expect(capture.batch?.caseEvents).toMatchObject([{ id: "case", personIds: [] }]);
  });
});
