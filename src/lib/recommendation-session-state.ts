import type { AgentTraceEvent } from "./agent-trace";
import type {
  ArchiveDisclosurePlan,
  RecommendationAgentCheckpoint,
  RecommendationAgentResult,
  RecommendationCapabilityPlan,
  RecommendationTargetResolution,
} from "./recommendation-agent";
import type { ArchiveAgentData } from "./archive-agent-tools";
import type { PersonRecord } from "./face-db";
import type { CandidateRecommendation } from "./recommendation";
import { providerPresetFingerprint, type ProviderPreset } from "./vision-providers";

export const RECOMMENDATION_THREAD_ID = "recommendation:default";
export const RECOMMENDATION_SESSION_STATE_VERSION = 1 as const;

export interface PersistedRecommendationCandidate extends Omit<CandidateRecommendation, "person"> {
  personId: string;
}

export interface PersistedRecommendationResult {
  status: RecommendationAgentResult["status"];
  candidates: PersistedRecommendationCandidate[];
  answer: string;
  disclosureMode: ArchiveDisclosurePlan["mode"];
  rounds: number;
  capabilityPlan?: RecommendationCapabilityPlan;
  targetResolution?: RecommendationTargetResolution;
}

export interface PersistedSuspendedRecommendationRequest {
  checkpoint: RecommendationAgentCheckpoint;
  presetId: string;
}

export interface RecommendationSessionState {
  version: typeof RECOMMENDATION_SESSION_STATE_VERSION;
  runId: string;
  task: string;
  presetId: string;
  aiArchiveMode: boolean;
  includeInferredPaths: boolean;
  selectedTargetId: string;
  trace: AgentTraceEvent[];
  notice: string;
  result: PersistedRecommendationResult | null;
  suspendedRequest: PersistedSuspendedRecommendationRequest | null;
  updatedAt: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isTrace(value: unknown): value is AgentTraceEvent {
  return (
    isRecord(value) &&
    ["status", "model", "tool", "check", "done", "error"].includes(String(value.kind)) &&
    typeof value.text === "string"
  );
}

function isPersistedResult(value: unknown): value is PersistedRecommendationResult {
  return (
    isRecord(value) &&
    (value.status === "completed" || value.status === "suspended") &&
    typeof value.answer === "string" &&
    (value.disclosureMode === "full" || value.disclosureMode === "progressive") &&
    typeof value.rounds === "number" &&
    Array.isArray(value.candidates) &&
    value.candidates.every(
      (candidate) => isRecord(candidate) && typeof candidate.personId === "string",
    )
  );
}

/** One persisted-state contract shared by checkpointing, hydration and resume. */
export function parseRecommendationSessionState(
  value: unknown,
): RecommendationSessionState | undefined {
  if (
    !isRecord(value) ||
    value.version !== RECOMMENDATION_SESSION_STATE_VERSION ||
    typeof value.runId !== "string" ||
    typeof value.task !== "string" ||
    typeof value.presetId !== "string" ||
    typeof value.aiArchiveMode !== "boolean" ||
    typeof value.includeInferredPaths !== "boolean" ||
    typeof value.selectedTargetId !== "string" ||
    !Array.isArray(value.trace) ||
    !value.trace.every(isTrace) ||
    typeof value.notice !== "string" ||
    typeof value.updatedAt !== "number" ||
    (value.result !== null && !isPersistedResult(value.result)) ||
    (value.suspendedRequest !== null &&
      (!isRecord(value.suspendedRequest) ||
        typeof value.suspendedRequest.presetId !== "string" ||
        !isRecord(value.suspendedRequest.checkpoint) ||
        value.suspendedRequest.checkpoint.version !== 1))
  ) {
    return undefined;
  }
  return structuredClone(value) as unknown as RecommendationSessionState;
}

export function persistRecommendationResult(
  result: RecommendationAgentResult,
): PersistedRecommendationResult {
  return {
    status: result.status,
    candidates: result.candidates.map(({ person, ...candidate }) => ({
      ...candidate,
      personId: person.id,
    })),
    answer: result.answer,
    disclosureMode: result.disclosureMode,
    rounds: result.rounds,
    capabilityPlan: result.capabilityPlan,
    targetResolution: result.targetResolution,
  };
}

export function restoreRecommendationCandidates(
  result: PersistedRecommendationResult | null,
  persons: readonly PersonRecord[],
) {
  if (!result) return [];
  const personById = new Map(persons.map((person) => [person.id, person]));
  return result.candidates.flatMap(({ personId, ...candidate }) => {
    const person = personById.get(personId);
    return person ? [{ ...candidate, person }] : [];
  });
}

export function recommendationArchiveRevision(archive: ArchiveAgentData) {
  const rows = [
    ...archive.persons.map((row) => ["p", row.id, row.updatedAt ?? row.createdAt, row.name]),
    ...archive.relations.map((row) => [
      "r",
      row.id,
      row.updatedAt ?? row.createdAt,
      row.fromId,
      row.toId,
      row.label,
    ]),
    ...archive.events.map((row) => ["e", row.id, row.updatedAt ?? row.createdAt, row.date]),
  ].sort((left, right) => String(left[1]).localeCompare(String(right[1])));
  let hash = 2166136261;
  for (const character of JSON.stringify(rows)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `${rows.length}:${(hash >>> 0).toString(36)}`;
}

export function recommendationProviderFingerprint(preset: ProviderPreset) {
  return providerPresetFingerprint(preset);
}
