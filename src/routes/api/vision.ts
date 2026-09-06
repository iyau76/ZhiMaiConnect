import { createFileRoute } from "@tanstack/react-router";

import {
  API_LIMITS,
  SafeApiError,
  apiErrorResponse,
  apiJson,
  appendApiPath,
  consumeUpstreamError,
  enforceRateLimit,
  noStoreHeaders,
  parseJsonRequest,
  readResponseTextLimited,
  requireApiSession,
  startUpstreamRequest,
  validateCustomBaseUrl,
  visionBodySchema,
  type UpstreamRequest,
  type VisionBody,
} from "../../lib/api-security.server";

import { buildVisionPayload, parseVisionReply } from "../../lib/provider-protocol";

function resolveTarget(body: VisionBody) {
  const baseUrl = validateCustomBaseUrl(body.baseUrl ?? "");
  return {
    url: appendApiPath(baseUrl, "chat/completions"),
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${body.apiKey}`,
    } as Record<string, string>,
  };
}

/**
 * Keep the Worker on the transport plane: forward bytes and refresh the idle
 * deadline, while the browser performs SSE decoding. This removes per-token
 * UTF-8 concatenation and JSON.parse work from the edge CPU budget.
 */
function proxySseBytes(
  upstream: ReadableStream<Uint8Array>,
  request: UpstreamRequest,
  onFinish: (result: {
    outcome: "completed" | "cancelled" | "stream_error";
    bytes: number;
  }) => void,
) {
  const reader = upstream.getReader();
  let bytes = 0;
  let finished = false;
  const finish = (outcome: "completed" | "cancelled" | "stream_error") => {
    if (finished) return;
    finished = true;
    onFinish({ outcome, bytes });
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          reader.releaseLock();
          request.dispose();
          finish("completed");
          return;
        }
        if (value.byteLength > 0) {
          bytes += value.byteLength;
          request.refreshTimeout();
        }
        controller.enqueue(value);
      } catch {
        controller.error(
          new Error(
            request.didTimeOut()
              ? "上游 AI 流式响应连续 90 秒没有收到数据，已中止连接"
              : "上游 AI 响应流中断",
          ),
        );
        reader.releaseLock();
        request.dispose();
        finish("stream_error");
      }
    },
    async cancel() {
      request.abort();
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
      request.dispose();
      finish("cancelled");
    },
  });
}

export async function handleVisionPost(request: Request): Promise<Response> {
  let upstreamRequest: UpstreamRequest | undefined;
  const startedAt = Date.now();
  const clientRequestId = request.headers.get("x-zhimai-client-request") ?? crypto.randomUUID();
  const requestBytes = Number(request.headers.get("content-length")) || undefined;
  let model = "unknown";
  let upstreamHeaderMs: number | undefined;
  const logResult = (
    outcome: string,
    details: { status?: number; code?: string; streamBytes?: number } = {},
  ) => {
    console.info(
      `[vision] ${JSON.stringify({
        clientRequestId,
        outcome,
        model,
        requestBytes,
        upstreamHeaderMs,
        wallTimeMs: Date.now() - startedAt,
        ...details,
      })}`,
    );
  };
  try {
    requireApiSession(request);
    await enforceRateLimit(request, "vision", 30);
    const body = await parseJsonRequest(request, visionBodySchema, API_LIMITS.visionRequestBytes);
    model = body.model;
    const target = resolveTarget(body);
    const oneShot = body.action !== "chat";
    const payload = buildVisionPayload({ ...body, baseUrl: body.baseUrl ?? "" });

    upstreamRequest = await startUpstreamRequest(
      target.url,
      {
        method: "POST",
        headers: target.headers,
        body: JSON.stringify(payload),
      },
      {
        timeoutMs: API_LIMITS.visionTimeoutMs,
        timeoutMessage: "上游 AI 连接或首包响应超时",
        requestSignal: request.signal,
      },
    );

    const upstream = upstreamRequest.response;
    upstreamHeaderMs = Date.now() - startedAt;
    if (!upstream.ok) {
      const response = await consumeUpstreamError(upstream, "vision");
      logResult("upstream_rejected", { status: response.status });
      upstreamRequest.dispose();
      upstreamRequest = undefined;
      return response;
    }

    if (oneShot) {
      let raw: string;
      try {
        raw = await readResponseTextLimited(upstream, API_LIMITS.upstreamJsonBytes);
      } catch {
        if (upstreamRequest.didTimeOut()) {
          throw new SafeApiError(504, "UPSTREAM_TIMEOUT", "上游 AI 服务响应超时");
        }
        throw new SafeApiError(502, "UPSTREAM_INVALID_RESPONSE", "上游 AI 返回内容过大或无法读取");
      } finally {
        upstreamRequest.dispose();
        upstreamRequest = undefined;
      }

      const reply = parseVisionReply(raw);
      logResult("completed", { status: 200 });
      return apiJson({ ok: true, reply });
    }

    if (!upstream.body) {
      upstreamRequest.dispose();
      upstreamRequest = undefined;
      throw new SafeApiError(502, "UPSTREAM_INVALID_RESPONSE", "上游 AI 没有返回内容");
    }

    const contentType = upstream.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.includes("text/event-stream")) {
      upstreamRequest.dispose();
      upstreamRequest = undefined;
      throw new SafeApiError(502, "UPSTREAM_INVALID_RESPONSE", "上游 AI 未返回 SSE 流");
    }

    const stream = proxySseBytes(upstream.body, upstreamRequest, (result) =>
      logResult(result.outcome, {
        status: result.outcome === "completed" ? 200 : undefined,
        streamBytes: result.bytes,
      }),
    );
    upstreamRequest = undefined;
    return new Response(stream, {
      headers: noStoreHeaders({
        "Content-Type": "text/event-stream; charset=utf-8",
        "X-Accel-Buffering": "no",
      }),
    });
  } catch (error) {
    upstreamRequest?.dispose();
    logResult("failed", {
      status: error instanceof SafeApiError ? error.status : 500,
      code: error instanceof SafeApiError ? error.code : "INTERNAL_ERROR",
    });
    if (!(error instanceof SafeApiError)) console.error("[vision] unexpected internal failure");
    return apiErrorResponse(error);
  }
}

export const Route = createFileRoute("/api/vision")({
  server: {
    handlers: {
      POST: ({ request }) => handleVisionPost(request),
    },
  },
});
