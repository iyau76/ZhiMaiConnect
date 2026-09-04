import { describe, expect, it } from "vitest";

import {
  normalizeSemanticIntakeTaskSnapshot,
  SemanticIntakeTaskStateMachine,
  transitionSemanticIntakeLifecycle,
  type LegacyReadySemanticIntakeTaskSnapshot,
  type SemanticIntakeTaskSnapshot,
} from "./intake-task-state";

const plan = {
  version: 1 as const,
  type: "semantic_plan" as const,
  tasks: [
    {
      id: "p1",
      domain: "person" as const,
      intent: "create" as const,
      target: { kind: "person" as const, name: "唐悦" },
      changes: {},
    },
    {
      id: "p2",
      domain: "person" as const,
      intent: "update" as const,
      target: { kind: "person" as const, name: "张伟" },
      changes: { title: "设计师" },
    },
  ],
};

function awaitingApproval(): SemanticIntakeTaskSnapshot {
  const state = new SemanticIntakeTaskStateMachine();
  state.acceptPlan(plan);
  state.beginResolution();
  state.markResolved("p1", ["draft:person:p1"]);
  state.markResolved("p2", ["person:zhang"]);
  state.beginProposal();
  state.markProposed("p1", ["draft:person:p1"]);
  state.markProposed("p2", ["person:zhang"]);
  return state.finish();
}

describe("SemanticIntakeTaskStateMachine", () => {
  it("moves one way through UNDERSTAND, DISCOVER, RESOLVE and PROPOSE", () => {
    const state = new SemanticIntakeTaskStateMachine();
    expect(state.snapshot()).toMatchObject({
      phase: "UNDERSTAND",
      nextAction: "request_semantic_plan",
    });
    state.acceptPlan(plan);
    state.markDiscovered("p1");
    state.markDiscovered("p2");
    state.beginResolution();
    state.markResolved("p1", ["draft:person:p1"]);
    state.markNeedsInput("p2", {
      taskId: "p2",
      stage: "RESOLVE",
      code: "ambiguous",
      message: "匹配到两个张伟",
    });
    state.beginProposal();
    state.markProposed("p1", ["draft:person:p1"]);

    expect(state.finish()).toMatchObject({
      phase: "AWAITING_APPROVAL",
      nextAction: "await_approval",
      commit: { proposalRefs: [], receiptRefs: [], commitAttempts: 0 },
    });
  });

  it("does not rewind or reopen a plan after resolution begins", () => {
    const state = new SemanticIntakeTaskStateMachine();
    state.acceptPlan(plan);
    state.beginResolution();

    expect(() => state.acceptPlan(plan)).toThrow("当前为 RESOLVE");
    state.markResolved("p1");
    state.markResolved("p2");
    state.beginProposal();
    expect(() => state.markResolved("p1")).toThrow("当前为 PROPOSE");
  });

  it("links coordinator proposals before recording user approval", () => {
    const awaiting = awaitingApproval();
    const linked = transitionSemanticIntakeLifecycle(awaiting, {
      type: "proposals_enqueued",
      proposalRefs: ["proposal:intake-1"],
    });
    const approved = transitionSemanticIntakeLifecycle(linked, { type: "approve" });

    expect(awaiting.commit.proposalRefs).toEqual([]);
    expect(linked).toMatchObject({
      phase: "AWAITING_APPROVAL",
      commit: { proposalRefs: ["proposal:intake-1"] },
    });
    expect(approved).toMatchObject({ phase: "APPROVED", nextAction: "commit" });
  });

  it("tracks a successful commit by receipt reference", () => {
    const linked = transitionSemanticIntakeLifecycle(awaitingApproval(), {
      type: "proposals_enqueued",
      proposalRefs: ["proposal:intake-1"],
    });
    const approved = transitionSemanticIntakeLifecycle(linked, { type: "approve" });
    const committing = transitionSemanticIntakeLifecycle(approved, { type: "commit_started" });
    const committed = transitionSemanticIntakeLifecycle(committing, {
      type: "commit_succeeded",
      receiptRefs: ["receipt:decision-1"],
    });

    expect(committing).toMatchObject({
      phase: "COMMITTING",
      nextAction: "wait_for_commit",
      commit: { commitAttempts: 1, receiptRefs: [] },
    });
    expect(committed).toMatchObject({
      phase: "COMMITTED",
      nextAction: "complete",
      commit: {
        proposalRefs: ["proposal:intake-1"],
        receiptRefs: ["receipt:decision-1"],
        commitAttempts: 1,
      },
    });
  });

  it("keeps an approved failed commit retryable without duplicating proposal payloads", () => {
    const linked = transitionSemanticIntakeLifecycle(awaitingApproval(), {
      type: "proposals_enqueued",
      proposalRefs: ["proposal:intake-1"],
    });
    const approved = transitionSemanticIntakeLifecycle(linked, { type: "approve" });
    const committing = transitionSemanticIntakeLifecycle(approved, { type: "commit_started" });
    const failed = transitionSemanticIntakeLifecycle(committing, {
      type: "commit_failed",
      message: "上游暂时不可用",
    });
    const retrying = transitionSemanticIntakeLifecycle(failed, { type: "retry_commit" });

    expect(failed).toMatchObject({
      phase: "COMMIT_FAILED",
      nextAction: "retry_commit",
      commit: { commitAttempts: 1, lastError: "上游暂时不可用" },
    });
    expect(retrying).toMatchObject({
      phase: "COMMITTING",
      nextAction: "wait_for_commit",
      commit: { commitAttempts: 2 },
    });
    expect(retrying.commit).not.toHaveProperty("lastError");
    expect(JSON.stringify(retrying)).not.toContain('"plan"');
    expect(JSON.stringify(retrying)).not.toContain('"receipt"');
  });

  it("ends the lifecycle when the user rejects an awaiting proposal", () => {
    const linked = transitionSemanticIntakeLifecycle(awaitingApproval(), {
      type: "proposals_enqueued",
      proposalRefs: ["proposal:intake-1"],
    });
    const rejected = transitionSemanticIntakeLifecycle(linked, { type: "reject" });

    expect(rejected).toMatchObject({
      phase: "REJECTED",
      nextAction: "complete",
      commit: { proposalRefs: ["proposal:intake-1"], receiptRefs: [] },
    });
    expect(() => transitionSemanticIntakeLifecycle(rejected, { type: "approve" })).toThrow(
      "当前为 REJECTED",
    );
  });

  it("allows the user to abandon a proposal after a failed commit", () => {
    let state = transitionSemanticIntakeLifecycle(awaitingApproval(), {
      type: "proposals_enqueued",
      proposalRefs: ["proposal:intake-1"],
    });
    state = transitionSemanticIntakeLifecycle(state, { type: "approve" });
    state = transitionSemanticIntakeLifecycle(state, { type: "commit_started" });
    state = transitionSemanticIntakeLifecycle(state, {
      type: "commit_failed",
      message: "write failed",
    });

    expect(transitionSemanticIntakeLifecycle(state, { type: "reject" }).phase).toBe("REJECTED");
  });

  it("migrates the former READY snapshot to explicit awaiting approval", () => {
    const current = awaitingApproval();
    const legacy: LegacyReadySemanticIntakeTaskSnapshot = {
      phase: "READY",
      tasks: current.tasks,
      issues: current.issues,
      nextAction: "return_proposal",
    };

    expect(normalizeSemanticIntakeTaskSnapshot(legacy)).toMatchObject({
      phase: "AWAITING_APPROVAL",
      nextAction: "await_approval",
      commit: { proposalRefs: [], receiptRefs: [], commitAttempts: 0 },
    });
  });
});
