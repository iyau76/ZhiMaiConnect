import { z } from "zod";

import { isAgentDeadlineExceeded, withAgentDeadline } from "./agent-deadline";
import { classifyAgentIssue, type AgentIssueClassification } from "./agent-issue-classifier";
import {
  MemoryAgentRunRecorder,
  type AgentRunEventStatus,
  type AgentRunIssueCategory,
  type AgentRunRecorder,
  type AgentTokenCount,
} from "./agent-run-log";
import { AgentToolRegistry, type AgentToolPermission } from "./agent-tool-registry";
import { ModelTransportError, runWithTransientModelRetries } from "./model-transport-resilience";

export const agentBudgetSchema = z
  .object({
    maxRounds: z.number().int().positive(),
    maxToolCalls: z.number().int().nonnegative(),
    maxInputTokens: z.number().int().positive(),
    maxOutputTokens: z.number().int().positive(),
    maxWallTimeMs: z.number().int().positive(),
  })
  .strict();

export type AgentBudget = z.infer<typeof agentBudgetSchema>;

export const AGENT_BUDGET_PRESETS = {
  quick: {
    maxRounds: 3,
    maxToolCalls: 4,
    maxInputTokens: 12_000,
    maxOutputTokens: 2_000,
    maxWallTimeMs: 45_000,
  },
  standard: {
    maxRounds: 7,
    maxToolCalls: 12,
    maxInputTokens: 40_000,
    maxOutputTokens: 8_000,
    maxWallTimeMs: 120_000,
  },
  deep: {
    maxRounds: 12,
    maxToolCalls: 32,
    maxInputTokens: 120_000,
    maxOutputTokens: 24_000,
    maxWallTimeMs: 300_000,
  },
} as const satisfies Record<string, AgentBudget>;

export type AgentBudgetPreset = keyof typeof AGENT_BUDGET_PRESETS;

export type AgentFinalizeReason =
  | "completed"
  | "manual"
  | "suspended"
  | "aborted"
  | "max_rounds"
  | "max_tool_calls"
  | "max_input_tokens"
  | "max_output_tokens"
  | "max_wall_time";

export interface AgentBudgetTokenState {
  total: number;
  actual: number;
  estimated: number;
}

export interface AgentBudgetSnapshot {
  limits: AgentBudget;
  rounds: number;
  toolCalls: number;
  inputTokens: AgentBudgetTokenState;
  outputTokens: AgentBudgetTokenState;
  startedAt: number;
  elapsedMs: number;
  remaining: {
    rounds: number;
    toolCalls: number;
    inputTokens: number;
    outputTokens: number;
    wallTimeMs: number;
  };
}

export interface AgentModelTurnPolicy {
  absoluteRound: number;
  maxRounds: number;
  remainingRounds: number;
  finalOnly: boolean;
}

/**
 * Describe the next model turn from the live budget ledger. Agent protocols
 * use this same policy both when rendering allowed response types and when
 * dispatching the parsed response, so the last round cannot spend itself on a
 * tool call with no synthesis round left.
 */
export function nextAgentModelTurn(snapshot: AgentBudgetSnapshot): AgentModelTurnPolicy | null {
  if (snapshot.remaining.rounds < 1) return null;
  return {
    absoluteRound: snapshot.rounds + 1,
    maxRounds: snapshot.limits.maxRounds,
    remainingRounds: snapshot.remaining.rounds,
    finalOnly: snapshot.remaining.rounds === 1,
  };
}

export interface AgentContinueDecision {
  status: "continue";
  budget: AgentBudgetSnapshot;
}

export interface AgentFinalizeDecision {
  status: "finalize";
  reason: AgentFinalizeReason;
  budget: AgentBudgetSnapshot;
}

export type AgentBudgetDecision = AgentContinueDecision | AgentFinalizeDecision;

function validateTokenCount(count: AgentTokenCount) {
  if (!Number.isInteger(count.value) || count.value < 0) {
    throw new TypeError(`Token count must be a non-negative integer: ${count.value}`);
  }
  return count;
}

function emptyTokenState(): AgentBudgetTokenState {
  return { total: 0, actual: 0, estimated: 0 };
}

function addTokenCount(target: AgentBudgetTokenState, count: AgentTokenCount) {
  validateTokenCount(count);
  target.total += count.value;
  target[count.source] += count.value;
}

export function resolveAgentBudget(budget: AgentBudgetPreset | AgentBudget = "standard") {
  const selected = typeof budget === "string" ? AGENT_BUDGET_PRESETS[budget] : budget;
  return agentBudgetSchema.parse({ ...selected });
}

/**
 * A deterministic cumulative budget ledger. It never sleeps or aborts work;
 * callers receive a finalize decision and own transport cancellation.
 */
export class ContextBudget {
  readonly limits: AgentBudget;
  private readonly now: () => number;
  private readonly startedAt: number;
  private rounds = 0;
  private toolCalls = 0;
  private readonly inputTokens = emptyTokenState();
  private readonly outputTokens = emptyTokenState();

  constructor(
    budget: AgentBudgetPreset | AgentBudget = "standard",
    options: { now?: () => number } = {},
  ) {
    this.limits = resolveAgentBudget(budget);
    this.now = options.now ?? Date.now;
    this.startedAt = this.now();
  }

  snapshot(): AgentBudgetSnapshot {
    const elapsedMs = Math.max(0, this.now() - this.startedAt);
    return {
      limits: { ...this.limits },
      rounds: this.rounds,
      toolCalls: this.toolCalls,
      inputTokens: { ...this.inputTokens },
      outputTokens: { ...this.outputTokens },
      startedAt: this.startedAt,
      elapsedMs,
      remaining: {
        rounds: Math.max(0, this.limits.maxRounds - this.rounds),
        toolCalls: Math.max(0, this.limits.maxToolCalls - this.toolCalls),
        inputTokens: Math.max(0, this.limits.maxInputTokens - this.inputTokens.total),
        outputTokens: Math.max(0, this.limits.maxOutputTokens - this.outputTokens.total),
        wallTimeMs: Math.max(0, this.limits.maxWallTimeMs - elapsedMs),
      },
    };
  }

  checkpoint(): AgentBudgetDecision {
    const snapshot = this.snapshot();
    if (snapshot.elapsedMs >= this.limits.maxWallTimeMs) {
      return { status: "finalize", reason: "max_wall_time", budget: snapshot };
    }
    if (snapshot.outputTokens.total >= this.limits.maxOutputTokens) {
      return { status: "finalize", reason: "max_output_tokens", budget: snapshot };
    }
    if (snapshot.inputTokens.total >= this.limits.maxInputTokens) {
      return { status: "finalize", reason: "max_input_tokens", budget: snapshot };
    }
    return { status: "continue", budget: snapshot };
  }

  claimModelRound(input: AgentTokenCount): AgentBudgetDecision {
    validateTokenCount(input);
    const checkpoint = this.checkpoint();
    if (checkpoint.status === "finalize") return checkpoint;
    if (this.rounds >= this.limits.maxRounds) {
      return { status: "finalize", reason: "max_rounds", budget: this.snapshot() };
    }
    if (this.inputTokens.total + input.value > this.limits.maxInputTokens) {
      return {
        status: "finalize",
        reason: "max_input_tokens",
        budget: this.snapshot(),
      };
    }
    this.rounds += 1;
    addTokenCount(this.inputTokens, input);
    return { status: "continue", budget: this.snapshot() };
  }

  claimToolCall(): AgentBudgetDecision {
    const checkpoint = this.checkpoint();
    if (checkpoint.status === "finalize") return checkpoint;
    if (this.toolCalls >= this.limits.maxToolCalls) {
      return {
        status: "finalize",
        reason: "max_tool_calls",
        budget: this.snapshot(),
      };
    }
    this.toolCalls += 1;
    return { status: "continue", budget: this.snapshot() };
  }

  recordModelOutput(output: AgentTokenCount): AgentBudgetDecision {
    addTokenCount(this.outputTokens, output);
    return this.checkpoint();
  }
}

/** A provider-independent fallback. Provider usage should replace it when available. */
export function estimateAgentTokens(value: unknown): AgentTokenCount {
  const text = typeof value === "string" ? value : JSON.stringify(value) || "";
  let cjkCharacters = 0;
  let otherCharacters = 0;
  for (const character of text) {
    if (/\p{Script=Han}/u.test(character)) cjkCharacters += 1;
    else otherCharacters += 1;
  }
  return {
    value: Math.max(1, cjkCharacters + Math.ceil(otherCharacters / 4)),
    source: "estimated",
  };
}

export interface AgentModelRetryEvent {
  round: number;
  failedAttempt: number;
  nextAttempt: number;
  delayMs: number;
  error: unknown;
}

export interface AgentModelRetryOptions {
  maxAttempts?: number;
  delaysMs?: readonly number[];
  onRetry?: (event: AgentModelRetryEvent) => void;
}

export interface AgentRuntimeOptions<TServices> {
  registry: AgentToolRegistry<TServices>;
  services: TServices;
  permissions?: ReadonlySet<AgentToolPermission> | readonly AgentToolPermission[];
  toolNames?: ReadonlySet<string> | readonly string[];
  budget?: AgentBudgetPreset | AgentBudget;
  recorder?: AgentRunRecorder;
  signal?: AbortSignal;
  now?: () => number;
  /** Logical round offset used when a suspended run resumes in a new runtime. */
  roundOffset?: number;
  /** Finite transport retry policy shared by every model round. */
  modelRetry?: AgentModelRetryOptions;
}

export interface AgentModelRoundInput {
  payload: unknown;
  tokens?: AgentTokenCount;
}

export type AgentModelRoundDecision =
  (AgentContinueDecision & { round: number }) | AgentFinalizeDecision;

export type AgentToolExecutionDecision =
  | { status: "ok"; value: unknown; budget: AgentBudgetSnapshot }
  | {
      status: "failed";
      error: unknown;
      issue: AgentIssueClassification;
      budget: AgentBudgetSnapshot;
    }
  | AgentFinalizeDecision;

export interface AgentModelInvocationResult<T> {
  value: T;
  /** Logged response payload; defaults to value. */
  payload?: unknown;
  tokens?: AgentTokenCount;
}

export type AgentModelExecutionDecision<T> =
  | {
      status: "ok";
      value: T;
      budget: AgentBudgetSnapshot;
      /** Present when the response consumed the final available budget. */
      finalize?: AgentFinalizeDecision;
    }
  | {
      status: "failed";
      error: unknown;
      issue: AgentIssueClassification;
      budget: AgentBudgetSnapshot;
    }
  | AgentFinalizeDecision;

type LifecycleEventKind = "proposal" | "approval" | "commit" | "validation";

export class AgentRuntime<TServices = unknown> {
  readonly registry: AgentToolRegistry<TServices>;
  readonly recorder: AgentRunRecorder;
  readonly contextBudget: ContextBudget;
  private readonly services: TServices;
  private readonly permissions: ReadonlySet<AgentToolPermission>;
  private readonly toolNames?: ReadonlySet<string>;
  private readonly signal?: AbortSignal;
  private readonly now: () => number;
  private readonly roundOffset: number;
  private readonly modelRetry: AgentModelRetryOptions;
  private finalDecision?: AgentFinalizeDecision;

  constructor(options: AgentRuntimeOptions<TServices>) {
    this.registry = options.registry;
    this.services = options.services;
    this.permissions =
      options.permissions instanceof Set
        ? options.permissions
        : new Set(options.permissions ?? ["public_read"]);
    this.toolNames = options.toolNames
      ? options.toolNames instanceof Set
        ? options.toolNames
        : new Set(options.toolNames)
      : undefined;
    this.now = options.now ?? Date.now;
    this.roundOffset = Math.max(0, Math.trunc(options.roundOffset ?? 0));
    this.modelRetry = options.modelRetry ?? {};
    this.recorder = options.recorder ?? new MemoryAgentRunRecorder({ now: this.now });
    this.contextBudget = new ContextBudget(options.budget, { now: this.now });
    this.signal = options.signal;
  }

  private abortDecision() {
    return this.signal?.aborted ? this.finalize("aborted") : undefined;
  }

  private finalizeBudget(decision: AgentFinalizeDecision) {
    const issue = classifyAgentIssue(decision.reason, { phase: "budget" });
    this.recorder.record({
      kind: "budget",
      status: "blocked",
      issueCategory: issue.category,
      payload: { reason: decision.reason, snapshot: decision.budget },
    });
    return this.finalize(decision.reason);
  }

  beginModelRound(input: AgentModelRoundInput): AgentModelRoundDecision {
    if (this.finalDecision) return this.finalDecision;
    const aborted = this.abortDecision();
    if (aborted) return aborted;
    const tokens = input.tokens ?? estimateAgentTokens(input.payload);
    const decision = this.contextBudget.claimModelRound(tokens);
    if (decision.status === "finalize") return this.finalizeBudget(decision);
    const round = decision.budget.rounds + this.roundOffset;
    this.recorder.record({
      kind: "model_request",
      status: "started",
      round,
      payload: input.payload,
      usage: { input: tokens },
    });
    return { ...decision, round };
  }

  completeModelRound(input: AgentModelRoundInput): AgentBudgetDecision {
    if (this.finalDecision) return this.finalDecision;
    const tokens = input.tokens ?? estimateAgentTokens(input.payload);
    this.recorder.record({
      kind: "model_response",
      status: "succeeded",
      round: this.contextBudget.snapshot().rounds + this.roundOffset,
      payload: input.payload,
      usage: { output: tokens },
    });
    const decision = this.contextBudget.recordModelOutput(tokens);
    return decision.status === "finalize" ? this.finalizeBudget(decision) : decision;
  }

  async executeTool(name: string, input: unknown): Promise<AgentToolExecutionDecision> {
    if (this.finalDecision) return this.finalDecision;
    const aborted = this.abortDecision();
    if (aborted) return aborted;
    const budgetDecision = this.contextBudget.claimToolCall();
    if (budgetDecision.status === "finalize") return this.finalizeBudget(budgetDecision);
    try {
      const value = await withAgentDeadline(
        (signal) =>
          this.registry.execute(name, input, {
            services: this.services,
            recorder: this.recorder,
            permissions: this.permissions,
            allowedToolNames: this.toolNames,
            round: budgetDecision.budget.rounds + this.roundOffset,
            signal,
            now: this.now,
          }),
        {
          timeoutMs: budgetDecision.budget.remaining.wallTimeMs,
          signals: [this.signal],
          now: this.now,
        },
      );
      return { status: "ok", value, budget: this.contextBudget.snapshot() };
    } catch (error) {
      if (isAgentDeadlineExceeded(error)) {
        return this.finalizeBudget({
          status: "finalize",
          reason: "max_wall_time",
          budget: this.contextBudget.snapshot(),
        });
      }
      if (this.signal?.aborted) return this.finalize("aborted");
      return {
        status: "failed",
        error,
        issue: classifyAgentIssue(error, { phase: "tool" }),
        budget: this.contextBudget.snapshot(),
      };
    }
  }

  async runModelRound<T>(
    input: AgentModelRoundInput,
    invoke: (signal: AbortSignal) => PromiseLike<AgentModelInvocationResult<T>>,
  ): Promise<AgentModelExecutionDecision<T>> {
    const started = this.beginModelRound(input);
    if (started.status === "finalize") return started;
    try {
      const response = await withAgentDeadline(
        async (signal) => {
          const attempted = await runWithTransientModelRetries({
            maxAttempts: this.modelRetry.maxAttempts,
            delaysMs: this.modelRetry.delaysMs,
            signal,
            invoke: async () => {
              const result = await invoke(signal);
              if (typeof result.value === "string" && !result.value.trim()) {
                throw new ModelTransportError("上游模型返回空响应", 502, "UPSTREAM_EMPTY_RESPONSE");
              }
              return result;
            },
            onRetry: (event) => {
              const retryEvent: AgentModelRetryEvent = { ...event, round: started.round };
              const issue = classifyAgentIssue(event.error, { phase: "model" });
              this.recorder.record({
                kind: "validation",
                status: "failed",
                issueCategory: issue.category,
                round: started.round,
                payload: { status: "transport_retry", ...event },
              });
              this.modelRetry.onRetry?.(retryEvent);
            },
          });
          return attempted.value;
        },
        {
          timeoutMs: started.budget.remaining.wallTimeMs,
          signals: [this.signal],
          now: this.now,
        },
      );
      const completed = this.completeModelRound({
        payload: response.payload ?? response.value,
        tokens: response.tokens,
      });
      return {
        status: "ok",
        value: response.value,
        budget: completed.budget,
        ...(completed.status === "finalize" ? { finalize: completed } : {}),
      };
    } catch (error) {
      const issue = classifyAgentIssue(error, { phase: "model" });
      this.recorder.record({
        kind: "model_response",
        status: "failed",
        issueCategory: issue.category,
        round: started.round,
        payload: error instanceof Error ? error : { error },
      });
      if (isAgentDeadlineExceeded(error)) {
        return this.finalizeBudget({
          status: "finalize",
          reason: "max_wall_time",
          budget: this.contextBudget.snapshot(),
        });
      }
      if (this.signal?.aborted) return this.finalize("aborted");
      return { status: "failed", error, issue, budget: this.contextBudget.snapshot() };
    }
  }

  recordLifecycle(
    kind: LifecycleEventKind,
    payload: unknown,
    status: AgentRunEventStatus = "succeeded",
    issueCategory?: AgentRunIssueCategory,
  ) {
    return this.recorder.record({
      kind,
      status,
      issueCategory,
      round: this.contextBudget.snapshot().rounds + this.roundOffset,
      payload,
    });
  }

  finalize(reason: AgentFinalizeReason = "completed", payload?: unknown) {
    if (this.finalDecision) return this.finalDecision;
    const budget = this.contextBudget.snapshot();
    this.finalDecision = { status: "finalize", reason, budget };
    this.recorder.record({
      kind: "finalize",
      status: reason === "completed" || reason === "manual" ? "succeeded" : "blocked",
      payload: { reason, detail: payload, snapshot: budget },
    });
    return this.finalDecision;
  }
}
