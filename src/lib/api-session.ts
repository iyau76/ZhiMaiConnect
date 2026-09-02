let cached: { token: string; expiresAt: number } | null = null;
let pending: Promise<string> | null = null;

async function requestSession() {
  const response = await fetch("/api/status", {
    method: "GET",
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  });
  const body = (await response.json()) as { sessionToken?: unknown; error?: string };
  if (!response.ok || typeof body.sessionToken !== "string") {
    throw new Error(body.error ?? "无法建立 AI 安全会话");
  }
  cached = { token: body.sessionToken, expiresAt: Date.now() + 60 * 60 * 1_000 };
  return body.sessionToken;
}

export async function apiSessionHeaders(headers: HeadersInit = {}) {
  if (!cached || cached.expiresAt <= Date.now()) {
    pending ??= requestSession().finally(() => {
      pending = null;
    });
    await pending;
  }
  const result = new Headers(headers);
  result.set("X-Zhimai-Session", cached!.token);
  return result;
}

export function resetApiSessionForRetry() {
  cached = null;
}

export type ReplayableApiBody = string | Blob | FormData | URLSearchParams | ArrayBuffer | null;

export interface ReplayableApiRequestInit extends Omit<RequestInit, "body"> {
  body?: ReplayableApiBody;
}

async function hasExpiredApiSession(response: Response) {
  if (response.status !== 401) return false;
  try {
    const body = (await response.clone().json()) as { code?: unknown };
    return body.code === "SESSION_REQUIRED";
  } catch {
    return false;
  }
}

/**
 * Send a same-origin API request with the browser session handshake. A second
 * tab can win the initial cookie race, so one SESSION_REQUIRED response is
 * synchronized with the current cookie and replayed exactly once.
 */
export async function fetchWithApiSession(
  input: string | URL,
  init: ReplayableApiRequestInit = {},
) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetch(input, {
      ...init,
      credentials: init.credentials ?? "same-origin",
      headers: await apiSessionHeaders(init.headers),
    });
    if (attempt > 0 || !(await hasExpiredApiSession(response))) return response;
    resetApiSessionForRetry();
  }
  throw new Error("无法恢复 AI 安全会话");
}
