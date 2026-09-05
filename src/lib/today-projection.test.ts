import { describe, expect, it } from "vitest";

import type { AgentRunRecord, PersistedMutationProposalRecord } from "./agent-run-ledger";
import type { LifeEventRecord, PersonRecord, ReminderRecord, TaskRecord } from "./face-db";
import { projectToday } from "./today-projection";

const now = Date.parse("2026-09-05T08:00:00+08:00");
const person: PersonRecord = {
  id: "person-tang",
  name: "唐悦",
  note: "",
  profile: { birthday: "09-06" },
  descriptors: [],
  thumb: "",
  createdAt: now,
};
const events: LifeEventRecord[] = [
  {
    id: "event-today",
    date: "2026-09-05",
    title: "讨论校园记忆展",
    personIds: [person.id],
    createdAt: now,
  },
  {
    id: "event-recent",
    date: "2026-09-02",
    title: "确认拍摄清单",
    personIds: [person.id],
    createdAt: now,
  },
];
const reminders: ReminderRecord[] = [
  {
    id: "reminder-overdue",
    title: "发送海报素材",
    due: "2026-09-04",
    done: false,
    personIds: [person.id],
    createdAt: now,
  },
  {
    id: "reminder-done",
    title: "已经完成",
    due: "2026-09-05",
    done: true,
    createdAt: now,
  },
];
const tasks: TaskRecord[] = [
  {
    id: "task-open",
    title: "补充展览预算",
    priority: "normal",
    status: "doing",
    createdAt: now,
  },
];

function run(overrides: Partial<AgentRunRecord> = {}): AgentRunRecord {
  return {
    schemaVersion: 1,
    id: "run-1",
    threadId: "assistant:default",
    ordinal: 1,
    agentName: "问一问",
    entrypoint: "models.ask",
    request: {},
    providerRef: { model: "deepseek-v4-flash" },
    includeArchive: true,
    budget: {
      maxRounds: 6,
      maxToolCalls: 12,
      maxInputTokens: 20_000,
      maxOutputTokens: 4_000,
      maxWallTimeMs: 60_000,
    },
    status: "suspended",
    nextSequence: 1,
    revision: 1,
    proposalRefs: [],
    receiptRefs: [],
    resumable: true,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("projectToday", () => {
  it("keeps a non-resumable intake draft visible until the user approves it", () => {
    const result = projectToday({
      today: "2026-09-05",
      persons: [],
      events: [],
      reminders: [],
      tasks: [],
      proposals: [],
      runs: [
        run({
          status: "awaiting_approval",
          resumable: false,
          entrypoint: "intake.organize",
          proposalRefs: ["intake-draft:run-1"],
        }),
      ],
    });
    expect(result.urgent).toEqual([
      expect.objectContaining({ id: "run:run-1", detail: "整理完成，等待你确认" }),
    ]);
    const completed = projectToday({
      today: "2026-09-05",
      persons: [],
      events: [],
      reminders: [],
      tasks: [],
      proposals: [],
      runs: [run({ status: "completed", resumable: false })],
    });
    expect(completed.urgent).toEqual([]);
  });
  it("projects source records without creating shadow task state", () => {
    const result = projectToday({
      today: "2026-09-05",
      persons: [person],
      events,
      reminders,
      tasks,
      runs: [run()],
      proposals: [],
    });

    expect(result.urgent.map((item) => item.id)).toEqual([
      "reminder:reminder-overdue",
      "event:event-today",
    ]);
    expect(result.upcoming).toEqual([
      expect.objectContaining({
        id: "birthday:person-tang",
        target: { view: "people", recordType: "person", recordId: "person-tang" },
      }),
    ]);
    expect(result.open.map((item) => item.id)).toEqual(["run:run-1", "task:task-open"]);
    expect(result.recent.map((item) => item.id)).toEqual(["event:event-recent"]);
    expect(JSON.stringify(result)).not.toContain("reminder-done");
  });

  it("shows a pending proposal once and sends it back to its owning workspace", () => {
    const proposal = {
      id: "proposal-1",
      sourceRunId: "run-1",
      enqueuedAt: now,
      schemaVersion: 1,
      status: "pending",
      revision: 1,
      updatedAt: now,
      plan: {
        version: 1,
        id: "plan-1",
        title: "更新唐悦职位",
        reason: "用户明确要求",
        createdAt: now,
        operations: [],
      },
    } satisfies PersistedMutationProposalRecord;

    const result = projectToday({
      today: "2026-09-05",
      persons: [],
      events: [],
      reminders: [],
      tasks: [],
      runs: [run({ proposalRefs: [proposal.id], status: "awaiting_approval" })],
      proposals: [proposal],
    });

    expect(result.urgent).toEqual([
      expect.objectContaining({
        id: "proposal:proposal-1",
        target: {
          view: "models",
          recordType: "proposal",
          recordId: "proposal-1",
          runId: "run-1",
        },
      }),
    ]);
    expect(result.open).toEqual([]);
  });

  it("keeps fuzzy ranges active when today falls inside the stored interval", () => {
    const result = projectToday({
      today: "2026-09-05",
      persons: [],
      reminders: [],
      tasks: [],
      runs: [],
      proposals: [],
      events: [
        {
          id: "summer",
          date: "2026-06-01",
          dateEnd: "2026-09-30",
          precision: "range",
          title: "去年夏天认识",
          createdAt: now,
        },
      ],
    });

    expect(result.urgent).toEqual([
      expect.objectContaining({ id: "event:summer", timing: "today" }),
    ]);
  });
});
