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

const LOVABLE_BASE = "https://ai.gateway.lovable.dev/v1";

const SYSTEM_PROMPT = [
  "你是「知脉 Connect」的内置助手：一个本地优先、证据可追溯的人际关系记忆与行动助手。",
  "你帮助用户整理其主动提供的人物档案、关系、互动记录、重要日期和行动事项，并生成可核对、可编辑的建议或草稿。",
  "事实规则：只依据本次对话中明确提供的文字、图片和资料回答；不得编造人物、关系、经历、联系方式或已完成的动作。资料不足时明确说“不确定”并指出需要补充什么。",
  "证据规则：涉及具体人物或关系时，尽量标明信息来源、发生或记录时间和置信度；严格区分已知事实、合理推断和行动建议。没有来源或时间时，不得虚构引用，应明确标注缺失。",
  "隐私规则：产品的档案默认保存在用户浏览器本地；只有用户主动调用云模型时，本次请求中选定的内容才会发送给相应服务商。不要声称所有处理都在本地完成。",
  "外部行动规则：你只能生成消息、提醒或沟通方案的草稿，不得声称已经发送、发布、联系或修改任何外部系统。",
  "平台边界：不得宣称能够读取、搜索或接入个人微信、QQ、小红书等封闭平台，也不得假装看到了用户未提供的聊天记录或账号数据。",
  "图片规则：只描述图片中可直接观察或读取的信息；不要凭外貌猜测身份、关系、健康、民族、政治倾向等敏感属性。若要关联到已有档案，必须让用户确认。",
  "表达规则：默认使用简洁、自然的中文；给出建议时说明依据、风险和下一步，始终让用户保留最终决定权。",
].join("\n");

type Message = { role: "system" | "user" | "assistant"; content: unknown };

function buildMessages(history: VisionBody["history"], prompt: string, image?: string | null) {
  const messages: Message[] = [{ role: "system", content: SYSTEM_PROMPT }];
  for (const turn of history) messages.push({ role: turn.role, content: turn.text });
  if (image) {
    messages.push({
      role: "user",
      content: [
        { type: "text", text: prompt },
        { type: "image_url", image_url: { url: image } },
      ],
    });
  } else {
    messages.push({ role: "user", content: prompt });
  }
  return messages;
}

function resolveTarget(body: VisionBody) {
  if (body.kind === "openai") {
    const baseUrl = validateCustomBaseUrl(body.baseUrl ?? "");
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (body.apiKey) headers.Authorization = `Bearer ${body.apiKey}`;
    return { url: appendApiPath(baseUrl, "chat/completions"), headers };
  }

  const key = process.env.LOVABLE_API_KEY;
  if (!key) {
    throw new SafeApiError(
      503,
      "SERVER_MISCONFIGURED",
      "内置 AI 尚未配置；请改用已获许可的自定义接口",
    );
  }
  return {
    url: `${LOVABLE_BASE}/chat/completions`,
    headers: {
      "Content-Type": "application/json",
      "Lovable-API-Key": key,
      "X-Lovable-AIG-SDK": "lovable-fetch",
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
    const oneShot = body.action === "test" || body.action === "audit";
    const prompt = body.action === "test" ? "回复两个字：连通" : (body.prompt ?? "");
    const payload = {
      model: body.model,
      messages: buildMessages(
        oneShot ? [] : body.history,
        prompt,
        body.action === "test" ? null : body.image,
      ),
      stream: !oneShot,
      ...(body.maxOutputTokens
        ? /(?:^|\/)(?:gpt-5|o[134])(?:[.-]|$)/i.test(body.model)
          ? { max_completion_tokens: body.maxOutputTokens }
          : { max_tokens: body.maxOutputTokens }
        : {}),
      ...(body.temperature !== undefined && !/(?:^|\/)(?:gpt-5|o[134])(?:[.-]|$)/i.test(body.model)
        ? { temperature: body.temperature }
        : {}),
      ...(body.model.startsWith("openai/gpt-5.6") ? { reasoning_effort: "none" } : {}),
    };

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

      let reply = "";
      try {
        const payload = JSON.parse(raw) as {
          choices?: Array<{ message?: { content?: unknown } }>;
        };
        const content = payload.choices?.[0]?.message?.content;
        if (typeof content === "string") reply = content;
      } catch {
        throw new SafeApiError(502, "UPSTREAM_INVALID_RESPONSE", "上游 AI 返回了无效响应");
      }
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
