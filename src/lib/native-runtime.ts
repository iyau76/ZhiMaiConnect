import { Capacitor, registerPlugin } from "@capacitor/core";

export type NativeHttpPacket =
  | { type: "headers"; status: number; headers: Record<string, string> }
  | { type: "chunk"; data: string }
  | { type: "end" }
  | { type: "error"; message: string };
export interface NativeHttpRequest {
  id: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  bodyBase64?: string;
  timeoutMs: number;
}
interface SavedFile {
  cancelled?: boolean;
  name?: string;
}
interface NativePort {
  platform: "windows" | "android";
  request(input: NativeHttpRequest, callback: (packet: NativeHttpPacket) => void): void;
  cancel(id: string): void;
  saveFile(input: { name: string; mime: string; data: string }): Promise<SavedFile>;
  printHtml(input: { name: string; html: string }): Promise<SavedFile>;
}
declare global {
  interface Window {
    zhimaiNative?: NativePort;
  }
}
export function isNativeRuntime() {
  return (
    typeof window !== "undefined" && Boolean(window.zhimaiNative || Capacitor.isNativePlatform())
  );
}
export function initializeNativeRuntime() {
  if (window.zhimaiNative || !Capacitor.isNativePlatform()) return;
  const plugin = registerPlugin<{
    request(
      input: NativeHttpRequest,
      cb: (value: NativeHttpPacket | null, error?: { message: string }) => void,
    ): Promise<string>;
    cancel(input: { id: string }): Promise<void>;
    saveFile(input: { name: string; mime: string; data: string }): Promise<SavedFile>;
    printHtml(input: { name: string; html: string }): Promise<SavedFile>;
  }>("ZhimaiNative");
  window.zhimaiNative = {
    platform: "android",
    request(input, callback) {
      void plugin
        .request(input, (packet, error) => {
          if (error) callback({ type: "error", message: error.message });
          else if (packet) callback(packet);
        })
        .catch((error: Error) => callback({ type: "error", message: error.message }));
    },
    cancel(id) {
      void plugin.cancel({ id });
    },
    saveFile: (input) => plugin.saveFile(input),
    printHtml: (input) => plugin.printHtml(input),
  };
}
export function bytesToBase64(bytes: Uint8Array) {
  const parts: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 8192)
    parts.push(String.fromCharCode(...bytes.subarray(offset, offset + 8192)));
  return btoa(parts.join(""));
}
export async function saveNativeFile(blob: Blob, name: string) {
  const result = await window.zhimaiNative!.saveFile({
    name,
    mime: blob.type || "application/octet-stream",
    data: bytesToBase64(new Uint8Array(await blob.arrayBuffer())),
  });
  if (result.cancelled) throw new Error("已取消保存文件");
}
/** Native HTTP is a transport only: model payloads and Agent loops remain shared. */
export async function platformFetch(
  input: string | URL,
  init: RequestInit = {},
): Promise<Response> {
  const port = typeof window !== "undefined" ? window.zhimaiNative : undefined;
  if (!port) return fetch(input, init);
  init.signal?.throwIfAborted();
  const id = crypto.randomUUID();
  const headers = new Headers(init.headers);
  let bodyBase64: string | undefined;
  if (init.body != null) {
    const encoded = new Response(init.body);
    if (!headers.has("content-type") && encoded.headers.has("content-type"))
      headers.set("content-type", encoded.headers.get("content-type")!);
    bodyBase64 = bytesToBase64(new Uint8Array(await encoded.arrayBuffer()));
  }
  return new Promise<Response>((resolve, reject) => {
    let controller: ReadableStreamDefaultController<Uint8Array>;
    let ended = false;
    const clean = () => {
      ended = true;
      init.signal?.removeEventListener("abort", abort);
    };
    const fail = (error: Error) => {
      if (ended) return;
      clean();
      controller.error(error);
      reject(error);
    };
    const abort = () => {
      port.cancel(id);
      fail(new DOMException("请求已取消", "AbortError"));
    };
    const stream = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
      },
      cancel() {
        if (!ended) {
          clean();
          port.cancel(id);
        }
      },
    });
    init.signal?.addEventListener("abort", abort, { once: true });
    if (init.signal?.aborted) {
      abort();
      return;
    }
    port.request(
      {
        id,
        url: String(input),
        method: init.method || "GET",
        headers: Object.fromEntries(headers),
        bodyBase64,
        timeoutMs: 120_000,
      },
      (packet) => {
        if (ended) return;
        if (packet.type === "headers")
          resolve(
            new Response([204, 205, 304].includes(packet.status) ? null : stream, {
              status: packet.status,
              headers: packet.headers,
            }),
          );
        else if (packet.type === "chunk")
          controller.enqueue(
            Uint8Array.from(atob(packet.data), (character) => character.charCodeAt(0)),
          );
        else if (packet.type === "end") {
          clean();
          controller.close();
        } else fail(new Error(packet.message));
      },
    );
  });
}
