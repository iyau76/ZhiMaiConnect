export type AgentRunStatus =
  "pending" | "running" | "completed" | "suspended" | "failed" | "cancelled" | "budget_exceeded";

export type AgentStepKind = "model" | "tool" | "validation" | "proposal" | "approval" | "system";

export type AgentStepStatus = "pending" | "running" | "completed" | "failed" | "skipped";

export interface AgentTokenUsage {
  input?: number;
  output?: number;
  total?: number;
  /** True when all or part of the displayed total was estimated. */
  estimated?: boolean;
  /** Exact provenance for consumers that distinguish mixed provider/local counts. */
  provenance?: "actual" | "estimated" | "mixed";
  actualCount?: number;
  estimatedCount?: number;
}

/**
 * Presentation contract for one observable Agent action. It deliberately does
 * not model private chain-of-thought; callers should provide action summaries,
 * tool I/O, validation results and approval events.
 */
export interface AgentStep {
  id: string;
  round?: number;
  kind: AgentStepKind;
  status?: AgentStepStatus;
  title?: string;
  message?: string;
  toolName?: string;
  input?: unknown;
  output?: unknown;
  /** Input-contract result correlated to this tool invocation. */
  validation?: {
    status?: AgentStepStatus;
    output?: unknown;
  };
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
}

/** Lightweight adapter target; existing Agent implementations can map to it incrementally. */
export interface AgentRun {
  id: string;
  title?: string;
  agentName?: string;
  model?: string;
  status: AgentRunStatus;
  rounds?: number;
  tokenUsage?: AgentTokenUsage;
  /** Used when no provider usage is available. */
  estimatedTokens?: number;
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
  steps: readonly AgentStep[];
}

const DEFAULT_SENSITIVE_KEYS = [
  "apiKey",
  "api_key",
  "authorization",
  "cookie",
  "set-cookie",
  "password",
  "passwd",
  "secret",
  "token",
  "accessToken",
  "access_token",
  "refreshToken",
  "refresh_token",
  "sessionToken",
  "session_token",
  "credential",
  "email",
  "phone",
  "mobile",
  "contact",
  "account",
];

function normalizedKey(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function redactString(value: string) {
  const redacted = value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, "[REDACTED_EMAIL]")
    .replace(/(?<!\d)(?:\+?86[- ]?)?1[3-9]\d(?:[- ]?\d){8}(?!\d)/g, "[REDACTED_PHONE]")
    .replace(
      /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|session[_-]?token|password|secret)\s*[:=]\s*)[^\s,;]+/gi,
      "$1[REDACTED]",
    );
  return redacted.length > 8_000 ? `${redacted.slice(0, 8_000)}…[TRUNCATED]` : redacted;
}

/**
 * Produces a JSON-safe copy and redacts credentials before anything reaches
 * the DOM or clipboard. Circular references and very large collections are
 * bounded so a diagnostic payload cannot freeze the inspector.
 */
export function redactAgentPayload(value: unknown, extraKeys: readonly string[] = []): unknown {
  const sensitive = new Set([...DEFAULT_SENSITIVE_KEYS, ...extraKeys].map(normalizedKey));
  const seen = new WeakSet<object>();

  const visit = (current: unknown, depth: number): unknown => {
    if (depth > 10) return "[MAX_DEPTH]";
    if (current === null || typeof current === "number" || typeof current === "boolean") {
      return current;
    }
    if (typeof current === "string") return redactString(current);
    if (typeof current === "bigint") return current.toString();
    if (current === undefined) return null;
    if (typeof current === "function" || typeof current === "symbol") {
      return `[UNSUPPORTED:${typeof current}]`;
    }
    if (current instanceof Date) return current.toISOString();
    if (current instanceof Error) {
      const extended = current as Error & {
        status?: unknown;
        code?: unknown;
        diagnostics?: unknown;
      };
      return {
        name: current.name,
        message: redactString(current.message),
        ...(typeof extended.status === "number" ? { status: extended.status } : {}),
        ...(typeof extended.code === "string" ? { code: redactString(extended.code) } : {}),
        ...(extended.diagnostics !== undefined
          ? { diagnostics: visit(extended.diagnostics, depth + 1) }
          : {}),
      };
    }
    if (typeof current !== "object") return String(current);
    if (seen.has(current)) return "[CIRCULAR]";
    seen.add(current);

    if (Array.isArray(current)) {
      const limit = 100;
      const rows = current.slice(0, limit).map((item) => visit(item, depth + 1));
      if (current.length > limit) rows.push(`[${current.length - limit} MORE ITEMS]`);
      return rows;
    }

    const entries = Object.entries(current as Record<string, unknown>);
    const result: Record<string, unknown> = {};
    entries.slice(0, 150).forEach(([key, item]) => {
      result[key] = sensitive.has(normalizedKey(key)) ? "[REDACTED]" : visit(item, depth + 1);
    });
    if (entries.length > 150) result.__truncated__ = `${entries.length - 150} MORE FIELDS`;
    return result;
  };

  return visit(value, 0);
}

export type AgentRunEventKind =
  | "model_request"
  | "model_response"
  | "tool_call"
  | "tool_result"
  | "validation"
  | "proposal"
  | "approval"
  | "commit"
  | "budget"
  | "finalize"
  | "error";

export type AgentRunEventStatus = "started" | "succeeded" | "failed" | "blocked";

export interface AgentTokenCount {
  value: number;
  /** Provider usage is actual; a local approximation is estimated. */
  source: "actual" | "estimated";
}

export interface AgentRunEventTokenUsage {
  input?: AgentTokenCount;
  output?: AgentTokenCount;
}

export interface AgentRunEvent {
  id: string;
  runId: string;
  sequence: number;
  at: number;
  kind: AgentRunEventKind;
  status?: AgentRunEventStatus;
  round?: number;
  toolName?: string;
  /** Correlates one tool_call with its validation and tool_result events. */
  invocationId?: string;
  durationMs?: number;
  payload?: unknown;
  usage?: AgentRunEventTokenUsage;
}

export interface AgentRunEventInput extends Omit<
  AgentRunEvent,
  "id" | "runId" | "sequence" | "at" | "payload"
> {
  at?: number;
  payload?: unknown;
  /** Runs before mandatory baseline redaction. */
  redact?: (payload: unknown) => unknown;
}

export interface AgentRunRecorder {
  readonly runId: string;
  record(event: AgentRunEventInput): AgentRunEvent;
  events(): AgentRunEvent[];
}

export interface AgentRunTokenTotals {
  input: { total: number; actual: number; estimated: number };
  output: { total: number; actual: number; estimated: number };
}

export function summarizeAgentRunTokens(events: readonly AgentRunEvent[]): AgentRunTokenTotals {
  const totals: AgentRunTokenTotals = {
    input: { total: 0, actual: 0, estimated: 0 },
    output: { total: 0, actual: 0, estimated: 0 },
  };
  events.forEach((event) => {
    (["input", "output"] as const).forEach((direction) => {
      const count = event.usage?.[direction];
      if (!count) return;
      totals[direction].total += count.value;
      totals[direction][count.source] += count.value;
    });
  });
  return totals;
}

/** In-memory recorder used by an Agent run and consumed by persistence/UI adapters. */
export class MemoryAgentRunRecorder implements AgentRunRecorder {
  readonly runId: string;
  private readonly now: () => number;
  private readonly rows: AgentRunEvent[] = [];

  constructor(options: { runId?: string; now?: () => number } = {}) {
    this.runId = options.runId ?? crypto.randomUUID();
    this.now = options.now ?? Date.now;
  }

  record(input: AgentRunEventInput): AgentRunEvent {
    const sequence = this.rows.length + 1;
    const { redact, payload, at, ...details } = input;
    const toolRedacted = redact ? redact(payload) : payload;
    const event: AgentRunEvent = {
      ...details,
      id: `${this.runId}:${sequence}`,
      runId: this.runId,
      sequence,
      at: at ?? this.now(),
      payload: payload === undefined ? undefined : redactAgentPayload(toolRedacted),
    };
    this.rows.push(event);
    return { ...event };
  }

  events() {
    return this.rows.map((event) => ({
      ...event,
      usage: event.usage
        ? {
            input: event.usage.input ? { ...event.usage.input } : undefined,
            output: event.usage.output ? { ...event.usage.output } : undefined,
          }
        : undefined,
      payload: event.payload === undefined ? undefined : redactAgentPayload(event.payload),
    }));
  }

  clear() {
    this.rows.length = 0;
  }

  tokenTotals() {
    return summarizeAgentRunTokens(this.rows);
  }
}

const EVENT_STEP_KIND: Record<AgentRunEventKind, AgentStepKind> = {
  model_request: "model",
  model_response: "model",
  tool_call: "tool",
  tool_result: "tool",
  validation: "validation",
  proposal: "proposal",
  approval: "approval",
  commit: "system",
  budget: "system",
  finalize: "system",
  error: "system",
};

const EVENT_STEP_STATUS: Record<AgentRunEventStatus, AgentStepStatus> = {
  started: "running",
  succeeded: "completed",
  failed: "failed",
  blocked: "skipped",
};

function projectedRunStatus(events: readonly AgentRunEvent[]): AgentRunStatus {
  const finalEvent = [...events].reverse().find((event) => event.kind === "finalize");
  const reason = (finalEvent?.payload as { reason?: unknown } | undefined)?.reason;
  if (reason === "completed" || reason === "manual") return "completed";
  if (reason === "suspended") return "suspended";
  if (reason === "aborted") return "cancelled";
  if (typeof reason === "string" && reason.startsWith("max_")) return "budget_exceeded";
  if (events.some((event) => event.kind === "error" && event.status === "failed")) {
    return "failed";
  }
  return events.length ? "running" : "pending";
}

function projectEventStep(event: AgentRunEvent): AgentStep {
  const kind = EVENT_STEP_KIND[event.kind];
  return {
    id: event.id,
    round: event.round,
    kind,
    status: event.status ? EVENT_STEP_STATUS[event.status] : undefined,
    title: event.toolName ?? event.kind,
    // Validation may name its subject in the title, but it is not another tool execution.
    toolName: kind === "tool" ? event.toolName : undefined,
    input: event.kind === "model_request" || event.kind === "tool_call" ? event.payload : undefined,
    output:
      event.kind !== "model_request" && event.kind !== "tool_call" ? event.payload : undefined,
    startedAt: event.at,
    endedAt: event.status === "started" ? undefined : event.at,
    durationMs: event.durationMs,
  };
}

function legacyInvocationKey(event: AgentRunEvent) {
  return `${event.round ?? "unscoped"}\u0000${event.toolName ?? "unknown"}`;
}

function projectAgentSteps(events: readonly AgentRunEvent[]) {
  const steps: AgentStep[] = [];
  const pendingModels = new Map<number, AgentStep[]>();
  const pendingByInvocation = new Map<string, AgentStep>();
  const pendingLegacy = new Map<string, AgentStep[]>();

  events.forEach((event) => {
    if (event.kind === "model_request") {
      const step = { ...projectEventStep(event), title: "model_round" };
      steps.push(step);
      const round = event.round ?? 0;
      pendingModels.set(round, [...(pendingModels.get(round) ?? []), step]);
      return;
    }

    if (event.kind === "model_response") {
      const round = event.round ?? 0;
      const queue = pendingModels.get(round);
      const requestStep = queue?.shift();
      if (!queue?.length) pendingModels.delete(round);
      if (requestStep) {
        requestStep.output = event.payload;
        requestStep.status = event.status ? EVENT_STEP_STATUS[event.status] : requestStep.status;
        requestStep.endedAt = event.at;
        requestStep.durationMs =
          event.durationMs ?? Math.max(0, event.at - (requestStep.startedAt ?? event.at));
        return;
      }
    }

    if (event.kind === "tool_call") {
      const step = projectEventStep(event);
      steps.push(step);
      if (event.invocationId) {
        pendingByInvocation.set(event.invocationId, step);
      } else {
        const key = legacyInvocationKey(event);
        pendingLegacy.set(key, [...(pendingLegacy.get(key) ?? []), step]);
      }
      return;
    }

    if (event.kind === "validation" && event.invocationId) {
      const callStep = pendingByInvocation.get(event.invocationId);
      if (callStep) {
        callStep.validation = {
          status: event.status ? EVENT_STEP_STATUS[event.status] : undefined,
          output: event.payload,
        };
        return;
      }
    }

    if (event.kind === "tool_result") {
      let callStep: AgentStep | undefined;
      if (event.invocationId) {
        callStep = pendingByInvocation.get(event.invocationId);
        pendingByInvocation.delete(event.invocationId);
      } else {
        const key = legacyInvocationKey(event);
        const queue = pendingLegacy.get(key);
        callStep = queue?.shift();
        if (!queue?.length) pendingLegacy.delete(key);
      }
      if (callStep) {
        callStep.output = event.payload;
        callStep.status = event.status ? EVENT_STEP_STATUS[event.status] : callStep.status;
        callStep.endedAt = event.at;
        callStep.durationMs =
          event.durationMs ?? Math.max(0, event.at - (callStep.startedAt ?? event.at));
        return;
      }
    }

    steps.push(projectEventStep(event));
  });

  return steps;
}

/**
 * Adapter from the append-only runtime ledger to the existing inspector view.
 * UI code never needs to reinterpret runtime events or token provenance.
 */
export function projectAgentRun(
  events: readonly AgentRunEvent[],
  metadata: Pick<AgentRun, "id"> & Partial<Omit<AgentRun, "id" | "steps">>,
): AgentRun {
  const ordered = [...events].sort((left, right) => left.sequence - right.sequence);
  const tokens = summarizeAgentRunTokens(ordered);
  const actualTokens = tokens.input.actual + tokens.output.actual;
  const estimatedTokens = tokens.input.estimated + tokens.output.estimated;
  const tokenProvenance =
    actualTokens > 0 && estimatedTokens > 0
      ? "mixed"
      : estimatedTokens > 0
        ? "estimated"
        : "actual";
  const startedAt = ordered[0]?.at;
  const endedAt = ordered.at(-1)?.at;
  return {
    ...metadata,
    status: metadata.status ?? projectedRunStatus(ordered),
    rounds:
      metadata.rounds ?? ordered.reduce((maximum, event) => Math.max(maximum, event.round ?? 0), 0),
    tokenUsage:
      metadata.tokenUsage ??
      (actualTokens || estimatedTokens
        ? {
            input: tokens.input.total,
            output: tokens.output.total,
            total: tokens.input.total + tokens.output.total,
            estimated: estimatedTokens > 0,
            provenance: tokenProvenance,
            actualCount: actualTokens,
            estimatedCount: estimatedTokens,
          }
        : undefined),
    estimatedTokens: metadata.estimatedTokens ?? (estimatedTokens || undefined),
    startedAt: metadata.startedAt ?? startedAt,
    endedAt: metadata.endedAt ?? endedAt,
    durationMs:
      metadata.durationMs ??
      (startedAt !== undefined && endedAt !== undefined ? endedAt - startedAt : undefined),
    steps: projectAgentSteps(ordered),
  };
}
