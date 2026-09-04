import { describe, expect, it } from "vitest";

import type { ArchiveMutationWriteBatch, FaceDbArchiveReplacement, PersonRecord } from "./face-db";
import type {
  ClaimMutationProposalDecisionInput,
  MutationRecordListener,
  MutationRecordRepository,
  PersistedMutationProposalRecord,
  PersistedMutationReceiptRecord,
  PutMutationProposalInput,
  PutMutationReceiptInput,
  SettleMutationProposalDecisionInput,
} from "./agent-run-ledger";
import {
  createArchiveMutationPlan,
  createDeletePersonOperation,
  createOrganizeCollectionOperation,
  createUpdatePersonOperation,
  type ArchiveMutationSnapshot,
} from "./archive-mutation-plan";
import {
  archiveMutationSnapshotFingerprint,
  MutationCommitCoordinator,
  type MutationCommitIssueEvent,
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
  archiveRevision = 0;
  readonly appliedDecisions = new Set<string>();
  failNextDecisionBeforeApply = false;

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
    this.archiveRevision += 1;
  }

  async applyArchiveMutationBatchOnce(
    batch: ArchiveMutationWriteBatch,
    guard: { decisionId: string; expectedRevision: number },
  ) {
    if (this.appliedDecisions.has(guard.decisionId)) return "already_applied" as const;
    if (guard.expectedRevision !== this.archiveRevision) return "conflict" as const;
    if (this.failNextDecisionBeforeApply) {
      this.failNextDecisionBeforeApply = false;
      throw new Error("simulated process interruption before archive apply");
    }
    await this.applyArchiveMutationBatch(batch);
    this.appliedDecisions.add(guard.decisionId);
    return "applied" as const;
  }

  async hasAppliedArchiveMutationDecision(decisionId: string) {
    return this.appliedDecisions.has(decisionId);
  }

  async getArchiveMutationRevision() {
    return this.archiveRevision;
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
    this.archiveRevision += 1;
  }
}

class MemoryMutationArtifactRepository implements MutationRecordRepository {
  readonly proposals = new Map<string, PersistedMutationProposalRecord>();
  readonly receipts = new Map<string, PersistedMutationReceiptRecord>();
  failNextProposalWrite = false;
  failNextSettle = false;

  async putProposal(input: PutMutationProposalInput) {
    if (this.failNextProposalWrite) {
      this.failNextProposalWrite = false;
      throw new Error("temporary storage failure");
    }
    const existing = this.proposals.get(input.id);
    if (existing) return structuredClone(existing);
    const record: PersistedMutationProposalRecord = {
      ...structuredClone(input),
      schemaVersion: 1,
      status: "pending",
      revision: 0,
      updatedAt: input.updatedAt ?? input.enqueuedAt,
    };
    this.proposals.set(record.id, record);
    return structuredClone(record);
  }

  async claimProposalDecision(input: ClaimMutationProposalDecisionInput) {
    const records = input.proposalIds.map((id) => {
      const record = this.proposals.get(id);
      if (!record) throw new Error(`missing ${id}`);
      if (record.decisionId && record.decisionId !== input.decisionId) {
        throw new Error(`decision conflict ${id}`);
      }
      const next: PersistedMutationProposalRecord = {
        ...record,
        decisionId: input.decisionId,
        decisionKind: input.decisionKind,
        decisionClaimedAt: input.claimedAt ?? record.updatedAt,
        revision: record.decisionId ? record.revision : record.revision + 1,
        decisionIntent:
          input.decisionKind === "committed" && id === [...input.proposalIds].sort()[0]
            ? input.intent
            : undefined,
      };
      this.proposals.set(id, next);
      return next;
    });
    return structuredClone(records);
  }

  async settleProposalDecision(input: SettleMutationProposalDecisionInput) {
    if (this.failNextSettle) {
      this.failNextSettle = false;
      throw new Error("simulated process interruption before decision settlement");
    }
    const records = input.proposalIds.map((id) => {
      const record = this.proposals.get(id);
      if (!record || record.decisionId !== input.decisionId)
        throw new Error(`decision conflict ${id}`);
      const next: PersistedMutationProposalRecord = {
        ...record,
        status: input.decisionKind,
        revision: record.status === input.decisionKind ? record.revision : record.revision + 1,
        decidedAt: input.decidedAt ?? record.updatedAt,
        receiptId: input.receipt?.id,
        updatedAt: input.decidedAt ?? record.updatedAt,
        decisionIntent: undefined,
      };
      this.proposals.set(id, next);
      return next;
    });
    if (input.receipt) await this.putReceipt(input.receipt);
    return structuredClone(records);
  }

  async releaseProposalDecision(input: {
    proposalIds: readonly string[];
    decisionId: string;
    releasedAt?: number;
    requireArchiveDecisionUnapplied?: boolean;
  }) {
    const records = input.proposalIds.map((id) => {
      const record = this.proposals.get(id);
      if (!record || record.decisionId !== input.decisionId)
        throw new Error(`decision conflict ${id}`);
      const next = { ...record };
      delete next.decisionId;
      delete next.decisionKind;
      delete next.decisionClaimedAt;
      delete next.decisionIntent;
      next.revision += 1;
      next.updatedAt = input.releasedAt ?? next.updatedAt;
      this.proposals.set(id, next);
      return next;
    });
    return structuredClone(records);
  }

  async getProposal(id: string) {
    const record = this.proposals.get(id);
    return record ? structuredClone(record) : undefined;
  }

  async listProposals(
    options: {
      sourceRunId?: string;
      status?: PersistedMutationProposalRecord["status"];
      scope?: string | null;
    } = {},
  ) {
    return structuredClone(
      [...this.proposals.values()]
        .filter((record) => !options.sourceRunId || record.sourceRunId === options.sourceRunId)
        .filter((record) => !options.status || record.status === options.status)
        .filter((record) =>
          options.scope === undefined
            ? true
            : options.scope === null
              ? !record.scope
              : record.scope === options.scope,
        ),
    );
  }

  async deleteProposal(id: string) {
    return this.proposals.delete(id);
  }

  async putReceipt(input: PutMutationReceiptInput) {
    const record: PersistedMutationReceiptRecord = {
      ...structuredClone(input),
      schemaVersion: 1,
      updatedAt: input.updatedAt ?? input.committedAt,
    };
    this.receipts.set(record.id, record);
    return structuredClone(record);
  }

  async getReceipt(id: string) {
    const record = this.receipts.get(id);
    return record ? structuredClone(record) : undefined;
  }

  async listReceipts(options: { sourceRunId?: string; scope?: string | null } = {}) {
    return structuredClone(
      [...this.receipts.values()]
        .filter((record) => !options.sourceRunId || record.sourceRunId === options.sourceRunId)
        .filter((record) =>
          options.scope === undefined
            ? true
            : options.scope === null
              ? !record.scope
              : record.scope === options.scope,
        ),
    );
  }

  async deleteReceipt(id: string) {
    return this.receipts.delete(id);
  }

  async clear() {
    this.proposals.clear();
    this.receipts.clear();
  }

  subscribe(_listener: MutationRecordListener) {
    return () => undefined;
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
  it("retries a failed persistence operation without poisoning later writes", async () => {
    const initial = emptySnapshot([person("a", "唐悦")]);
    const artifacts = new MemoryMutationArtifactRepository();
    const issues: MutationCommitIssueEvent[] = [];
    artifacts.failNextProposalWrite = true;
    const coordinator = new MutationCommitCoordinator({
      repository: new MemoryMutationRepository(initial),
      artifactRepository: artifacts,
      now: () => 90,
      scope: "assistant",
      onIssue: (issue) => issues.push(issue),
    });
    const proposal = coordinator.enqueue(updatePlan(initial, "a", "前同事"), {
      sourceRunId: "run-persist",
    });

    await expect(coordinator.flushPersistence()).rejects.toThrow("temporary storage failure");
    expect(issues).toEqual([
      expect.objectContaining({
        category: "transaction",
        phase: "transaction",
        operation: "persist_artifacts",
        sourceRunId: "run-persist",
        scope: "assistant",
        proposalIds: [proposal.id],
      }),
    ]);
    expect(coordinator.pending()).toHaveLength(1);
    await expect(coordinator.flushPersistence()).resolves.toBeUndefined();
    expect(issues).toHaveLength(1);
    await expect(artifacts.getProposal(proposal.id)).resolves.toMatchObject({
      id: proposal.id,
      status: "pending",
    });
  });

  it("hydrates receipts in commit order and undoes the newest receipt first", async () => {
    const base = emptySnapshot([person("a", "唐悦")]);
    const afterFirst = structuredClone(base);
    afterFirst.persons[0].note = "第一次";
    const afterSecond = structuredClone(afterFirst);
    afterSecond.persons[0].note = "第二次";
    const repository = new MemoryMutationRepository(afterSecond);
    const artifacts = new MemoryMutationArtifactRepository();
    await artifacts.putReceipt({
      id: "receipt:newer",
      planId: "plan:newer",
      proposalIds: ["proposal:newer"],
      authorizationMode: "standard",
      signature: { signer: "user", signedAt: 20 },
      committedAt: 20,
      operationIds: ["operation:newer"],
      diff: [],
      checkpoint: {
        id: "checkpoint:newer",
        createdAt: 19,
        snapshot: afterFirst,
        committedFingerprint: archiveMutationSnapshotFingerprint(afterSecond),
      },
    });
    await artifacts.putReceipt({
      id: "receipt:older",
      planId: "plan:older",
      proposalIds: ["proposal:older"],
      authorizationMode: "standard",
      signature: { signer: "user", signedAt: 10 },
      committedAt: 10,
      operationIds: ["operation:older"],
      diff: [],
      checkpoint: {
        id: "checkpoint:older",
        createdAt: 9,
        snapshot: base,
        committedFingerprint: archiveMutationSnapshotFingerprint(afterFirst),
      },
    });
    let now = 30;
    const coordinator = new MutationCommitCoordinator({
      repository,
      artifactRepository: artifacts,
      now: () => now++,
    });

    await coordinator.hydrate();
    await expect(coordinator.undo("receipt:older")).rejects.toThrow();
    await coordinator.undo("receipt:newer");
    expect(repository.snapshot.persons[0].note).toBe("第一次");
    await coordinator.undo("receipt:older");
    expect(repository.snapshot.persons[0].note).toBe("");
  });

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

  it("resumes an approved decision after interruption before archive apply", async () => {
    const initial = emptySnapshot([person("a", "唐悦")]);
    const repository = new MemoryMutationRepository(initial);
    const artifacts = new MemoryMutationArtifactRepository();
    const issues: MutationCommitIssueEvent[] = [];
    repository.failNextDecisionBeforeApply = true;
    const firstPage = new MutationCommitCoordinator({
      repository,
      artifactRepository: artifacts,
      now: () => 400,
      scope: "assistant",
      onIssue: (issue) => issues.push(issue),
    });
    const proposal = firstPage.enqueue(updatePlan(initial, "a", "前同事"), {
      sourceRunId: "run-commit",
    });
    await firstPage.flushPersistence();

    await expect(
      firstPage.commit({
        authorizationMode: "standard",
        signature: { signer: "user", signedAt: 400 },
      }),
    ).rejects.toThrow(/interruption before archive apply/);
    expect(issues).toEqual([
      expect.objectContaining({
        category: "transaction",
        phase: "transaction",
        operation: "commit",
        sourceRunId: "run-commit",
        scope: "assistant",
        proposalIds: [proposal.id],
      }),
    ]);
    expect(repository.commitCount).toBe(0);
    await expect(artifacts.getProposal(proposal.id)).resolves.toMatchObject({
      status: "pending",
      decisionKind: "committed",
      decisionIntent: {
        beforeFingerprint: expect.any(String),
        afterFingerprint: expect.any(String),
      },
    });

    const restoredPage = new MutationCommitCoordinator({
      repository,
      artifactRepository: artifacts,
      now: () => 401,
      scope: "assistant",
    });
    await restoredPage.hydrate();

    expect(repository.commitCount).toBe(1);
    expect(repository.snapshot.persons[0].note).toBe("前同事");
    expect(restoredPage.pending()).toHaveLength(0);
    expect(restoredPage.committedReceipts()).toHaveLength(1);
    await expect(artifacts.getProposal(proposal.id)).resolves.toMatchObject({
      status: "committed",
    });
  });

  it("settles without replay after interruption between archive apply and receipt settlement", async () => {
    const initial = emptySnapshot([person("a", "唐悦")]);
    const repository = new MemoryMutationRepository(initial);
    const artifacts = new MemoryMutationArtifactRepository();
    artifacts.failNextSettle = true;
    const firstPage = new MutationCommitCoordinator({
      repository,
      artifactRepository: artifacts,
      now: () => 500,
      scope: "assistant",
    });
    firstPage.enqueue(updatePlan(initial, "a", "前同事"));
    await firstPage.flushPersistence();

    await expect(
      firstPage.commit({
        authorizationMode: "standard",
        signature: { signer: "user", signedAt: 500 },
      }),
    ).rejects.toThrow(/interruption before decision settlement/);
    expect(repository.commitCount).toBe(1);

    const restoredPage = new MutationCommitCoordinator({
      repository,
      artifactRepository: artifacts,
      now: () => 501,
      scope: "assistant",
    });
    await restoredPage.hydrate();

    expect(repository.commitCount).toBe(1);
    expect(repository.snapshot.persons[0].note).toBe("前同事");
    expect(restoredPage.committedReceipts()).toHaveLength(1);
  });

  it("allows only one of two tabs to approve the same proposal", async () => {
    const initial = emptySnapshot([person("a", "唐悦")]);
    const repository = new MemoryMutationRepository(initial);
    const artifacts = new MemoryMutationArtifactRepository();
    const seed = new MutationCommitCoordinator({
      repository,
      artifactRepository: artifacts,
      now: () => 600,
      scope: "assistant",
    });
    seed.enqueue(updatePlan(initial, "a", "前同事"));
    await seed.flushPersistence();
    const firstTab = new MutationCommitCoordinator({
      repository,
      artifactRepository: artifacts,
      now: () => 601,
      scope: "assistant",
    });
    const secondTab = new MutationCommitCoordinator({
      repository,
      artifactRepository: artifacts,
      now: () => 601,
      scope: "assistant",
    });
    await Promise.all([firstTab.hydrate(), secondTab.hydrate()]);

    const outcomes = await Promise.allSettled([
      firstTab.commit({
        authorizationMode: "standard",
        signature: { signer: "user", signedAt: 601 },
      }),
      secondTab.commit({
        authorizationMode: "standard",
        signature: { signer: "user", signedAt: 601 },
      }),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    expect(repository.commitCount).toBe(1);
    expect(repository.snapshot.persons[0].note).toBe("前同事");
    expect(artifacts.receipts.size).toBe(1);
  });

  it("keeps a recovered receipt from overwriting changes made after the archive apply", async () => {
    const initial = emptySnapshot([person("a", "唐悦")]);
    const repository = new MemoryMutationRepository(initial);
    const artifacts = new MemoryMutationArtifactRepository();
    artifacts.failNextSettle = true;
    const firstPage = new MutationCommitCoordinator({
      repository,
      artifactRepository: artifacts,
      now: () => 700,
      scope: "assistant",
    });
    firstPage.enqueue(updatePlan(initial, "a", "前同事"));
    await firstPage.flushPersistence();
    await expect(
      firstPage.commit({
        authorizationMode: "standard",
        signature: { signer: "user", signedAt: 700 },
      }),
    ).rejects.toThrow();
    await repository.applyArchiveMutationBatch({ persons: [person("later", "后来新增")] });

    const restoredPage = new MutationCommitCoordinator({
      repository,
      artifactRepository: artifacts,
      now: () => 701,
      scope: "assistant",
    });
    await restoredPage.hydrate();
    const [receipt] = restoredPage.committedReceipts();

    await expect(restoredPage.undo(receipt.id)).rejects.toThrow(/提交后又发生了变化/);
    expect(repository.snapshot.persons.map((row) => row.name)).toEqual(["唐悦", "后来新增"]);
    expect(repository.restoreCount).toBe(0);
  });

  it("isolates proposal queues by Agent scope and adopts legacy work only when requested", async () => {
    const initial = emptySnapshot([person("a", "唐悦")]);
    const repository = new MemoryMutationRepository(initial);
    const artifacts = new MemoryMutationArtifactRepository();
    const assistantWriter = new MutationCommitCoordinator({
      repository,
      artifactRepository: artifacts,
      now: () => 800,
      scope: "assistant",
    });
    const intakeWriter = new MutationCommitCoordinator({
      repository,
      artifactRepository: artifacts,
      now: () => 801,
      scope: "intake",
    });
    const legacyWriter = new MutationCommitCoordinator({
      repository,
      artifactRepository: artifacts,
      now: () => 802,
    });
    assistantWriter.enqueue(updatePlan(initial, "a", "assistant"));
    intakeWriter.enqueue(updatePlan(initial, "a", "intake"));
    legacyWriter.enqueue(updatePlan(initial, "a", "legacy"));
    await Promise.all([
      assistantWriter.flushPersistence(),
      intakeWriter.flushPersistence(),
      legacyWriter.flushPersistence(),
    ]);

    const assistantReader = new MutationCommitCoordinator({
      repository,
      artifactRepository: artifacts,
      scope: "assistant",
      acceptLegacyUnscoped: true,
    });
    const intakeReader = new MutationCommitCoordinator({
      repository,
      artifactRepository: artifacts,
      scope: "intake",
    });
    await Promise.all([assistantReader.hydrate(), intakeReader.hydrate()]);

    expect(assistantReader.pending().map((proposal) => proposal.scope)).toEqual([
      "assistant",
      undefined,
    ]);
    expect(intakeReader.pending().map((proposal) => proposal.scope)).toEqual(["intake"]);
  });
});
