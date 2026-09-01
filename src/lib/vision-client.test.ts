// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

import { clearCloudTransferConsents } from "./cloud-consent";
import { resetApiSessionForRetry } from "./api-session";
import { askModel } from "./vision-client";
import type { ProviderPreset } from "./vision-providers";

const preset: ProviderPreset = {
  id: "deepseek-test",
  name: "DeepSeek test",
  kind: "openai",
  baseUrl: "https://api.deepseek.com/v1",
  apiKey: "test-key",
  model: "deepseek-chat",
};

describe("browser-side vision SSE decoding", () => {
  beforeEach(() => {
    resetApiSessionForRetry();
    clearCloudTransferConsents();
  });

  it("decodes split SSE chunks after the Worker forwards raw bytes", async () => {
    const encoder = new TextEncoder();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (String(input) === "/api/status") {
        return Response.json({ sessionToken: "session-token" });
      }
      expect(String(input)).toBe("/api/vision");
      const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(payload.temperature).toBe(0);
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode('data: {"choices":[{"delta":{"content":"整理"}}]}\n'),
            );
            controller.enqueue(
              encoder.encode(
                '\ndata: {"choices":[{"delta":{"content":"完成"}}]}\n\ndata: [DONE]\n\n',
              ),
            );
            controller.close();
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    });
    const chunks: string[] = [];

    const request = askModel(
      preset,
      "整理这段材料",
      null,
      [],
      (chunk) => chunks.push(chunk),
      new AbortController().signal,
      { temperature: 0 },
    );
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="cloud-transfer-consent"]')).not.toBeNull();
    });
    document.querySelector<HTMLButtonElement>("[data-cloud-consent-continue]")!.click();
    await request;

    expect(chunks).toEqual(["整理", "完成"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
