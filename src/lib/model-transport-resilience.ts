export interface ModelTransportDiagnostics {
  clientRequestId?: string;
  edgeRequestId?: string;
  upstreamRequestId?: string;
  upstreamStatus?: number;
  providerCode?: string;
  providerType?: string;
}

export class ModelTransportError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
    readonly diagnostics?: ModelTransportDiagnostics,
  ) {
    super(message);
    this.name = "ModelTransportError";
  }
}

export class ModelRetryExhaustedError extends Error {
  constructor(
    readonly attempts: number,
    readonly lastError: unknown,
  ) {
    super(lastError instanceof Error ? lastError.message : "上游模型暂时不可用");
    this.name = "ModelRetryExhaustedError";
  }
}

const NON_RETRYABLE_CODES = new Set(["SERVER_MISCONFIGURED"]);
const NON_RETRYABLE_MESSAGES = /API Key|凭据|额度不足|尚未配置|接口地址/u;
const TIMEOUT_MESSAGES =
  /(?:timeout|timed out|响应超时|连接超时|首包.*超时|连续\s*\d+\s*秒没有收到数据)/iu;

export function isTransientModelError(error: unknown) {
  if (error instanceof ModelRetryExhaustedError) return true;
  if (error instanceof ModelTransportError) {
    if (error.code && NON_RETRYABLE_CODES.has(error.code)) return false;
    if (NON_RETRYABLE_MESSAGES.test(error.message)) return false;
    if (error.status === 408 || error.status === 425 || error.status === 429) return true;
    if (error.status !== undefined && error.status >= 500 && error.status <= 599) return true;
  }
  if (error instanceof Error) {
    if (error.name === "AbortError") return false;
    return TIMEOUT_MESSAGES.test(error.message);
  }
  return false;
}

function waitForRetry(delayMs: number, signal?: AbortSignal) {
  if (delayMs <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, delayMs);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

export async function runWithTransientModelRetries<T>(options: {
  invoke: (attempt: number) => Promise<T>;
  maxAttempts?: number;
  delaysMs?: readonly number[];
  signal?: AbortSignal;
  onRetry?: (event: {
    failedAttempt: number;
    nextAttempt: number;
    delayMs: number;
    error: unknown;
  }) => void;
}) {
  const maxAttempts = Math.max(1, Math.trunc(options.maxAttempts ?? 3));
  const delays = options.delaysMs ?? [300, 900];
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    options.signal?.throwIfAborted();
    try {
      return { value: await options.invoke(attempt), attempts: attempt };
    } catch (error) {
      if (!isTransientModelError(error)) throw error;
      if (attempt >= maxAttempts) throw new ModelRetryExhaustedError(attempt, error);
      const delayMs = delays[Math.min(attempt - 1, delays.length - 1)] ?? 0;
      options.onRetry?.({ failedAttempt: attempt, nextAttempt: attempt + 1, delayMs, error });
      await waitForRetry(delayMs, options.signal);
    }
  }
  throw new ModelRetryExhaustedError(maxAttempts, new Error("上游模型暂时不可用"));
}
