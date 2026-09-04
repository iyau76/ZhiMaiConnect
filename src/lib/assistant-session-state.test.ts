import { describe, expect, it } from "vitest";

import {
  assistantProviderFingerprint,
  parseAssistantSessionState,
  type AssistantSessionState,
} from "./assistant-session-state";
import type { ProviderPreset } from "./vision-providers";

function sessionState(): AssistantSessionState {
  return {
    version: 1,
    runId: "run-1",
    turns: [
      { role: "user", text: "谁适合拍照？" },
      { role: "assistant", text: "唐悦。" },
    ],
    useData: true,
    workingMemory: null,
    suspendedRequest: null,
    contextNotice: "已保留 1 条工具记忆。",
    citations: [],
    citationFeedback: {},
    latestReceiptId: "receipt-1",
    updatedAt: 100,
  };
}

describe("assistant session state", () => {
  it("restores one complete session snapshot without sharing mutable references", () => {
    const original = sessionState();
    const restored = parseAssistantSessionState(original);

    expect(restored).toEqual(original);
    expect(restored).not.toBe(original);
    restored!.turns[0].text = "changed";
    expect(original.turns[0].text).toBe("谁适合拍照？");
  });

  it("rejects partial or unknown session shapes at the persistence boundary", () => {
    const partial = { ...sessionState() } as Record<string, unknown>;
    delete partial.suspendedRequest;
    expect(parseAssistantSessionState(partial)).toBeUndefined();
    expect(parseAssistantSessionState({ ...sessionState(), version: 2 })).toBeUndefined();
    expect(
      parseAssistantSessionState({
        ...sessionState(),
        citationFeedback: { "person:1": "maybe" },
      }),
    ).toBeUndefined();
  });

  it("fingerprints provider routing without depending on the API key", () => {
    const preset: ProviderPreset = {
      id: "provider-1",
      name: "OpenAI 兼容接口",
      kind: "openai",
      baseUrl: "https://api.example.com/v1/",
      model: "example-model",
      apiKey: "secret-a",
    };
    expect(assistantProviderFingerprint(preset)).toBe(
      assistantProviderFingerprint({ ...preset, apiKey: "secret-b" }),
    );
    expect(assistantProviderFingerprint(preset)).not.toBe(
      assistantProviderFingerprint({ ...preset, model: "other-model" }),
    );
  });
});
