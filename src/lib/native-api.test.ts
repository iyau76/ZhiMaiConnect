import { afterEach, expect, it, vi } from "vitest";
import { nativeApi } from "./native-api";
import { buildVisionPayload } from "./provider-protocol";

afterEach(() => vi.unstubAllGlobals());
it("uses the same provider payload as the hosted API, without a Cloudflare handshake", async () => {
  const request = {
    action: "agent" as const,
    model: "test-model",
    baseUrl: "https://example.com/v1",
    apiKey: "synthetic-test-key",
    prompt: "请返回 JSON",
    history: [],
  };
  const fetch = vi
    .fn()
    .mockResolvedValue(Response.json({ choices: [{ message: { content: '{"ok":true}' } }] }));
  vi.stubGlobal("fetch", fetch);
  const result = await nativeApi("/api/vision", { body: JSON.stringify(request) });
  expect(await result.json()).toEqual({ ok: true, reply: '{"ok":true}' });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0][0]).toBe("https://example.com/v1/chat/completions");
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual(buildVisionPayload(request));
});
it("returns the provider status for the existing retry policy", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("unavailable", { status: 503 })));
  const response = await nativeApi("/api/vision", {
    body: JSON.stringify({ baseUrl: "https://example.com/v1", model: "test-model" }),
  });
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ code: "UPSTREAM_REJECTED" });
});
