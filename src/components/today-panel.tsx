import {
  ArrowRight,
  CalendarClock,
  Cake,
  CircleAlert,
  History,
  Inbox,
  ListTodo,
  PauseCircle,
  PenLine,
  Sparkles,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  indexedDbAgentRunLedger,
  indexedDbMutationArtifactRepository,
} from "@/lib/agent-run-ledger";
import { facesDb } from "@/lib/face-db";
import { t } from "@/lib/i18n";
import { todayStr } from "@/lib/personal";
import {
  projectToday,
  type TodayProjection,
  type TodayProjectionItem,
  type TodayTarget,
} from "@/lib/today-projection";
import { cn } from "@/lib/utils";

interface TodayPanelProps {
  onOpenIntake: () => void;
  onOpenTarget: (target: TodayTarget) => void;
}

const EMPTY_PROJECTION: TodayProjection = { urgent: [], upcoming: [], open: [], recent: [] };

const KIND_ICON = {
  birthday: Cake,
  event: CalendarClock,
  reminder: CircleAlert,
  task: ListTodo,
  run: PauseCircle,
  proposal: Sparkles,
} as const;

function timingLabel(item: TodayProjectionItem) {
  if (item.timing === "overdue") return "已到期";
  if (item.timing === "today") return "今天";
  if (item.timing === "upcoming") return item.date ?? "近期";
  if (item.timing === "recent") return item.date ?? "最近";
  return "待安排";
}

function TodayCard({
  item,
  names,
  onOpen,
}: {
  item: TodayProjectionItem;
  names: ReadonlyMap<string, string>;
  onOpen: (target: TodayTarget) => void;
}) {
  const Icon = KIND_ICON[item.kind];
  const relatedNames = item.personIds.flatMap((id) => names.get(id) ?? []);
  return (
    <button
      type="button"
      data-today-item-id={item.id}
      onClick={() => onOpen(item.target)}
      className="group flex w-full items-start gap-3 rounded-xl border border-border bg-background/65 p-3 text-left transition-colors hover:border-primary/60 hover:bg-accent/40"
      aria-label={`${t("打开")}：${item.title}`}
    >
      <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
        <Icon className="size-4" aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="text-sm font-medium leading-snug">{item.title}</span>
          <span
            className={cn(
              "rounded-full border px-2 py-0.5 text-[10px]",
              item.timing === "overdue"
                ? "border-rose-500/40 text-rose-600 dark:text-rose-300"
                : "border-border text-muted-foreground",
            )}
          >
            {t(timingLabel(item))}
          </span>
        </span>
        {item.detail && (
          <span className="mt-1 line-clamp-2 block text-[11px] leading-relaxed text-muted-foreground">
            {item.detail}
          </span>
        )}
        {relatedNames.length > 0 && (
          <span className="mt-1 block text-[10px] text-muted-foreground">
            {t("相关人物")}：{relatedNames.join("、")}
          </span>
        )}
      </span>
      <ArrowRight
        className="mt-2 size-3.5 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-primary"
        aria-hidden="true"
      />
    </button>
  );
}

function TodaySection({
  title,
  subtitle,
  items,
  names,
  onOpen,
}: {
  title: string;
  subtitle: string;
  items: TodayProjectionItem[];
  names: ReadonlyMap<string, string>;
  onOpen: (target: TodayTarget) => void;
}) {
  if (!items.length) return null;
  return (
    <section className="space-y-2.5" aria-label={t(title)}>
      <header className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold">{t(title)}</h2>
        <p className="text-[10px] text-muted-foreground">{t(subtitle)}</p>
      </header>
      <div className="grid gap-2 lg:grid-cols-2">
        {items.map((item) => (
          <TodayCard key={item.id} item={item} names={names} onOpen={onOpen} />
        ))}
      </div>
    </section>
  );
}

export function TodayPanel({ onOpenIntake, onOpenTarget }: TodayPanelProps) {
  const [projection, setProjection] = useState<TodayProjection>(EMPTY_PROJECTION);
  const [names, setNames] = useState<ReadonlyMap<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    setError("");
    try {
      const [persons, events, reminders, tasks, runs, proposals] = await Promise.all([
        facesDb.listPersons(),
        facesDb.listLifeEvents(),
        facesDb.listReminders(),
        facesDb.listTasks(),
        indexedDbAgentRunLedger.listRuns(),
        indexedDbMutationArtifactRepository.listProposals(),
      ]);
      setNames(new Map(persons.map((person) => [person.id, person.name])));
      setProjection(
        projectToday({
          today: todayStr(),
          persons,
          events,
          reminders,
          tasks,
          runs,
          proposals,
        }),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "今天的事项读取失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const unsubscribe = indexedDbAgentRunLedger.subscribe(() => void refresh());
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      unsubscribe();
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [refresh]);

  const total = useMemo(
    () =>
      projection.urgent.length +
      projection.upcoming.length +
      projection.open.length +
      projection.recent.length,
    [projection],
  );
  const today = new Intl.DateTimeFormat(undefined, {
    month: "long",
    day: "numeric",
    weekday: "long",
  }).format(new Date());

  return (
    <div className="min-w-0 space-y-6">
      <section className="overflow-hidden rounded-2xl border border-primary/25 bg-gradient-to-br from-primary/10 via-card to-card p-5 md:p-6">
        <div className="flex flex-col justify-between gap-5 md:flex-row md:items-center">
          <div>
            <p className="text-[11px] text-muted-foreground">{today}</p>
            <h2 className="mt-1 font-display text-2xl tracking-tight">
              {projection.urgent.length > 0
                ? `${projection.urgent.length} 件事值得先看`
                : "今天可以从一条记录开始"}
            </h2>
            <p className="mt-2 max-w-2xl text-xs leading-relaxed text-muted-foreground">
              {total > 0
                ? `这里汇总了 ${total} 条来自人物、事件、提醒、计划和 Agent 运行的记录。点开就回到原处。`
                : "记下刚发生的事、今天要联系的人，或者载入演示资料看看完整流程。"}
            </p>
          </div>
          <Button onClick={onOpenIntake} className="shrink-0 rounded-full px-5">
            <PenLine className="size-4" aria-hidden="true" />
            {t("随手记一条")}
          </Button>
        </div>
      </section>

      {loading ? (
        <p className="py-12 text-center text-xs text-muted-foreground">{t("正在整理今天…")}</p>
      ) : error ? (
        <section className="rounded-xl border border-rose-500/30 bg-rose-500/5 p-4">
          <p className="text-sm text-rose-700 dark:text-rose-300">{error}</p>
          <Button size="sm" variant="outline" className="mt-3" onClick={() => void refresh()}>
            {t("重新读取")}
          </Button>
        </section>
      ) : total === 0 ? (
        <section className="flex flex-col items-center rounded-2xl border border-dashed border-border py-14 text-center">
          <Inbox className="size-8 text-primary" aria-hidden="true" />
          <h2 className="mt-3 text-sm font-medium">{t("今天还没有待处理事项")}</h2>
          <p className="mt-1 max-w-md text-xs leading-relaxed text-muted-foreground">
            {t("人物生日、带日期的事件和提醒、行动计划与未完成的 Agent 任务会自动出现在这里。")}
          </p>
        </section>
      ) : (
        <div className="space-y-6">
          <TodaySection
            title="先处理"
            subtitle="到期、今天发生、等待批准"
            items={projection.urgent}
            names={names}
            onOpen={onOpenTarget}
          />
          <TodaySection
            title="接下来两周"
            subtitle="生日、事件、提醒与截止任务"
            items={projection.upcoming}
            names={names}
            onOpen={onOpenTarget}
          />
          <TodaySection
            title="还在手上"
            subtitle="未排日期的行动与可继续任务"
            items={projection.open}
            names={names}
            onOpen={onOpenTarget}
          />
          <TodaySection
            title="最近发生"
            subtitle="过去七天的事件"
            items={projection.recent}
            names={names}
            onOpen={onOpenTarget}
          />
        </div>
      )}

      <p className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
        <History className="size-3" aria-hidden="true" />
        {t("今天页只读取现有记录；修改仍在对应的人物、日历、提醒或计划中完成。")}
      </p>
    </div>
  );
}
