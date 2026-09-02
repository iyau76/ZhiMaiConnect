import { describe, expect, it, vi } from "vitest";

import {
  ModelRetryExhaustedError,
  ModelTransportError,
  isTransientModelError,
  runWithTransientModelRetries,
} from "./model-transport-resilience";

describe("model transport resilience", () => {
  it("classifies transient service failures without retrying configuration errors", () => {
    expect(isTransientModelError(new ModelTransportError("temporary", 503))).toBe(true);
    expect(isTransientModelError(new ModelTransportError("响应超时", 504))).toBe(true);
    expect(
      isTransientModelError(
        new ModelTransportError("内置 AI 尚未配置", 503, "SERVER_MISCONFIGURED"),
      ),
    ).toBe(false);
    expect(isTransientModelError(new ModelTransportError("API Key 无效", 502))).toBe(false);
    expect(
      isTransientModelError(
        new ModelTransportError("上游拒绝请求", 502, "UPSTREAM_REJECTED", {
          upstreamStatus: 400,
        }),
      ),
    ).toBe(false);
    expect(
      isTransientModelError(
        new ModelTransportError("上游暂时不可用", 502, "UPSTREAM_REJECTED", {
          upstreamStatus: 503,
        }),
      ),
    ).toBe(true);
    expect(isTransientModelError(new ModelTransportError("请求过多", 429, "RATE_LIMITED"))).toBe(
      false,
    );
    expect(
      isTransientModelError(
        new ModelTransportError("上游请求过多", 502, "UPSTREAM_REJECTED", {
          upstreamStatus: 429,
        }),
      ),
    ).toBe(false);
    expect(
      isTransientModelError(new ModelRetryExhaustedError(3, new ModelTransportError("503", 503))),
    ).toBe(false);
  });

  it("retries only the invocation while preserving one caller-owned logical round", async () => {
    const invoke = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new ModelTransportError("503", 503))
      .mockRejectedValueOnce(new ModelTransportError("timeout", 504))
      .mockResolvedValueOnce("ok");
    const retries: number[] = [];
    const result = await runWithTransientModelRetries({
      invoke,
      delaysMs: [0, 0],
      onRetry: ({ nextAttempt }) => retries.push(nextAttempt),
    });
    expect(result).toEqual({ value: "ok", attempts: 3 });
    expect(retries).toEqual([2, 3]);
  });

  it("returns a typed exhaustion error for resumable callers", async () => {
    await expect(
      runWithTransientModelRetries({
        invoke: () => Promise.reject(new ModelTransportError("503", 503)),
        maxAttempts: 2,
        delaysMs: [0],
      }),
    ).rejects.toBeInstanceOf(ModelRetryExhaustedError);
  });

  it("does not nest another retry loop around an exhausted request", async () => {
    const exhausted = new ModelRetryExhaustedError(3, new ModelTransportError("503", 503));
    const invoke = vi.fn<() => Promise<string>>().mockRejectedValue(exhausted);

    await expect(
      runWithTransientModelRetries({ invoke, maxAttempts: 3, delaysMs: [0, 0] }),
    ).rejects.toBe(exhausted);
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
