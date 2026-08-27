/// <reference types="node" />

import assert from "node:assert/strict";
import { describe, test, vi } from "vitest";

import { API_LIMITS } from "../../lib/api-security.server.ts";
import { handleVisionPost } from "./vision.ts";
import { assertSafeResponse, responseBody, routeRequest } from "./-route-test-helpers.ts";

const validBody = {
  kind: "openai",
  baseUrl: "https://api.openai.com/v1",
  apiKey: "test-only-key",
  model: "gpt-4o-mini",
  action: "test",
} as const;

describe("POST /api/vision", () => {
  test("rejects requests without a matching status session before proxying", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const request = await routeRequest("vision", JSON.stringify(validBody));

    const response = await handleVisionPost(request);

    assert.equal(response.status, 401);
    assert.equal((await responseBody(response)).code, "SESSION_REQUIRED");
    assertSafeResponse(response);
    assert.equal(fetchMock.mock.calls.length, 0);
  });

  test("rejects malformed JSON and a declared oversized request", async () => {
    const malformed = await handleVisionPost(
      await routeRequest("vision", "{", { authenticated: true }),
    );
    assert.equal(malformed.status, 400);
    assert.equal((await responseBody(malformed)).code, "INVALID_JSON");
    assertSafeResponse(malformed);

    const oversized = await handleVisionPost(
      await routeRequest("vision", JSON.stringify(validBody), {
        authenticated: true,
        headers: { "Content-Length": String(API_LIMITS.visionRequestBytes + 1) },
      }),
    );
    assert.equal(oversized.status, 413);
    assert.equal((await responseBody(oversized)).code, "PAYLOAD_TOO_LARGE");
    assertSafeResponse(oversized);
  });

  test("proxies an authenticated one-shot request and returns only the parsed reply", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ choices: [{ message: { content: "连接成功" } }] }));
    const request = await routeRequest("vision", JSON.stringify(validBody), {
      authenticated: true,
    });

    const response = await handleVisionPost(request);
    const payload = await responseBody(response);

    assert.equal(response.status, 200);
    assert.deepEqual(payload, { ok: true, reply: "连接成功" });
    assertSafeResponse(response);
    assert.equal(fetchMock.mock.calls.length, 1);

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    assert.equal(url, "https://api.openai.com/v1/chat/completions");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-only-key");
    assert.equal(init?.redirect, "manual");
    const upstreamBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    assert.equal(upstreamBody.model, "gpt-4o-mini");
    assert.equal(upstreamBody.stream, false);
  });

  test("maps an upstream credential failure to a body-safe 502", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("upstream-secret-and-private-prompt", { status: 401 }),
    );
    const request = await routeRequest("vision", JSON.stringify(validBody), {
      authenticated: true,
    });

    const response = await handleVisionPost(request);
    const serialized = JSON.stringify(await responseBody(response));

    assert.equal(response.status, 502);
    assert.match(serialized, /UPSTREAM_REJECTED/);
    assert.equal(serialized.includes("upstream-secret"), false);
    assert.equal(serialized.includes("private-prompt"), false);
    assertSafeResponse(response);
  });

  test("finishes a streaming response at the SSE DONE marker without waiting for disconnect", async () => {
    const encoder = new TextEncoder();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                'data: {"choices":[{"delta":{"content":"整理完成"}}]}\n\ndata: [DONE]\n\n',
              ),
            );
            // Deliberately keep the mocked network stream open. [DONE] must be sufficient.
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      ),
    );
    const request = await routeRequest(
      "vision",
      JSON.stringify({
        kind: "openai",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "test-only-key",
        model: "gpt-4o-mini",
        action: "chat",
        prompt: "整理测试",
        image: null,
        history: [],
      }),
      { authenticated: true },
    );

    const response = await handleVisionPost(request);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "整理完成");
  });

  test("rejects a 200 HTML error page instead of returning an empty successful stream", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("<html>Bad Gateway</html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      }),
    );
    const response = await handleVisionPost(
      await routeRequest(
        "vision",
        JSON.stringify({ ...validBody, action: "chat", prompt: "test", history: [] }),
        { authenticated: true },
      ),
    );
    assert.equal(response.status, 502);
    assert.equal((await responseBody(response)).code, "UPSTREAM_INVALID_RESPONSE");
  });

  test("rejects an SSE response that completes without any content delta", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("data: [DONE]\n\n", {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    );
    const response = await handleVisionPost(
      await routeRequest(
        "vision",
        JSON.stringify({ ...validBody, action: "chat", prompt: "test", history: [] }),
        { authenticated: true },
      ),
    );
    assert.equal(response.status, 502);
    assert.equal((await responseBody(response)).code, "UPSTREAM_INVALID_RESPONSE");
  });
});
