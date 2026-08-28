import assert from "node:assert/strict";

import { handleStatusGet } from "./status.ts";

type SessionPayload = {
  ok?: unknown;
  sessionToken?: unknown;
};

export async function apiSessionHeaders(): Promise<Headers> {
  const response = handleStatusGet(new Request("https://connect.example/api/status"));
  const payload = (await response.json()) as SessionPayload;
  const setCookie = response.headers.get("set-cookie");

  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(typeof payload.sessionToken, "string");
  assert.ok(setCookie);

  return new Headers({
    Cookie: setCookie.split(";", 1)[0] ?? "",
    "X-Zhimai-Session": payload.sessionToken as string,
  });
}

export async function routeRequest(
  path: "vision" | "transcribe" | "web-tools",
  body: BodyInit,
  options: {
    authenticated?: boolean;
    contentType?: string;
    headers?: HeadersInit;
  } = {},
): Promise<Request> {
  const headers = options.authenticated ? await apiSessionHeaders() : new Headers();
  const uniqueIp = crypto.randomUUID().replaceAll("-", "");
  headers.set(
    "CF-Connecting-IP",
    `2001:db8:${uniqueIp.slice(0, 4)}:${uniqueIp.slice(4, 8)}:${uniqueIp.slice(8, 12)}:${uniqueIp.slice(12, 16)}`,
  );
  if (options.contentType !== undefined) headers.set("Content-Type", options.contentType);
  else headers.set("Content-Type", "application/json");
  for (const [name, value] of new Headers(options.headers)) headers.set(name, value);

  return new Request(`https://connect.example/api/${path}`, {
    method: "POST",
    headers,
    body,
  });
}

export async function responseBody(response: Response) {
  return (await response.json()) as Record<string, unknown>;
}

export function assertSafeResponse(response: Response): void {
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("pragma"), "no-cache");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
}
