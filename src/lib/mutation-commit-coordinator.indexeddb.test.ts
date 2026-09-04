import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PersonRecord } from "./face-db";

function useFreshIndexedDb() {
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: new IDBFactory(),
    writable: true,
  });
}

function person(): PersonRecord {
  return {
    id: "person-a",
    name: "唐悦",
    note: "",
    profile: {},
    descriptors: [],
    thumb: "",
    createdAt: 1,
    updatedAt: 1,
  };
}

beforeEach(() => {
  vi.resetModules();
  useFreshIndexedDb();
});

describe("MutationCommitCoordinator IndexedDB recovery", () => {
  it("resumes a signed decision interrupted before the archive transaction", async () => {
    const { facesDb } = await import("./face-db");
    const { IndexedDbMutationRecordRepository } = await import("./agent-run-ledger");
    const { createArchiveMutationPlan, createUpdatePersonOperation, loadArchiveMutationSnapshot } =
      await import("./archive-mutation-plan");
    const { MutationCommitCoordinator } = await import("./mutation-commit-coordinator");
    await facesDb.putPerson(person());
    const initial = await loadArchiveMutationSnapshot(facesDb);
    const plan = createArchiveMutationPlan({
      title: "更新人物",
      reason: "用户批准",
      operations: [
        createUpdatePersonOperation(initial, {
          personId: "person-a",
          reason: "用户批准",
          changes: { set: { note: "前同事" } },
        }),
      ],
    });
    const artifacts = new IndexedDbMutationRecordRepository({ now: () => 100 });
    const interruptedRepository = {
      ...facesDb,
      applyArchiveMutationBatchOnce: async () => {
        throw new Error("simulated refresh before archive transaction");
      },
    };
    const firstPage = new MutationCommitCoordinator({
      repository: interruptedRepository,
      artifactRepository: artifacts,
      now: () => 100,
      scope: "assistant",
    });
    firstPage.enqueue(plan);
    await firstPage.flushPersistence();

    await expect(
      firstPage.commit({
        authorizationMode: "standard",
        signature: { signer: "user", signedAt: 100 },
      }),
    ).rejects.toThrow(/before archive transaction/);
    expect(await facesDb.getArchiveMutationRevision()).toBe(0);
    expect((await facesDb.listPersons()).find((record) => record.id === "person-a")?.note).toBe("");

    const restoredPage = new MutationCommitCoordinator({
      repository: facesDb,
      artifactRepository: new IndexedDbMutationRecordRepository({ now: () => 101 }),
      now: () => 101,
      scope: "assistant",
    });
    await restoredPage.hydrate();

    expect(await facesDb.getArchiveMutationRevision()).toBe(1);
    expect((await facesDb.listPersons()).find((record) => record.id === "person-a")?.note).toBe(
      "前同事",
    );
    expect(restoredPage.pending()).toHaveLength(0);
    expect(restoredPage.committedReceipts()).toHaveLength(1);
  });

  it("uses the archive transaction marker to settle after refresh without applying twice", async () => {
    const { facesDb } = await import("./face-db");
    const { IndexedDbMutationRecordRepository } = await import("./agent-run-ledger");
    const { createArchiveMutationPlan, createUpdatePersonOperation, loadArchiveMutationSnapshot } =
      await import("./archive-mutation-plan");
    const { MutationCommitCoordinator } = await import("./mutation-commit-coordinator");
    await facesDb.putPerson(person());
    const initial = await loadArchiveMutationSnapshot(facesDb);
    const plan = createArchiveMutationPlan({
      title: "更新人物",
      reason: "用户批准",
      operations: [
        createUpdatePersonOperation(initial, {
          personId: "person-a",
          reason: "用户批准",
          changes: { set: { note: "前同事" } },
        }),
      ],
    });
    const artifacts = new IndexedDbMutationRecordRepository({ now: () => 100 });
    const settle = artifacts.settleProposalDecision.bind(artifacts);
    let interruptSettlement = true;
    artifacts.settleProposalDecision = async (input) => {
      if (interruptSettlement) {
        interruptSettlement = false;
        throw new Error("simulated refresh before receipt settlement");
      }
      return settle(input);
    };
    const firstPage = new MutationCommitCoordinator({
      repository: facesDb,
      artifactRepository: artifacts,
      now: () => 100,
      scope: "assistant",
    });
    firstPage.enqueue(plan);
    await firstPage.flushPersistence();

    await expect(
      firstPage.commit({
        authorizationMode: "standard",
        signature: { signer: "user", signedAt: 100 },
      }),
    ).rejects.toThrow(/refresh before receipt settlement/);
    expect(await facesDb.getArchiveMutationRevision()).toBe(1);
    expect((await facesDb.listPersons()).find((record) => record.id === "person-a")?.note).toBe(
      "前同事",
    );

    const restoredArtifacts = new IndexedDbMutationRecordRepository({ now: () => 101 });
    const restoredPage = new MutationCommitCoordinator({
      repository: facesDb,
      artifactRepository: restoredArtifacts,
      now: () => 101,
      scope: "assistant",
    });
    await restoredPage.hydrate();

    expect(await facesDb.getArchiveMutationRevision()).toBe(1);
    expect(restoredPage.pending()).toHaveLength(0);
    expect(restoredPage.committedReceipts()).toHaveLength(1);
    await expect(restoredArtifacts.listProposals({ status: "committed" })).resolves.toHaveLength(1);
  });

  it("allows exactly one of two pages to approve the same proposal", async () => {
    const { facesDb } = await import("./face-db");
    const { IndexedDbMutationRecordRepository } = await import("./agent-run-ledger");
    const { createArchiveMutationPlan, createUpdatePersonOperation, loadArchiveMutationSnapshot } =
      await import("./archive-mutation-plan");
    const { MutationCommitCoordinator } = await import("./mutation-commit-coordinator");
    await facesDb.putPerson(person());
    const initial = await loadArchiveMutationSnapshot(facesDb);
    const plan = createArchiveMutationPlan({
      title: "更新人物",
      reason: "用户批准",
      operations: [
        createUpdatePersonOperation(initial, {
          personId: "person-a",
          reason: "用户批准",
          changes: { set: { note: "前同事" } },
        }),
      ],
    });
    const firstPage = new MutationCommitCoordinator({
      repository: facesDb,
      artifactRepository: new IndexedDbMutationRecordRepository({ now: () => 100 }),
      now: () => 100,
      scope: "assistant",
    });
    firstPage.enqueue(plan);
    await firstPage.flushPersistence();
    const secondPage = new MutationCommitCoordinator({
      repository: facesDb,
      artifactRepository: new IndexedDbMutationRecordRepository({ now: () => 100 }),
      now: () => 100,
      scope: "assistant",
    });
    await secondPage.hydrate();

    const decisions = await Promise.allSettled([
      firstPage.commit({
        authorizationMode: "standard",
        signature: { signer: "user", signedAt: 100 },
      }),
      secondPage.commit({
        authorizationMode: "standard",
        signature: { signer: "user", signedAt: 100 },
      }),
    ]);

    expect(decisions.filter((decision) => decision.status === "fulfilled")).toHaveLength(1);
    expect(decisions.filter((decision) => decision.status === "rejected")).toHaveLength(1);
    expect(await facesDb.getArchiveMutationRevision()).toBe(1);
    expect((await facesDb.listPersons()).find((record) => record.id === "person-a")?.note).toBe(
      "前同事",
    );
    const artifacts = new IndexedDbMutationRecordRepository({ now: () => 101 });
    await expect(artifacts.listReceipts()).resolves.toHaveLength(1);
  });
});
