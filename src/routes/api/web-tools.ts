import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import {
  API_LIMITS,
  SafeApiError,
  apiErrorResponse,
  apiJson,
  enforceRateLimit,
  parseJsonRequest,
  readResponseTextLimited,
  requireApiSession,
  startUpstreamRequest,
  type UpstreamRequest,
} from "../../lib/api-security.server";

const webToolBodySchema = z.discriminatedUnion("tool", [
  z.object({ tool: z.literal("weather"), location: z.string().trim().min(1).max(100) }).strict(),
  z.object({ tool: z.literal("news"), query: z.string().trim().min(2).max(120) }).strict(),
  z.object({ tool: z.literal("search"), query: z.string().trim().min(2).max(120) }).strict(),
]);

import { createWebTools } from "../../lib/web-tool-service";
async function readFixedUpstream(url: string, request: Request, service: string, maxBytes: number) {
  let upstream: UpstreamRequest | undefined;
  try {
    upstream = await startUpstreamRequest(
      url,
      {
        method: "GET",
        headers: {
          Accept: "application/json, application/rss+xml, text/xml",
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/136 Safari/537.36",
        },
      },
      {
        timeoutMs: 12_000,
        timeoutMessage: `${service}响应超时`,
        unavailableMessage: `无法连接${service}`,
        requestSignal: request.signal,
      },
    );
    if (!upstream.response.ok) {
      console.warn(`[web-tools:${service}] upstream status=${upstream.response.status}`);
      throw new SafeApiError(502, "UPSTREAM_REJECTED", `${service}暂时不可用`);
    }
    return await readResponseTextLimited(upstream.response, maxBytes);
  } finally {
    upstream?.dispose();
  }
}
const { weather, news, webSearch } = createWebTools(readFixedUpstream);

export async function handleWebToolsPost(request: Request): Promise<Response> {
  try {
    requireApiSession(request);
    await enforceRateLimit(request, "web-tools", 24);
    const body = await parseJsonRequest(request, webToolBodySchema, API_LIMITS.webToolRequestBytes);
    const result =
      body.tool === "weather"
        ? await weather(body.location, request)
        : body.tool === "news"
          ? await news(body.query, request)
          : await webSearch(body.query, request);
    return apiJson({ ok: true, result });
  } catch (error) {
    if (!(error instanceof SafeApiError)) console.error("[web-tools] unexpected internal failure");
    return apiErrorResponse(error);
  }
}

export const Route = createFileRoute("/api/web-tools")({
  server: { handlers: { POST: ({ request }) => handleWebToolsPost(request) } },
});
