import { SafeApiError } from "./api-error";
import {
  buildVisionPayload,
  buildTranscriptionForm,
  parseVisionReply,
  type VisionProtocolInput,
} from "./provider-protocol";
import { platformFetch } from "./native-runtime";
import { createWebTools } from "./web-tool-service";
import type { ReplayableApiRequestInit } from "./api-session";

function endpoint(base: string, path: string) {
  const url = new URL(`${base.replace(/\/+$/, "")}/${path}`);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password)
    throw new Error("模型接口需要有效的 HTTP 或 HTTPS 地址");
  return url.toString();
}
async function checkProvider(response: Response) {
  if (response.ok) return;
  await response.body?.cancel();
  throw new SafeApiError(
    response.status,
    "UPSTREAM_REJECTED",
    response.status === 401 || response.status === 403
      ? "模型服务拒绝了凭据，请检查 API Key"
      : `模型服务返回 ${response.status}，请检查接口配置或稍后重试`,
  );
}
export async function nativeApi(
  input: string | URL,
  init: ReplayableApiRequestInit,
): Promise<Response> {
  try {
    const path = new URL(String(input), "https://localhost").pathname;
    const body = JSON.parse(String(init.body ?? "{}"));
    if (path === "/api/vision") {
      const modelInput: VisionProtocolInput = { history: [], action: "chat", ...body };
      const response = await platformFetch(endpoint(body.baseUrl, "chat/completions"), {
        method: "POST",
        signal: init.signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${body.apiKey}` },
        body: JSON.stringify(buildVisionPayload(modelInput)),
      });
      await checkProvider(response);
      if (modelInput.action === "chat") return response;
      return Response.json({ ok: true, reply: parseVisionReply(await response.text()) });
    }
    if (path === "/api/transcribe") {
      const audio = Uint8Array.from(atob(String(body.audio).split(",").pop()!), (x) =>
        x.charCodeAt(0),
      );
      const form = buildTranscriptionForm(audio, body);
      const response = await platformFetch(endpoint(body.baseUrl, "audio/transcriptions"), {
        method: "POST",
        signal: init.signal,
        headers: { Authorization: `Bearer ${body.apiKey}` },
        body: form,
      });
      await checkProvider(response);
      const result = await response.json();
      if (typeof result.text !== "string") throw new Error("语音服务没有返回转写文字");
      return Response.json({ ok: true, text: result.text });
    }
    if (path === "/api/web-tools") {
      const tools = createWebTools(async (url, request, service, maxBytes) => {
        const response = await platformFetch(url, { signal: request.signal });
        if (!response.ok) throw new Error(`${service}返回 ${response.status}`);
        const text = await response.text();
        if (new TextEncoder().encode(text).length > maxBytes) throw new Error(`${service}响应过大`);
        return text;
      });
      const request = new Request("https://localhost/api/web-tools", { signal: init.signal });
      const result =
        body.tool === "weather"
          ? await tools.weather(body.location, request)
          : body.tool === "news"
            ? await tools.news(body.query, request)
            : await tools.webSearch(body.query, request);
      return Response.json({ ok: true, result });
    }
    throw new Error(`原生接口未定义：${path}`);
  } catch (error) {
    if (init.signal?.aborted) throw error;
    const value = error as Error;
    return Response.json(
      {
        error: value.message,
        code: error instanceof SafeApiError ? error.code : "UPSTREAM_UNAVAILABLE",
      },
      { status: error instanceof SafeApiError ? error.status : 503 },
    );
  }
}
