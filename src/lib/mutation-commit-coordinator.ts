import type { FaceDbArchiveReplacement } from "./face-db";
import { facesDb } from "./face-db";
import type { AgentAuthorizationMode } from "./agent-settings";
import {
  applyArchiveMutationPlan,
  archiveMutationPlanSchema,
  createArchiveMutationPlan,
  loadArchiveMutationSnapshot,
  prepareArchiveMutationPlan,
  type ArchiveMutationDiffRow,
  type ArchiveMutationPlan,
  type ArchiveMutationRepository,
  type ArchiveMutationSnapshot,
} from "./archive-mutation-plan";

export interface MutationCommitRepository extends ArchiveMutationRepository {
  replaceArchiveSnapshot(replacement: FaceDbArchiveReplacement): Promise<void>;
}

export interface MutationProposalEntry {
  id: string;
  plan: ArchiveMutationPlan;
  enqueuedAt: number;
  sourceRunId?: string;
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
  authorizationMode: AgentAuthorizationMode;
  signature: MutationApprovalSignature;
  committedAt: number;
  operationIds: string[];
  diff: ArchiveMutationDiffRow[];
  checkpoint: MutationCheckpoint;
  undoneAt?: number;
}

export interface PreparedMutationCommit {
  plan: ArchiveMutationPlan;
  proposalIds: string[];
  diff: ArchiveMutationDiffRow[];
  checkpoint: MutationCheckpoint;
  containsDeletion: boolean;
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
  private readonly now: () => number;
  private readonly queue: MutationProposalEntry[] = [];
  private readonly receipts: MutationCommitReceipt[] = [];

  constructor(options: { repository?: MutationCommitRepository; now?: () => number } = {}) {
    this.repository = options.repository ?? facesDb;
    this.now = options.now ?? Date.now;
  }

  enqueue(rawPlan: unknown, metadata: { sourceRunId?: string } = {}) {
    const plan = archiveMutationPlanSchema.parse(rawPlan);
    const entry: MutationProposalEntry = {
      id: proposalId(plan.id),
      plan,
      enqueuedAt: this.now(),
      sourceRunId: metadata.sourceRunId,
    };
    this.queue.push(entry);
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
    this.queue.splice(
      0,
      this.queue.length,
      ...this.queue.filter((entry) => !rejected.has(entry.id)),
    );
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
    const plan =
      proposals.length === 1
        ? proposals[0].plan
        : createArchiveMutationPlan(
            {
              title: `${proposals.length} 份 Agent 提案`,
              reason: proposals.map((entry) => entry.plan.reason).join("；"),
              operations: proposals.flatMap((entry) => entry.plan.operations),
            },
            { createdAt: this.now() },
          );
    const snapshot = await loadArchiveMutationSnapshot(this.repository);
    const prepared = prepareArchiveMutationPlan(plan, snapshot, { now: this.now() });
    return {
      plan: prepared.plan,
      proposalIds: proposals.map((entry) => entry.id),
      diff: prepared.diff,
      checkpoint: {
        id: `checkpoint:${crypto.randomUUID()}`,
        createdAt: this.now(),
        snapshot: cloneSnapshot(snapshot),
      },
      containsDeletion: prepared.plan.operations.some(
        (operation) => operation.kind === "delete_person",
      ),
    };
  }

  async commit(options: {
    authorizationMode: AgentAuthorizationMode;
    proposalIds?: string[];
    signature?: MutationApprovalSignature;
  }): Promise<MutationCommitReceipt> {
    const selected = this.select(options.proposalIds);
    if (options.authorizationMode === "cautious" && selected.length !== 1) {
      throw new Error("谨慎模式每次只批准一份提案");
    }
    const prepared = await this.prepare({ proposalIds: selected.map((entry) => entry.id) });
    const automatic = options.authorizationMode === "full" && !prepared.containsDeletion;
    if (!automatic && !options.signature) throw new Error("本次档案变更需要用户签字");
    if (prepared.containsDeletion && options.signature?.signer !== "user") {
      throw new Error("删除人物必须由用户明确签字");
    }
    const signature =
      options.signature ??
      ({ signer: "authorization:full", signedAt: this.now() } satisfies MutationApprovalSignature);

    const applied = await applyArchiveMutationPlan(prepared.plan, {
      repository: this.repository,
      now: this.now(),
    });
    const committedSnapshot = await loadArchiveMutationSnapshot(this.repository);
    const receipt: MutationCommitReceipt = {
      id: `receipt:${crypto.randomUUID()}`,
      planId: applied.planId,
      proposalIds: prepared.proposalIds,
      authorizationMode: options.authorizationMode,
      signature,
      committedAt: applied.appliedAt,
      operationIds: applied.operationIds,
      diff: applied.diff,
      checkpoint: {
        ...prepared.checkpoint,
        committedFingerprint: archiveMutationSnapshotFingerprint(committedSnapshot),
      },
    };
    this.discard(prepared.proposalIds);
    this.receipts.push(receipt);
    return receipt;
  }

  async submitProposal(
    rawPlan: unknown,
    options: { authorizationMode: AgentAuthorizationMode; sourceRunId?: string },
  ): Promise<SubmitProposalResult> {
    const proposal = this.enqueue(rawPlan, { sourceRunId: options.sourceRunId });
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
    const receipt = this.receipts.find((entry) => entry.id === receiptId);
    if (!receipt) throw new Error("找不到这张变更收据");
    if (receipt.undoneAt) throw new Error("这张收据已经撤销");
    const latest = [...this.receipts].reverse().find((entry) => !entry.undoneAt);
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
    return { ...receipt };
  }
}
