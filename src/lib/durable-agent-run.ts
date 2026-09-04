import {
  MemoryAgentRunRecorder,
  redactAgentCredentials,
  summarizeAgentRunTokens,
  type AgentRunEvent,
  type AgentRunEventInput,
  type AgentRunRecorder,
} from "./agent-run-log";
import {
  type AgentCheckpointKind,
  type CreateAgentCheckpointInput,
  type AgentDependencyRef,
  type AgentLedgerRunStatus,
  type AgentObservationRecord,
  type AgentRunBudgetRecord,
  type AgentRunLedgerRepository,
  type AgentRunLeaseToken,
  type AgentRunProviderRef,
  type AgentRunRecord,
} from "./agent-run-ledger";

const DEFAULT_LEASE_MS = 45_000;

export type DurableRunResumeMode = "model" | "execution" | "decision" | "cancel";

export type DurableRunResumeErrorCode =
  "RUN_NOT_RESUMABLE" | "CHECKPOINT_NOT_RESUMABLE" | "PROVIDER_CHANGED" | "ARCHIVE_CHANGED";

/** A stale checkpoint is a new-request boundary, not a transient retry. */
export class DurableRunResumeError extends Error {
  constructor(
    readonly code: DurableRunResumeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DurableRunResumeError";
  }
}

function stableValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableValue(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function fingerprint(value: unknown) {
  const canonical = stableValue(value);
  let hash = 2166136261;
  for (const character of canonical) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `${canonical.length}:${(hash >>> 0).toString(36)}`;
}

function eventInput(event: AgentRunEvent): AgentRunEventInput {
  const { id: _id, runId: _runId, sequence: _sequence, ...input } = event;
  return input;
}

function collectRecordRefs(
  value: unknown,
  scope: string,
  version: string | number,
): AgentDependencyRef[] {
  const candidates: Array<Record<string, unknown>> = [];
  const visit = (current: unknown, depth: number) => {
    if (depth > 2 || !current) return;
    if (Array.isArray(current)) {
      current.slice(0, 100).forEach((item) => visit(item, depth + 1));
      return;
    }
    if (typeof current !== "object") return;
    const record = current as Record<string, unknown>;
    if (typeof record.id === "string" && record.id.trim()) candidates.push(record);
    Object.values(record).forEach((item) => visit(item, depth + 1));
  };
  visit(value, 0);
  const seen = new Set<string>();
  return candidates.flatMap((record) => {
    const id = record.id as string;
    if (seen.has(id)) return [];
    seen.add(id);
    return [
      {
        scope,
        id,
        version,
        fields: Object.keys(record)
          .filter((key) => key !== "id")
          .sort(),
      },
    ];
  });
}

function optionalStringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : undefined;
}

function observationFromResult(input: {
  event: AgentRunEvent;
  call?: AgentRunEvent;
  archiveVersion: string | number;
}): Omit<AgentObservationRecord, "schemaVersion" | "runId"> | undefined {
  const { event, call, archiveVersion } = input;
  if (
    event.kind !== "tool_result" ||
    event.status !== "succeeded" ||
    !event.invocationId ||
    !event.toolName ||
    !call
  ) {
    return undefined;
  }
  const result = event.payload;
  const resultRecord =
    result && typeof result === "object" && !Array.isArray(result)
      ? (result as Record<string, unknown>)
      : undefined;
  const scope = `tool:${event.toolName}`;
  const recordRefs = collectRecordRefs(result, scope, archiveVersion);
  const dependencyRefs = recordRefs.length
    ? recordRefs
    : [{ scope, version: archiveVersion } satisfies AgentDependencyRef];
  return {
    id: `${event.runId}:observation:${event.invocationId}`,
    invocationId: event.invocationId,
    toolName: event.toolName,
    callFingerprint: fingerprint({ toolName: event.toolName, args: call.payload }),
    args: redactAgentCredentials(call.payload ?? null),
    result: redactAgentCredentials(result ?? null),
    dependencyRefs,
    cursor: resultRecord?.nextCursor ?? resultRecord?.cursor,
    omittedFields:
      optionalStringArray(resultRecord?.omittedFields) ??
      optionalStringArray(resultRecord?.omitted),
    obtainedAt: event.at,
  };
}

/**
 * Runtime recorder whose append-only events are mirrored into the durable
 * ledger while the model is still running. The in-memory copy stays the
 * synchronous source consumed by AgentRuntime; `flush()` is the durability
 * boundary used before a checkpoint or terminal transition is written.
 */
export class DurableAgentRunRecorder implements AgentRunRecorder {
  readonly runId: string;
  private readonly memory: MemoryAgentRunRecorder;
  private readonly repository: AgentRunLedgerRepository;
  private readonly archiveVersion: string | number;
  private readonly retainEventPayload: boolean;
  private readonly calls = new Map<string, AgentRunEvent>();
  private readonly observationIds = new Set<string>();
  private currentRun: AgentRunRecord;
  private lease: AgentRunLeaseToken;
  private pending: Promise<void> = Promise.resolve();
  private persistenceError: unknown;
  private readonly leaseDurationMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly onPersistenceError?: (error: unknown) => void;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private closed = false;

  constructor(input: {
    repository: AgentRunLedgerRepository;
    run: AgentRunRecord;
    lease: AgentRunLeaseToken;
    initialEvents?: readonly AgentRunEvent[];
    initialObservationIds?: readonly string[];
    archiveVersion: string | number;
    retainEventPayload?: boolean;
    leaseDurationMs: number;
    heartbeatIntervalMs?: number;
    onPersistenceError?: (error: unknown) => void;
    now?: () => number;
  }) {
    this.repository = input.repository;
    this.currentRun = input.run;
    this.lease = input.lease;
    this.runId = input.run.id;
    this.archiveVersion = input.archiveVersion;
    this.retainEventPayload = input.retainEventPayload ?? false;
    this.leaseDurationMs = input.leaseDurationMs;
    this.heartbeatIntervalMs =
      input.heartbeatIntervalMs ?? Math.max(1_000, Math.min(15_000, input.leaseDurationMs / 3));
    this.onPersistenceError = input.onPersistenceError;
    this.memory = new MemoryAgentRunRecorder({
      runId: this.runId,
      now: input.now,
      initialEvents: input.initialEvents,
    });
    input.initialObservationIds?.forEach((id) => this.observationIds.add(id));
    input.initialEvents?.forEach((event) => {
      if (event.kind === "tool_call" && event.invocationId) {
        this.calls.set(event.invocationId, event);
      }
    });
    this.startHeartbeat();
  }

  private reportPersistenceError(error: unknown) {
    if (this.persistenceError) return;
    this.persistenceError = error;
    this.stopHeartbeat();
    try {
      this.onPersistenceError?.(error);
    } catch {
      // The original persistence failure remains the authoritative error.
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.pending.then(async () => {
      if (this.persistenceError) throw this.persistenceError;
      return operation();
    });
    this.pending = task.then(
      () => undefined,
      (error: unknown) => this.reportPersistenceError(error),
    );
    return task;
  }

  private startHeartbeat() {
    this.heartbeatTimer = setInterval(() => {
      if (this.closed || this.persistenceError) return;
      void this.enqueue(async () => {
        const renewed = await this.repository.renewLease({
          lease: this.lease,
          expectedRevision: this.currentRun.revision,
          leaseDurationMs: this.leaseDurationMs,
        });
        this.currentRun = renewed.run;
        this.lease = renewed.lease;
      }).catch(() => undefined);
    }, this.heartbeatIntervalMs);
    const timer = this.heartbeatTimer as unknown as { unref?: () => void };
    timer.unref?.();
  }

  private stopHeartbeat() {
    if (!this.heartbeatTimer) return;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  record(input: AgentRunEventInput) {
    if (this.closed) throw new Error("Cannot append events after an Agent run has settled");
    const event = this.memory.record(input);
    if (event.kind === "tool_call" && event.invocationId) this.calls.set(event.invocationId, event);
    const observation = observationFromResult({
      event,
      call: event.invocationId ? this.calls.get(event.invocationId) : undefined,
      archiveVersion: this.archiveVersion,
    });
    if (observation) this.observationIds.add(observation.id);
    void this.enqueue(async () => {
      const durableEvent = eventInput(event);
      if (!this.retainEventPayload) delete durableEvent.payload;
      const appended = await this.repository.append({
        runId: this.runId,
        expectedRevision: this.currentRun.revision,
        lease: this.lease,
        events: [durableEvent],
        observations: observation ? [observation] : undefined,
      });
      this.currentRun = appended.run;
    }).catch(() => undefined);
    return event;
  }

  events() {
    return this.memory.events();
  }

  async flush() {
    await this.pending;
    if (this.persistenceError) throw this.persistenceError;
    return this.currentRun;
  }

  persistedObservationIds() {
    return [...this.observationIds];
  }

  private checkpointBudget() {
    const events = this.memory.events();
    const tokenTotals = summarizeAgentRunTokens(events);
    return {
      events,
      tokenTotals,
      budget: {
        rounds: events.reduce((highest, event) => Math.max(highest, event.round ?? 0), 0),
        toolCalls: events.filter((event) => event.kind === "tool_call").length,
        inputTokens: tokenTotals.input,
        outputTokens: tokenTotals.output,
        elapsedMs: events.length > 1 ? Math.max(0, events.at(-1)!.at - events[0].at) : undefined,
      },
    };
  }

  /**
   * Persist a resumable state while the run keeps its active lease. This is
   * the boundary used before the first network request and after every safe
   * local step, so a page reload never has to reconstruct intent from logs.
   */
  async checkpoint(input: {
    state: unknown;
    checkpointKind: AgentCheckpointKind;
    nextAction: "invoke_model" | "execute_tool";
    dependencyRefs?: readonly AgentDependencyRef[];
    resumable?: boolean;
  }) {
    if (this.closed) throw new Error("Cannot checkpoint an Agent run after it has settled");
    const { budget } = this.checkpointBudget();
    const checkpoint = await this.enqueue(() =>
      this.repository.append({
        runId: this.runId,
        expectedRevision: this.currentRun.revision,
        lease: this.lease,
        checkpoint: {
          id: `${this.runId}:checkpoint:${crypto.randomUUID()}`,
          kind: input.checkpointKind,
          status: "active",
          nextAction: { kind: input.nextAction },
          state: redactAgentCredentials(input.state),
          observationIds: this.persistedObservationIds(),
          dependencyRefs: [...(input.dependencyRefs ?? [])],
          budget,
        },
        transition: { resumable: input.resumable ?? true },
      }),
    );
    this.currentRun = checkpoint.run;
    return checkpoint;
  }

  async renewLease() {
    if (this.closed) throw new Error("Cannot renew an Agent run after it has settled");
    const renewed = await this.enqueue(() =>
      this.repository.renewLease({
        lease: this.lease,
        expectedRevision: this.currentRun.revision,
        leaseDurationMs: this.leaseDurationMs,
      }),
    );
    this.currentRun = renewed.run;
    this.lease = renewed.lease;
    return renewed.run;
  }

  async settle(input: {
    status: AgentLedgerRunStatus;
    state: unknown;
    checkpointKind?: AgentCheckpointKind;
    nextAction?: "invoke_model" | "execute_tool" | "await_approval" | "finalize";
    proposalRefs?: readonly string[];
    receiptRefs?: readonly string[];
    resumable?: boolean;
    dependencyRefs?: readonly AgentDependencyRef[];
  }) {
    if (this.closed) throw new Error("Agent run has already settled");
    const closesExecution = input.status !== "running";
    if (closesExecution) {
      this.closed = true;
      this.stopHeartbeat();
    }
    const { tokenTotals, budget } = this.checkpointBudget();
    const checkpoint = await this.enqueue(() =>
      this.repository.append({
        runId: this.runId,
        expectedRevision: this.currentRun.revision,
        lease: this.lease,
        checkpoint: {
          kind: input.checkpointKind ?? "safe_boundary",
          status: "active",
          nextAction: { kind: input.nextAction ?? "finalize" },
          state: redactAgentCredentials(input.state),
          observationIds: this.persistedObservationIds(),
          dependencyRefs: [...(input.dependencyRefs ?? [])],
          budget,
        },
        transition: {
          status: input.status,
          usage: tokenTotals,
          proposalRefs: input.proposalRefs,
          receiptRefs: input.receiptRefs,
          resumable: input.resumable ?? input.status === "suspended",
        },
      }),
    );
    this.currentRun = checkpoint.run;
    return checkpoint;
  }
}

export interface BeginDurableAgentRunInput {
  repository: AgentRunLedgerRepository;
  threadId: string;
  agentName: string;
  entrypoint: string;
  title?: string;
  request: unknown;
  providerRef: AgentRunProviderRef;
  includeArchive: boolean;
  budget: AgentRunBudgetRecord;
  archiveVersion: string | number;
  resumeRunId?: string;
  resumeMode?: DurableRunResumeMode;
  ownerId?: string;
  leaseDurationMs?: number;
  heartbeatIntervalMs?: number;
  initialCheckpoint?: CreateAgentCheckpointInput | ((runId: string) => CreateAgentCheckpointInput);
  retainEventPayload?: boolean;
  onPersistenceError?: (error: unknown) => void;
  now?: () => number;
}

export interface ContinueDurableAgentRunInput {
  repository: AgentRunLedgerRepository;
  runId: string;
  archiveVersion: string | number;
  events: readonly AgentRunEventInput[];
  settle: Parameters<DurableAgentRunRecorder["settle"]>[0];
  ownerId?: string;
  leaseDurationMs?: number;
  heartbeatIntervalMs?: number;
  retainEventPayload?: boolean;
  onPersistenceError?: (error: unknown) => void;
  now?: () => number;
}

function sameProvider(left: AgentRunProviderRef, right: AgentRunProviderRef) {
  return (
    left.kind === right.kind &&
    left.model === right.model &&
    left.configFingerprint === right.configFingerprint
  );
}

async function assertResumableRun(input: BeginDurableAgentRunInput, run: AgentRunRecord) {
  const mode = input.resumeMode;
  if (!mode) {
    throw new TypeError("resumeMode is required when continuing an Agent run");
  }
  if (mode === "cancel") return;

  const checkpoint = run.latestCheckpointId
    ? await input.repository.getCheckpoint(run.latestCheckpointId)
    : undefined;
  if (mode === "model" || mode === "execution") {
    if ((run.status !== "suspended" && run.status !== "running") || !run.resumable) {
      throw new DurableRunResumeError(
        "RUN_NOT_RESUMABLE",
        "这次运行已不处于可续跑状态；请作为新问题发送。",
      );
    }
    const expectedCheckpoint =
      mode === "model"
        ? checkpoint?.kind === "awaiting_model" && checkpoint.nextAction.kind === "invoke_model"
        : checkpoint?.kind === "safe_boundary" &&
          (checkpoint.nextAction.kind === "execute_tool" ||
            checkpoint.nextAction.kind === "finalize");
    if (!checkpoint || checkpoint.status !== "active" || !expectedCheckpoint) {
      throw new DurableRunResumeError(
        "CHECKPOINT_NOT_RESUMABLE",
        mode === "model"
          ? "找不到可继续的模型断点；请作为新问题发送。"
          : "找不到可继续的本地执行断点；请作为新任务发送。",
      );
    }
    if (!sameProvider(run.providerRef, input.providerRef)) {
      throw new DurableRunResumeError(
        "PROVIDER_CHANGED",
        "模型配置已经变化，旧工具结果仍保留，但这次问题需要重新发送。",
      );
    }
    const archiveDependency = checkpoint.dependencyRefs.find(
      (dependency) => dependency.scope === "archive",
    );
    if (archiveDependency && archiveDependency.version !== input.archiveVersion) {
      throw new DurableRunResumeError(
        "ARCHIVE_CHANGED",
        "人物档案已经变化，旧工具结果可能失效；请作为新问题重新发送。",
      );
    }
    return;
  }

  if (
    run.status !== "awaiting_approval" ||
    !checkpoint ||
    checkpoint.status !== "active" ||
    checkpoint.kind !== "awaiting_approval" ||
    checkpoint.nextAction.kind !== "await_approval"
  ) {
    throw new DurableRunResumeError("RUN_NOT_RESUMABLE", "这份提案已经处理，不能再次签字。");
  }
}

export async function beginDurableAgentRun(input: BeginDurableAgentRunInput) {
  const now = input.now ?? Date.now;
  const ownerId = input.ownerId ?? `tab:${crypto.randomUUID()}`;
  const leaseDurationMs =
    input.leaseDurationMs ?? Math.max(DEFAULT_LEASE_MS, input.budget.maxWallTimeMs + 30_000);
  let run: AgentRunRecord;
  let lease: AgentRunLeaseToken;
  let initialEvents: AgentRunEvent[] = [];
  let initialObservationIds: string[] = [];
  if (input.resumeRunId) {
    const existing = await input.repository.getRun(input.resumeRunId);
    if (!existing) throw new Error("找不到要继续的 Agent 运行记录");
    await assertResumableRun(input, existing);
    run = existing;
    [initialEvents, initialObservationIds] = await Promise.all([
      input.repository.listEvents(run.id),
      input.repository
        .listObservations(run.id)
        .then((observations) => observations.map((observation) => observation.id)),
    ]);
    const claimed = await input.repository.claimRun({
      runId: run.id,
      ownerId,
      expectedRevision: run.revision,
      leaseDurationMs,
    });
    run = claimed.run;
    lease = claimed.lease;
  } else {
    const runId = crypto.randomUUID();
    const initialCheckpoint =
      typeof input.initialCheckpoint === "function"
        ? input.initialCheckpoint(runId)
        : input.initialCheckpoint;
    const durableInitialCheckpoint = initialCheckpoint
      ? {
          ...initialCheckpoint,
          state: redactAgentCredentials(initialCheckpoint.state),
          nextAction: {
            ...initialCheckpoint.nextAction,
            ...(initialCheckpoint.nextAction.payload === undefined
              ? {}
              : { payload: redactAgentCredentials(initialCheckpoint.nextAction.payload) }),
          },
        }
      : undefined;
    const started = await input.repository.startClaimedRun({
      run: {
        id: runId,
        threadId: input.threadId,
        agentName: input.agentName,
        entrypoint: input.entrypoint,
        title: input.title,
        request: input.request,
        providerRef: input.providerRef,
        includeArchive: input.includeArchive,
        budget: input.budget,
        resumable: true,
        createdAt: now(),
      },
      ownerId,
      leaseDurationMs,
      checkpoint: durableInitialCheckpoint,
    });
    run = started.run;
    lease = started.lease;
    initialEvents = started.events;
  }
  return new DurableAgentRunRecorder({
    repository: input.repository,
    run,
    lease,
    initialEvents,
    initialObservationIds,
    archiveVersion: input.archiveVersion,
    retainEventPayload: input.retainEventPayload,
    leaseDurationMs,
    heartbeatIntervalMs: input.heartbeatIntervalMs,
    onPersistenceError: input.onPersistenceError,
    now,
  });
}

/**
 * Continue an existing non-terminal run at a local decision boundary. This is
 * used after the model has stopped and the user later approves or rejects its
 * proposal. The original run header, events and observations remain the only
 * execution record; a second shadow run is not created for the same request.
 */
export async function continueDurableAgentRun(input: ContinueDurableAgentRunInput) {
  const run = await input.repository.getRun(input.runId);
  if (!run) throw new Error("找不到要继续的 Agent 运行记录");
  const recorder = await beginDurableAgentRun({
    repository: input.repository,
    threadId: run.threadId,
    agentName: run.agentName,
    entrypoint: run.entrypoint,
    title: run.title,
    request: run.request,
    providerRef: run.providerRef,
    includeArchive: run.includeArchive,
    budget: run.budget,
    archiveVersion: input.archiveVersion,
    resumeRunId: run.id,
    resumeMode: "decision",
    ownerId: input.ownerId,
    leaseDurationMs: input.leaseDurationMs,
    heartbeatIntervalMs: input.heartbeatIntervalMs,
    retainEventPayload: input.retainEventPayload,
    onPersistenceError: input.onPersistenceError,
    now: input.now,
  });
  input.events.forEach((event) => recorder.record(event));
  return recorder.settle(input.settle);
}

export interface CancelDurableAgentRunInput {
  repository: AgentRunLedgerRepository;
  runId: string;
  archiveVersion: string | number;
  state: unknown;
  reason: string;
  ownerId?: string;
  now?: () => number;
}

/** Retires a stale checkpoint so refresh cannot offer the same broken resume again. */
export async function cancelDurableAgentRun(input: CancelDurableAgentRunInput) {
  const run = await input.repository.getRun(input.runId);
  if (!run || ["completed", "failed", "cancelled", "budget_exceeded"].includes(run.status)) {
    return run;
  }
  const recorder = await beginDurableAgentRun({
    repository: input.repository,
    threadId: run.threadId,
    agentName: run.agentName,
    entrypoint: run.entrypoint,
    title: run.title,
    request: run.request,
    providerRef: run.providerRef,
    includeArchive: run.includeArchive,
    budget: run.budget,
    archiveVersion: input.archiveVersion,
    resumeRunId: run.id,
    resumeMode: "cancel",
    ownerId: input.ownerId,
    now: input.now,
  });
  recorder.record({
    kind: "finalize",
    status: "blocked",
    payload: { reason: input.reason },
  });
  const settled = await recorder.settle({
    status: "cancelled",
    state: input.state,
    checkpointKind: "safe_boundary",
    nextAction: "finalize",
    resumable: false,
    dependencyRefs: [{ scope: "archive", version: input.archiveVersion }],
  });
  return settled.run;
}
