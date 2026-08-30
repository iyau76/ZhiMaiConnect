import { BrainCircuit, CheckCircle2, Circle, CircleDot, Loader2, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { ReasoningDisclosure } from "@/components/reasoning-disclosure";
import { SourceBadge } from "@/components/source-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  facesDb,
  type LifeEventRecord,
  type PersonRecord,
  type RelationRecord,
  type TaskRecord,
} from "@/lib/face-db";
import { getLang, t } from "@/lib/i18n";
import { runPlanningAgent, type PlannerTraceEvent } from "@/lib/planning-agent";
import { makeSource } from "@/lib/provenance";
import type { ProviderPreset } from "@/lib/vision-providers";

const OFFICER_KEY = "openglass.officer";

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

export function PlanBoard({ preset }: { preset: ProviderPreset }) {
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [people, setPeople] = useState<PersonRecord[]>([]);
  const [relations, setRelations] = useState<RelationRecord[]>([]);
  const [events, setEvents] = useState<LifeEventRecord[]>([]);
  const [officer, setOfficer] = useState("");
  const [goal, setGoal] = useState("");
  const [title, setTitle] = useState("");
  const [detail, setDetail] = useState("");
  const [due, setDue] = useState("");
  const [priority, setPriority] = useState<TaskRecord["priority"]>("normal");
  const [planBusy, setPlanBusy] = useState(false);
  const [trace, setTrace] = useState<PlannerTraceEvent[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    const [rows, persons, rel, ev] = await Promise.all([
      facesDb.listTasks(),
      facesDb.listPersons(),
      facesDb.listRelations(),
      facesDb.listLifeEvents(),
    ]);
    setTasks(rows);
    setPeople(persons);
    setRelations(rel);
    setEvents(ev);
  }, []);

  useEffect(() => {
    void refresh();
    return () => abortRef.current?.abort();
  }, [refresh]);

  useEffect(() => {
    try {
      setOfficer(localStorage.getItem(OFFICER_KEY) ?? "");
    } catch {
      /* ignore */
    }
  }, []);

  const rememberOfficer = (value: string) => {
    setOfficer(value);
    try {
      localStorage.setItem(OFFICER_KEY, value);
    } catch {
      /* ignore */
    }
  };

  const add = async () => {
    if (!title.trim()) {
      toast.error(t("先写一句这一步要做什么"));
      return;
    }
    await facesDb.putTask({
      id: crypto.randomUUID(),
      title: title.trim(),
      detail: detail.trim() || undefined,
      assignee: officer.trim() || undefined,
      priority,
      status: "todo",
      due: due || undefined,
      createdAt: Date.now(),
      source: makeSource("manual", officer.trim() || undefined),
    });
    setTitle("");
    setDetail("");
    setDue("");
    await refresh();
    toast.success(t("已加入行动计划"));
  };

  const patch = async (task: TaskRecord, next: Partial<TaskRecord>) => {
    await facesDb.putTask({ ...task, ...next });
    await refresh();
  };

  const remove = async (id: string) => {
    await facesDb.deleteTask(id);
    await refresh();
  };

  const generatePlan = async () => {
    if (!goal.trim() || planBusy) return;
    if (!people.length) {
      toast.error(t("库里还没有资料，先去「录入」写点情况"));
      return;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setPlanBusy(true);
    setTrace([]);
    try {
      const result = await runPlanningAgent({
        preset,
        goal: goal.trim(),
        persons: people,
        relations,
        events,
        signal: controller.signal,
        onTrace: (event) => setTrace((current) => [...current.slice(-29), event]),
      });
      const now = Date.now();
      for (const [index, item] of result.tasks.entries()) {
        await facesDb.putTask({
          id: crypto.randomUUID(),
          title: item.title,
          detail: item.detail,
          assignee: item.assignee ?? (officer.trim() || undefined),
          personIds: item.personIds?.length ? item.personIds : undefined,
          priority: item.priority,
          status: "todo",
          due: item.due,
          createdAt: now - index,
          source: makeSource("ai", preset.model),
        });
      }
      await refresh();
      toast.success(`${t("已生成行动项")} ${result.tasks.length}`);
    } catch (error) {
      if (!controller.signal.aborted) toast.error((error as Error).message);
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setPlanBusy(false);
    }
  };

  const en = getLang() === "en";

  return (
    <section className="flex min-w-0 flex-col gap-4 rounded-2xl border border-border bg-card/60 p-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="flex items-baseline gap-2.5">
          <span className="font-display text-xl leading-none tracking-tight">{t("行动计划")}</span>
          <span className="text-[10px] uppercase tracking-[0.24em] text-muted-foreground">
            Agent Plan
          </span>
        </h2>
      </header>

      <div className="space-y-2 rounded-xl border border-border bg-background/45 p-3">
        <div className="flex flex-wrap gap-2">
          <Input
            value={goal}
            onChange={(event) => {
              abortRef.current?.abort();
              setGoal(event.target.value);
              setTrace([]);
            }}
            placeholder={t("目标，例：筹备校园记忆展开幕活动")}
            className="min-w-0 flex-1"
          />
          <Button onClick={() => void generatePlan()} disabled={planBusy || !goal.trim()}>
            {planBusy ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <BrainCircuit className="size-4" aria-hidden="true" />
            )}
            {planBusy ? t("拆解中…") : t("智能体拆解任务")}
          </Button>
        </div>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {t(
            "智能体会先读取本机档案、核对相关人物与关系，再按优先级排出可执行行动项；排出的任务可继续手动修改，确认后再执行。",
          )}
        </p>
        {trace.length > 0 && (
          <ReasoningDisclosure
            label={t("规划轨迹")}
            current={trace.at(-1)?.text ?? t("正在拆解")}
            steps={trace.length}
            running={planBusy}
            events={trace}
            stepLabel={t("步")}
          />
        )}
      </div>

      <p className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
        {t("手动加一条行动项")}
      </p>
      <div className="grid gap-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_auto]">
        <Input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder={t("行动项，例：走访保姆李姐核对报警经过")}
        />
        <Input
          value={officer}
          onChange={(event) => rememberOfficer(event.target.value)}
          placeholder={t("负责人")}
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
        placeholder={t("想验证什么、注意事项（可留空）")}
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
        <Button size="sm" className="rounded-full px-4" onClick={() => void add()}>
          <Plus className="size-3.5" aria-hidden="true" />
          {t("加入计划")}
        </Button>
      </div>

      <div className="grid gap-3 lg:grid-cols-3">
        {STATUS.map((column) => {
          const list = tasks.filter((task) => task.status === column.id);
          return (
            <div key={column.id} className="min-w-0 space-y-2 rounded-xl border border-border p-3">
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
                    className="space-y-1.5 rounded-lg border border-border bg-background/50 p-2.5"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <p className="min-w-0 text-[13px] font-medium leading-snug">{task.title}</p>
                      <button
                        type="button"
                        className="shrink-0 text-muted-foreground hover:text-destructive"
                        onClick={() => void remove(task.id)}
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
                        onChange={(event) => void patch(task, { assignee: event.target.value })}
                        placeholder={t("负责人")}
                        className="h-7 flex-1 text-[11px]"
                      />
                      {STATUS.filter((item) => item.id !== task.status).map((item) => (
                        <Button
                          key={item.id}
                          size="sm"
                          variant="ghost"
                          className="h-7 px-2 text-[10px]"
                          onClick={() => void patch(task, { status: item.id })}
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

      <p className="text-[11px] leading-relaxed text-muted-foreground">
        {t("每条行动项记录负责人和来源（人工或智能体）；智能体排出的任务需要人工确认后再执行。")}
      </p>
    </section>
  );
}
