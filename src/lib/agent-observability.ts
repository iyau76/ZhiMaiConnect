import type { AgentRun, AgentRunEvent } from "./agent-run-log";
import {
  LocalAgentRunStore,
  sanitizeAgentRunSnapshot,
  type StoredAgentRun,
} from "./agent-run-store";
import type { AgentBudget, AgentBudgetPreset } from "./agent-runtime";
import { resolveAgentBudget } from "./agent-runtime";
import { LocalAgentSettingsStore } from "./agent-settings";

const volatileRuns: StoredAgentRun[] = [];

/** Settings are optional infrastructure; blocked storage must never block an Agent run. */
export function resolveSavedAgentBudget(
  fallback: AgentBudgetPreset | AgentBudget = "standard",
): AgentBudget {
  try {
    const store = new LocalAgentSettingsStore();
    return store.resolveBudget(store.load());
  } catch {
    return resolveAgentBudget(fallback);
  }
}

/**
 * Persist a redacted run when possible and keep an in-memory copy otherwise.
 * Free-text/private archive payload is opt-in and remains false in production calls.
 */
export function saveAgentRunBestEffort(
  run: AgentRun,
  events: readonly AgentRunEvent[],
  options: { privatePayload?: boolean } = {},
) {
  let configuredPrivatePayload = false;
  if (options.privatePayload === undefined) {
    try {
      configuredPrivatePayload = new LocalAgentSettingsStore().load().savePrivatePayload;
    } catch {
      configuredPrivatePayload = false;
    }
  }
  const privatePayload = options.privatePayload ?? configuredPrivatePayload;
  try {
    return {
      stored: true as const,
      entry: new LocalAgentRunStore().save(run, events, { privatePayload }),
    };
  } catch (error) {
    const now = Date.now();
    const sanitized = sanitizeAgentRunSnapshot(run, events, privatePayload);
    volatileRuns.unshift({
      run: sanitized.run,
      events: sanitized.events,
      privatePayload,
      createdAt: now,
      updatedAt: now,
      expiresAt: now + 30 * 24 * 60 * 60 * 1_000,
    });
    volatileRuns.splice(50);
    return { stored: false as const, error };
  }
}

export function listVolatileAgentRuns() {
  return volatileRuns.map((entry) => ({ ...entry, events: [...entry.events] }));
}

export function clearVolatileAgentRuns() {
  volatileRuns.length = 0;
}
