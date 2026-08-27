import { createFileRoute } from "@tanstack/react-router";

import {
  API_LIMITS,
  SafeApiError,
  apiErrorResponse,
  apiJson,
  appendApiPath,
  consumeUpstreamError,
  decodeBase64,
  enforceRateLimit,
  parseJsonRequest,
  readResponseTextLimited,
  requireApiSession,
  startUpstreamRequest,
  transcribeBodySchema,
  validateCustomBaseUrl,
  type TranscribeBody,
  type UpstreamRequest,
} from "../../lib/api-security.server";

const LOVABLE_BASE = "https://ai.gateway.lovable.dev/v1";
const DEFAULT_MODEL = "openai/gpt-4o-mini-transcribe";

function resolveTarget(body: TranscribeBody) {
  if (body.kind === "openai") {
    const baseUrl = validateCustomBaseUrl(body.baseUrl ?? "");
    const headers: Record<string, string> = {};
    if (body.apiKey) headers.Authorization = `Bearer ${body.apiKey}`;
    return {
      url: appendApiPath(baseUrl, "audio/transcriptions"),
      headers,
      model: body.model ?? "whisper-1",
    };
  }

  const key = process.env.LOVABLE_API_KEY;
  if (!key) {
    throw new SafeApiError(
      503,
      "SERVER_MISCONFIGURED",
      "内置语音转写尚未配置；请改用已获许可的自定义接口",
    );
  }
  return {
    url: `${LOVABLE_BASE}/audio/transcriptions`,
    headers: {
      "Lovable-API-Key": key,
      "X-Lovable-AIG-SDK": "lovable-fetch",
    } as Record<string, string>,
    model: body.model ?? DEFAULT_MODEL,
  };
}

export async function handleTranscribePost(request: Request): Promise<Response> {
  let upstreamRequest: UpstreamRequest | undefined;
  try {
    requireApiSession(request);
    await enforceRateLimit(request, "transcribe", 10);
    const body = await parseJsonRequest(
      request,
      transcribeBodySchema,
      API_LIMITS.transcribeRequestBytes,
    );
    const target = resolveTarget(body);

    let audio: Uint8Array;
    try {
      audio = decodeBase64(body.audio);
    } catch {
      throw new SafeApiError(400, "INVALID_REQUEST", "音频 base64 无法解码");
    }

    const form = new FormData();
    form.append(
      "file",
      new Blob([audio as unknown as BlobPart], { type: body.mime || "audio/webm" }),
      body.filename || "audio.webm",
    );
    form.append("model", target.model);
    if (body.hint) form.append("prompt", body.hint);
    if (body.language && body.language !== "auto") form.append("language", body.language);

    upstreamRequest = await startUpstreamRequest(
      target.url,
      { method: "POST", headers: target.headers, body: form },
      {
        timeoutMs: API_LIMITS.transcriptionTimeoutMs,
        timeoutMessage: "上游语音转写连接或首包响应超时",
        requestSignal: request.signal,
      },
    );

    const upstream = upstreamRequest.response;
    if (!upstream.ok) {
      const response = await consumeUpstreamError(upstream, "transcribe");
      upstreamRequest.dispose();
      upstreamRequest = undefined;
      return response;
    }

    let raw: string;
    try {
      raw = await readResponseTextLimited(upstream, API_LIMITS.upstreamJsonBytes);
    } catch {
      if (upstreamRequest.didTimeOut()) {
        throw new SafeApiError(504, "UPSTREAM_TIMEOUT", "上游语音转写响应超时");
      }
      throw new SafeApiError(502, "UPSTREAM_INVALID_RESPONSE", "上游语音转写响应无法读取");
    } finally {
      upstreamRequest.dispose();
      upstreamRequest = undefined;
    }

    let text: string;
    try {
      const payload = JSON.parse(raw) as { text?: unknown };
      if (typeof payload.text !== "string") throw new Error("missing text");
      text = payload.text;
    } catch {
      throw new SafeApiError(502, "UPSTREAM_INVALID_RESPONSE", "上游语音转写返回了无效响应");
    }
    return apiJson({ ok: true, text });
  } catch (error) {
    upstreamRequest?.dispose();
    if (!(error instanceof SafeApiError)) console.error("[transcribe] unexpected internal failure");
    return apiErrorResponse(error);
  }
}

export const Route = createFileRoute("/api/transcribe")({
  server: {
    handlers: {
      POST: ({ request }) => handleTranscribePost(request),
    },
  },
});
