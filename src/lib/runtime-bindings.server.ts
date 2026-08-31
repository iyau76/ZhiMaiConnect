export type DistributedRateLimiter = {
  limit(options: { key: string }): Promise<{ success: boolean }>;
};

export type ZhimaiRuntimeBindings = {
  ZHIMAI_TRANSCRIBE_LIMITER?: DistributedRateLimiter;
  ZHIMAI_VISION_LIMITER?: DistributedRateLimiter;
  ZHIMAI_WEB_TOOLS_LIMITER?: DistributedRateLimiter;
  /** Secret salt used only to pseudonymise edge client identifiers in limiter keys. */
  ZHIMAI_RATE_LIMIT_SALT?: string;
};

let runtimeBindings: ZhimaiRuntimeBindings = {};

/**
 * The Worker entrypoint receives bindings from Cloudflare. Keeping the immutable
 * binding handles here lets route modules use them without importing a
 * Cloudflare-only module during Node/Vitest execution.
 */
export function registerRuntimeBindings(bindings: unknown): void {
  if (bindings && typeof bindings === "object") {
    runtimeBindings = bindings as ZhimaiRuntimeBindings;
  }
}

export function getRuntimeBindings(): ZhimaiRuntimeBindings {
  return runtimeBindings;
}
