/// <reference types="node" />

import assert from "node:assert/strict";
import { test, vi } from "vitest";

import {
  API_LIMITS,
  SafeApiError,
  apiErrorResponse,
  appendApiPath,
  consumeUpstreamError,
  decodedBase64Bytes,
  enforceRateLimit,
  parseJsonRequest,
  issueApiSession,
  requireApiSession,
  startUpstreamRequest,
  transcribeBodySchema,
  validateCustomBaseUrl,
  visionBodySchema,
} from "./api-security.server.ts";
import { registerRuntimeBindings } from "./runtime-bindings.server.ts";

function jsonRequest(body: string, headers?: HeadersInit): Request {
  return new Request("https://connect.example/api/vision", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body,
  });
}

test("parseJsonRequest rejects malformed JSON and unknown fields", async () => {
  await assert.rejects(
    parseJsonRequest(jsonRequest("{"), visionBodySchema, API_LIMITS.visionRequestBytes),
    (error: unknown) => error instanceof SafeApiError && error.code === "INVALID_JSON",
  );

  await assert.rejects(
    parseJsonRequest(
      jsonRequest(JSON.stringify({ model: "model", action: "test", unexpected: true })),
      visionBodySchema,
      API_LIMITS.visionRequestBytes,
    ),
    (error: unknown) => error instanceof SafeApiError && error.code === "INVALID_REQUEST",
  );
});

test("parseJsonRequest enforces content type and declared request size", async () => {
  await assert.rejects(
    parseJsonRequest(
      new Request("https://connect.example/api/vision", { method: "POST", body: "{}" }),
      visionBodySchema,
      API_LIMITS.visionRequestBytes,
    ),
    (error: unknown) => error instanceof SafeApiError && error.code === "INVALID_CONTENT_TYPE",
  );

  await assert.rejects(
    parseJsonRequest(
      jsonRequest("{}", { "Content-Length": String(API_LIMITS.visionRequestBytes + 1) }),
      visionBodySchema,
      API_LIMITS.visionRequestBytes,
    ),
    (error: unknown) => error instanceof SafeApiError && error.code === "PAYLOAD_TOO_LARGE",
  );
});

test("vision schema caps prompt, processed history, and image bytes", () => {
  assert.equal(
    visionBodySchema.safeParse({
      model: "model",
      prompt: "x".repeat(API_LIMITS.promptCharacters + 1),
    }).success,
    false,
  );

  const history = Array.from({ length: 12 }, (_, index) => ({
    role: index % 2 ? ("assistant" as const) : ("user" as const),
    text: String(index),
  }));
  const parsed = visionBodySchema.parse({ model: "model", prompt: "hello", history });
  assert.equal(parsed.history.length, API_LIMITS.historyTurns);
  assert.equal(parsed.history[0]?.text, "4");

  const oversizedImage = `data:image/png;base64,${"A".repeat(
    Math.ceil((API_LIMITS.imageBytes + 1) / 3) * 4,
  )}`;
  assert.equal(
    visionBodySchema.safeParse({ model: "model", prompt: "hello", image: oversizedImage }).success,
    false,
  );
});

test("transcription schema rejects malformed and oversized audio", () => {
  assert.equal(
    transcribeBodySchema.safeParse({ model: "whisper-1", audio: "not base64" }).success,
    false,
  );
  const oversizedAudio = "A".repeat(Math.ceil((API_LIMITS.audioBytes + 1) / 3) * 4);
  assert.equal(
    transcribeBodySchema.safeParse({ model: "whisper-1", audio: oversizedAudio }).success,
    false,
  );
  assert.equal(decodedBase64Bytes("TQ=="), 1);
});

test("custom proxy requests require the caller's own upstream credential", () => {
  const common = {
    kind: "openai" as const,
    baseUrl: "https://api.openai.com/v1",
  };
  assert.equal(
    visionBodySchema.safeParse({ ...common, model: "model", prompt: "hello" }).success,
    false,
  );
  assert.equal(transcribeBodySchema.safeParse({ ...common, audio: "TQ==" }).success, false);
  assert.equal(
    visionBodySchema.safeParse({ ...common, apiKey: "caller-key", model: "model", prompt: "hello" })
      .success,
    true,
  );
});

test("custom base URL policy rejects SSRF primitives", () => {
  const rejected = [
    "http://api.openai.com/v1",
    "https://user:secret@api.openai.com/v1",
    "https://api.openai.com:8443/v1",
    "https://localhost/v1",
    "https://127.0.0.1/v1",
    "https://169.254.169.254/latest/meta-data",
    "https://10.0.0.1/v1",
    "https://[::1]/v1",
    "https://metadata.google.internal/v1",
    "https://attacker.example/v1",
    "https://api.openai.com/v1?next=https://127.0.0.1",
  ];
  for (const candidate of rejected) {
    assert.throws(
      () => validateCustomBaseUrl(candidate),
      (error: unknown) => error instanceof SafeApiError && error.code === "CUSTOM_HOST_DENIED",
      candidate,
    );
  }

  const accepted = validateCustomBaseUrl("https://api.deepseek.com/v1/");
  assert.equal(
    appendApiPath(accepted, "/chat/completions"),
    "https://api.deepseek.com/v1/chat/completions",
  );
});

test("deployment allowlist is exact and has no wildcard/subdomain expansion", () => {
  const previous = process.env.AI_PROXY_ALLOWED_HOSTS;
  process.env.AI_PROXY_ALLOWED_HOSTS = "trusted.example";
  try {
    assert.equal(validateCustomBaseUrl("https://trusted.example/v1").hostname, "trusted.example");
    assert.throws(() => validateCustomBaseUrl("https://sub.trusted.example/v1"), SafeApiError);
  } finally {
    if (previous === undefined) delete process.env.AI_PROXY_ALLOWED_HOSTS;
    else process.env.AI_PROXY_ALLOWED_HOSTS = previous;
  }
});

test("upstream timeout aborts the fetch and becomes a safe 504", async () => {
  const pendingFetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener(
        "abort",
        () => reject(new DOMException("aborted", "AbortError")),
        {
          once: true,
        },
      );
    })) as typeof fetch;

  await assert.rejects(
    startUpstreamRequest(
      "https://api.openai.com/v1/chat/completions",
      {},
      {
        timeoutMs: 5,
        fetcher: pendingFetch,
      },
    ),
    (error: unknown) =>
      error instanceof SafeApiError && error.status === 504 && error.code === "UPSTREAM_TIMEOUT",
  );
});

test("upstream activity refreshes the timeout deadline", async () => {
  vi.useFakeTimers();
  let upstream: Awaited<ReturnType<typeof startUpstreamRequest>> | undefined;
  try {
    upstream = await startUpstreamRequest(
      "https://api.openai.com/v1/chat/completions",
      {},
      {
        timeoutMs: 50,
        fetcher: (async () => new Response("ok")) as typeof fetch,
      },
    );

    await vi.advanceTimersByTimeAsync(40);
    upstream.refreshTimeout();
    await vi.advanceTimersByTimeAsync(40);
    assert.equal(upstream.signal.aborted, false);
    await vi.advanceTimersByTimeAsync(11);
    assert.equal(upstream.signal.aborted, true);
    assert.equal(upstream.didTimeOut(), true);
  } finally {
    upstream?.dispose();
    vi.useRealTimers();
  }
});

test("upstream errors never echo sensitive response bodies and disable caching", async () => {
  const response = await consumeUpstreamError(
    new Response("secret-key and complete private prompt", { status: 500 }),
    "test",
  );
  const body = await response.text();
  assert.equal(response.status, 502);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(body.includes("secret-key"), false);
  assert.equal(body.includes("private prompt"), false);
});

test("upstream errors retain only bounded diagnostic identifiers", async () => {
  const response = await consumeUpstreamError(
    new Response(
      JSON.stringify({
        error: {
          message: "private prompt must never be returned",
          type: "server_error",
          code: "upstream_overloaded",
        },
      }),
      { status: 503, headers: { "X-Request-Id": "req-safe-42" } },
    ),
    "test",
  );
  const body = (await response.json()) as Record<string, unknown>;

  assert.equal(response.status, 502);
  assert.equal(body.upstreamStatus, 503);
  assert.equal(body.providerType, "server_error");
  assert.equal(body.providerCode, "upstream_overloaded");
  assert.equal(body.upstreamRequestId, "req-safe-42");
  assert.equal(JSON.stringify(body).includes("private prompt"), false);
});

test("rate limiter returns a safe 429 with Retry-After", async () => {
  const request = jsonRequest("{}", { "CF-Connecting-IP": `test-${crypto.randomUUID()}` });
  await enforceRateLimit(request, "test", 1);
  let caught: unknown;
  try {
    await enforceRateLimit(request, "test", 1);
  } catch (error) {
    caught = error;
  }
  const response = apiErrorResponse(caught);
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.ok(Number(response.headers.get("retry-after")) >= 1);
});

test("rate limiter does not trust forged forwarding headers outside Cloudflare", async () => {
  const route = `spoof-${crypto.randomUUID()}`;
  await enforceRateLimit(jsonRequest("{}", { "X-Forwarded-For": "1.1.1.1" }), route, 1);
  await assert.rejects(
    enforceRateLimit(jsonRequest("{}", { "X-Forwarded-For": "2.2.2.2" }), route, 1),
    (error: unknown) => error instanceof SafeApiError && error.code === "RATE_LIMITED",
  );
});

test("memory limiter cannot be bypassed by rotating a status-session UUID", async () => {
  registerRuntimeBindings({});
  const route = `session-rotation-${crypto.randomUUID()}`;
  await enforceRateLimit(
    jsonRequest("{}", {
      "CF-Connecting-IP": "2001:db8::42",
      "X-Zhimai-Session": crypto.randomUUID(),
    }),
    route,
    1,
  );
  await assert.rejects(
    enforceRateLimit(
      jsonRequest("{}", {
        "CF-Connecting-IP": "2001:db8::42",
        "X-Zhimai-Session": crypto.randomUUID(),
      }),
      route,
      1,
    ),
    (error: unknown) => error instanceof SafeApiError && error.code === "RATE_LIMITED",
  );
});

test("production limiter uses a pseudonymous stable edge-client bucket across rotated sessions", async () => {
  const seen: string[] = [];
  registerRuntimeBindings({
    ZHIMAI_RATE_LIMIT_SALT: "unit-test-secret",
    ZHIMAI_VISION_LIMITER: {
      async limit({ key }: { key: string }) {
        seen.push(key);
        return { success: seen.length === 1 };
      },
    },
  });
  const firstSession = crypto.randomUUID();
  const secondSession = crypto.randomUUID();
  const first = jsonRequest("{}", {
    "CF-Connecting-IP": "203.0.113.42",
    "X-Forwarded-For": "1.1.1.1",
    "X-Zhimai-Session": firstSession,
  });
  const rotated = jsonRequest("{}", {
    "CF-Connecting-IP": "203.0.113.42",
    "X-Forwarded-For": "2.2.2.2",
    "X-Zhimai-Session": secondSession,
  });
  try {
    await enforceRateLimit(first, "vision", 30);
    await assert.rejects(
      enforceRateLimit(rotated, "vision", 30),
      (error: unknown) => error instanceof SafeApiError && error.code === "RATE_LIMITED",
    );
    assert.equal(seen.length, 2);
    assert.equal(seen[0], seen[1]);
    assert.match(seen[0]!, /^vision:client:[0-9a-f]{32}$/);
    assert.equal(seen[0]!.includes("203.0.113.42"), false);
    assert.equal(seen[0]!.includes(firstSession), false);
    assert.equal(seen[0]!.includes(secondSession), false);
  } finally {
    registerRuntimeBindings({});
  }
});

test("production limiter separates different Cloudflare edge clients", async () => {
  const seen: string[] = [];
  registerRuntimeBindings({
    ZHIMAI_RATE_LIMIT_SALT: "unit-test-secret",
    ZHIMAI_WEB_TOOLS_LIMITER: {
      async limit({ key }: { key: string }) {
        seen.push(key);
        return { success: true };
      },
    },
  });
  try {
    await enforceRateLimit(
      jsonRequest("{}", { "CF-Connecting-IP": "203.0.113.10" }),
      "web-tools",
      30,
    );
    await enforceRateLimit(
      jsonRequest("{}", { "CF-Connecting-IP": "203.0.113.11" }),
      "web-tools",
      30,
    );
    assert.equal(seen.length, 2);
    assert.notEqual(seen[0], seen[1]);
  } finally {
    registerRuntimeBindings({});
  }
});

test("AI routes require a matching in-memory session header and SameSite cookie", () => {
  const base = new Request("https://connect.example/api/status");
  const session = issueApiSession(base);
  assert.match(session.cookie, /HttpOnly; SameSite=Strict/);
  const accepted = new Request("https://connect.example/api/vision", {
    headers: {
      "X-Zhimai-Session": session.token,
      Cookie: `zhimai_ai_session=${session.token}`,
    },
  });
  assert.doesNotThrow(() => requireApiSession(accepted));
  assert.throws(
    () =>
      requireApiSession(
        new Request("https://connect.example/api/vision", {
          headers: { "X-Zhimai-Session": session.token },
        }),
      ),
    (error: unknown) => error instanceof SafeApiError && error.code === "SESSION_REQUIRED",
  );
});
