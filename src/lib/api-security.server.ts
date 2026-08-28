import { z } from "zod";

import { VISION_TEXT_LIMITS } from "./ai-request-contract";
import { getRuntimeBindings, type DistributedRateLimiter } from "./runtime-bindings.server";

const KIB = 1024;
const MIB = 1024 * KIB;

export const API_LIMITS = {
  visionRequestBytes: 9 * MIB,
  transcribeRequestBytes: 21 * MIB,
  webToolRequestBytes: 8 * KIB,
  ...VISION_TEXT_LIMITS,
  imageBytes: 6 * MIB,
  audioBytes: 15 * MIB,
  upstreamErrorBytes: 2 * KIB,
  upstreamJsonBytes: 2 * MIB,
  visionTimeoutMs: 90_000,
  transcriptionTimeoutMs: 120_000,
} as const;

const SAFE_HEADERS = {
  "Cache-Control": "no-store",
  Pragma: "no-cache",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
} as const;

const DEFAULT_CUSTOM_AI_HOSTS = new Set(["api.openai.com", "api.deepseek.com"]);
const METADATA_HOSTS = new Set([
  "metadata.google.internal",
  "metadata.google.com",
  "instance-data",
  "instance-data.ec2.internal",
]);

export type ApiErrorCode =
  | "INVALID_CONTENT_TYPE"
  | "INVALID_JSON"
  | "INVALID_REQUEST"
  | "PAYLOAD_TOO_LARGE"
  | "RATE_LIMITED"
  | "SESSION_REQUIRED"
  | "CUSTOM_HOST_DENIED"
  | "UPSTREAM_REJECTED"
  | "UPSTREAM_TIMEOUT"
  | "UPSTREAM_UNAVAILABLE"
  | "UPSTREAM_INVALID_RESPONSE"
  | "SERVER_MISCONFIGURED"
  | "INTERNAL_ERROR";

export class SafeApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly retryAfterSeconds?: number;

  constructor(status: number, code: ApiErrorCode, message: string, retryAfterSeconds?: number) {
    super(message);
    this.name = "SafeApiError";
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export function apiJson(body: Record<string, unknown>, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  for (const [name, value] of Object.entries(SAFE_HEADERS)) headers.set(name, value);
  return Response.json(body, { ...init, headers });
}

export function apiErrorResponse(error: unknown): Response {
  const safeError =
    error instanceof SafeApiError
      ? error
      : new SafeApiError(500, "INTERNAL_ERROR", "服务暂时不可用，请稍后再试");
  const headers = new Headers();
  if (safeError.retryAfterSeconds !== undefined) {
    headers.set("Retry-After", String(safeError.retryAfterSeconds));
  }
  return apiJson(
    { error: safeError.message, code: safeError.code },
    { status: safeError.status, headers },
  );
}

export function noStoreHeaders(extra?: HeadersInit): Headers {
  const headers = new Headers(extra);
  for (const [name, value] of Object.entries(SAFE_HEADERS)) headers.set(name, value);
  return headers;
}

const optionalTrimmedString = (max: number) => z.string().trim().max(max).optional();

function splitDataUrl(value: string): { metadata: string | null; base64: string } {
  if (!value.startsWith("data:")) return { metadata: null, base64: value };
  const comma = value.indexOf(",");
  if (comma === -1) return { metadata: value, base64: "" };
  return { metadata: value.slice(0, comma), base64: value.slice(comma + 1) };
}

function isCanonicalBase64(value: string): boolean {
  if (!value || value.length % 4 !== 0) return false;
  let padding = 0;
  if (value.endsWith("==")) padding = 2;
  else if (value.endsWith("=")) padding = 1;
  const contentLength = value.length - padding;
  for (let index = 0; index < contentLength; index += 1) {
    const code = value.charCodeAt(index);
    const valid =
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) ||
      code === 43 ||
      code === 47;
    if (!valid) return false;
  }
  for (let index = contentLength; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 61) return false;
  }
  return true;
}

export function decodedBase64Bytes(value: string): number | null {
  const { base64 } = splitDataUrl(value);
  if (!isCanonicalBase64(base64)) return null;
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return (base64.length / 4) * 3 - padding;
}

const imageSchema = z.string().superRefine((value, context) => {
  const { metadata } = splitDataUrl(value);
  if (!metadata || !/^data:image\/(?:jpeg|png|webp|gif);base64$/i.test(metadata)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "图片必须是受支持的 base64 data URL",
    });
    return;
  }
  const bytes = decodedBase64Bytes(value);
  if (bytes === null) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "图片 base64 无效" });
  } else if (bytes > API_LIMITS.imageBytes) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "图片超过大小限制" });
  }
});

const historyTurnSchema = z
  .object({
    role: z.enum(["user", "assistant"]),
    text: z.string().max(API_LIMITS.historyTurnCharacters),
    // The current client keeps the thumbnail on a past turn. It is validated
    // for request-size safety, then omitted from the messages sent upstream.
    image: imageSchema.optional(),
  })
  .strict()
  .transform(({ role, text }) => ({ role, text }));

const baseBodyShape = {
  kind: z.enum(["lovable", "openai"]).default("lovable"),
  baseUrl: optionalTrimmedString(2_048),
  apiKey: optionalTrimmedString(1_024),
};

export const visionBodySchema = z
  .object({
    ...baseBodyShape,
    model: z.string().trim().min(1).max(200),
    action: z.enum(["chat", "test", "audit"]).default("chat"),
    maxOutputTokens: z.number().int().min(1).max(32_768).optional(),
    prompt: optionalTrimmedString(API_LIMITS.promptCharacters),
    image: imageSchema.nullish(),
    history: z
      .preprocess(
        (value) => (Array.isArray(value) ? value.slice(-API_LIMITS.historyTurns) : value),
        z.array(historyTurnSchema).max(API_LIMITS.historyTurns),
      )
      .default([]),
  })
  .strict()
  .superRefine((body, context) => {
    const historyCharacters = body.history.reduce((total, turn) => total + turn.text.length, 0);
    if (historyCharacters > API_LIMITS.historyTotalCharacters) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["history"],
        message: "历史消息总长度超过限制",
      });
    }
    if (body.action !== "test" && !body.prompt) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["prompt"],
        message: "缺少问题",
      });
    }
    if (body.kind === "openai" && !body.baseUrl) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["baseUrl"],
        message: "缺少接口地址",
      });
    }
    if (body.kind === "openai" && !body.apiKey) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["apiKey"],
        message: "自定义接口必须使用调用者自己的 API Key",
      });
    }
  });

export type VisionBody = z.infer<typeof visionBodySchema>;

const audioSchema = z.string().superRefine((value, context) => {
  const { metadata } = splitDataUrl(value);
  if (metadata && !/^data:audio\/[a-z0-9.+-]+(?:;[^,;=]+=[^,;]+)*;base64$/i.test(metadata)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "音频 data URL 无效" });
    return;
  }
  const bytes = decodedBase64Bytes(value);
  if (bytes === null) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "音频 base64 无效" });
  } else if (bytes < 256) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "音频内容过短" });
  } else if (bytes > API_LIMITS.audioBytes) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "音频超过大小限制" });
  }
});

function isSafeFilename(value: string): boolean {
  if (value.includes("/") || value.includes("\\")) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return false;
  }
  return true;
}

export const transcribeBodySchema = z
  .object({
    ...baseBodyShape,
    model: z.string().trim().min(1).max(200).optional(),
    audio: audioSchema,
    mime: optionalTrimmedString(100).refine(
      (value) =>
        !value || /^audio\/[a-z0-9.+-]+(?:\s*;\s*[a-z0-9.+-]+=[a-z0-9.+-]+)*$/i.test(value),
      "音频 MIME 类型无效",
    ),
    filename: optionalTrimmedString(160).refine(
      (value) => !value || isSafeFilename(value),
      "文件名无效",
    ),
    hint: optionalTrimmedString(600),
    language: optionalTrimmedString(35).refine(
      (value) => !value || value === "auto" || /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(value),
      "语言代码无效",
    ),
  })
  .strict()
  .superRefine((body, context) => {
    if (body.kind === "openai" && !body.baseUrl) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["baseUrl"],
        message: "缺少接口地址",
      });
    }
    if (body.kind === "openai" && !body.apiKey) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["apiKey"],
        message: "自定义接口必须使用调用者自己的 API Key",
      });
    }
  });

export type TranscribeBody = z.infer<typeof transcribeBodySchema>;

async function readTextLimited(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<string> {
  if (!body) return "";
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let total = 0;
  let result = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new SafeApiError(413, "PAYLOAD_TOO_LARGE", "请求体超过大小限制");
      }
      result += decoder.decode(value, { stream: true });
    }
    return result + decoder.decode();
  } catch (error) {
    if (error instanceof SafeApiError) throw error;
    throw new SafeApiError(400, "INVALID_JSON", "请求体不是合法 UTF-8 JSON");
  } finally {
    reader.releaseLock();
  }
}

export async function parseJsonRequest<T extends z.ZodTypeAny>(
  request: Request,
  schema: T,
  maxBytes: number,
): Promise<z.infer<T>> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new SafeApiError(415, "INVALID_CONTENT_TYPE", "请求必须使用 application/json");
  }

  const contentLength = request.headers.get("content-length");
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > maxBytes) {
    throw new SafeApiError(413, "PAYLOAD_TOO_LARGE", "请求体超过大小限制");
  }

  const raw = await readTextLimited(request.body, maxBytes);
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new SafeApiError(400, "INVALID_JSON", "请求体不是合法 JSON");
  }

  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new SafeApiError(400, "INVALID_REQUEST", "请求参数不符合要求");
  }
  return parsed.data;
}

function normalizedHostname(hostname: string): string {
  const withoutBrackets =
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  return withoutBrackets.toLowerCase().replace(/\.+$/, "");
}

function isIpv4(hostname: string): boolean {
  const parts = hostname.split(".");
  return (
    parts.length === 4 &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) >= 0 && Number(part) <= 255)
  );
}

function isIpv6(hostname: string): boolean {
  return hostname.includes(":") && /^[0-9a-f:.]+$/i.test(hostname);
}

function isBlockedHostname(hostname: string): boolean {
  const host = normalizedHostname(hostname);
  if (!host) return true;
  if (isIpv4(host) || isIpv6(host)) return true;
  if (METADATA_HOSTS.has(host) || host.includes("metadata")) return true;
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".home.arpa")
  ) {
    return true;
  }
  return false;
}

function configuredCustomAiHosts(): Set<string> {
  const hosts = new Set(DEFAULT_CUSTOM_AI_HOSTS);
  const configured = process.env.AI_PROXY_ALLOWED_HOSTS ?? "";
  for (const entry of configured.split(",")) {
    const host = normalizedHostname(entry.trim());
    if (host && !host.includes("*") && !isBlockedHostname(host)) hosts.add(host);
  }
  return hosts;
}

/**
 * Cloudflare deployments cannot safely pin an HTTPS request to a pre-resolved IP.
 * Exact trusted-host allowlisting (never wildcards), literal-IP rejection, and manual
 * redirect handling therefore form the DNS-rebinding-safe trust boundary.
 */
export function validateCustomBaseUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SafeApiError(400, "CUSTOM_HOST_DENIED", "接口地址格式无效");
  }

  if (url.protocol !== "https:") {
    throw new SafeApiError(400, "CUSTOM_HOST_DENIED", "自定义接口只允许 HTTPS");
  }
  if (url.username || url.password) {
    throw new SafeApiError(400, "CUSTOM_HOST_DENIED", "接口地址不能包含用户名或密码");
  }
  if (url.port && url.port !== "443") {
    throw new SafeApiError(400, "CUSTOM_HOST_DENIED", "自定义接口只允许 443 端口");
  }
  if (url.search || url.hash) {
    throw new SafeApiError(400, "CUSTOM_HOST_DENIED", "接口地址不能包含查询参数或片段");
  }

  const hostname = normalizedHostname(url.hostname);
  if (isBlockedHostname(hostname) || !configuredCustomAiHosts().has(hostname)) {
    throw new SafeApiError(
      403,
      "CUSTOM_HOST_DENIED",
      "该接口域名未获服务端许可；部署者可通过 AI_PROXY_ALLOWED_HOSTS 添加精确域名",
    );
  }

  url.hostname = hostname;
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url;
}

export function appendApiPath(baseUrl: URL, endpoint: string): string {
  const url = new URL(baseUrl.toString());
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/${endpoint.replace(/^\/+/, "")}`;
  return url.toString();
}

type RateLimitEntry = { windowStartedAt: number; count: number };
const rateLimitBuckets = new Map<string, RateLimitEntry>();
const MAX_RATE_LIMIT_BUCKETS = 5_000;

function distributedLimiterFor(routeName: string): DistributedRateLimiter | undefined {
  const bindings = getRuntimeBindings();
  if (routeName === "transcribe") return bindings.ZHIMAI_TRANSCRIBE_LIMITER;
  if (routeName === "vision") return bindings.ZHIMAI_VISION_LIMITER;
  if (routeName === "web-tools") return bindings.ZHIMAI_WEB_TOOLS_LIMITER;
  return undefined;
}

async function digestRateLimitIdentity(value: string): Promise<string> {
  const bindings = getRuntimeBindings();
  const salt =
    bindings.ZHIMAI_RATE_LIMIT_SALT ??
    process.env.ZHIMAI_RATE_LIMIT_SALT ??
    "zhimai-connect-rate-limit-v1";
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${salt}\u0000${value}`),
  );
  return [...new Uint8Array(digest)]
    .slice(0, 16)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function rateLimitActor(request: Request): Promise<string> {
  // Cloudflare overwrites CF-Connecting-IP before the Worker runs. The public
  // status endpoint may rotate session UUIDs, so the stable client bucket must
  // be based on this edge identity, never X-Forwarded-For/X-Real-IP/session.
  const connectingIp = request.headers.get("cf-connecting-ip")?.trim().toLowerCase() ?? "";
  const edgeIdentity =
    connectingIp.length <= 64 && (isIpv4(connectingIp) || isIpv6(connectingIp))
      ? `edge-ip:${connectingIp}`
      : "unverified-edge-client";
  return `client:${await digestRateLimitIdentity(edgeIdentity)}`;
}

function enforceMemoryRateLimit(
  actor: string,
  routeName: string,
  limit: number,
  windowMs = 60_000,
): void {
  const now = Date.now();
  const key = `${routeName}:${actor}`;
  const current = rateLimitBuckets.get(key);
  if (!current || now - current.windowStartedAt >= windowMs) {
    if (!current && rateLimitBuckets.size >= MAX_RATE_LIMIT_BUCKETS) {
      for (const [candidate, entry] of rateLimitBuckets) {
        if (now - entry.windowStartedAt >= windowMs) rateLimitBuckets.delete(candidate);
      }
      while (rateLimitBuckets.size >= MAX_RATE_LIMIT_BUCKETS) {
        const oldest = rateLimitBuckets.keys().next().value as string | undefined;
        if (!oldest) break;
        rateLimitBuckets.delete(oldest);
      }
    }
    rateLimitBuckets.set(key, { windowStartedAt: now, count: 1 });
    return;
  }
  current.count += 1;
  if (current.count > limit) {
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((windowMs - (now - current.windowStartedAt)) / 1_000),
    );
    throw new SafeApiError(429, "RATE_LIMITED", "请求过于频繁，请稍后再试", retryAfterSeconds);
  }
}

export async function enforceRateLimit(
  request: Request,
  routeName: string,
  limit: number,
  windowMs = 60_000,
): Promise<void> {
  const actor = await rateLimitActor(request);
  const distributed = distributedLimiterFor(routeName);
  if (distributed) {
    try {
      const { success } = await distributed.limit({
        key: `${routeName}:${actor}`,
      });
      if (!success) {
        throw new SafeApiError(
          429,
          "RATE_LIMITED",
          "请求过于频繁，请稍后再试",
          Math.max(1, Math.ceil(windowMs / 1_000)),
        );
      }
      return;
    } catch (error) {
      if (error instanceof SafeApiError) throw error;
      // A binding outage must not turn every AI endpoint into a 500. The local
      // bounded limiter remains a conservative fallback for non-Workers runtimes.
      console.error("Cloudflare rate limiter unavailable; using local fallback", error);
    }
  }
  enforceMemoryRateLimit(actor, routeName, limit, windowMs);
}

const API_SESSION_COOKIE = "zhimai_ai_session";

export function issueApiSession(request: Request) {
  const token = crypto.randomUUID();
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return {
    token,
    cookie: `${API_SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/api; Max-Age=7200${secure}`,
  };
}

/**
 * 同源页面先从 /api/status 取得内存令牌，并通过 HttpOnly SameSite cookie 做双提交校验。
 * 这不是用户账号体系，但可阻止未建立浏览器会话的匿名/跨站直接代理调用。
 */
export function requireApiSession(request: Request) {
  const header = request.headers.get("x-zhimai-session")?.trim() ?? "";
  const cookie = request.headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${API_SESSION_COOKIE}=`))
    ?.slice(API_SESSION_COOKIE.length + 1);
  if (!header || !cookie || header !== cookie || !/^[0-9a-f-]{36}$/i.test(header)) {
    throw new SafeApiError(401, "SESSION_REQUIRED", "AI 会话已失效，请刷新页面后重试");
  }
}

export type UpstreamRequest = {
  response: Response;
  signal: AbortSignal;
  didTimeOut: () => boolean;
  /** Reset the deadline after receiving upstream activity (used by streaming routes). */
  refreshTimeout: () => void;
  abort: () => void;
  dispose: () => void;
};

export async function startUpstreamRequest(
  url: string,
  init: RequestInit,
  options: {
    timeoutMs: number;
    timeoutMessage?: string;
    unavailableMessage?: string;
    requestSignal?: AbortSignal;
    fetcher?: typeof fetch;
  },
): Promise<UpstreamRequest> {
  const controller = new AbortController();
  let timedOut = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const armTimeout = () => {
    if (timeout !== undefined) clearTimeout(timeout);
    timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, options.timeoutMs);
  };
  armTimeout();
  const abortFromClient = () => controller.abort();
  options.requestSignal?.addEventListener("abort", abortFromClient, { once: true });
  if (options.requestSignal?.aborted) abortFromClient();

  const dispose = () => {
    if (timeout !== undefined) clearTimeout(timeout);
    options.requestSignal?.removeEventListener("abort", abortFromClient);
  };

  try {
    const response = await (options.fetcher ?? fetch)(url, {
      ...init,
      redirect: "manual",
      signal: controller.signal,
    });
    return {
      response,
      signal: controller.signal,
      didTimeOut: () => timedOut,
      refreshTimeout: () => {
        if (!controller.signal.aborted) armTimeout();
      },
      abort: () => controller.abort(),
      dispose,
    };
  } catch {
    dispose();
    if (timedOut) {
      throw new SafeApiError(
        504,
        "UPSTREAM_TIMEOUT",
        options.timeoutMessage ?? "上游服务连接或首包响应超时",
      );
    }
    throw new SafeApiError(
      502,
      "UPSTREAM_UNAVAILABLE",
      options.unavailableMessage ?? "无法连接上游 AI 服务",
    );
  }
}

export async function readResponseTextLimited(
  response: Response,
  maxBytes: number,
): Promise<string> {
  return await readTextLimited(response.body, maxBytes);
}

export async function consumeUpstreamError(response: Response, service: string): Promise<Response> {
  let raw = "";
  try {
    raw = await readResponseTextLimited(response, API_LIMITS.upstreamErrorBytes);
  } catch {
    await response.body?.cancel().catch(() => undefined);
  }
  const safeToken = (value: unknown) => {
    if (typeof value !== "string" && typeof value !== "number") return undefined;
    const token = String(value).trim();
    return token && token.length <= 160 && /^[A-Za-z0-9._:/ -]+$/.test(token) ? token : undefined;
  };
  let providerCode: string | undefined;
  let providerType: string | undefined;
  try {
    const body = JSON.parse(raw) as Record<string, unknown>;
    const error =
      body.error && typeof body.error === "object" && !Array.isArray(body.error)
        ? (body.error as Record<string, unknown>)
        : body;
    providerCode = safeToken(error.code);
    providerType = safeToken(error.type);
  } catch {
    // Plain-text and HTML error pages intentionally contribute no body details.
  }
  const upstreamRequestId =
    safeToken(response.headers.get("x-request-id")) ??
    safeToken(response.headers.get("request-id")) ??
    safeToken(response.headers.get("cf-ray"));
  console.warn(
    `[${service}] upstream rejected request (status=${response.status}${providerCode ? `, code=${providerCode}` : ""}${upstreamRequestId ? `, request=${upstreamRequestId}` : ""})`,
  );

  const diagnostic = {
    upstreamStatus: response.status,
    ...(providerCode ? { providerCode } : {}),
    ...(providerType ? { providerType } : {}),
    ...(upstreamRequestId ? { upstreamRequestId } : {}),
  };

  if (response.status === 429) {
    return apiJson(
      {
        error: "上游 AI 服务请求过于频繁，请稍后再试",
        code: "UPSTREAM_REJECTED",
        ...diagnostic,
      },
      { status: 429 },
    );
  }
  if (response.status === 401 || response.status === 403) {
    return apiJson(
      {
        error: "上游 AI 服务拒绝了凭据，请检查 API Key",
        code: "UPSTREAM_REJECTED",
        ...diagnostic,
      },
      { status: 502 },
    );
  }
  if (response.status === 402) {
    return apiJson(
      {
        error: "上游 AI 服务额度不足，请检查账户余额",
        code: "UPSTREAM_REJECTED",
        ...diagnostic,
      },
      { status: 502 },
    );
  }
  return apiJson(
    { error: "上游 AI 服务拒绝了请求", code: "UPSTREAM_REJECTED", ...diagnostic },
    { status: 502 },
  );
}

export function decodeBase64(value: string): Uint8Array {
  const { base64 } = splitDataUrl(value);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
