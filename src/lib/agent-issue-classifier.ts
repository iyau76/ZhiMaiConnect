import { isAgentDeadlineExceeded } from "./agent-deadline";
import type { AgentRunIssueCategory } from "./agent-run-log";
import {
  isTransientModelError,
  ModelRetryExhaustedError,
  ModelTransportError,
} from "./model-transport-resilience";

/**
 * The boundary that owns a failed Agent step. Callers supply the boundary;
 * this module supplies the shared error taxonomy used by logs and recovery.
 */
export type AgentIssuePhase = "model" | "tool" | "budget" | "context" | "contract" | "transaction";

export interface AgentIssueContext {
  phase: AgentIssuePhase;
  /** Links a later transaction failure back to the run that produced it. */
  sourceRunId?: string;
  /** Optional stable boundary name such as `commit` or `hydrate`. */
  operation?: string;
}

export interface AgentIssueClassification {
  category: AgentRunIssueCategory;
  phase: AgentIssuePhase;
  message: string;
  code?: string;
  sourceRunId?: string;
  operation?: string;
}

type AgentIssueCore = Pick<AgentIssueClassification, "category" | "phase" | "message" | "code">;

/**
 * A tool's registry boundary knows whether failure happened during contract
 * validation, transport, or a write transaction. The outer runtime only sees
 * a rejected tool promise, so retain that nearer classification for it.
 */
const toolIssueByError = new WeakMap<object, AgentIssueCore>();

function errorMessage(error: unknown) {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return "Agent step failed";
}

function directErrorCode(error: unknown) {
  if (!error || typeof error !== "object") return undefined;
  const code = "code" in error ? error.code : undefined;
  if (typeof code === "string" && code.trim()) return code;
  const status = "status" in error ? error.status : undefined;
  return typeof status === "number" && Number.isFinite(status) ? `HTTP_${status}` : undefined;
}

function errorCode(error: unknown) {
  if (error instanceof ModelRetryExhaustedError) {
    return directErrorCode(error.lastError) ?? "MODEL_RETRY_EXHAUSTED";
  }
  return directErrorCode(error);
}

function categoryFor(error: unknown, phase: AgentIssuePhase): AgentRunIssueCategory {
  if (phase === "budget") return "budget";
  if (phase === "context") return "context_omission";
  if (phase === "contract") return "contract";
  if (phase === "transaction") return "transaction";

  if (isAgentDeadlineExceeded(error)) return "budget";
  if (
    error instanceof ModelTransportError ||
    error instanceof ModelRetryExhaustedError ||
    isTransientModelError(error)
  ) {
    return "transport";
  }

  // A non-transport failure at a model/tool boundary means the harness could
  // not satisfy that step's declared protocol.
  return "contract";
}

export function classifyAgentIssue(
  error: unknown,
  context: AgentIssueContext,
): AgentIssueClassification {
  const sourceRunId = context.sourceRunId?.trim() || undefined;
  const operation = context.operation?.trim() || undefined;
  const retained =
    context.phase === "tool" && error && typeof error === "object"
      ? toolIssueByError.get(error)
      : undefined;
  const code = errorCode(error);
  const core: AgentIssueCore = retained ?? {
    category: categoryFor(error, context.phase),
    phase: context.phase,
    message: errorMessage(error),
    ...(code ? { code } : {}),
  };
  if (
    error &&
    typeof error === "object" &&
    (context.phase === "tool" || context.phase === "contract" || context.phase === "transaction")
  ) {
    toolIssueByError.set(error, core);
  }
  return {
    ...core,
    ...(sourceRunId ? { sourceRunId } : {}),
    ...(operation ? { operation } : {}),
  };
}
