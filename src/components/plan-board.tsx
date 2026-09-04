import {
  BrainCircuit,
  CheckCircle2,
  Circle,
  CircleDot,
  Loader2,
  Plus,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { AgentRunInspector } from "@/components/agent-run-inspector";
import { ReasoningDisclosure } from "@/components/reasoning-disclosure";
import { SourceBadge } from "@/components/source-badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { AgentRun } from "@/lib/agent-run-log";
import { indexedDbMutationArtifactRepository } from "@/lib/agent-run-ledger";
import {
  facesDb,
  type LifeEventRecord,
  type PersonRecord,
  type RelationRecord,
  type TaskRecord,
} from "@/lib/face-db";
import { getLang, t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { createArchiveMutationPlan, createTaskOperation } from "@/lib/archive-mutation-plan";
import {
  MutationCommitCoordinator,
  type MutationCommitReceipt,
  type MutationProposalEntry,
} from "@/lib/mutation-commit-coordinator";
import {
  runPlanningAgent,
  type PlannedTaskDraft,
  type PlanningTraceEvent,
} from "@/lib/planning-agent";
import { makeSource } from "@/lib/provenance";
import type { ProviderPreset } from "@/lib/vision-providers";

const OWNER_KEY = "openglass.plan-owner";
function createPlanningMutationCoordinator() {
  return new MutationCommitCoordinator({
    artifactRepository: indexedDbMutationArtifactRepository,
    scope: "planning",
  });
}

const planningMutationCoordinator = createPlanningMutationCoordinator();

const STATUS: Array<{ id: TaskRecord["status"]; zh: string; en: string; icon: typeof Circle }> = [
  { id: "todo", zh: "待办", en: "To do", icon: Circle },
  { id: "doing", zh: "进行中", en: "In progress", icon: CircleDot },
  { id: "done", zh: "已完成", en: "Done", icon: CheckCircle2 },
];

const PRIORITY: Record<TaskRecord["priority"], { zh: string; en: string; cls: string }> = {
  high: { zh: "紧急", en: "High", cls: "border-primary text-primary" },
  normal: { zh: "一般", en: "Normal", cls: "border-border text-muted-foreground" },
  low: { zh: "可延后", en: "Low", cls: "border-border text-muted-foreground/70" },
};

interface PendingTask extends PlannedTaskDraft {
  id: string;
  selected: boolean;
}

function pendingTasks(tasks: PlannedTaskDraft[]): PendingTask[] {
  return tasks.map((task) => ({ ...task, id: crypto.randomUUID(), selected: true }));
}

function restorePendingTasks(proposals: readonly MutationProposalEntry[]): PendingTask[] {
  return proposals.flatMap((proposal) =>
    proposal.plan.operations.flatMap((operation) =>
      operation.kind === "create_task"
        ? [
            {
              id: operation.id,
              selected: true,
              title: operation.replacement.title,
              detail: operation.replacement.detail ?? undefined,
              priority: operation.replacement.priority,
              due: operation.replacement.due ?? undefined,
              personIds: [...operation.replacement.personIds],
            },
          ]
        : [],
    ),
  );
}

export function PlanBoard({
  preset,
  active = true,
  focusTaskId,
  focusProposalId,
  focusNonce,
}: {
  preset: ProviderPreset;
  active?: boolean;
  focusTaskId?: string;
  focusProposalId?: string;
  focusNonce?: number;
}) {
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [people, setPeople] = useState<PersonRecord[]>([]);
  const [relations, setRelations] = useState<RelationRecord[]>([]);
  const [events, setEvents] = useState<LifeEventRecord[]>([]);
  const [owner, setOwner] = useState("");
  const [goal, setGoal] = useState("");
  const [title, setTitle] = useState("");
  const [detail, setDetail] = useState("");
  const [due, setDue] = useState("");
  const [priority, setPriority] = useState<TaskRecord["priority"]>("normal");
  const [planning, setPlanning] = useState(false);
  const [approving, setApproving] = useState(false);
  const [trace, setTrace] = useState<PlanningTraceEvent[]>([]);
  const [latestRun, setLatestRun] = useState<AgentRun | null>(null);
  const [latestReceipt, setLatestReceipt] = useState<MutationCommitReceipt | null>(null);
  const [pendingProposals, setPendingProposals] = useState<MutationProposalEntry[]>([]);
  const [artifactsReady, setArtifactsReady] = useState(false);
  const [drafts, setDrafts] = useState<PendingTask[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const handledFocus = useRef("");
  const proposalRef = useRef<HTMLElement | null>(null);

  const refresh = useCallback(async () => {
    const [taskRows, personRows, relationRows, eventRows] = await Promise.all([
      facesDb.listTasks(),
      facesDb.listPersons(),
      facesDb.listRelations(),
      facesDb.listLifeEvents(),
    ]);
    setTasks(taskRows);
    setPeople(personRows);
    setRelations(relationRows);
    setEvents(eventRows);
  }, []);

  useEffect(() => {
    if (active) void refresh();
  }, [active, refresh]);

  useEffect(() => {
    let cancelled = false;
    void planningMutationCoordinator
      .hydrate()
      .then(async ({ proposals, receipts }) => {
        if (cancelled) return;
        setPendingProposals(proposals);
        setLatestReceipt(
          [...receipts]
            .filter((receipt) => !receipt.undoneAt)
            .sort(
              (left, right) =>
                right.committedAt - left.committedAt || right.id.localeCompare(left.id),
            )[0] ?? null,
        );
        if (proposals.length) {
          setDrafts(restorePendingTasks(proposals));
          const restoredAssignee = proposals
            .flatMap((proposal) => proposal.plan.operations)
            .find((operation) => operation.kind === "create_task")?.replacement.assignee;
          if (restoredAssignee) setOwner(restoredAssignee);
        }
        await refresh();
      })
      .catch((error) => {
        if (!cancelled) {
          toast.error(error instanceof Error ? error.message : t("行动草案恢复失败"));
        }
      })
      .finally(() => {
        if (!cancelled) setArtifactsReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  useEffect(() => {
    try {
      setOwner(localStorage.getItem(OWNER_KEY) ?? "");
    } catch {
      // 浏览器禁用存储时，本页仍可在内存中使用。
    }
    return () => abortRef.current?.abort();
  }, []);

  const namesById = useMemo(
    () => new Map(people.map((person) => [person.id, person.name])),
    [people],
  );
  const selectedDrafts = drafts.filter((task) => task.selected);

  useEffect(() => {
    const targetId = focusProposalId ?? focusTaskId;
    if (!targetId) return;
    const exists = focusProposalId
      ? pendingProposals.some((proposal) => proposal.id === focusProposalId)
      : tasks.some((task) => task.id === focusTaskId);
    if (!exists) return;
    const focusKey = `${targetId}:${focusNonce ?? 0}`;
    if (handledFocus.current === focusKey) return;
    handledFocus.current = focusKey;
    requestAnimationFrame(() => {
      const target = focusProposalId
        ? proposalRef.current
        : document.getElementById(`task-${focusTaskId}`);
      target?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }, [focusNonce, focusProposalId, focusTaskId, pendingProposals, tasks]);

  const rememberOwner = (value: string) => {
    setOwner(value);
    try {
      localStorage.setItem(OWNER_KEY, value);
    } catch {
      // 浏览器禁用存储时，本页仍可在内存中使用。
    }
  };

  const addManualTask = async () => {
    if (!title.trim()) {
      toast.error(t("先写一句这一步要做什么"));
      return;
    }
    await facesDb.putTask({
      id: crypto.randomUUID(),
      title: title.trim(),
      detail: detail.trim() || undefined,
      assignee: owner.trim() || undefined,
      priority,
      status: "todo",
      due: due || undefined,
      createdAt: Date.now(),
      source: makeSource("manual", owner.trim() || undefined),
    });
    setTitle("");
    setDetail("");
    setDue("");
    await refresh();
    toast.success(t("已加入行动计划"));
  };

  const patchTask = async (task: TaskRecord, next: Partial<TaskRecord>) => {
    await facesDb.putTask({ ...task, ...next });
    await refresh();
  };

  const removeTask = async (id: string) => {
    await facesDb.deleteTask(id);
    await refresh();
  };

  const generatePlan = async () => {
    if (!goal.trim() || planning || !artifactsReady || pendingProposals.length) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setPlanning(true);
    setTrace([]);
    setLatestRun(null);
    setDrafts([]);
    try {
      const result = await runPlanningAgent({
        preset,
        goal,
        archive: { persons: people, relations, events },
        signal: controller.signal,
        onTrace: (event) => setTrace((current) => [...current.slice(-39), event]),
      });
      setLatestRun(result.run);
      setDrafts(pendingTasks(result.tasks));
      toast.success(`${t("已生成待批准行动草案")} ${result.tasks.length}`);
    } catch (error) {
      if (!controller.signal.aborted) {
        toast.error(error instanceof Error ? error.message : t("行动规划失败"));
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setPlanning(false);
    }
  };

  const patchDraft = (id: string, next: Partial<PendingTask>) => {
    setDrafts((current) => current.map((task) => (task.id === id ? { ...task, ...next } : task)));
  };

  const approveDrafts = async () => {
    const approved = selectedDrafts.filter((task) => task.title.trim());
    if (!approved.length) {
      toast.error(t("至少选择一条有标题的行动项"));
      return;
    }
    const now = Date.now();
    setApproving(true);
    try {
      let proposals = pendingProposals;
      if (!proposals.length) {
        const plan = createArchiveMutationPlan(
          {
            title: `${t("行动计划")}：${goal.trim().slice(0, 80)}`,
            reason: t("用户批准了智能体生成并经人工编辑的行动草案"),
            operations: approved.map((task) =>
              createTaskOperation({
                reason: t("用户批准此行动项"),
                replacement: {
                  title: task.title.trim(),
                  detail: task.detail?.trim() || null,
                  assignee: owner.trim() || null,
                  personIds: task.personIds,
                  priority: task.priority,
                  due: task.due || null,
                },
              }),
            ),
          },
          { createdAt: now },
        );
        proposals = [planningMutationCoordinator.enqueue(plan, { sourceRunId: latestRun?.id })];
        await planningMutationCoordinator.flushPersistence();
        setPendingProposals(proposals);
      }
      const receipt = await planningMutationCoordinator.commit({
        authorizationMode: "standard",
        proposalIds: proposals.map((proposal) => proposal.id),
        signature: { signer: "user", signedAt: now },
      });
      setLatestReceipt(receipt);
      setPendingProposals([]);
      setDrafts([]);
      await refresh();
      toast.success(`${t("已批准并加入行动计划")} ${approved.length}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("行动计划写入失败"));
    } finally {
      setApproving(false);
    }
  };

  const discardDrafts = async () => {
    setApproving(true);
    try {
      if (pendingProposals.length) {
        planningMutationCoordinator.discard(pendingProposals.map((proposal) => proposal.id));
        await planningMutationCoordinator.flushPersistence();
      }
      setPendingProposals([]);
      setDrafts([]);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("放弃行动草案失败"));
    } finally {
      setApproving(false);
    }
  };

  const undoLatestApproval = async () => {
    if (!latestReceipt) return;
    try {
      await planningMutationCoordinator.undo(latestReceipt.id);
      setLatestReceipt(null);
      await refresh();
      toast.success(t("已撤销本次批准"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("撤销失败"));
    }
  };

  const en = getLang() === "en";

  return (
    <div className="min-w-0 space-y-5" data-testid="plan-board">
      <section className="flex min-w-0 flex-col gap-4 rounded-2xl border border-border bg-card/60 p-5">
        <header>
          <h2 className="flex items-baseline gap-2.5">
            <span className="font-display text-xl leading-none tracking-tight">
              {t("行动规划")}
            </span>
            <span className="text-[10px] uppercase tracking-[0.24em] text-muted-foreground">
              Agent Plan
            </span>
          </h2>
          <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
            {t(
              "写下目标后，智能体会按需读取人物、关系和事件，形成可编辑草案；只有你批准的行动项才会写入计划。",
            )}
          </p>
        </header>

        <div className="flex flex-col gap-2 sm:flex-row">
          <Textarea
            value={goal}
            onChange={(event) => {
              setGoal(event.target.value);
              if (planning) abortRef.current?.abort();
            }}
            rows={2}
            className="min-w-0 flex-1 text-sm"
            placeholder={t("目标，例如：筹备校园记忆展开幕活动")}
          />
          <Button
            className="self-stretch sm:self-end"
            disabled={planning || !goal.trim() || !artifactsReady || pendingProposals.length > 0}
            onClick={() => void generatePlan()}
          >
            {planning ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <BrainCircuit className="size-4" aria-hidden="true" />
            )}
            {planning ? t("正在拆解") : t("智能体拆解任务")}
          </Button>
        </div>

        {trace.length > 0 && (
          <ReasoningDisclosure
            label={t("规划轨迹")}
            current={trace.at(-1)?.text ?? t("正在准备")}
            steps={trace.length}
            running={planning}
            events={trace}
            stepLabel={t("步")}
          />
        )}
        {latestRun && !planning && <AgentRunInspector run={latestRun} />}
        {latestReceipt && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-emerald-500/35 bg-emerald-500/8 px-3 py-2 text-[11px] text-emerald-700 dark:text-emerald-300">
            <span>
              {t("本次批准已作为一个事务写入")} · {latestReceipt.operationIds.length} {t("项")}
            </span>
            <Button variant="outline" size="sm" onClick={() => void undoLatestApproval()}>
              <Undo2 className="size-3.5" aria-hidden="true" />
              {t("撤销本次批准")}
            </Button>
          </div>
        )}
      </section>

      {drafts.length > 0 && (
        <section
          ref={proposalRef}
          data-proposal-ids={pendingProposals.map((proposal) => proposal.id).join(" ")}
          className="space-y-3 rounded-2xl border border-amber-500/45 bg-amber-500/5 p-5"
          aria-label={t("待批准行动草案")}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="font-display text-lg">{t("待批准行动草案")}</h3>
              <p className="mt-1 text-[11px] text-muted-foreground">
                {t("可以改写、取消选择或调整日期，再一次性加入计划。")}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={approving}
                onClick={() => void discardDrafts()}
              >
                <X className="size-3.5" aria-hidden="true" />
                {t("放弃草案")}
              </Button>
              <Button size="sm" disabled={approving} onClick={() => void approveDrafts()}>
                {approving ? (
                  <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <CheckCircle2 className="size-3.5" aria-hidden="true" />
                )}
                {approving ? t("正在写入") : t("批准并加入计划")}（{selectedDrafts.length}）
              </Button>
            </div>
          </div>

          <div className="grid gap-3 lg:grid-cols-2">
            {drafts.map((task) => (
              <article
                key={task.id}
                className="space-y-2 rounded-xl border border-border bg-background/70 p-3"
              >
                <div className="flex items-start gap-2">
                  <Checkbox
                    checked={task.selected}
                    onCheckedChange={(checked) =>
                      patchDraft(task.id, { selected: checked === true })
                    }
                    aria-label={t("选择此行动项")}
                  />
                  <Input
                    value={task.title}
                    onChange={(event) => patchDraft(task.id, { title: event.target.value })}
                    className="h-8 min-w-0 font-medium"
                    aria-label={t("行动项标题")}
                  />
                </div>
                <Textarea
                  value={task.detail ?? ""}
                  onChange={(event) => patchDraft(task.id, { detail: event.target.value })}
                  rows={2}
                  className="text-xs"
                  aria-label={t("行动项说明")}
                />
                <div className="flex flex-wrap items-center gap-1.5">
                  {(Object.keys(PRIORITY) as TaskRecord["priority"][]).map((key) => (
                    <Button
                      key={key}
                      type="button"
                      size="sm"
                      variant={task.priority === key ? "default" : "outline"}
                      className="h-7 rounded-full px-2.5 text-[10px]"
                      onClick={() => patchDraft(task.id, { priority: key })}
                    >
                      {en ? PRIORITY[key].en : PRIORITY[key].zh}
                    </Button>
                  ))}
                  <Input
                    type="date"
                    value={task.due ?? ""}
                    onChange={(event) => patchDraft(task.id, { due: event.target.value })}
                    className="h-7 w-auto text-[11px]"
                    aria-label={t("计划完成日期")}
                  />
                </div>
                {task.personIds.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {task.personIds.map((personId) => (
                      <span
                        key={personId}
                        className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] text-primary"
                      >
                        {namesById.get(personId) ?? personId}
                      </span>
                    ))}
                  </div>
                )}
              </article>
            ))}
          </div>
        </section>
      )}

      <section className="flex min-w-0 flex-col gap-4 rounded-2xl border border-border bg-card/60 p-5">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="flex items-baseline gap-2.5">
            <span className="font-display text-xl leading-none tracking-tight">
              {t("行动计划")}
            </span>
            <span className="text-[10px] uppercase tracking-[0.24em] text-muted-foreground">
              Tasks
            </span>
          </h2>
          <Input
            value={owner}
            onChange={(event) => rememberOwner(event.target.value)}
            placeholder={t("默认负责人")}
            className="h-8 w-full sm:w-48"
          />
        </header>

        <div className="grid gap-2 sm:grid-cols-[minmax(0,2fr)_auto]">
          <Input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder={t("手动添加行动项")}
          />
          <Input
            type="date"
            value={due}
            onChange={(event) => setDue(event.target.value)}
            className="w-auto"
          />
        </div>
        <Textarea
          value={detail}
          onChange={(event) => setDetail(event.target.value)}
          rows={2}
          className="text-sm"
          placeholder={t("交付结果、背景和注意事项（可留空）")}
        />
        <div className="flex flex-wrap items-center gap-2">
          {(Object.keys(PRIORITY) as TaskRecord["priority"][]).map((key) => (
            <Button
              key={key}
              type="button"
              size="sm"
              variant={priority === key ? "default" : "outline"}
              className="h-7 rounded-full px-3 text-[11px]"
              onClick={() => setPriority(key)}
            >
              {en ? PRIORITY[key].en : PRIORITY[key].zh}
            </Button>
          ))}
          <Button size="sm" className="rounded-full px-4" onClick={() => void addManualTask()}>
            <Plus className="size-3.5" aria-hidden="true" />
            {t("加入计划")}
          </Button>
        </div>

        <div className="grid gap-3 lg:grid-cols-3">
          {STATUS.map((column) => {
            const list = tasks.filter((task) => task.status === column.id);
            return (
              <div
                key={column.id}
                className="min-w-0 space-y-2 rounded-xl border border-border p-3"
              >
                <p className="flex items-center gap-1.5 text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
                  <column.icon className="size-3.5" aria-hidden="true" />
                  {en ? column.en : column.zh} · {list.length}
                </p>
                {list.length === 0 ? (
                  <p className="py-4 text-center text-[11px] text-muted-foreground">—</p>
                ) : (
                  list.map((task) => (
                    <div
                      key={task.id}
                      id={`task-${task.id}`}
                      data-task-id={task.id}
                      className={cn(
                        "scroll-mt-6 space-y-1.5 rounded-lg border border-border bg-background/50 p-2.5",
                        focusTaskId === task.id && "ring-2 ring-primary/35",
                      )}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <p className="min-w-0 text-[13px] font-medium leading-snug">{task.title}</p>
                        <button
                          type="button"
                          className="shrink-0 text-muted-foreground hover:text-destructive"
                          onClick={() => void removeTask(task.id)}
                          aria-label={t("删除")}
                        >
                          <Trash2 className="size-3.5" aria-hidden="true" />
                        </button>
                      </div>
                      {task.detail && (
                        <p className="whitespace-pre-wrap text-[11px] leading-relaxed text-muted-foreground">
                          {task.detail}
                        </p>
                      )}
                      {task.personIds && task.personIds.length > 0 && (
                        <p className="text-[10px] text-muted-foreground">
                          {task.personIds.map((id) => namesById.get(id) ?? id).join("、")}
                        </p>
                      )}
                      <div className="flex flex-wrap items-center gap-1">
                        <span
                          className={`rounded-full border px-2 py-0.5 text-[10px] ${PRIORITY[task.priority].cls}`}
                        >
                          {en ? PRIORITY[task.priority].en : PRIORITY[task.priority].zh}
                        </span>
                        {task.due && (
                          <span className="rounded-full border border-border px-2 py-0.5 text-[10px] text-muted-foreground">
                            {task.due}
                          </span>
                        )}
                        <SourceBadge source={task.source} />
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Input
                          value={task.assignee ?? ""}
                          onChange={(event) =>
                            void patchTask(task, { assignee: event.target.value })
                          }
                          placeholder={t("负责人")}
                          className="h-7 flex-1 text-[11px]"
                        />
                        {STATUS.filter((item) => item.id !== task.status).map((item) => (
                          <Button
                            key={item.id}
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2 text-[10px]"
                            onClick={() => void patchTask(task, { status: item.id })}
                          >
                            {en ? item.en : item.zh}
                          </Button>
                        ))}
                      </div>
                    </div>
                  ))
                )}
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
