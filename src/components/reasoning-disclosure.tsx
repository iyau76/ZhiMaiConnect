import {
  BrainCircuit,
  CheckCircle2,
  ChevronDown,
  CircleDashed,
  ClipboardCheck,
  Loader2,
  Search,
  TriangleAlert,
  Wrench,
} from "lucide-react";
import { useState } from "react";

import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export type AgentTraceKind = "status" | "model" | "tool" | "check" | "done" | "error";

export interface AgentTraceStep {
  kind: AgentTraceKind;
  text: string;
}

const STAGE_META: Record<AgentTraceKind, { label: string; icon: typeof Search; cls: string }> = {
  status: { label: "准备", icon: CircleDashed, cls: "text-muted-foreground" },
  model: { label: "分析", icon: BrainCircuit, cls: "text-primary" },
  tool: { label: "工具", icon: Wrench, cls: "text-sky-600 dark:text-sky-300" },
  check: { label: "校验", icon: ClipboardCheck, cls: "text-amber-600 dark:text-amber-300" },
  done: { label: "完成", icon: CheckCircle2, cls: "text-emerald-600 dark:text-emerald-300" },
  error: { label: "错误", icon: TriangleAlert, cls: "text-destructive" },
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
  history?: string[];
  events?: AgentTraceStep[];
  stepLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const trace: AgentTraceStep[] =
    events ?? (history ?? []).map((text) => ({ kind: "status", text }));
  const toolCount = trace.filter((item) => item.kind === "tool").length;
  const checkCount = trace.filter((item) => item.kind === "check").length;
  const done = trace.some((item) => item.kind === "done");
  const error = trace.some((item) => item.kind === "error");
  const visible = [...trace].slice(-40);
  const expandable = trace.length > 0;

  return (
    <div
      data-variant="think"
      data-state={running ? "running" : "complete"}
      className="reasoning-disclosure"
      title={trace.map((item) => item.text).join(" → ")}
    >
      <button
        type="button"
        data-disclosure-row="true"
        aria-expanded={open}
        className="reasoning-disclosure-row w-full cursor-pointer text-left"
        onClick={() => expandable && setOpen((value) => !value)}
      >
        <span className="reasoning-state-dot" aria-hidden="true" />
        <BrainCircuit className="relative z-10 size-3.5 shrink-0 text-primary" aria-hidden="true" />
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
        <span className="sr-only" role="status" aria-live="polite">
          {label}：{current}
        </span>
      </button>

      {open && (
        <div className="reasoning-disclosure-body">
          <div className="flex flex-wrap items-center gap-1.5 border-b border-border/60 px-3 py-2">
            <span className="rounded-full border border-border bg-background/50 px-2 py-0.5 text-[10px] text-muted-foreground">
              {t("工具调用")} {toolCount}
            </span>
            <span className="rounded-full border border-border bg-background/50 px-2 py-0.5 text-[10px] text-muted-foreground">
              {t("校验")} {checkCount}
            </span>
            {done && (
              <span className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[10px] text-emerald-700 dark:text-emerald-300">
                {t("已完成")}
              </span>
            )}
            {error && (
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
              const meta = STAGE_META[item.kind] ?? STAGE_META.status;
              const Icon = meta.icon;
              return (
                <li
                  key={index}
                  className="grid grid-cols-[2.2rem_minmax(0,1fr)] items-start gap-2 rounded-md px-2 py-1 text-[11px] odd:bg-muted/20"
                >
                  <span className={cn("flex items-center gap-1 font-medium", meta.cls)}>
                    <Icon className="size-3.5" aria-hidden="true" />
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
