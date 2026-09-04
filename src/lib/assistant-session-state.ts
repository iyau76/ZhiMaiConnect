import type { AssistantAgentCheckpoint, AssistantWorkingMemory } from "./assistant-agent";
import type { ArchiveCitation } from "./agent-output-grounding";
import { providerPresetFingerprint, type ProviderPreset, type ChatTurn } from "./vision-providers";

export const ASSISTANT_THREAD_ID = "assistant:default";
export const ASSISTANT_SESSION_STATE_VERSION = 1 as const;

export interface PersistedSuspendedAssistantRequest {
  checkpoint: AssistantAgentCheckpoint;
  presetId: string;
  history: ChatTurn[];
  image: string | null;
  includeArchive: boolean;
}

export interface AssistantSessionState {
  version: typeof ASSISTANT_SESSION_STATE_VERSION;
  runId: string;
  turns: ChatTurn[];
  useData: boolean;
  workingMemory: AssistantWorkingMemory | null;
  suspendedRequest: PersistedSuspendedAssistantRequest | null;
  contextNotice: string;
  citations: ArchiveCitation[];
  citationFeedback: Record<string, "correct" | "incorrect">;
  latestReceiptId?: string;
  updatedAt: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isChatTurn(value: unknown): value is ChatTurn {
  return (
    isRecord(value) &&
    (value.role === "user" || value.role === "assistant") &&
    typeof value.text === "string" &&
    (value.image === undefined || typeof value.image === "string")
  );
}

/** One explicit persisted-state boundary; consumers never invent their own defaults. */
export function parseAssistantSessionState(value: unknown): AssistantSessionState | undefined {
  if (
    !isRecord(value) ||
    value.version !== ASSISTANT_SESSION_STATE_VERSION ||
    typeof value.runId !== "string" ||
    !Array.isArray(value.turns) ||
    !value.turns.every(isChatTurn) ||
    typeof value.useData !== "boolean" ||
    typeof value.contextNotice !== "string" ||
    !Array.isArray(value.citations) ||
    !isRecord(value.citationFeedback) ||
    typeof value.updatedAt !== "number"
  ) {
    return undefined;
  }
  if (
    value.workingMemory !== null &&
    (!isRecord(value.workingMemory) || value.workingMemory.version !== 1)
  ) {
    return undefined;
  }
  if (
    value.suspendedRequest !== null &&
    (!isRecord(value.suspendedRequest) ||
      typeof value.suspendedRequest.presetId !== "string" ||
      !Array.isArray(value.suspendedRequest.history) ||
      !value.suspendedRequest.history.every(isChatTurn) ||
      typeof value.suspendedRequest.includeArchive !== "boolean" ||
      !isRecord(value.suspendedRequest.checkpoint))
  ) {
    return undefined;
  }
  const feedbackEntries = Object.entries(value.citationFeedback);
  if (feedbackEntries.some(([, feedback]) => feedback !== "correct" && feedback !== "incorrect")) {
    return undefined;
  }
  return structuredClone(value) as unknown as AssistantSessionState;
}

export function assistantProviderFingerprint(preset: ProviderPreset) {
  return providerPresetFingerprint(preset);
}
