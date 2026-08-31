import { describe, expect, it } from "vitest";

import { IntakeTaskStateMachine } from "./intake-task-state";

describe("IntakeTaskStateMachine", () => {
  it("accepts typed create/update intent and closes only by task id", () => {
    const state = new IntakeTaskStateMachine({ planRequired: true });
    expect(state.snapshot()).toMatchObject({ phase: "planning", nextAction: "declare_plan" });
    state.acceptPlan({
      type: "plan",
      tasks: [
        {
          id: "p",
          domain: "person",
          intent: "update",
          target: { name: "唐悦" },
          changes: { title: "品牌总监" },
        },
        {
          id: "r",
          domain: "relation",
          intent: "update",
          target: { from: "唐悦", to: "周宁", label: "同事" },
          changes: { label: "前同事" },
        },
        {
          id: "e",
          domain: "event",
          intent: "create",
          target: { title: "会议" },
          changes: { date: "2026-09-02" },
        },
        {
          id: "s",
          domain: "summary",
          intent: "create",
          target: { title: "本次材料概要" },
          changes: { text: "唐悦职位与关系更新" },
        },
      ],
    });
    state.completeTask("p", "person", "person-1");
    state.completeTask("r", "relation", "relation-1");
    state.completeTask("e", "event", "plan:e");
    state.completeTask("s", "summary", "plan:s");
    expect(state.snapshot()).toMatchObject({
      phase: "ready",
      nextAction: "return_staged",
      pendingDomains: [],
    });
    expect(() => state.assertFinalizable()).not.toThrow();
  });

  it("rejects untyped plans and plan-external completion", () => {
    const invalid = new IntakeTaskStateMachine({ planRequired: true });
    expect(() =>
      invalid.acceptPlan({
        type: "plan",
        tasks: [{ id: "p", domain: "person", target: "唐悦", objective: "更新职位" }],
      }),
    ).toThrow("intent");

    const state = new IntakeTaskStateMachine({ planRequired: true });
    state.acceptPlan({
      type: "plan",
      tasks: [
        {
          id: "inside",
          domain: "person",
          intent: "create",
          target: { name: "唐悦" },
          changes: {},
        },
      ],
    });
    expect(() => state.completeTask("outside", "event", "event-1")).toThrow("计划外变更");
  });

  it("rejects an empty plan for non-empty intake work", () => {
    const state = new IntakeTaskStateMachine({ planRequired: true });
    expect(() => state.acceptPlan({ type: "plan", tasks: [] })).toThrow("不能返回空 tasks");
  });

  it("lets the transport token budget, rather than an arbitrary task count, bound complex input", () => {
    const state = new IntakeTaskStateMachine({ planRequired: true });
    const tasks = Array.from({ length: 52 }, (_, index) => ({
      id: `person-${index + 1}`,
      domain: "person",
      intent: "create",
      target: { name: `人物${index + 1}` },
      changes: { note: `第 ${index + 1} 位人物` },
    }));

    expect(() => state.acceptPlan({ type: "plan", tasks })).not.toThrow();
    expect(state.snapshot().tasks).toHaveLength(52);
  });
});
