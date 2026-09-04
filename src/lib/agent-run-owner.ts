const AGENT_RUN_OWNER_KEY = "zhimai.agent-run-owner.v2";
const LEGACY_OWNER_KEYS = ["zhimai:assistant-run-owner", "zhimai.intake.run-owner.v1"];

interface AgentRunOwnerStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

let serverOwnerId = `runtime:${crypto.randomUUID()}`;

/**
 * One browser profile is one logical executor. Every claim still receives a
 * fresh fencing epoch, so reopening the app can resume immediately while an
 * older page loses the right to append or commit the same run.
 */
export function loadOrCreateAgentRunOwnerId(
  storage: AgentRunOwnerStorage,
  legacyStorage?: AgentRunOwnerStorage,
) {
  const current = storage.getItem(AGENT_RUN_OWNER_KEY)?.trim();
  if (current) return current;

  const migrated = LEGACY_OWNER_KEYS.map((key) => legacyStorage?.getItem(key)?.trim()).find(
    Boolean,
  );
  const ownerId = migrated ?? `browser:${crypto.randomUUID()}`;
  storage.setItem(AGENT_RUN_OWNER_KEY, ownerId);
  return ownerId;
}

export function browserAgentRunOwnerId() {
  if (typeof window === "undefined") return serverOwnerId;
  return loadOrCreateAgentRunOwnerId(window.localStorage, window.sessionStorage);
}

export const agentRunOwnerStorageKey = AGENT_RUN_OWNER_KEY;

export function resetServerAgentRunOwnerId() {
  serverOwnerId = `runtime:${crypto.randomUUID()}`;
}
