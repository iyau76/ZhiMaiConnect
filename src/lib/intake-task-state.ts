export type IntakeMutationDomain =
  "person" | "fact" | "relation" | "event" | "reminder" | "evidence" | "summary";
export type IntakeMutationIntent = "create" | "update";

interface IntakeMutationTaskBase {
  id: string;
  intent: IntakeMutationIntent;
  changes: Record<string, unknown>;
}

export interface IntakePersonMutationTask extends IntakeMutationTaskBase {
  domain: "person";
  target: { name: string; personId?: string };
}

export interface IntakeRelationMutationTask extends IntakeMutationTaskBase {
  domain: "relation";
  target: {
    from: string;
    to: string;
    fromPersonId?: string;
    toPersonId?: string;
    relationId?: string;
    label?: string;
  };
}

export interface IntakeFactMutationTask extends IntakeMutationTaskBase {
  domain: "fact";
  target: { person: string; personId?: string; key: string; factId?: string };
}

export interface IntakeEventMutationTask extends IntakeMutationTaskBase {
  domain: "event";
  target: { title: string; eventId?: string; date?: string };
}

export interface IntakeReminderMutationTask extends IntakeMutationTaskBase {
  domain: "reminder";
  target: { title: string; reminderId?: string };
}

export interface IntakeEvidenceMutationTask extends IntakeMutationTaskBase {
  domain: "evidence";
  target: { title: string; evidenceId?: string };
}

export interface IntakeSummaryMutationTask extends IntakeMutationTaskBase {
  domain: "summary";
  target: { title: string };
}

export type IntakeMutationTask =
  | IntakePersonMutationTask
  | IntakeFactMutationTask
  | IntakeRelationMutationTask
  | IntakeEventMutationTask
  | IntakeReminderMutationTask
  | IntakeEvidenceMutationTask
  | IntakeSummaryMutationTask;

export interface IntakeMutationPlan {
  type: "plan";
  summary?: string;
  tasks: IntakeMutationTask[];
}

export interface IntakeTaskSnapshot {
  phase: "planning" | "working" | "ready";
  tasks: Array<
    IntakeMutationTask & {
      status: "pending" | "completed";
      targetId?: string;
    }
  >;
  pendingDomains: IntakeMutationDomain[];
  completedDomains: IntakeMutationDomain[];
  nextAction: "declare_plan" | "stage_typed_plan" | "return_staged";
}

const DOMAIN_ORDER: IntakeMutationDomain[] = [
  "person",
  "fact",
  "relation",
  "event",
  "reminder",
  "evidence",
  "summary",
];

function text(value: unknown, field: string, maxLength: number) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`录入任务计划的 ${field} 必须是非空字符串`);
  }
  return value.trim().slice(0, maxLength);
}

function optionalText(value: unknown, field: string, maxLength: number) {
  return value === undefined ? undefined : text(value, field, maxLength);
}

function record(value: unknown, field: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`录入任务计划的 ${field} 必须是 JSON 对象`);
  }
  return value as Record<string, unknown>;
}

function intent(value: unknown, field: string): IntakeMutationIntent {
  if (value === "create" || value === "update") return value;
  throw new Error(`录入任务计划的 ${field} 只能是 create 或 update`);
}

function parseTask(value: unknown, index: number): IntakeMutationTask {
  const row = record(value, `tasks[${index}]`);
  const id = text(row.id, `tasks[${index}].id`, 80);
  const taskIntent = intent(row.intent, `tasks[${index}].intent`);
  const changes = record(row.changes, `tasks[${index}].changes`);
  const target = record(row.target, `tasks[${index}].target`);
  if (row.domain === "person") {
    return {
      id,
      domain: "person",
      intent: taskIntent,
      target: {
        name: text(target.name, `tasks[${index}].target.name`, 200),
        personId: optionalText(target.personId, `tasks[${index}].target.personId`, 200),
      },
      changes,
    };
  }
  if (row.domain === "relation") {
    return {
      id,
      domain: "relation",
      intent: taskIntent,
      target: {
        from: text(target.from, `tasks[${index}].target.from`, 200),
        to: text(target.to, `tasks[${index}].target.to`, 200),
        fromPersonId: optionalText(target.fromPersonId, `tasks[${index}].target.fromPersonId`, 200),
        toPersonId: optionalText(target.toPersonId, `tasks[${index}].target.toPersonId`, 200),
        relationId: optionalText(target.relationId, `tasks[${index}].target.relationId`, 200),
        label: optionalText(target.label, `tasks[${index}].target.label`, 200),
      },
      changes,
    };
  }
  if (row.domain === "fact") {
    return {
      id,
      domain: "fact",
      intent: taskIntent,
      target: {
        person: text(target.person, `tasks[${index}].target.person`, 200),
        personId: optionalText(target.personId, `tasks[${index}].target.personId`, 200),
        key: text(target.key, `tasks[${index}].target.key`, 200),
        factId: optionalText(target.factId, `tasks[${index}].target.factId`, 200),
      },
      changes,
    };
  }
  if (row.domain === "event") {
    return {
      id,
      domain: "event",
      intent: taskIntent,
      target: {
        title: text(target.title, `tasks[${index}].target.title`, 500),
        eventId: optionalText(target.eventId, `tasks[${index}].target.eventId`, 200),
        date: optionalText(target.date, `tasks[${index}].target.date`, 100),
      },
      changes,
    };
  }
  if (row.domain === "reminder") {
    return {
      id,
      domain: "reminder",
      intent: taskIntent,
      target: {
        title: text(target.title, `tasks[${index}].target.title`, 500),
        reminderId: optionalText(target.reminderId, `tasks[${index}].target.reminderId`, 200),
      },
      changes,
    };
  }
  if (row.domain === "evidence") {
    return {
      id,
      domain: "evidence",
      intent: taskIntent,
      target: {
        title: text(target.title, `tasks[${index}].target.title`, 500),
        evidenceId: optionalText(target.evidenceId, `tasks[${index}].target.evidenceId`, 200),
      },
      changes,
    };
  }
  if (row.domain === "summary") {
    if (taskIntent !== "create") throw new Error("录入任务计划暂不支持更新已有概要");
    return {
      id,
      domain: "summary",
      intent: taskIntent,
      target: {
        title: text(target.title, `tasks[${index}].target.title`, 500),
      },
      changes,
    };
  }
  throw new Error(
    `录入任务计划的 tasks[${index}].domain 只能是 person、fact、relation、event、reminder、evidence 或 summary`,
  );
}

/**
 * Deterministic ledger for one intake run. The model declares typed semantic
 * mutations once; local resolution and staging are the only completion path.
 */
export class IntakeTaskStateMachine {
  private readonly planRequired: boolean;
  private planned = false;
  private tasks: IntakeMutationTask[] = [];
  private readonly completions = new Map<string, string>();

  constructor(options: { planRequired: boolean }) {
    this.planRequired = options.planRequired;
    this.planned = !options.planRequired;
  }

  acceptsPlan() {
    return this.planRequired && !this.planned;
  }

  acceptPlan(candidate: unknown): IntakeTaskSnapshot {
    if (!this.acceptsPlan()) throw new Error("本轮录入任务计划已经确定，不能重新规划");
    const input = record(candidate, "根节点");
    if (input.type !== "plan" || !Array.isArray(input.tasks)) {
      throw new Error("首轮必须返回 type=plan 和 tasks 数组");
    }
    if (input.tasks.length === 0) throw new Error("非空录入材料不能返回空 tasks");
    const ids = new Set<string>();
    this.tasks = input.tasks.map((item, index) => {
      const task = parseTask(item, index);
      if (ids.has(task.id)) throw new Error(`录入任务计划存在重复 id：${task.id}`);
      ids.add(task.id);
      return task;
    });
    this.planned = true;
    return this.snapshot();
  }

  plannedTasks() {
    return [...this.tasks];
  }

  completeTask(taskId: string, domain: IntakeMutationDomain, targetId: string) {
    if (!this.planned) throw new Error("尚未建立录入任务计划，不能暂存修改");
    if (!this.planRequired) return this.snapshot();
    const task = this.tasks.find((candidate) => candidate.id === taskId);
    if (!task) throw new Error(`任务计划中不存在 ${taskId}，不能暂存计划外变更`);
    if (task.domain !== domain) {
      throw new Error(`任务 ${taskId} 的 domain 是 ${task.domain}，不能由 ${domain} 暂存`);
    }
    this.completions.set(task.id, targetId);
    return this.snapshot();
  }

  assertFinalizable() {
    const snapshot = this.snapshot();
    if (snapshot.phase === "planning") throw new Error("返回结果前必须先声明 typed plan");
    if (snapshot.phase === "working") {
      throw new Error(
        `录入任务尚未完成：${snapshot.tasks
          .filter((task) => task.status === "pending")
          .map((task) => `${task.id}(${task.domain})`)
          .join("、")}`,
      );
    }
  }

  snapshot(): IntakeTaskSnapshot {
    const tasks = this.tasks.map((task) => {
      const targetId = this.completions.get(task.id);
      return {
        ...task,
        status: targetId ? ("completed" as const) : ("pending" as const),
        ...(targetId ? { targetId } : {}),
      };
    });
    const pendingDomains = DOMAIN_ORDER.filter((name) =>
      tasks.some((task) => task.domain === name && task.status === "pending"),
    );
    const completedDomains = DOMAIN_ORDER.filter((name) =>
      tasks.some((task) => task.domain === name && task.status === "completed"),
    );
    const phase = !this.planned ? "planning" : pendingDomains.length ? "working" : "ready";
    return {
      phase,
      tasks,
      pendingDomains,
      completedDomains,
      nextAction:
        phase === "planning"
          ? "declare_plan"
          : phase === "working"
            ? "stage_typed_plan"
            : "return_staged",
    };
  }
}
