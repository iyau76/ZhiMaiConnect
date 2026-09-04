import {
  summarizeAgentRunTokens,
  type AgentRun,
  type AgentRunEvent,
  type AgentRunEventInput,
} from "./agent-run-log";
import { indexedDbAgentRunLedger } from "./agent-run-ledger";
import { sanitizeAgentRunSnapshot, type StoredAgentRun } from "./agent-run-store";
import type { AgentBudget, AgentBudgetPreset } from "./agent-runtime";
import { resolveAgentBudget } from "./agent-runtime";
import { LocalAgentSettingsStore } from "./agent-settings";

const volatileRuns: StoredAgentRun[] = [];

function rememberVolatileRun(
  run: AgentRun,
  events: readonly AgentRunEvent[],
  privatePayload: boolean,
) {
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
}

function eventInput(event: AgentRunEvent): AgentRunEventInput {
  const { id: _id, runId: _runId, sequence: _sequence, ...input } = event;
  return input;
}

/**
 * Shared migration path for Agents not yet started through beginDurableAgentRun.
 * They still land in the v13 ledger once, marked as a non-resumable legacy run;
 * Agents already streaming into that ledger are detected by stable run ID.
 */
async function mirrorCompletedRunToLedger(
  run: AgentRun,
  events: readonly AgentRunEvent[],
  privatePayload: boolean,
) {
  if (await indexedDbAgentRunLedger.getRun(run.id)) return;
  const sanitized = sanitizeAgentRunSnapshot(run, events, privatePayload);
  const budget = resolveSavedAgentBudget("standard");
  const created = await indexedDbAgentRunLedger.createRun({
    id: run.id,
    threadId: `${run.agentName ?? "agent"}:runs`,
    ordinal: Date.now(),
    agentName: run.agentName ?? "agent",
    entrypoint: "legacy-observability",
    title: sanitized.run.title,
    request: { migratedFrom: "agent-observability" },
    providerRef: { model: run.model ?? "unknown" },
    includeArchive: true,
    budget,
    status: "pending",
    resumable: false,
    legacyObservability: true,
    createdAt: run.startedAt,
  });
  const claimed = await indexedDbAgentRunLedger.claimRun({
    runId: run.id,
    ownerId: `legacy:${crypto.randomUUID()}`,
    expectedRevision: created.revision,
    leaseDurationMs: Math.max(30_000, budget.maxWallTimeMs),
  });
  await indexedDbAgentRunLedger.append({
    runId: run.id,
    expectedRevision: claimed.run.revision,
    lease: claimed.lease,
    events: sanitized.events.map(eventInput),
    transition: {
      status: run.status,
      usage: summarizeAgentRunTokens(sanitized.events),
      resumable: false,
      endedAt: run.endedAt,
    },
  });
}

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
  if (typeof indexedDB === "undefined") {
    rememberVolatileRun(run, events, privatePayload);
    return { stored: false as const, error: new Error("IndexedDB is unavailable") };
  }
  void mirrorCompletedRunToLedger(run, events, privatePayload).catch(() => {
    rememberVolatileRun(run, events, privatePayload);
  });
  return { stored: true as const };
}

export function listVolatileAgentRuns() {
  return volatileRuns.map((entry) => ({ ...entry, events: [...entry.events] }));
}

export function clearVolatileAgentRuns() {
  volatileRuns.length = 0;
}
