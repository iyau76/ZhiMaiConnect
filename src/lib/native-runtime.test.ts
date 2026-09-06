import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bytesToBase64,
  platformFetch,
  type NativeHttpPacket,
  type NativeHttpRequest,
} from "./native-runtime";

afterEach(() => vi.unstubAllGlobals());
function port() {
  let emit!: (packet: NativeHttpPacket) => void;
  let request!: NativeHttpRequest;
  const cancel = vi.fn();
  vi.stubGlobal("window", {
    zhimaiNative: {
      request(input: NativeHttpRequest, callback: (packet: NativeHttpPacket) => void) {
        request = input;
        emit = callback;
      },
      cancel,
    },
  });
  return { emit: (packet: NativeHttpPacket) => emit(packet), request: () => request, cancel };
}
describe("native fetch transport", () => {
  it("keeps ordinary browser fetch unchanged", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("web"));
    vi.stubGlobal("fetch", fetch);
    expect(await (await platformFetch("https://example.com")).text()).toBe("web");
    expect(fetch).toHaveBeenCalledWith("https://example.com", {});
  });
  it("delivers headers and separate UTF-8 chunks without buffering the whole reply", async () => {
    const native = port();
    const pending = platformFetch("https://example.com/chat");
    native.emit({ type: "headers", status: 200, headers: { "content-type": "text/event-stream" } });
    const response = await pending;
    const reader = response.body!.getReader();
    const bytes = new TextEncoder().encode("data: 你好\n\n");
    native.emit({ type: "chunk", data: bytesToBase64(bytes.subarray(0, 7)) });
    expect((await reader.read()).value).toEqual(bytes.subarray(0, 7));
    native.emit({ type: "chunk", data: bytesToBase64(bytes.subarray(7)) });
    expect((await reader.read()).value).toEqual(bytes.subarray(7));
    native.emit({ type: "end" });
    expect((await reader.read()).done).toBe(true);
  });
  it("preserves JSON bytes and multipart boundary", async () => {
    const native = port();
    const form = new FormData();
    form.append("file", new Blob(["声音"], { type: "audio/webm" }), "voice.webm");
    const response = platformFetch("https://example.com/audio", { method: "POST", body: form });
    await vi.waitFor(() => expect(native.request()).toBeDefined());
    const input = native.request();
    expect(input.headers["content-type"]).toContain("multipart/form-data; boundary=");
    expect(atob(input.bodyBase64!)).toContain('filename="voice.webm"');
    native.emit({ type: "headers", status: 204, headers: {} });
    native.emit({ type: "end" });
    expect((await response).status).toBe(204);
  });
  it("cancels in-flight native calls and errors the response stream", async () => {
    const native = port();
    const abort = new AbortController();
    const response = platformFetch("https://example.com/chat", { signal: abort.signal });
    native.emit({ type: "headers", status: 200, headers: {} });
    const result = (await response).text();
    abort.abort();
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(native.cancel).toHaveBeenCalledWith(native.request().id);
    native.emit({ type: "end" });
  });
  it("preserves upstream HTTP status and error body", async () => {
    const native = port();
    const response = platformFetch("https://example.com/chat");
    native.emit({ type: "headers", status: 429, headers: {} });
    native.emit({ type: "chunk", data: btoa("rate limited") });
    native.emit({ type: "end" });
    const result = await response;
    expect(result.status).toBe(429);
    expect(await result.text()).toBe("rate limited");
  });
});
