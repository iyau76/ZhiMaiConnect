import type { LifeEventRecord, PersonRecord, ReminderRecord, TaskRecord } from "./face-db";
import type { AgentRunRecord, PersistedMutationProposalRecord } from "./agent-run-ledger";
import { eventSpan } from "./fuzzy-date";
import { birthdayMd } from "./personal";

export type TodayTarget =
  | { view: "people"; recordType: "person"; recordId: string }
  | { view: "calendar"; recordType: "event"; recordId: string }
  | { view: "reminders"; recordType: "reminder"; recordId: string }
  | { view: "plan"; recordType: "task"; recordId: string }
  | {
      view: "intake" | "reminders" | "plan" | "models" | "settings";
      recordType: "run" | "proposal";
      recordId: string;
      runId?: string;
    };

export type TodayItemKind = "birthday" | "event" | "reminder" | "task" | "run" | "proposal";

export interface TodayProjectionItem {
  id: string;
  kind: TodayItemKind;
  title: string;
  detail?: string;
  date?: string;
  timing?: "overdue" | "today" | "upcoming" | "undated" | "recent";
  personIds: string[];
  target: TodayTarget;
}

export interface TodayProjection {
  urgent: TodayProjectionItem[];
  upcoming: TodayProjectionItem[];
  open: TodayProjectionItem[];
  recent: TodayProjectionItem[];
}

export interface TodayProjectionInput {
  today: string;
  persons: readonly PersonRecord[];
  events: readonly LifeEventRecord[];
  reminders: readonly ReminderRecord[];
  tasks: readonly TaskRecord[];
  runs: readonly AgentRunRecord[];
  proposals: readonly PersistedMutationProposalRecord[];
  upcomingDays?: number;
  recentDays?: number;
}

function dateOrdinal(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const time = Date.UTC(year, month - 1, day);
  const probe = new Date(time);
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    return null;
  }
  return Math.floor(time / 86_400_000);
}

function daysFrom(today: string, date: string) {
  const todayOrdinal = dateOrdinal(today);
  const dateValue = dateOrdinal(date);
  return todayOrdinal === null || dateValue === null ? null : dateValue - todayOrdinal;
}

function birthdayDate(md: string, today: string) {
  const year = Number(today.slice(0, 4));
  for (const candidateYear of [year, year + 1]) {
    const candidate = `${candidateYear}-${md}`;
    const distance = daysFrom(today, candidate);
    if (distance !== null && distance >= 0) return { candidate, distance };
  }
  return null;
}

function timingFor(distance: number): TodayProjectionItem["timing"] {
  if (distance < 0) return "overdue";
  if (distance === 0) return "today";
  return "upcoming";
}

type AgentWorkspaceView = "intake" | "reminders" | "plan" | "models" | "settings";

function viewForEntrypoint(entrypoint?: string): AgentWorkspaceView {
  if (entrypoint?.startsWith("intake.")) return "intake";
  if (entrypoint?.startsWith("reminders.")) return "reminders";
  if (entrypoint?.startsWith("plan.")) return "plan";
  if (entrypoint?.startsWith("models.")) return "models";
  return "settings";
}

function viewForProposal(proposal: PersistedMutationProposalRecord, run?: AgentRunRecord) {
  if (proposal.scope === "intake") return "intake" as const;
  if (proposal.scope === "assistant") return "models" as const;
  if (proposal.scope === "planning") return "plan" as const;
  return viewForEntrypoint(run?.entrypoint);
}

function compareItems(left: TodayProjectionItem, right: TodayProjectionItem) {
  const byDate = (left.date ?? "9999-99-99").localeCompare(right.date ?? "9999-99-99");
  if (byDate) return byDate;
  const kindOrder: Record<TodayItemKind, number> = {
    proposal: 0,
    run: 1,
    reminder: 2,
    task: 3,
    event: 4,
    birthday: 5,
  };
  return (
    kindOrder[left.kind] - kindOrder[right.kind] ||
    left.title.localeCompare(right.title, "zh-CN") ||
    left.id.localeCompare(right.id)
  );
}

export function projectToday(input: TodayProjectionInput): TodayProjection {
  const upcomingDays = input.upcomingDays ?? 14;
  const recentDays = input.recentDays ?? 7;
  const urgent: TodayProjectionItem[] = [];
  const upcoming: TodayProjectionItem[] = [];
  const open: TodayProjectionItem[] = [];
  const recent: TodayProjectionItem[] = [];

  for (const reminder of input.reminders) {
    if (reminder.done) continue;
    const item: TodayProjectionItem = {
      id: `reminder:${reminder.id}`,
      kind: "reminder",
      title: reminder.title,
      detail: reminder.detail,
      date: reminder.due,
      timing: reminder.due ? undefined : "undated",
      personIds: [...(reminder.personIds ?? [])],
      target: { view: "reminders", recordType: "reminder", recordId: reminder.id },
    };
    if (!reminder.due) {
      open.push(item);
      continue;
    }
    const distance = daysFrom(input.today, reminder.due);
    if (distance === null) continue;
    item.timing = timingFor(distance);
    if (distance <= 0) urgent.push(item);
    else if (distance <= upcomingDays) upcoming.push(item);
  }

  for (const task of input.tasks) {
    if (task.status === "done") continue;
    const item: TodayProjectionItem = {
      id: `task:${task.id}`,
      kind: "task",
      title: task.title,
      detail: task.detail,
      date: task.due,
      timing: task.due ? undefined : "undated",
      personIds: [...(task.personIds ?? [])],
      target: { view: "plan", recordType: "task", recordId: task.id },
    };
    if (!task.due) {
      open.push(item);
      continue;
    }
    const distance = daysFrom(input.today, task.due);
    if (distance === null) continue;
    item.timing = timingFor(distance);
    if (distance <= 0) urgent.push(item);
    else if (distance <= upcomingDays) upcoming.push(item);
  }

  for (const event of input.events) {
    const span = eventSpan(event);
    const startDistance = daysFrom(input.today, span.start);
    const endDistance = daysFrom(input.today, span.end);
    if (startDistance === null || endDistance === null) continue;
    const item: TodayProjectionItem = {
      id: `event:${event.id}`,
      kind: "event",
      title: event.title,
      detail: event.detail,
      date: event.date,
      personIds: [...(event.personIds ?? [])],
      target: { view: "calendar", recordType: "event", recordId: event.id },
    };
    if (startDistance <= 0 && endDistance >= 0) {
      urgent.push({ ...item, timing: "today" });
    } else if (startDistance > 0 && startDistance <= upcomingDays) {
      upcoming.push({ ...item, timing: "upcoming" });
    } else if (endDistance < 0 && endDistance >= -recentDays) {
      recent.push({ ...item, timing: "recent" });
    }
  }

  for (const person of input.persons) {
    const md = birthdayMd(person.profile?.birthday);
    const next = md ? birthdayDate(md, input.today) : null;
    if (!next || next.distance > upcomingDays) continue;
    const item: TodayProjectionItem = {
      id: `birthday:${person.id}`,
      kind: "birthday",
      title: `${person.name}生日`,
      date: next.candidate,
      timing: next.distance === 0 ? "today" : "upcoming",
      personIds: [person.id],
      target: { view: "people", recordType: "person", recordId: person.id },
    };
    (next.distance === 0 ? urgent : upcoming).push(item);
  }

  const runsById = new Map(input.runs.map((run) => [run.id, run]));
  const pendingProposals = input.proposals.filter((proposal) => proposal.status === "pending");
  const proposalRunIds = new Set(pendingProposals.map((proposal) => proposal.sourceRunId));
  for (const proposal of pendingProposals) {
    const run = proposal.sourceRunId ? runsById.get(proposal.sourceRunId) : undefined;
    urgent.push({
      id: `proposal:${proposal.id}`,
      kind: "proposal",
      title: proposal.plan.title,
      detail: proposal.plan.reason,
      personIds: [],
      target: {
        view: viewForProposal(proposal, run),
        recordType: "proposal",
        recordId: proposal.id,
        runId: proposal.sourceRunId,
      },
    });
  }

  for (const run of input.runs) {
    if (!run.resumable || proposalRunIds.has(run.id)) continue;
    if (!new Set(["running", "suspended", "awaiting_approval"]).has(run.status)) continue;
    open.push({
      id: `run:${run.id}`,
      kind: "run",
      title: run.title || "未完成的 AI 任务",
      detail: run.status === "suspended" ? "已暂停，可以继续" : "仍在处理中",
      personIds: [],
      target: {
        view: viewForEntrypoint(run.entrypoint),
        recordType: "run",
        recordId: run.id,
        runId: run.id,
      },
    });
  }

  urgent.sort(compareItems);
  upcoming.sort(compareItems);
  open.sort(compareItems);
  recent.sort((left, right) => compareItems(right, left));
  return { urgent, upcoming, open, recent };
}
