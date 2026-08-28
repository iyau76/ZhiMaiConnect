"use client";

import {
  Activity,
  BrainCircuit,
  Check,
  CheckCircle2,
  Clipboard,
  Clock3,
  FilePenLine,
  ShieldCheck,
  TriangleAlert,
  Wrench,
  XCircle,
} from "lucide-react";
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  redactAgentPayload,
  type AgentRun,
  type AgentRunStatus,
  type AgentStep,
  type AgentStepKind,
  type AgentStepStatus,
} from "@/lib/agent-run-log";
import { cn } from "@/lib/utils";

export interface AgentRunInspectorLabels {
  details: string;
  copyRun: string;
  copied: string;
  copyStep: string;
  close: string;
  round: (round: number) => string;
  preparation: string;
  payload: string;
  input: string;
  output: string;
  redactionNote: string;
}

export interface AgentRunInspectorProps {
  run: AgentRun;
  className?: string;
  labels?: Partial<AgentRunInspectorLabels>;
  /** Additional case-insensitive payload keys to replace with [REDACTED]. */
  redactKeys?: readonly string[];
}

const DEFAULT_LABELS: AgentRunInspectorLabels = {
  details: "运行详情",
  copyRun: "复制运行 JSON",
  copied: "已复制",
  copyStep: "复制本轮 JSON",
  close: "关闭运行详情",
  round: (round) => `第 ${round} 轮`,
  preparation: "准备阶段",
  payload: "参数与结果",
  input: "参数",
  output: "结果",
  redactionNote: "密钥、认证信息及调用方指定的敏感字段已脱敏。",
};

const RUN_STATUS: Record<AgentRunStatus, { label: string; className: string }> = {
  pending: { label: "等待", className: "bg-muted text-muted-foreground" },
  running: { label: "运行中", className: "bg-primary/10 text-primary" },
  completed: {
    label: "完成",
    className: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  },
  failed: { label: "失败", className: "bg-destructive/10 text-destructive" },
  cancelled: { label: "已取消", className: "bg-muted text-muted-foreground" },
  budget_exceeded: {
    label: "达到预算",
    className: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
  },
};

const STEP_STATUS: Record<AgentStepStatus, string> = {
  pending: "等待",
  running: "运行中",
  completed: "完成",
  failed: "失败",
  skipped: "已跳过",
};

const STEP_KIND: Record<
  AgentStepKind,
  { label: string; icon: typeof Activity; className: string }
> = {
  model: { label: "模型", icon: BrainCircuit, className: "text-primary" },
  tool: { label: "工具", icon: Wrench, className: "text-sky-700 dark:text-sky-300" },
  validation: {
    label: "验证",
    icon: ShieldCheck,
    className: "text-emerald-700 dark:text-emerald-300",
  },
  proposal: {
    label: "提案",
    icon: FilePenLine,
    className: "text-amber-700 dark:text-amber-300",
  },
  approval: {
    label: "批准",
    icon: CheckCircle2,
    className: "text-emerald-700 dark:text-emerald-300",
  },
  system: { label: "系统", icon: Activity, className: "text-muted-foreground" },
};

function jsonText(value: unknown, redactKeys: readonly string[]) {
  return JSON.stringify(redactAgentPayload(value, redactKeys), null, 2);
}

function roundCount(run: AgentRun) {
  if (run.rounds !== undefined) return Math.max(0, Math.round(run.rounds));
  return run.steps.reduce((maximum, step) => Math.max(maximum, step.round ?? 0), 0);
}

function toolCount(run: AgentRun) {
  return run.steps.filter((step) => step.kind === "tool" || Boolean(step.toolName)).length;
}

function tokenCount(run: AgentRun) {
  const usage = run.tokenUsage;
  const actual = usage?.total ?? (usage?.input ?? 0) + (usage?.output ?? 0);
  if (actual > 0) {
    return {
      value: actual,
      // A mixed provider/estimated total must not be presented as fully measured.
      estimated: Boolean(usage?.estimated || (run.estimatedTokens ?? 0) > 0),
    };
  }
  if ((run.estimatedTokens ?? 0) > 0) return { value: run.estimatedTokens!, estimated: true };
  return undefined;
}

function durationMs(run: AgentRun) {
  if (run.durationMs !== undefined) return Math.max(0, run.durationMs);
  if (run.startedAt !== undefined) {
    return Math.max(0, (run.endedAt ?? Date.now()) - run.startedAt);
  }
  const durations = run.steps.map((step) => {
    if (step.durationMs !== undefined) return step.durationMs;
    if (step.startedAt !== undefined && step.endedAt !== undefined) {
      return Math.max(0, step.endedAt - step.startedAt);
    }
    return 0;
  });
  return durations.reduce((sum, value) => sum + value, 0);
}

function compactNumber(value: number) {
  if (value < 1_000) return `${Math.round(value)}`;
  if (value < 1_000_000) {
    const thousands = value / 1_000;
    return `${thousands >= 10 ? Math.round(thousands) : Number(thousands.toFixed(1))}k`;
  }
  const millions = value / 1_000_000;
  return `${millions >= 10 ? Math.round(millions) : Number(millions.toFixed(1))}m`;
}

function compactDuration(value: number) {
  if (value < 1_000) return `${Math.round(value)}ms`;
  if (value < 60_000) return `${Number((value / 1_000).toFixed(1))}s`;
  const minutes = Math.floor(value / 60_000);
  const seconds = Math.round((value % 60_000) / 1_000);
  return `${minutes}m ${seconds}s`;
}

async function copyText(value: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}

function StepStatusIcon({ status }: { status: AgentStepStatus }) {
  if (status === "failed") return <XCircle className="size-3.5 text-destructive" aria-hidden />;
  if (status === "completed") {
    return <Check className="size-3.5 text-emerald-700 dark:text-emerald-300" aria-hidden />;
  }
  if (status === "running") return <Clock3 className="size-3.5 text-primary" aria-hidden />;
  if (status === "skipped") {
    return <TriangleAlert className="size-3.5 text-muted-foreground" aria-hidden />;
  }
  return <Clock3 className="size-3.5 text-muted-foreground" aria-hidden />;
}

function AgentStepRow({
  step,
  labels,
  redactKeys,
}: {
  step: AgentStep;
  labels: AgentRunInspectorLabels;
  redactKeys: readonly string[];
}) {
  const [copied, setCopied] = useState(false);
  const kind = STEP_KIND[step.kind];
  const Icon = kind.icon;
  const status = step.status ?? "completed";
  const hasPayload = step.input !== undefined || step.output !== undefined;
  const elapsed =
    step.durationMs ??
    (step.startedAt !== undefined && step.endedAt !== undefined
      ? Math.max(0, step.endedAt - step.startedAt)
      : undefined);

  const handleCopy = async () => {
    await copyText(jsonText(step, redactKeys));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  };

  return (
    <li className="rounded-xl border border-border bg-card/50 p-3" data-agent-step={step.kind}>
      <div className="flex min-w-0 flex-wrap items-start gap-2">
        <span
          className={cn(
            "mt-0.5 inline-flex shrink-0 items-center gap-1 rounded-full bg-muted px-2 py-1 text-[11px] font-medium",
            kind.className,
          )}
        >
          <Icon className="size-3.5" aria-hidden />
          {kind.label}
        </span>
        <div className="min-w-0 flex-1">
          <p className="break-words text-sm font-medium">
            {step.title || step.toolName || kind.label}
          </p>
          {step.toolName && step.title && step.title !== step.toolName && (
            <p className="mt-0.5 break-all font-mono text-[11px] text-muted-foreground">
              {step.toolName}
            </p>
          )}
          {step.message && (
            <p className="mt-1 whitespace-pre-wrap break-words text-xs leading-relaxed text-muted-foreground">
              {step.message}
            </p>
          )}
        </div>
        <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
          <StepStatusIcon status={status} />
          {STEP_STATUS[status]}
          {elapsed !== undefined ? ` · ${compactDuration(elapsed)}` : ""}
        </span>
      </div>

      {hasPayload && (
        <details className="mt-2 rounded-lg border border-border/80 bg-background/70">
          <summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
            {labels.payload}
          </summary>
          <div className="space-y-3 border-t border-border p-3">
            {step.input !== undefined && (
              <div className="min-w-0">
                <p className="mb-1 text-[11px] font-medium text-muted-foreground">{labels.input}</p>
                <pre className="max-h-52 overflow-auto rounded-md bg-muted/60 p-2 text-[11px] leading-relaxed">
                  {jsonText(step.input, redactKeys)}
                </pre>
              </div>
            )}
            {step.output !== undefined && (
              <div className="min-w-0">
                <p className="mb-1 text-[11px] font-medium text-muted-foreground">
                  {labels.output}
                </p>
                <pre className="max-h-52 overflow-auto rounded-md bg-muted/60 p-2 text-[11px] leading-relaxed">
                  {jsonText(step.output, redactKeys)}
                </pre>
              </div>
            )}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-[10px] text-muted-foreground">{labels.redactionNote}</p>
              <Button type="button" size="sm" variant="outline" onClick={() => void handleCopy()}>
                {copied ? (
                  <Check className="size-3.5" aria-hidden />
                ) : (
                  <Clipboard className="size-3.5" aria-hidden />
                )}
                {copied ? labels.copied : labels.copyStep}
              </Button>
            </div>
          </div>
        </details>
      )}
    </li>
  );
}

export function AgentRunInspector({
  run,
  className,
  labels: labelsOverride,
  redactKeys = [],
}: AgentRunInspectorProps) {
  const [copied, setCopied] = useState(false);
  const labels = useMemo(() => ({ ...DEFAULT_LABELS, ...labelsOverride }), [labelsOverride]);
  const status = RUN_STATUS[run.status];
  const rounds = roundCount(run);
  const tools = toolCount(run);
  const tokens = tokenCount(run);
  const elapsed = durationMs(run);
  const tokenSummary = tokens
    ? `${tokens.estimated ? "≈" : ""}${compactNumber(tokens.value)} token`
    : "token 未知";
  const summary = `${status.label} · ${rounds} 轮 · ${tools} 个工具 · ${tokenSummary} · ${compactDuration(elapsed)}`;

  const groupedSteps = useMemo(() => {
    const groups = new Map<number, AgentStep[]>();
    run.steps.forEach((step) => {
      const round = Math.max(0, step.round ?? 0);
      groups.set(round, [...(groups.get(round) ?? []), step]);
    });
    return [...groups.entries()].sort(([left], [right]) => left - right);
  }, [run.steps]);

  const handleCopy = async () => {
    await copyText(jsonText(run, redactKeys));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  };

  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          type="button"
          className={cn(
            "flex w-full min-w-0 items-center gap-2 rounded-lg border border-border bg-card/50 px-3 py-2 text-left transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
            className,
          )}
          aria-label={`${labels.details}：${summary}`}
        >
          <span
            className={cn(
              "shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium",
              status.className,
            )}
          >
            {status.label}
          </span>
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            {rounds} 轮 · {tools} 个工具 · {tokenSummary} · {compactDuration(elapsed)}
          </span>
          <span className="shrink-0 text-xs font-medium text-primary">{labels.details}</span>
        </button>
      </DialogTrigger>

      <DialogContent
        className="flex max-h-[calc(100vh-2rem)] w-[calc(100vw-2rem)] max-w-3xl grid-cols-none flex-col gap-0 overflow-hidden p-0 sm:rounded-2xl"
        data-testid="agent-run-details"
      >
        <DialogHeader className="shrink-0 border-b border-border px-5 py-4 pr-14 text-left">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <DialogTitle className="min-w-0 break-words">
              {run.title || run.agentName || labels.details}
            </DialogTitle>
            <span
              className={cn(
                "shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium",
                status.className,
              )}
            >
              {status.label}
            </span>
          </div>
          <DialogDescription className="break-words text-xs">
            {summary}
            {run.model ? ` · ${run.model}` : ""}
            {` · run ${run.id}`}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 sm:px-5">
          {groupedSteps.length ? (
            <div className="space-y-5">
              {groupedSteps.map(([round, steps]) => (
                <section key={round} aria-labelledby={`agent-run-${run.id}-round-${round}`}>
                  <h3
                    id={`agent-run-${run.id}-round-${round}`}
                    className="mb-2 text-xs font-semibold text-muted-foreground"
                  >
                    {round > 0 ? labels.round(round) : labels.preparation}
                  </h3>
                  <ol className="space-y-2">
                    {steps.map((step) => (
                      <AgentStepRow
                        key={step.id}
                        step={step}
                        labels={labels}
                        redactKeys={redactKeys}
                      />
                    ))}
                  </ol>
                </section>
              ))}
            </div>
          ) : (
            <p className="rounded-xl border border-dashed border-border p-4 text-sm text-muted-foreground">
              暂无运行步骤。
            </p>
          )}
        </div>

        <DialogFooter className="shrink-0 flex-row items-center justify-between gap-2 border-t border-border px-4 py-3 sm:px-5">
          <span className="min-w-0 text-[10px] text-muted-foreground" aria-live="polite">
            {copied ? labels.copied : labels.redactionNote}
          </span>
          <div className="flex shrink-0 items-center gap-2">
            <Button type="button" size="sm" variant="outline" onClick={() => void handleCopy()}>
              {copied ? (
                <Check className="size-3.5" aria-hidden />
              ) : (
                <Clipboard className="size-3.5" aria-hidden />
              )}
              {copied ? labels.copied : labels.copyRun}
            </Button>
            <DialogClose asChild>
              <Button type="button" size="sm">
                {labels.close}
              </Button>
            </DialogClose>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
