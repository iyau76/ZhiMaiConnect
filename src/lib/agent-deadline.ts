export class AgentDeadlineExceededError extends Error {
  readonly code = "AGENT_DEADLINE_EXCEEDED";

  constructor(readonly timeoutMs: number) {
    super(`Agent operation exceeded its ${timeoutMs} ms deadline`);
    this.name = "AgentDeadlineExceededError";
  }
}

export class AgentOperationAbortedError extends Error {
  readonly code = "AGENT_OPERATION_ABORTED";

  constructor(readonly cause?: unknown) {
    super("Agent operation was aborted");
    this.name = "AgentOperationAbortedError";
  }
}

export interface AgentDeadlineOptions {
  timeoutMs?: number;
  signals?: ReadonlyArray<AbortSignal | undefined>;
  now?: () => number;
}

export interface AgentDeadline {
  signal: AbortSignal;
  deadlineAt?: number;
  remainingMs(): number;
  throwIfAborted(): void;
  dispose(): void;
}

function abortReason(signal: AbortSignal) {
  return signal.reason instanceof Error
    ? signal.reason
    : new AgentOperationAbortedError(signal.reason);
}

/** Compose parent cancellation and an optional wall-clock deadline into one signal. */
export function createAgentDeadline(options: AgentDeadlineOptions = {}): AgentDeadline {
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs;
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs < 0)) {
    throw new TypeError(`Deadline must be a finite non-negative number: ${timeoutMs}`);
  }

  const controller = new AbortController();
  const deadlineAt = timeoutMs === undefined ? undefined : now() + timeoutMs;
  const cleanup: Array<() => void> = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const abort = (reason: unknown) => {
    if (!controller.signal.aborted) controller.abort(reason);
  };

  (options.signals ?? []).forEach((signal) => {
    if (!signal) return;
    if (signal.aborted) {
      abort(abortReason(signal));
      return;
    }
    const onAbort = () => abort(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    cleanup.push(() => signal.removeEventListener("abort", onAbort));
  });

  if (timeoutMs !== undefined && !controller.signal.aborted) {
    if (timeoutMs === 0) {
      abort(new AgentDeadlineExceededError(timeoutMs));
    } else {
      timer = setTimeout(() => abort(new AgentDeadlineExceededError(timeoutMs)), timeoutMs);
      if (typeof timer === "object" && "unref" in timer) {
        (timer as ReturnType<typeof setTimeout> & { unref(): void }).unref();
      }
    }
  }

  return {
    signal: controller.signal,
    deadlineAt,
    remainingMs: () =>
      deadlineAt === undefined ? Number.POSITIVE_INFINITY : Math.max(0, deadlineAt - now()),
    throwIfAborted: () => {
      if (controller.signal.aborted) throw abortReason(controller.signal);
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
      cleanup.forEach((removeListener) => removeListener());
    },
  };
}

/** Reject promptly on abort even when the underlying promise ignores its signal. */
export function raceAgentAbort<T>(operation: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(operation)
      .then(resolve, reject)
      .finally(() => {
        signal.removeEventListener("abort", onAbort);
      });
  });
}

export async function withAgentDeadline<T>(
  operation: (signal: AbortSignal) => T | PromiseLike<T>,
  options: AgentDeadlineOptions,
): Promise<T> {
  const deadline = createAgentDeadline(options);
  try {
    deadline.throwIfAborted();
    return await raceAgentAbort(
      Promise.resolve().then(() => operation(deadline.signal)),
      deadline.signal,
    );
  } finally {
    deadline.dispose();
  }
}

export function isAgentDeadlineExceeded(error: unknown): error is AgentDeadlineExceededError {
  return error instanceof AgentDeadlineExceededError;
}
