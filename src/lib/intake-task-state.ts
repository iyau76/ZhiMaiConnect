import type { SemanticIntakePlan, SemanticIntakeTask } from "./intake-semantic-plan";

export type SemanticIntakePhase =
  | "UNDERSTAND"
  | "DISCOVER"
  | "RESOLVE"
  | "PROPOSE"
  | "AWAITING_APPROVAL"
  | "APPROVED"
  | "COMMITTING"
  | "COMMIT_FAILED"
  | "COMMITTED"
  | "REJECTED";

export type SemanticIntakeTaskStatus =
  "declared" | "discovered" | "resolved" | "proposed" | "needs_input";

export interface SemanticIntakeIssue {
  taskId?: string;
  stage: "UNDERSTAND" | "DISCOVER" | "RESOLVE" | "PROPOSE";
  code: "invalid" | "missing" | "ambiguous" | "unsupported" | "compile";
  message: string;
  path?: string;
  candidates?: Array<{ id: string; label: string }>;
}

export interface SemanticIntakeTaskProgress {
  task: SemanticIntakeTask;
  status: SemanticIntakeTaskStatus;
  targetIds: string[];
  issues: SemanticIntakeIssue[];
}

export interface SemanticIntakeTaskSnapshot {
  phase: SemanticIntakePhase;
  tasks: SemanticIntakeTaskProgress[];
  issues: SemanticIntakeIssue[];
  nextAction:
    | "request_semantic_plan"
    | "discover"
    | "resolve"
    | "propose"
    | "await_approval"
    | "commit"
    | "wait_for_commit"
    | "retry_commit"
    | "complete";
  commit: SemanticIntakeCommitLifecycle;
}

/**
 * Durable execution references for the approval boundary. Proposal and receipt
 * payloads remain owned by MutationCommitCoordinator and its ledger.
 */
export interface SemanticIntakeCommitLifecycle {
  proposalRefs: string[];
  receiptRefs: string[];
  commitAttempts: number;
  lastError?: string;
}

export interface LegacyReadySemanticIntakeTaskSnapshot extends Omit<
  SemanticIntakeTaskSnapshot,
  "phase" | "nextAction" | "commit"
> {
  phase: "READY";
  nextAction: "return_proposal";
  commit?: undefined;
}

export type RestorableSemanticIntakeTaskSnapshot =
  SemanticIntakeTaskSnapshot | LegacyReadySemanticIntakeTaskSnapshot;

export type SemanticIntakeLifecycleEvent =
  | { type: "proposals_enqueued"; proposalRefs: readonly string[] }
  | { type: "approve" }
  | { type: "commit_started" }
  | { type: "commit_succeeded"; receiptRefs: readonly string[] }
  | { type: "commit_failed"; message: string }
  | { type: "retry_commit" }
  | { type: "reject" };

function uniqueRefs(refs: readonly string[], label: string) {
  const unique = [...new Set(refs.map((ref) => ref.trim()).filter(Boolean))];
  if (!unique.length) throw new Error(`${label}不能为空`);
  return unique;
}

function sameRefs(left: readonly string[], right: readonly string[]) {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((ref, index) => ref === sortedRight[index]);
}

/**
 * One-way orchestration for intake. The model is used only in UNDERSTAND;
 * discovery, ID resolution and proposal compilation are deterministic local
 * phases. Individual failures become needs_input rows instead of rewinding the
 * whole plan.
 */
export class SemanticIntakeTaskStateMachine {
  private phase: SemanticIntakePhase = "UNDERSTAND";
  private progress = new Map<string, SemanticIntakeTaskProgress>();
  private issues: SemanticIntakeIssue[] = [];
  private commitLifecycle: SemanticIntakeCommitLifecycle = {
    proposalRefs: [],
    receiptRefs: [],
    commitAttempts: 0,
  };

  static restore(snapshot: RestorableSemanticIntakeTaskSnapshot) {
    const machine = new SemanticIntakeTaskStateMachine();
    machine.phase = snapshot.phase === "READY" ? "AWAITING_APPROVAL" : snapshot.phase;
    machine.progress = new Map(
      snapshot.tasks.map((progress) => [
        progress.task.id,
        {
          ...structuredClone(progress),
          targetIds: [...progress.targetIds],
          issues: structuredClone(progress.issues),
        },
      ]),
    );
    machine.issues = structuredClone(snapshot.issues);
    machine.commitLifecycle =
      snapshot.phase === "READY"
        ? { proposalRefs: [], receiptRefs: [], commitAttempts: 0 }
        : {
            ...structuredClone(snapshot.commit),
            proposalRefs: [...snapshot.commit.proposalRefs],
            receiptRefs: [...snapshot.commit.receiptRefs],
          };
    return machine;
  }

  acceptPlan(plan: SemanticIntakePlan, planIssues: SemanticIntakeIssue[] = []) {
    this.expectPhase("UNDERSTAND");
    this.progress = new Map(
      plan.tasks.map((task) => [
        task.id,
        { task, status: "declared" as const, targetIds: [], issues: [] },
      ]),
    );
    this.issues.push(...planIssues);
    this.phase = "DISCOVER";
    return this.snapshot();
  }

  markDiscovered(taskId: string) {
    this.expectPhase("DISCOVER");
    this.task(taskId).status = "discovered";
  }

  beginResolution() {
    this.expectPhase("DISCOVER");
    for (const progress of this.progress.values()) {
      if (progress.status === "declared") progress.status = "discovered";
    }
    this.phase = "RESOLVE";
    return this.snapshot();
  }

  markResolved(taskId: string, targetIds: readonly string[] = []) {
    this.expectPhase("RESOLVE");
    const progress = this.task(taskId);
    progress.status = "resolved";
    progress.targetIds = [...targetIds];
  }

  markNeedsInput(taskId: string, issue: SemanticIntakeIssue) {
    if (this.phase !== "RESOLVE" && this.phase !== "PROPOSE") {
      throw new Error(`只能在 RESOLVE 或 PROPOSE 阶段记录待消歧项，当前为 ${this.phase}`);
    }
    const progress = this.task(taskId);
    progress.status = "needs_input";
    progress.issues.push(issue);
    this.issues.push(issue);
  }

  addTaskIssue(taskId: string, issue: SemanticIntakeIssue) {
    const progress = this.task(taskId);
    progress.issues.push(issue);
    this.issues.push(issue);
  }

  beginProposal() {
    this.expectPhase("RESOLVE");
    const unresolved = [...this.progress.values()].filter(
      (progress) => progress.status === "declared" || progress.status === "discovered",
    );
    if (unresolved.length) {
      throw new Error(`尚有任务未解析：${unresolved.map((item) => item.task.id).join("、")}`);
    }
    this.phase = "PROPOSE";
    return this.snapshot();
  }

  markProposed(taskId: string, targetIds: readonly string[] = []) {
    this.expectPhase("PROPOSE");
    const progress = this.task(taskId);
    if (progress.status !== "resolved") {
      throw new Error(`任务 ${taskId} 尚未解析，不能生成提案`);
    }
    progress.status = "proposed";
    progress.targetIds = [...targetIds];
  }

  finish() {
    this.expectPhase("PROPOSE");
    const incomplete = [...this.progress.values()].filter(
      (progress) => progress.status !== "proposed" && progress.status !== "needs_input",
    );
    if (incomplete.length) {
      throw new Error(`尚有任务未形成提案：${incomplete.map((item) => item.task.id).join("、")}`);
    }
    this.phase = "AWAITING_APPROVAL";
    return this.snapshot();
  }

  linkProposals(proposalRefs: readonly string[]) {
    this.expectPhase("AWAITING_APPROVAL");
    const refs = uniqueRefs(proposalRefs, "待批准提案引用");
    if (this.commitLifecycle.proposalRefs.length) {
      if (sameRefs(this.commitLifecycle.proposalRefs, refs)) return this.snapshot();
      throw new Error("当前录入任务已经关联另一组待批准提案");
    }
    this.commitLifecycle.proposalRefs = refs;
    return this.snapshot();
  }

  approve() {
    this.expectPhase("AWAITING_APPROVAL");
    if (!this.commitLifecycle.proposalRefs.length) {
      throw new Error("录入任务尚未关联 MutationCommitCoordinator 提案");
    }
    this.phase = "APPROVED";
    return this.snapshot();
  }

  beginCommit() {
    this.expectPhase("APPROVED");
    this.phase = "COMMITTING";
    this.commitLifecycle.commitAttempts += 1;
    delete this.commitLifecycle.lastError;
    return this.snapshot();
  }

  markCommitSucceeded(receiptRefs: readonly string[]) {
    this.expectPhase("COMMITTING");
    this.commitLifecycle.receiptRefs = uniqueRefs(receiptRefs, "提交收据引用");
    delete this.commitLifecycle.lastError;
    this.phase = "COMMITTED";
    return this.snapshot();
  }

  markCommitFailed(message: string) {
    this.expectPhase("COMMITTING");
    const error = message.trim();
    if (!error) throw new Error("提交失败原因不能为空");
    this.commitLifecycle.lastError = error;
    this.phase = "COMMIT_FAILED";
    return this.snapshot();
  }

  retryCommit() {
    this.expectPhase("COMMIT_FAILED");
    delete this.commitLifecycle.lastError;
    this.commitLifecycle.commitAttempts += 1;
    this.phase = "COMMITTING";
    return this.snapshot();
  }

  reject() {
    if (this.phase !== "AWAITING_APPROVAL" && this.phase !== "COMMIT_FAILED") {
      throw new Error(`录入状态机当前为 ${this.phase}，不能放弃提案`);
    }
    this.phase = "REJECTED";
    return this.snapshot();
  }

  snapshot(): SemanticIntakeTaskSnapshot {
    const nextAction =
      this.phase === "UNDERSTAND"
        ? "request_semantic_plan"
        : this.phase === "DISCOVER"
          ? "discover"
          : this.phase === "RESOLVE"
            ? "resolve"
            : this.phase === "PROPOSE"
              ? "propose"
              : this.phase === "AWAITING_APPROVAL"
                ? "await_approval"
                : this.phase === "APPROVED"
                  ? "commit"
                  : this.phase === "COMMITTING"
                    ? "wait_for_commit"
                    : this.phase === "COMMIT_FAILED"
                      ? "retry_commit"
                      : "complete";
    return {
      phase: this.phase,
      tasks: [...this.progress.values()].map((progress) => ({
        ...progress,
        targetIds: [...progress.targetIds],
        issues: [...progress.issues],
      })),
      issues: [...this.issues],
      nextAction,
      commit: {
        ...this.commitLifecycle,
        proposalRefs: [...this.commitLifecycle.proposalRefs],
        receiptRefs: [...this.commitLifecycle.receiptRefs],
      },
    };
  }

  private task(taskId: string) {
    const progress = this.progress.get(taskId);
    if (!progress) throw new Error(`语义计划中不存在任务 ${taskId}`);
    return progress;
  }

  private expectPhase(expected: SemanticIntakePhase) {
    if (this.phase !== expected) {
      throw new Error(`录入状态机当前为 ${this.phase}，不能执行 ${expected} 阶段动作`);
    }
  }
}

/** Pure reducer used by UI or durable run code without retaining a class instance. */
export function transitionSemanticIntakeLifecycle(
  snapshot: RestorableSemanticIntakeTaskSnapshot,
  event: SemanticIntakeLifecycleEvent,
) {
  const machine = SemanticIntakeTaskStateMachine.restore(snapshot);
  switch (event.type) {
    case "proposals_enqueued":
      return machine.linkProposals(event.proposalRefs);
    case "approve":
      return machine.approve();
    case "commit_started":
      return machine.beginCommit();
    case "commit_succeeded":
      return machine.markCommitSucceeded(event.receiptRefs);
    case "commit_failed":
      return machine.markCommitFailed(event.message);
    case "retry_commit":
      return machine.retryCommit();
    case "reject":
      return machine.reject();
  }
}

/** Normalize the former READY snapshot at the persistence boundary. */
export function normalizeSemanticIntakeTaskSnapshot(
  snapshot: RestorableSemanticIntakeTaskSnapshot,
) {
  return SemanticIntakeTaskStateMachine.restore(snapshot).snapshot();
}
