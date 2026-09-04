import type { AgentTraceEvent } from "./agent-trace";

/** 「AI 整理」跑在模块层，切到别的页签也不会中断；回到录入页再认领结果 */

export interface IntakeJobState {
  busy: boolean;
  /** 面向用户的单行处理轨迹；不保存模型原始 JSON。 */
  trace: IntakeJobTrace[];
  /** 整理完但还没被界面认领的结果 */
  result: unknown | null;
  error: string | null;
  /** 本轮的补充材料（有值说明是「补充再整理」） */
  extra: string | null;
  /** 本轮送去整理的完整材料 */
  text: string | null;
}

export interface IntakeJobTrace extends AgentTraceEvent {
  at: number;
}

export type IntakeJobReporter = (text: string, kind?: IntakeJobTrace["kind"]) => void;

const IDLE: IntakeJobState = {
  busy: false,
  trace: [],
  result: null,
  error: null,
  extra: null,
  text: null,
};

let state: IntakeJobState = IDLE;
let activeRunId = 0;
const listeners = new Set<() => void>();

function set(next: IntakeJobState) {
  state = next;
  listeners.forEach((fn) => fn());
}

export function getIntakeJob() {
  return state;
}

export function subscribeIntakeJob(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** 界面拿走结果后清空，避免重复应用 */
export function claimIntakeJob() {
  if (state.result === null && state.error === null) return;
  set({ ...IDLE, busy: state.busy, trace: state.trace });
}

/**
 * Rebuild the transient page projection from the durable Agent ledger.
 * The ledger remains authoritative; this module only feeds useSyncExternalStore.
 */
export function restoreIntakeJob(input: {
  trace: IntakeJobTrace[];
  text: string | null;
  extra: string | null;
  result?: unknown | null;
  error?: string | null;
}) {
  activeRunId += 1;
  set({
    busy: false,
    trace: input.trace.slice(-24),
    result: input.result ?? null,
    error: input.error ?? null,
    extra: input.extra,
    text: input.text,
  });
}

/** 启动一次整理；已经在跑就忽略 */
export function startIntakeJob(options: {
  text: string;
  extra: string | null;
  initialTrace: string;
  priorTrace?: IntakeJobTrace[];
  run: (report: IntakeJobReporter) => Promise<unknown>;
}) {
  if (state.busy) return;
  activeRunId += 1;
  const runId = activeRunId;
  const runStartedAt = Date.now();
  const report: IntakeJobReporter = (text, kind = "status") => {
    if (!state.busy || activeRunId !== runId) return;
    set({
      ...state,
      trace: [...state.trace.slice(-23), { kind, text, at: Date.now() }],
    });
  };
  set({
    busy: true,
    trace: [
      ...(options.priorTrace ?? []).slice(-23),
      { kind: "status" as const, text: options.initialTrace, at: runStartedAt },
    ].slice(-24),
    result: null,
    error: null,
    extra: options.extra,
    text: options.text,
  });
  options
    .run(report)
    .then((result) => {
      set({
        busy: false,
        trace: state.trace,
        result,
        error: null,
        extra: options.extra,
        text: options.text,
      });
    })
    .catch((error: unknown) => {
      const message = (error as Error)?.message || "整理失败";
      set({
        busy: false,
        trace: [...state.trace.slice(-23), { kind: "error", text: message, at: Date.now() }],
        result: null,
        error: message,
        extra: options.extra,
        text: options.text,
      });
    });
}
