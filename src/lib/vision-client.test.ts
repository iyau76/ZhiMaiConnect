// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("decodes split SSE chunks after the Worker forwards raw bytes", async () => {
    const encoder = new TextEncoder();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (String(input) === "/api/status") {
        return Response.json({ sessionToken: "session-token" });
      }
      expect(String(input)).toBe("/api/vision");
      const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(payload.action).toBe("chat");
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

  it("uses the non-streaming Agent protocol for structured model rounds", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (String(input) === "/api/status") {
        return Response.json({ sessionToken: "session-token" });
      }
      expect(String(input)).toBe("/api/vision");
      const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(payload.action).toBe("agent");
      expect(payload.maxOutputTokens).toBe(2_000);
      expect(payload.temperature).toBe(0);
      expect(payload.history).toEqual([{ role: "assistant", text: "上一轮摘要" }]);
      return Response.json({ ok: true, reply: '{"type":"final","answer":"完成"}' });
    });
    const chunks: string[] = [];

    const request = askModel(
      preset,
      "整理人物档案",
      null,
      [{ role: "assistant", text: "上一轮摘要" }],
      (chunk) => chunks.push(chunk),
      new AbortController().signal,
      { maxOutputTokens: 2_000, temperature: 0, responseMode: "structured" },
    );
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="cloud-transfer-consent"]')).not.toBeNull();
    });
    document.querySelector<HTMLButtonElement>("[data-cloud-consent-continue]")!.click();
    await request;

    expect(chunks).toEqual(['{"type":"final","answer":"完成"}']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("uses Ollama JSON mode without streaming for structured model rounds", async () => {
    const ollamaPreset: ProviderPreset = {
      id: "ollama-test",
      name: "Ollama test",
      kind: "ollama",
      baseUrl: "http://localhost:11434",
      apiKey: "",
      model: "qwen3",
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      expect(String(input)).toBe("http://localhost:11434/api/chat");
      const payload = JSON.parse(String(init?.body)) as {
        stream?: unknown;
        format?: unknown;
        options?: Record<string, unknown>;
      };
      expect(payload.stream).toBe(false);
      expect(payload.format).toBe("json");
      expect(payload.options).toEqual({ num_predict: 1_500, temperature: 0 });
      return Response.json({ message: { content: '{"type":"final"}' } });
    });
    const chunks: string[] = [];

    await askModel(
      ollamaPreset,
      "返回协议对象",
      null,
      [],
      (chunk) => chunks.push(chunk),
      new AbortController().signal,
      { maxOutputTokens: 1_500, temperature: 0, responseMode: "structured" },
    );

    expect(chunks).toEqual(['{"type":"final"}']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects an empty structured response with a stable transport code", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input) === "/api/status") {
        return Response.json({ sessionToken: "session-token" });
      }
      return Response.json({ ok: true, reply: "" });
    });

    const request = askModel(
      preset,
      "返回协议对象",
      null,
      [],
      () => undefined,
      new AbortController().signal,
      { responseMode: "structured" },
    );
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="cloud-transfer-consent"]')).not.toBeNull();
    });
    document.querySelector<HTMLButtonElement>("[data-cloud-consent-continue]")!.click();

    await expect(request).rejects.toMatchObject({ code: "UPSTREAM_INVALID_RESPONSE", status: 502 });
  });
});
