import { describe, expect, it } from "vitest";

import type { PersonRecord } from "./face-db";
import {
  parseRecommendationSessionState,
  recommendationArchiveRevision,
  restoreRecommendationCandidates,
  type RecommendationSessionState,
} from "./recommendation-session-state";

const person: PersonRecord = {
  id: "person-1",
  name: "唐悦",
  note: "",
  thumb: "",
  descriptors: [],
  createdAt: 1,
};

describe("recommendation session state", () => {
  it("round-trips a suspended checkpoint and restores candidates by stable id", () => {
    const state: RecommendationSessionState = {
      version: 1,
      runId: "run-1",
      task: "校园活动找谁拍照",
      presetId: "preset-1",
      aiArchiveMode: true,
      includeInferredPaths: false,
      selectedTargetId: "",
      trace: [{ kind: "tool", text: "已锁定候选" }],
      notice: "运行已暂停",
      result: {
        status: "suspended",
        candidates: [
          {
            personId: person.id,
            score: 95,
            confidence: "高",
            reasons: ["活动摄影"],
            evidence: ["档案记录：摄影师"],
            risks: [],
            updatedAt: 1,
          },
        ],
        answer: "稍后继续",
        disclosureMode: "full",
        rounds: 1,
      },
      suspendedRequest: {
        presetId: "preset-1",
        checkpoint: {
          version: 1,
          sourceRunId: "run-1",
          task: "校园活动找谁拍照",
          archiveVersion: "1:test",
          includeInferredPaths: false,
          phase: "analysis",
          nextRound: 2,
          maxRounds: 7,
          toolHistory: [],
          repeatedCalls: [],
          formatCorrection: false,
          trace: [],
          lockedCandidates: [],
          lockedMode: "open",
          consumedBudget: {
            rounds: 1,
            toolCalls: 1,
            inputTokens: { total: 10, actual: 0, estimated: 10 },
            outputTokens: { total: 5, actual: 0, estimated: 5 },
          },
        },
      },
      updatedAt: 2,
    };

    const restored = parseRecommendationSessionState(state);
    expect(restored).toEqual(state);
    expect(restoreRecommendationCandidates(restored!.result, [person])).toMatchObject([
      { person: { id: "person-1", name: "唐悦" }, score: 95 },
    ]);
  });

  it("rejects a malformed state and changes archive revision when a source record changes", () => {
    expect(parseRecommendationSessionState({ version: 1 })).toBeUndefined();
    const initial = recommendationArchiveRevision({ persons: [person], relations: [], events: [] });
    const changed = recommendationArchiveRevision({
      persons: [{ ...person, name: "唐悦（更新）", updatedAt: 2 }],
      relations: [],
      events: [],
    });
    expect(changed).not.toBe(initial);
  });
});
