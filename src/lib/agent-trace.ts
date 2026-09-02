/**
 * Public, user-facing Agent progress. These events describe observable work
 * only: runtime state, model-authored summaries, tool actions, validation and
 * terminal outcomes. Raw prompts and private model reasoning do not belong in
 * this contract.
 */
export type AgentTraceKind = "status" | "model" | "tool" | "check" | "done" | "error";

export interface AgentTraceEvent {
  kind: AgentTraceKind;
  text: string;
  /** Optional runtime timestamp, used by background jobs and future persisted traces. */
  at?: number;
}

/** Adapts the pre-structured string history used by older callers. */
export function agentTraceFromHistory(history: readonly string[]): AgentTraceEvent[] {
  return history.map((text) => ({ kind: "status", text }));
}
