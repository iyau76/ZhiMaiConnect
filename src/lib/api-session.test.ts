import { beforeEach, describe, expect, it, vi } from "vitest";

import { apiSessionHeaders, fetchWithApiSession, resetApiSessionForRetry } from "./api-session";

describe("browser API session", () => {
  beforeEach(() => {
    resetApiSessionForRetry();
    vi.restoreAllMocks();
  });

  it("caches the status handshake for subsequent requests", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ sessionToken: "session-one" }));

    const first = await apiSessionHeaders();
    const second = await apiSessionHeaders();

    expect(first.get("x-zhimai-session")).toBe("session-one");
    expect(second.get("x-zhimai-session")).toBe("session-one");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("re-synchronizes once when another tab replaced the initial session cookie", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ sessionToken: "tab-one-token" }))
      .mockResolvedValueOnce(
        Response.json({ error: "session changed", code: "SESSION_REQUIRED" }, { status: 401 }),
      )
      .mockResolvedValueOnce(Response.json({ sessionToken: "shared-cookie-token" }))
      .mockResolvedValueOnce(Response.json({ ok: true }));

    const response = await fetchWithApiSession("/api/vision", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"action":"agent"}',
    });

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get("x-zhimai-session")).toBe(
      "tab-one-token",
    );
    expect(new Headers(fetchMock.mock.calls[3]?.[1]?.headers).get("x-zhimai-session")).toBe(
      "shared-cookie-token",
    );
    expect(fetchMock.mock.calls[3]?.[1]?.body).toBe('{"action":"agent"}');
  });

  it("does not replay unrelated authorization failures", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ sessionToken: "valid-token" }))
      .mockResolvedValueOnce(Response.json({ code: "UPSTREAM_REJECTED" }, { status: 401 }));

    const response = await fetchWithApiSession("/api/vision", { method: "POST" });

    expect(response.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
