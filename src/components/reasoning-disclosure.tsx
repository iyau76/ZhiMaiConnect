import {
  BrainCircuit,
  CheckCircle2,
  ChevronDown,
  CircleDashed,
  ClipboardCheck,
  Loader2,
  TriangleAlert,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { useId, useMemo, useState } from "react";

import {
  agentTraceFromHistory,
  type AgentTraceEvent,
  type AgentTraceKind,
} from "@/lib/agent-trace";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

const STAGE_META: Record<
  AgentTraceKind,
  {
    label: string;
    icon: LucideIcon;
    className: string;
  }
> = {
  status: { label: "状态", icon: CircleDashed, className: "text-muted-foreground" },
  model: { label: "模型摘要", icon: BrainCircuit, className: "text-primary" },
  tool: { label: "工具", icon: Wrench, className: "text-sky-600 dark:text-sky-300" },
  check: { label: "校验", icon: ClipboardCheck, className: "text-amber-600 dark:text-amber-300" },
  done: { label: "完成", icon: CheckCircle2, className: "text-emerald-600 dark:text-emerald-300" },
  error: { label: "错误", icon: TriangleAlert, className: "text-destructive" },
};

export function ReasoningDisclosure({
  label,
  current,
  steps,
  running,
  history,
  events,
  stepLabel = "步",
}: {
  label: string;
  current: string;
  steps: number;
  running: boolean;
  /** Compatibility input for callers that still hold the former string history. */
  history?: readonly string[];
  events?: readonly AgentTraceEvent[];
  stepLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const trace = useMemo(() => events ?? agentTraceFromHistory(history ?? []), [events, history]);
  const visible = trace.slice(-40);
  const latest = trace.at(-1);
  const latestMeta = STAGE_META[latest?.kind ?? "status"];
  const LatestIcon = latestMeta.icon;
  const toolCount = trace.filter((item) => item.kind === "tool").length;
  const checkCount = trace.filter((item) => item.kind === "check").length;
  const hasDone = trace.some((item) => item.kind === "done");
  const hasError = trace.some((item) => item.kind === "error");
  const expandable = trace.length > 0;

  return (
    <div
      data-variant="agent-trace"
      data-state={running ? "running" : hasError ? "error" : "complete"}
      className="reasoning-disclosure"
    >
      <button
        type="button"
        data-disclosure-row="true"
        aria-label={`${label} · ${steps} ${stepLabel}`}
        aria-expanded={open}
        aria-controls={bodyId}
        className="reasoning-disclosure-row w-full cursor-pointer text-left"
        onClick={() => expandable && setOpen((value) => !value)}
      >
        <span className="reasoning-state-dot" aria-hidden="true" />
        <LatestIcon
          className={cn("relative z-10 size-3.5 shrink-0", latestMeta.className)}
          aria-hidden="true"
        />
        <span className="relative z-10 shrink-0 text-[10px] font-medium text-primary">{label}</span>
        <span className="relative z-10 min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {current}
        </span>
        <span className="relative z-10 shrink-0 text-[10px] tabular-nums text-muted-foreground">
          {steps} {stepLabel}
        </span>
        {expandable && (
          <ChevronDown
            className={cn(
              "relative z-10 size-3.5 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-180",
            )}
            aria-hidden="true"
          />
        )}
      </button>
      <span className="sr-only" role="status" aria-live="polite">
        {label}：{current} · {steps} {stepLabel}
      </span>

      {open && (
        <div id={bodyId} className="reasoning-disclosure-body">
          <div className="flex flex-wrap items-center gap-1.5 border-b border-border/60 px-3 py-2">
            <span className="rounded-full border border-border bg-background/50 px-2 py-0.5 text-[10px] text-muted-foreground">
              {t("工具轨迹")} {toolCount}
            </span>
            <span className="rounded-full border border-border bg-background/50 px-2 py-0.5 text-[10px] text-muted-foreground">
              {t("校验")} {checkCount}
            </span>
            {hasDone && (
              <span className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[10px] text-emerald-700 dark:text-emerald-300">
                {t("已完成")}
              </span>
            )}
            {hasError && (
              <span className="rounded-full border border-destructive/40 bg-destructive/10 px-2 py-0.5 text-[10px] text-destructive">
                {t("有错误")}
              </span>
            )}
            {running && (
              <span className="flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[10px] text-primary">
                <Loader2 className="size-3 animate-spin" aria-hidden="true" />
                {t("运行中")}
              </span>
            )}
          </div>
          <ol className="max-h-56 space-y-1 overflow-y-auto p-2.5">
            {visible.map((item, index) => {
              const meta = STAGE_META[item.kind];
              const Icon = meta.icon;
              return (
                <li
                  key={`${item.at ?? index}:${item.kind}:${item.text}`}
                  data-trace-kind={item.kind}
                  className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-start gap-2 rounded-md px-2 py-1 text-[11px] odd:bg-muted/20"
                >
                  <span className={cn("flex items-center gap-1 font-medium", meta.className)}>
                    <Icon className="size-3.5 shrink-0" aria-hidden="true" />
                    {t(meta.label)}
                  </span>
                  <span className="min-w-0 leading-relaxed text-muted-foreground">{item.text}</span>
                </li>
              );
            })}
          </ol>
        </div>
      )}
    </div>
  );
}
