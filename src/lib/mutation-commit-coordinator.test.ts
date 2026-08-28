import { describe, expect, it } from "vitest";

import type { ArchiveMutationWriteBatch, FaceDbArchiveReplacement, PersonRecord } from "./face-db";
import {
  createArchiveMutationPlan,
  createDeletePersonOperation,
  createOrganizeCollectionOperation,
  createUpdatePersonOperation,
  type ArchiveMutationSnapshot,
} from "./archive-mutation-plan";
import {
  MutationCommitCoordinator,
  type MutationCommitRepository,
} from "./mutation-commit-coordinator";

function person(id: string, name: string): PersonRecord {
  return {
    id,
    name,
    note: "",
    profile: {},
    descriptors: [],
    thumb: "",
    createdAt: 1,
    updatedAt: 1,
  };
}

function emptySnapshot(persons: PersonRecord[]): ArchiveMutationSnapshot {
  return {
    persons,
    assertions: [],
    derivedRelations: [],
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
}

class MemoryMutationRepository implements MutationCommitRepository {
  snapshot: ArchiveMutationSnapshot;
  commitCount = 0;
  restoreCount = 0;

  constructor(snapshot: ArchiveMutationSnapshot) {
    this.snapshot = structuredClone(snapshot);
  }

  listPersons = async () => structuredClone(this.snapshot.persons);
  listRelationAssertions = async () => structuredClone(this.snapshot.assertions);
  listDerivedRelations = async () => structuredClone(this.snapshot.derivedRelations);
  listRelationEvidenceLinks = async () => structuredClone(this.snapshot.evidenceLinks);
  listEvidence = async () => structuredClone(this.snapshot.evidence);
  listCaseEvents = async () => structuredClone(this.snapshot.caseEvents);
  listRelationViewPreferences = async () => structuredClone(this.snapshot.viewPreferences);
  listReferralPolicies = async () => structuredClone(this.snapshot.referralPolicies);
  listLifeEvents = async () => structuredClone(this.snapshot.lifeEvents);
  listReminders = async () => structuredClone(this.snapshot.reminders);
  listTasks = async () => structuredClone(this.snapshot.tasks);
  listProjects = async () => structuredClone(this.snapshot.projects);
  listCollections = async () => structuredClone(this.snapshot.collections);
  listCollectionMemberships = async () => structuredClone(this.snapshot.collectionMemberships);

  async applyArchiveMutationBatch(batch: ArchiveMutationWriteBatch) {
    this.commitCount += 1;
    const persons = new Map(this.snapshot.persons.map((row) => [row.id, row]));
    for (const id of batch.deletePersonIds ?? []) persons.delete(id);
    for (const row of batch.persons ?? []) persons.set(row.id, structuredClone(row));
    this.snapshot.persons = [...persons.values()];
  }

  async replaceArchiveSnapshot(replacement: FaceDbArchiveReplacement) {
    this.restoreCount += 1;
    this.snapshot = {
      persons: structuredClone(replacement.persons),
      assertions: structuredClone(replacement.relationAssertions),
      derivedRelations: [],
      evidenceLinks: structuredClone(replacement.relationEvidenceLinks),
      evidence: structuredClone(replacement.evidence),
      caseEvents: structuredClone(replacement.caseEvents),
      viewPreferences: structuredClone(replacement.relationViewPreferences),
      referralPolicies: structuredClone(replacement.referralPolicies),
      lifeEvents: structuredClone(replacement.lifeEvents),
      reminders: structuredClone(replacement.reminders),
      tasks: structuredClone(replacement.tasks),
      projects: structuredClone(replacement.projects),
      collections: structuredClone(replacement.collections),
      collectionMemberships: structuredClone(replacement.collectionMemberships),
    };
  }
}

function updatePlan(snapshot: ArchiveMutationSnapshot, personId: string, note: string) {
  return createArchiveMutationPlan({
    title: `修改 ${personId}`,
    reason: "用户要求",
    operations: [
      createUpdatePersonOperation(snapshot, {
        personId,
        reason: "用户要求",
        changes: { set: { note } },
      }),
    ],
  });
}

describe("MutationCommitCoordinator", () => {
  it("prepares a queued receipt, commits once, and restores the full checkpoint", async () => {
    const initial = emptySnapshot([person("a", "唐悦"), person("b", "周宁")]);
    const repository = new MemoryMutationRepository(initial);
    const coordinator = new MutationCommitCoordinator({ repository, now: () => 100 });
    coordinator.enqueue(updatePlan(initial, "a", "前同事"));
    coordinator.enqueue(updatePlan(initial, "b", "已离职"));

    const preview = await coordinator.prepare();
    expect(preview.diff).toHaveLength(2);
    const receipt = await coordinator.commit({
      authorizationMode: "standard",
      signature: { signer: "user", signedAt: 100 },
    });

    expect(repository.commitCount).toBe(1);
    expect(coordinator.pending()).toHaveLength(0);
    expect(receipt.operationIds).toHaveLength(2);
    expect(repository.snapshot.persons.map((row) => row.note)).toEqual(["前同事", "已离职"]);

    await coordinator.undo(receipt.id);
    expect(repository.restoreCount).toBe(1);
    expect(repository.snapshot.persons.map((row) => row.note)).toEqual(["", ""]);
  });

  it("never overwrites archive changes made after the receipt was committed", async () => {
    const initial = emptySnapshot([person("a", "唐悦")]);
    const repository = new MemoryMutationRepository(initial);
    const coordinator = new MutationCommitCoordinator({ repository, now: () => 150 });
    coordinator.enqueue(updatePlan(initial, "a", "前同事"));
    const receipt = await coordinator.commit({
      authorizationMode: "standard",
      signature: { signer: "user", signedAt: 150 },
    });

    await repository.applyArchiveMutationBatch({ persons: [person("later", "后来新增")] });

    await expect(coordinator.undo(receipt.id)).rejects.toThrow(/提交后又发生了变化/);
    expect(repository.snapshot.persons.map((row) => row.name)).toEqual(["唐悦", "后来新增"]);
    expect(repository.restoreCount).toBe(0);
  });

  it("changes signature timing without changing the transaction path", async () => {
    const initial = emptySnapshot([person("a", "唐悦"), person("b", "周宁")]);
    const repository = new MemoryMutationRepository(initial);
    const coordinator = new MutationCommitCoordinator({ repository, now: () => 200 });
    coordinator.enqueue(updatePlan(initial, "a", "一"));
    coordinator.enqueue(updatePlan(initial, "b", "二"));
    await expect(
      coordinator.commit({
        authorizationMode: "cautious",
        signature: { signer: "user", signedAt: 200 },
      }),
    ).rejects.toThrow(/一份提案/);

    const auto = new MutationCommitCoordinator({
      repository: new MemoryMutationRepository(initial),
      now: () => 201,
    });
    const result = await auto.submitProposal(updatePlan(initial, "a", "自动"), {
      authorizationMode: "full",
    });
    expect(result.status).toBe("committed");
  });

  it("proposalContainsBothFictionalPeople in semantic approval labels", async () => {
    const initial = emptySnapshot([person("jia-mu", "贾母"), person("jia-zheng", "贾政")]);
    initial.collections.push({
      id: "fictional",
      name: "红楼梦人物",
      kind: "relationship_circle",
      createdAt: 1,
      updatedAt: 1,
    });
    const repository = new MemoryMutationRepository(initial);
    const coordinator = new MutationCommitCoordinator({ repository, now: () => 250 });
    coordinator.enqueue(
      createArchiveMutationPlan({
        title: "整理真实圈层",
        reason: "用户批准迁移",
        operations: [
          createOrganizeCollectionOperation(initial, {
            collectionId: "fictional",
            reason: "用户批准迁移",
            replacement: { name: "红楼梦人物", kind: "relationship_circle", color: null },
            memberships: [
              { personId: "jia-mu", action: "add" },
              { personId: "jia-zheng", action: "add" },
            ],
          }),
        ],
      }),
    );

    const preview = await coordinator.prepare();
    expect(preview.diff.map((row) => row.targetLabel)).toEqual([
      "贾母 · 红楼梦人物",
      "贾政 · 红楼梦人物",
    ]);
    expect(preview.diff.map((row) => row.field)).toEqual([
      "collection.membership",
      "collection.membership",
    ]);
  });

  it("never lets full authorization bypass person-deletion confirmation", async () => {
    const initial = emptySnapshot([person("a", "唐悦")]);
    const repository = new MemoryMutationRepository(initial);
    const coordinator = new MutationCommitCoordinator({ repository, now: () => 300 });
    const plan = createArchiveMutationPlan({
      title: "删除唐悦",
      reason: "用户要求",
      operations: [
        createDeletePersonOperation(initial, {
          personId: "a",
          reason: "用户要求",
        }),
      ],
    });

    const submitted = await coordinator.submitProposal(plan, { authorizationMode: "full" });
    expect(submitted.status).toBe("queued");
    await expect(coordinator.commit({ authorizationMode: "full" })).rejects.toThrow(/签字/);
    await coordinator.commit({
      authorizationMode: "full",
      signature: { signer: "user", signedAt: 300 },
    });
    expect(repository.snapshot.persons).toHaveLength(0);
  });
});
