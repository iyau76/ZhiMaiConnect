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
