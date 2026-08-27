/// <reference types="node" />

import assert from "node:assert/strict";
import { describe, test, vi } from "vitest";

import { API_LIMITS } from "../../lib/api-security.server.ts";
import { handleTranscribePost } from "./transcribe.ts";
import { assertSafeResponse, responseBody, routeRequest } from "./-route-test-helpers.ts";

const validBody = {
  kind: "openai",
  baseUrl: "https://api.openai.com/v1",
  apiKey: "test-only-key",
  model: "whisper-1",
  audio: Buffer.alloc(512, 1).toString("base64"),
  mime: "audio/webm",
  filename: "voice.webm",
  hint: "人名和项目名",
  language: "zh",
} as const;

describe("POST /api/transcribe", () => {
  test("rejects requests without a matching status session before proxying", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const request = await routeRequest("transcribe", JSON.stringify(validBody));

    const response = await handleTranscribePost(request);

    assert.equal(response.status, 401);
    assert.equal((await responseBody(response)).code, "SESSION_REQUIRED");
    assertSafeResponse(response);
    assert.equal(fetchMock.mock.calls.length, 0);
  });

  test("rejects form uploads and a declared oversized JSON request", async () => {
    const form = new FormData();
    form.set("audio", "TQ==");
    const invalidForm = await handleTranscribePost(
      await routeRequest("transcribe", form, {
        authenticated: true,
        contentType: "multipart/form-data; boundary=vitest",
      }),
    );
    assert.equal(invalidForm.status, 415);
    assert.equal((await responseBody(invalidForm)).code, "INVALID_CONTENT_TYPE");
    assertSafeResponse(invalidForm);

    const oversized = await handleTranscribePost(
      await routeRequest("transcribe", JSON.stringify(validBody), {
        authenticated: true,
        headers: { "Content-Length": String(API_LIMITS.transcribeRequestBytes + 1) },
      }),
    );
    assert.equal(oversized.status, 413);
    assert.equal((await responseBody(oversized)).code, "PAYLOAD_TOO_LARGE");
    assertSafeResponse(oversized);

    const tooShort = await handleTranscribePost(
      await routeRequest("transcribe", JSON.stringify({ ...validBody, audio: "TQ==" }), {
        authenticated: true,
      }),
    );
    assert.equal(tooShort.status, 400);
    assert.equal((await responseBody(tooShort)).code, "INVALID_REQUEST");
  });

  test("proxies authenticated audio as multipart form data", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ text: "这是转写结果" }));
    const request = await routeRequest("transcribe", JSON.stringify(validBody), {
      authenticated: true,
    });

    const response = await handleTranscribePost(request);
    const payload = await responseBody(response);

    assert.equal(response.status, 200);
    assert.deepEqual(payload, { ok: true, text: "这是转写结果" });
    assertSafeResponse(response);
    assert.equal(fetchMock.mock.calls.length, 1);

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    assert.equal(url, "https://api.openai.com/v1/audio/transcriptions");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-only-key");
    assert.equal(init?.redirect, "manual");
    assert.ok(init?.body instanceof FormData);
    assert.equal(init.body.get("model"), "whisper-1");
    assert.equal(init.body.get("prompt"), "人名和项目名");
    assert.equal(init.body.get("language"), "zh");
    const file = init.body.get("file");
    assert.ok(file instanceof Blob);
    assert.equal(file.type, "audio/webm");
    assert.equal(file.size, 512);
  });

  test("maps a rejected upstream fetch to a safe unavailable response", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("private network detail"));
    const request = await routeRequest("transcribe", JSON.stringify(validBody), {
      authenticated: true,
    });

    const response = await handleTranscribePost(request);
    const serialized = JSON.stringify(await responseBody(response));

    assert.equal(response.status, 502);
    assert.match(serialized, /UPSTREAM_UNAVAILABLE/);
    assert.equal(serialized.includes("private network detail"), false);
    assertSafeResponse(response);
  });
});
