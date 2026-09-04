import type {
  ArchiveMutationDecisionApplyResult,
  ArchiveMutationDecisionGuard,
  ArchiveMutationWriteBatch,
  FaceDbArchiveReplacement,
} from "./face-db";
import { facesDb } from "./face-db";
import type { MutationRecordRepository } from "./agent-run-ledger";
import { classifyAgentIssue, type AgentIssueClassification } from "./agent-issue-classifier";
import type { AgentAuthorizationMode } from "./agent-settings";
import {
  archiveMutationPlanSchema,
  createArchiveMutationPlan,
  loadArchiveMutationSnapshot,
  materializeArchiveMutationSnapshot,
  prepareArchiveMutationPlan,
  type ArchiveMutationDiffRow,
  type ArchiveMutationPlan,
  type ArchiveMutationRepository,
  type ArchiveMutationSnapshot,
} from "./archive-mutation-plan";

export interface MutationCommitRepository extends ArchiveMutationRepository {
  replaceArchiveSnapshot(replacement: FaceDbArchiveReplacement): Promise<void>;
  /** Durable exactly-once boundary used when proposals are persisted. */
  applyArchiveMutationBatchOnce(
    batch: ArchiveMutationWriteBatch,
    guard: ArchiveMutationDecisionGuard,
  ): Promise<ArchiveMutationDecisionApplyResult>;
  hasAppliedArchiveMutationDecision(decisionId: string): Promise<boolean>;
  getArchiveMutationRevision(): Promise<number>;
}

export interface MutationProposalEntry {
  id: string;
  plan: ArchiveMutationPlan;
  enqueuedAt: number;
  sourceRunId?: string;
  /** Keeps proposals from independent Agent entrypoints out of each other's queue. */
  scope?: string;
}

export interface MutationApprovalSignature {
  signer: "user" | "authorization:full";
  signedAt: number;
}

export interface MutationCheckpoint {
  id: string;
  createdAt: number;
  snapshot: ArchiveMutationSnapshot;
  /** Compare-and-swap guard: undo may only replace the exact committed archive. */
  committedFingerprint?: string;
}

export interface MutationCommitReceipt {
  id: string;
  planId: string;
  proposalIds: string[];
  sourceRunId?: string;
  scope?: string;
  authorizationMode: AgentAuthorizationMode;
  signature: MutationApprovalSignature;
  committedAt: number;
  operationIds: string[];
  diff: ArchiveMutationDiffRow[];
  checkpoint: MutationCheckpoint;
  undoneAt?: number;
}

export type MutationCommitIssueOperation =
  "hydrate" | "prepare" | "persist_artifacts" | "commit" | "undo";

/** A transaction failure plus the stable run link needed by a ledger adapter. */
export interface MutationCommitIssueEvent extends AgentIssueClassification {
  operation: MutationCommitIssueOperation;
  proposalIds: string[];
  scope?: string;
  receiptId?: string;
}

export type MutationCommitIssueReporter = (event: MutationCommitIssueEvent) => void;

export interface PreparedMutationCommit {
  plan: ArchiveMutationPlan;
  proposalIds: string[];
  diff: ArchiveMutationDiffRow[];
  checkpoint: MutationCheckpoint;
  containsDeletion: boolean;
  batch: ArchiveMutationWriteBatch;
  beforeFingerprint: string;
  afterFingerprint: string;
  archiveRevision: number;
  materializedAt: number;
}

/** Write-ahead record for one signed commit, stored on the proposal-set leader. */
export interface MutationCommitDecisionIntent {
  version: 1;
  decisionId: string;
  kind: "committed";
  proposalIds: string[];
  plan: ArchiveMutationPlan;
  beforeFingerprint: string;
  afterFingerprint: string;
  archiveRevision: number;
  receipt: MutationCommitReceipt;
}

export type SubmitProposalResult =
  | { status: "queued"; proposal: MutationProposalEntry }
  | { status: "committed"; proposal: MutationProposalEntry; receipt: MutationCommitReceipt };

function cloneSnapshot(snapshot: ArchiveMutationSnapshot): ArchiveMutationSnapshot {
  return structuredClone(snapshot);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableValue(item)]),
    );
  }
  return value;
}

/** Stable revision for every durable store replaced by checkpoint undo. */
export function archiveMutationSnapshotFingerprint(snapshot: ArchiveMutationSnapshot) {
  const durable = {
    persons: snapshot.persons,
    assertions: snapshot.assertions,
    evidenceLinks: snapshot.evidenceLinks,
    evidence: snapshot.evidence,
    caseEvents: snapshot.caseEvents,
    viewPreferences: snapshot.viewPreferences,
    referralPolicies: snapshot.referralPolicies,
    lifeEvents: snapshot.lifeEvents,
    reminders: snapshot.reminders,
    tasks: snapshot.tasks,
    projects: snapshot.projects,
    collections: snapshot.collections,
    collectionMemberships: snapshot.collectionMemberships,
  };
  const canonical = JSON.stringify(
    Object.fromEntries(
      Object.entries(durable).map(([key, rows]) => [
        key,
        [...rows]
          .sort((left, right) => left.id.localeCompare(right.id))
          .map((row) => stableValue(row)),
      ]),
    ),
  );
  let hash = 2166136261;
  for (const character of canonical) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `${canonical.length}:${(hash >>> 0).toString(36)}`;
}

function checkpointReplacement(snapshot: ArchiveMutationSnapshot): FaceDbArchiveReplacement {
  return {
    persons: snapshot.persons,
    relationAssertions: snapshot.assertions,
    relationEvidenceLinks: snapshot.evidenceLinks,
    relationViewPreferences: snapshot.viewPreferences,
    referralPolicies: snapshot.referralPolicies,
    collections: snapshot.collections,
    collectionMemberships: snapshot.collectionMemberships,
    evidence: snapshot.evidence,
    caseEvents: snapshot.caseEvents,
    tasks: snapshot.tasks,
    projects: snapshot.projects,
    lifeEvents: snapshot.lifeEvents,
    reminders: snapshot.reminders,
  };
}

function proposalId(planId: string) {
  return `proposal:${planId}:${crypto.randomUUID()}`;
}

function proposalSetKey(proposalIds: readonly string[]) {
  return [...proposalIds].sort().join("\u001f");
}

/**
 * The sole signing boundary for Agent-authored archive mutations.
 *
 * Agents only enqueue plans. This coordinator validates and previews the whole
 * selected queue through archive-mutation-plan, commits it through that same
 * transaction entry, and retains the exact pre-commit archive as the undo
 * checkpoint. Authorization changes when a signature is requested; it never
 * changes validation or persistence code.
 */
export class MutationCommitCoordinator {
  private readonly repository: MutationCommitRepository;
  private readonly artifactRepository?: MutationRecordRepository;
  private readonly now: () => number;
  private readonly scope?: string;
  private readonly acceptLegacyUnscoped: boolean;
  private readonly onIssue?: MutationCommitIssueReporter;
  private readonly queue: MutationProposalEntry[] = [];
  private readonly receipts: MutationCommitReceipt[] = [];
  private readonly persistenceQueue: Array<
    (repository: MutationRecordRepository) => Promise<unknown>
  > = [];
  private readonly activeDecisions = new Map<
    string,
    { id: string; kind: "committed" | "discarded" }
  >();
  private readonly completedDecisions = new Map<string, MutationCommitReceipt>();
  private readonly commitFlights = new Map<string, Promise<MutationCommitReceipt>>();
  private pendingPersistence: Promise<void> | null = null;
  private persistenceFailure: unknown;

  constructor(
    options: {
      repository?: MutationCommitRepository;
      artifactRepository?: MutationRecordRepository;
      now?: () => number;
      scope?: string;
      /** Only the assistant scope adopts proposals written before scoping existed. */
      acceptLegacyUnscoped?: boolean;
      /** Adapter boundary for appending transaction failures to the source Agent run. */
      onIssue?: MutationCommitIssueReporter;
    } = {},
  ) {
    this.repository = options.repository ?? facesDb;
    this.artifactRepository = options.artifactRepository;
    this.now = options.now ?? Date.now;
    this.scope = options.scope;
    this.acceptLegacyUnscoped = options.acceptLegacyUnscoped ?? false;
    this.onIssue = options.onIssue;
  }

  private reportIssue(
    error: unknown,
    operation: MutationCommitIssueOperation,
    proposals: readonly MutationProposalEntry[] = [],
    receipt?: MutationCommitReceipt,
  ) {
    if (!this.onIssue) return;
    const proposalIds = proposals.length
      ? proposals.map((proposal) => proposal.id)
      : (receipt?.proposalIds ?? []);
    const sourceRunIds = [
      ...new Set(
        [...proposals.map((proposal) => proposal.sourceRunId), receipt?.sourceRunId].filter(
          (value): value is string => Boolean(value),
        ),
      ),
    ];
    const targets: Array<string | undefined> = sourceRunIds.length ? sourceRunIds : [undefined];
    for (const sourceRunId of targets) {
      const classification = classifyAgentIssue(error, {
        phase: "transaction",
        operation,
        ...(sourceRunId ? { sourceRunId } : {}),
      });
      this.onIssue({
        ...classification,
        operation,
        proposalIds: [...proposalIds],
        ...(this.scope ? { scope: this.scope } : {}),
        ...(receipt ? { receiptId: receipt.id } : {}),
      });
    }
  }

  private persist(operation: (repository: MutationRecordRepository) => Promise<unknown>) {
    if (!this.artifactRepository) return;
    this.persistenceQueue.push(operation);
    if (!this.persistenceFailure) this.startPersistence();
  }

  private startPersistence() {
    if (!this.artifactRepository || this.pendingPersistence || !this.persistenceQueue.length) {
      return this.pendingPersistence ?? Promise.resolve();
    }
    const run = (async () => {
      while (this.persistenceQueue.length) {
        await this.persistenceQueue[0](this.artifactRepository!);
        this.persistenceQueue.shift();
      }
    })();
    this.pendingPersistence = run;
    void run.then(
      () => {
        if (this.pendingPersistence === run) this.pendingPersistence = null;
      },
      (error) => {
        if (this.pendingPersistence === run) this.pendingPersistence = null;
        this.persistenceFailure = error;
      },
    );
    return run;
  }

  async flushPersistence(options: { reportIssue?: boolean } = {}) {
    if (!this.artifactRepository) return;
    try {
      if (this.persistenceFailure) {
        const failure = this.persistenceFailure;
        this.persistenceFailure = undefined;
        throw failure;
      }
      await this.startPersistence();
    } catch (error) {
      if (this.persistenceFailure === error) this.persistenceFailure = undefined;
      if (options.reportIssue !== false) {
        this.reportIssue(error, "persist_artifacts", this.queue);
      }
      throw error;
    }
  }

  private decisionFor(proposalIds: readonly string[], kind: "committed" | "discarded") {
    const key = proposalSetKey(proposalIds);
    const direct = this.activeDecisions.get(key);
    const inherited = proposalIds
      .map((id) => this.activeDecisions.get(proposalSetKey([id])))
      .filter((decision): decision is { id: string; kind: "committed" | "discarded" } =>
        Boolean(decision),
      );
    const existing =
      direct ??
      (inherited.length === proposalIds.length &&
      inherited.every(
        (decision) => decision.id === inherited[0].id && decision.kind === inherited[0].kind,
      )
        ? inherited[0]
        : undefined);
    if (existing) {
      if (existing.kind !== kind) {
        throw new Error("这组提案已经进入另一项批准决定");
      }
      this.activeDecisions.set(key, existing);
      return existing;
    }
    const decision = { id: `decision:${crypto.randomUUID()}`, kind };
    this.activeDecisions.set(key, decision);
    proposalIds.forEach((id) => this.activeDecisions.set(proposalSetKey([id]), decision));
    return decision;
  }

  private finishDecision(proposalIds: readonly string[], receipt?: MutationCommitReceipt) {
    const key = proposalSetKey(proposalIds);
    this.activeDecisions.delete(key);
    proposalIds.forEach((id) => this.activeDecisions.delete(proposalSetKey([id])));
    if (receipt) this.completedDecisions.set(key, receipt);
  }

  private async listScopedProposals() {
    if (!this.artifactRepository) return [];
    const scoped = await this.artifactRepository.listProposals({
      status: "pending",
      scope: this.scope ?? null,
    });
    if (!this.scope || !this.acceptLegacyUnscoped) return scoped;
    const legacy = await this.artifactRepository.listProposals({ status: "pending", scope: null });
    return [...new Map([...scoped, ...legacy].map((proposal) => [proposal.id, proposal])).values()];
  }

  private async listScopedReceipts() {
    if (!this.artifactRepository) return [];
    const scoped = await this.artifactRepository.listReceipts({ scope: this.scope ?? null });
    if (!this.scope || !this.acceptLegacyUnscoped) return scoped;
    const legacy = await this.artifactRepository.listReceipts({ scope: null });
    return [...new Map([...scoped, ...legacy].map((receipt) => [receipt.id, receipt])).values()];
  }

  private finishLocalCommit(input: {
    proposalIds: readonly string[];
    receipt: MutationCommitReceipt;
  }) {
    this.queue.splice(
      0,
      this.queue.length,
      ...this.queue.filter((entry) => !input.proposalIds.includes(entry.id)),
    );
    if (!this.receipts.some((entry) => entry.id === input.receipt.id)) {
      this.receipts.push(input.receipt);
    }
    this.finishDecision(input.proposalIds, input.receipt);
  }

  private async settleCommittedDecision(intent: MutationCommitDecisionIntent) {
    if (!this.artifactRepository) throw new Error("持久化提案缺少事务记录库");
    await this.artifactRepository.settleProposalDecision({
      proposalIds: intent.proposalIds,
      decisionId: intent.decisionId,
      decisionKind: "committed",
      decidedAt: intent.receipt.committedAt,
      receipt: intent.receipt,
    });
    this.finishLocalCommit(intent);
    return intent.receipt;
  }

  private async reconcileCommittedDecision(intent: MutationCommitDecisionIntent) {
    if (!this.artifactRepository) throw new Error("持久化提案缺少事务记录库");
    if (await this.repository.hasAppliedArchiveMutationDecision(intent.decisionId)) {
      return this.settleCommittedDecision(intent);
    }

    const current = await loadArchiveMutationSnapshot(this.repository);
    if (archiveMutationSnapshotFingerprint(current) !== intent.beforeFingerprint) {
      try {
        await this.artifactRepository.releaseProposalDecision({
          proposalIds: intent.proposalIds,
          decisionId: intent.decisionId,
          releasedAt: this.now(),
          requireArchiveDecisionUnapplied: true,
        });
        this.finishDecision(intent.proposalIds);
        return undefined;
      } catch (error) {
        if (await this.repository.hasAppliedArchiveMutationDecision(intent.decisionId)) {
          return this.settleCommittedDecision(intent);
        }
        throw error;
      }
    }

    const prepared = prepareArchiveMutationPlan(intent.plan, intent.receipt.checkpoint.snapshot, {
      now: intent.receipt.committedAt,
    });
    const expected = materializeArchiveMutationSnapshot(
      intent.receipt.checkpoint.snapshot,
      prepared.batch,
    );
    if (archiveMutationSnapshotFingerprint(expected) !== intent.afterFingerprint) {
      throw new Error("批准决定的目标档案与持久化指纹不一致");
    }
    try {
      const result = await this.repository.applyArchiveMutationBatchOnce(prepared.batch, {
        decisionId: intent.decisionId,
        proposalIds: intent.proposalIds,
        expectedRevision: intent.archiveRevision,
      });
      if (result === "conflict") {
        await this.artifactRepository.releaseProposalDecision({
          proposalIds: intent.proposalIds,
          decisionId: intent.decisionId,
          releasedAt: this.now(),
          requireArchiveDecisionUnapplied: true,
        });
        this.finishDecision(intent.proposalIds);
        return undefined;
      }
    } catch (error) {
      if (await this.repository.hasAppliedArchiveMutationDecision(intent.decisionId)) {
        return this.settleCommittedDecision(intent);
      }
      throw error;
    }
    return this.settleCommittedDecision(intent);
  }

  private commitIntentFrom(
    proposals: Array<{
      id: string;
      decisionId?: string;
      decisionKind?: "committed" | "discarded";
      decisionIntent?: MutationCommitDecisionIntent;
    }>,
  ) {
    const decisionIds = new Set(proposals.map((proposal) => proposal.decisionId).filter(Boolean));
    if (decisionIds.size !== 1) return undefined;
    const intent = proposals.find((proposal) => proposal.decisionIntent)?.decisionIntent;
    if (!intent || intent.decisionId !== [...decisionIds][0]) return undefined;
    if (
      JSON.stringify([...intent.proposalIds].sort()) !==
      JSON.stringify(proposals.map((proposal) => proposal.id).sort())
    ) {
      return undefined;
    }
    return intent;
  }

  /** Restore unsigned work and undo receipts before the owning page renders. */
  async hydrate() {
    try {
      return await this.hydrateArtifacts();
    } catch (error) {
      this.reportIssue(error, "hydrate", this.queue);
      throw error;
    }
  }

  private async hydrateArtifacts() {
    if (!this.artifactRepository)
      return { proposals: this.pending(), receipts: this.committedReceipts() };
    await this.flushPersistence({ reportIssue: false });
    let proposals = await this.listScopedProposals();
    const claimedGroups = new Map<string, typeof proposals>();
    for (const proposal of proposals) {
      if (!proposal.decisionId || !proposal.decisionKind) continue;
      claimedGroups.set(proposal.decisionId, [
        ...(claimedGroups.get(proposal.decisionId) ?? []),
        proposal,
      ]);
    }
    for (const group of claimedGroups.values()) {
      if (group[0].decisionKind === "discarded") {
        await this.artifactRepository.settleProposalDecision({
          proposalIds: group.map((proposal) => proposal.id),
          decisionId: group[0].decisionId!,
          decisionKind: "discarded",
          decidedAt: group[0].decisionClaimedAt ?? this.now(),
        });
        continue;
      }
      const intent = this.commitIntentFrom(group);
      if (!intent) {
        // Pre-intent records cannot prove whether the old process crossed its
        // write boundary. Release them for a fresh preview; operation
        // preconditions prevent an already-applied legacy plan from replaying.
        await this.artifactRepository.releaseProposalDecision({
          proposalIds: group.map((proposal) => proposal.id),
          decisionId: group[0].decisionId!,
          releasedAt: this.now(),
          requireArchiveDecisionUnapplied: true,
        });
        continue;
      }
      await this.reconcileCommittedDecision(intent);
    }
    proposals = await this.listScopedProposals();
    const receipts = await this.listScopedReceipts();
    this.queue.splice(
      0,
      this.queue.length,
      ...proposals.sort((left, right) => left.enqueuedAt - right.enqueuedAt),
    );
    this.activeDecisions.clear();
    for (const proposal of proposals) {
      if (proposal.decisionId && proposal.decisionKind) {
        this.activeDecisions.set(proposalSetKey([proposal.id]), {
          id: proposal.decisionId,
          kind: proposal.decisionKind,
        });
      }
    }
    this.receipts.splice(
      0,
      this.receipts.length,
      ...receipts.sort(
        (left, right) => left.committedAt - right.committedAt || left.id.localeCompare(right.id),
      ),
    );
    return { proposals: this.pending(), receipts: this.committedReceipts() };
  }

  enqueue(rawPlan: unknown, metadata: { sourceRunId?: string } = {}) {
    const plan = archiveMutationPlanSchema.parse(rawPlan);
    const entry: MutationProposalEntry = {
      id: proposalId(plan.id),
      plan,
      enqueuedAt: this.now(),
      sourceRunId: metadata.sourceRunId,
      scope: this.scope,
    };
    this.queue.push(entry);
    this.persist((repository) => repository.putProposal(entry));
    return entry;
  }

  pending() {
    return [...this.queue];
  }

  committedReceipts() {
    return [...this.receipts];
  }

  discard(proposalIds: string[]) {
    const rejected = new Set(proposalIds);
    const discarded = this.queue.filter((entry) => rejected.has(entry.id));
    if (!discarded.length) return discarded;
    const ids = discarded.map((entry) => entry.id);
    if (!this.artifactRepository) {
      this.queue.splice(
        0,
        this.queue.length,
        ...this.queue.filter((entry) => !rejected.has(entry.id)),
      );
      return discarded;
    }
    const decision = this.decisionFor(ids, "discarded");
    const decidedAt = this.now();
    this.persist(async (repository) => {
      await repository.claimProposalDecision({
        proposalIds: ids,
        decisionId: decision.id,
        decisionKind: "discarded",
        claimedAt: decidedAt,
      });
      await repository.settleProposalDecision({
        proposalIds: ids,
        decisionId: decision.id,
        decisionKind: "discarded",
        decidedAt,
      });
      this.queue.splice(
        0,
        this.queue.length,
        ...this.queue.filter((entry) => !rejected.has(entry.id)),
      );
      this.finishDecision(ids);
    });
    return discarded;
  }

  private select(proposalIds?: string[]) {
    if (!this.queue.length) throw new Error("没有待提交的档案提案");
    if (!proposalIds?.length) return [...this.queue];
    const selectedIds = new Set(proposalIds);
    const selected = this.queue.filter((entry) => selectedIds.has(entry.id));
    if (selected.length !== selectedIds.size) throw new Error("待提交队列中不存在指定提案");
    return selected;
  }

  async prepare(options: { proposalIds?: string[] } = {}): Promise<PreparedMutationCommit> {
    const proposals = this.select(options.proposalIds);
    try {
      return await this.prepareSelected(proposals);
    } catch (error) {
      this.reportIssue(error, "prepare", proposals);
      throw error;
    }
  }

  private async prepareSelected(
    proposals: MutationProposalEntry[],
  ): Promise<PreparedMutationCommit> {
    const materializedAt = this.now();
    const plan =
      proposals.length === 1
        ? proposals[0].plan
        : createArchiveMutationPlan(
            {
              title: `${proposals.length} 份 Agent 提案`,
              reason: proposals.map((entry) => entry.plan.reason).join("；"),
              operations: proposals.flatMap((entry) => entry.plan.operations),
            },
            { createdAt: materializedAt },
          );
    const [snapshot, archiveRevision] = await Promise.all([
      loadArchiveMutationSnapshot(this.repository),
      this.repository.getArchiveMutationRevision(),
    ]);
    const prepared = prepareArchiveMutationPlan(plan, snapshot, { now: materializedAt });
    const materialized = materializeArchiveMutationSnapshot(snapshot, prepared.batch);
    return {
      plan: prepared.plan,
      proposalIds: proposals.map((entry) => entry.id),
      diff: prepared.diff,
      checkpoint: {
        id: `checkpoint:${crypto.randomUUID()}`,
        createdAt: materializedAt,
        snapshot: cloneSnapshot(snapshot),
      },
      containsDeletion: prepared.plan.operations.some(
        (operation) => operation.kind === "delete_person",
      ),
      batch: prepared.batch,
      beforeFingerprint: archiveMutationSnapshotFingerprint(snapshot),
      afterFingerprint: archiveMutationSnapshotFingerprint(materialized),
      archiveRevision,
      materializedAt,
    };
  }

  async commit(options: {
    authorizationMode: AgentAuthorizationMode;
    proposalIds?: string[];
    signature?: MutationApprovalSignature;
  }): Promise<MutationCommitReceipt> {
    const selected = this.select(options.proposalIds);
    const selectionKey = proposalSetKey(selected.map((entry) => entry.id));
    const inFlight = this.commitFlights.get(selectionKey);
    if (inFlight) return inFlight;
    const commit = this.commitSelected(selected, selectionKey, options);
    this.commitFlights.set(selectionKey, commit);
    try {
      return await commit;
    } catch (error) {
      this.reportIssue(error, "commit", selected);
      throw error;
    } finally {
      if (this.commitFlights.get(selectionKey) === commit) {
        this.commitFlights.delete(selectionKey);
      }
    }
  }

  private async commitSelected(
    selected: MutationProposalEntry[],
    selectionKey: string,
    options: {
      authorizationMode: AgentAuthorizationMode;
      signature?: MutationApprovalSignature;
    },
  ): Promise<MutationCommitReceipt> {
    await this.flushPersistence({ reportIssue: false });
    const completed = this.completedDecisions.get(selectionKey);
    if (completed) {
      this.completedDecisions.delete(selectionKey);
      return { ...completed };
    }
    if (this.artifactRepository) {
      const persisted = (
        await Promise.all(
          selected.map((proposal) => this.artifactRepository!.getProposal(proposal.id)),
        )
      ).filter((proposal): proposal is NonNullable<typeof proposal> => Boolean(proposal));
      if (persisted.length !== selected.length) throw new Error("待提交提案的持久化记录不完整");
      if (persisted.every((proposal) => proposal.status === "committed")) {
        const receiptIds = new Set(persisted.map((proposal) => proposal.receiptId).filter(Boolean));
        if (receiptIds.size !== 1) throw new Error("已提交提案缺少唯一收据");
        const receipt = await this.artifactRepository.getReceipt([...receiptIds][0]!);
        if (!receipt) throw new Error("已提交提案的收据不存在");
        this.finishLocalCommit({
          proposalIds: persisted.map((proposal) => proposal.id),
          receipt,
        });
        return receipt;
      }
      if (persisted.some((proposal) => proposal.status === "discarded")) {
        throw new Error("这组提案已经被舍弃");
      }
      if (persisted.every((proposal) => proposal.decisionId)) {
        const intent = this.commitIntentFrom(persisted);
        if (!intent) throw new Error("这组提案正在执行另一项批准决定");
        const recovered = await this.reconcileCommittedDecision(intent);
        if (recovered) return recovered;
        throw new Error("档案在批准前已变化，请重新预览");
      }
    }
    if (options.authorizationMode === "cautious" && selected.length !== 1) {
      throw new Error("谨慎模式每次只批准一份提案");
    }
    const prepared = await this.prepareSelected(selected);
    const automatic = options.authorizationMode === "full" && !prepared.containsDeletion;
    if (!automatic && !options.signature) throw new Error("本次档案变更需要用户签字");
    if (prepared.containsDeletion && options.signature?.signer !== "user") {
      throw new Error("删除人物必须由用户明确签字");
    }
    const signature =
      options.signature ??
      ({ signer: "authorization:full", signedAt: this.now() } satisfies MutationApprovalSignature);

    const decision = this.artifactRepository
      ? this.decisionFor(prepared.proposalIds, "committed")
      : undefined;
    const committedAt = prepared.materializedAt;
    const receipt: MutationCommitReceipt = {
      id: decision ? `receipt:${decision.id}` : `receipt:${crypto.randomUUID()}`,
      planId: prepared.plan.id,
      proposalIds: [...prepared.proposalIds].sort(),
      sourceRunId: selected.map((entry) => entry.sourceRunId).find(Boolean),
      scope: this.scope,
      authorizationMode: options.authorizationMode,
      signature,
      committedAt,
      operationIds: prepared.plan.operations.map((operation) => operation.id),
      diff: prepared.diff,
      checkpoint: {
        ...prepared.checkpoint,
        committedFingerprint: prepared.afterFingerprint,
      },
    };
    if (decision && this.artifactRepository) {
      const intent: MutationCommitDecisionIntent = {
        version: 1,
        decisionId: decision.id,
        kind: "committed",
        proposalIds: receipt.proposalIds,
        plan: prepared.plan,
        beforeFingerprint: prepared.beforeFingerprint,
        afterFingerprint: prepared.afterFingerprint,
        archiveRevision: prepared.archiveRevision,
        receipt,
      };
      await this.artifactRepository.claimProposalDecision({
        proposalIds: intent.proposalIds,
        decisionId: decision.id,
        decisionKind: "committed",
        intent,
        claimedAt: committedAt,
      });
      return this.reconcileCommittedDecision(intent).then((recovered) => {
        if (!recovered) throw new Error("档案在批准前已变化，请重新预览");
        return recovered;
      });
    }

    await this.repository.applyArchiveMutationBatch(prepared.batch);
    const finishLocalCommit = () => {
      this.queue.splice(
        0,
        this.queue.length,
        ...this.queue.filter((entry) => !prepared.proposalIds.includes(entry.id)),
      );
      if (!this.receipts.some((entry) => entry.id === receipt.id)) this.receipts.push(receipt);
      this.finishDecision(prepared.proposalIds, receipt);
    };
    finishLocalCommit();
    return receipt;
  }

  async submitProposal(
    rawPlan: unknown,
    options: { authorizationMode: AgentAuthorizationMode; sourceRunId?: string },
  ): Promise<SubmitProposalResult> {
    const proposal = this.enqueue(rawPlan, { sourceRunId: options.sourceRunId });
    try {
      await this.flushPersistence({ reportIssue: false });
    } catch (error) {
      this.reportIssue(error, "persist_artifacts", [proposal]);
      throw error;
    }
    const containsDeletion = proposal.plan.operations.some(
      (operation) => operation.kind === "delete_person",
    );
    if (options.authorizationMode !== "full" || containsDeletion) {
      return { status: "queued", proposal };
    }
    const receipt = await this.commit({
      authorizationMode: "full",
      proposalIds: [proposal.id],
    });
    return { status: "committed", proposal, receipt };
  }

  async undo(receiptId: string) {
    let receipt: MutationCommitReceipt | undefined;
    try {
      receipt = this.receipts.find((entry) => entry.id === receiptId);
      if (!receipt) throw new Error("找不到这张变更收据");
      if (receipt.undoneAt) throw new Error("这张收据已经撤销");
      const latest = this.receipts
        .filter((entry) => !entry.undoneAt)
        .sort(
          (left, right) => right.committedAt - left.committedAt || right.id.localeCompare(left.id),
        )[0];
      if (latest?.id !== receipt.id) throw new Error("请先撤销更新的变更收据");
      const current = await loadArchiveMutationSnapshot(this.repository);
      if (
        !receipt.checkpoint.committedFingerprint ||
        archiveMutationSnapshotFingerprint(current) !== receipt.checkpoint.committedFingerprint
      ) {
        throw new Error("档案在本次提交后又发生了变化，已停止整库覆盖；请先处理后续变更");
      }
      await this.repository.replaceArchiveSnapshot(
        checkpointReplacement(cloneSnapshot(receipt.checkpoint.snapshot)),
      );
      receipt.undoneAt = this.now();
      const persistedReceipt = receipt;
      this.persist((repository) => repository.putReceipt(persistedReceipt));
      await this.flushPersistence({ reportIssue: false });
      return { ...receipt };
    } catch (error) {
      this.reportIssue(error, "undo", [], receipt);
      throw error;
    }
  }
}
