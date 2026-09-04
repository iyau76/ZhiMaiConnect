import {
  containsAgentCredential,
  type AgentRunEvent,
  type AgentRunEventInput,
  type AgentRunStatus,
  type AgentRunTokenTotals,
} from "./agent-run-log";
/*
 * Agent run payloads are checked again at the storage boundary even when the
 * caller already applied a display redactor.
 */
import {
  APP_META,
  AGENT_CHECKPOINTS,
  AGENT_OBSERVATIONS,
  AGENT_RUN_EVENTS,
  AGENT_RUNS,
  MUTATION_PROPOSALS,
  MUTATION_RECEIPTS,
  archiveMutationDecisionMarkerId,
  openFacesDbDatabase,
} from "./face-db";
import type {
  MutationCommitDecisionIntent,
  MutationCommitReceipt,
  MutationProposalEntry,
} from "./mutation-commit-coordinator";

export const AGENT_RUN_LEDGER_SCHEMA_VERSION = 1 as const;

export type AgentLedgerRunStatus = AgentRunStatus | "awaiting_approval";

export interface AgentRunProviderRef {
  presetId?: string;
  kind?: string;
  model: string;
  /** Identifies a changed provider configuration without retaining credentials. */
  configFingerprint?: string;
}

export interface AgentRunBudgetRecord {
  maxRounds: number;
  maxToolCalls: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxWallTimeMs: number;
}

export interface AgentRunLease {
  ownerId: string;
  epoch: number;
  acquiredAt: number;
  expiresAt: number;
}

export interface AgentRunLeaseToken {
  runId: string;
  ownerId: string;
  epoch: number;
}

/**
 * Durable header for one user request. Runtime events remain the sole source
 * for steps; this record deliberately has no `steps` field.
 */
export interface AgentRunRecord {
  schemaVersion: typeof AGENT_RUN_LEDGER_SCHEMA_VERSION;
  id: string;
  threadId: string;
  ordinal: number;
  agentName: string;
  entrypoint: string;
  title?: string;
  request: unknown;
  providerRef: AgentRunProviderRef;
  includeArchive: boolean;
  budget: AgentRunBudgetRecord;
  usage?: AgentRunTokenTotals;
  status: AgentLedgerRunStatus;
  nextSequence: number;
  revision: number;
  latestCheckpointId?: string;
  proposalRefs: string[];
  receiptRefs: string[];
  resumable: boolean;
  legacyObservability?: boolean;
  createdAt: number;
  updatedAt: number;
  endedAt?: number;
  lease?: AgentRunLease;
}

export interface AgentDependencyRef {
  /** Durable store or logical query scope, for example `persons` or `persons@index`. */
  scope: string;
  id?: string;
  version: string | number;
  fields?: string[];
}

export interface AgentObservationRecord {
  schemaVersion: typeof AGENT_RUN_LEDGER_SCHEMA_VERSION;
  id: string;
  runId: string;
  invocationId: string;
  toolName: string;
  callFingerprint: string;
  args: unknown;
  result: unknown;
  dependencyRefs: AgentDependencyRef[];
  cursor?: unknown;
  omittedFields?: string[];
  obtainedAt: number;
  freshUntil?: number;
}

export type AgentCheckpointStatus = "active" | "consumed" | "invalid";

export type AgentCheckpointKind = "safe_boundary" | "awaiting_model" | "awaiting_approval";

export interface AgentCheckpointBudgetRecord {
  rounds: number;
  toolCalls: number;
  inputTokens: AgentRunTokenTotals["input"];
  outputTokens: AgentRunTokenTotals["output"];
  elapsedMs?: number;
}

export interface AgentCheckpointRecord {
  schemaVersion: typeof AGENT_RUN_LEDGER_SCHEMA_VERSION;
  id: string;
  runId: string;
  afterSequence: number;
  kind: AgentCheckpointKind;
  status: AgentCheckpointStatus;
  nextAction: {
    kind: "invoke_model" | "execute_tool" | "await_approval" | "finalize";
    payload?: unknown;
  };
  /** Agent-specific resumable state, expressed in stable IDs and observation IDs. */
  state: unknown;
  observationIds: string[];
  dependencyRefs: AgentDependencyRef[];
  budget: AgentCheckpointBudgetRecord;
  createdAt: number;
}

export type MutationProposalStatus = "pending" | "committed" | "discarded";
export type MutationProposalDecisionKind = Exclude<MutationProposalStatus, "pending">;

export interface PersistedMutationProposalRecord extends MutationProposalEntry {
  schemaVersion: typeof AGENT_RUN_LEDGER_SCHEMA_VERSION;
  status: MutationProposalStatus;
  revision: number;
  updatedAt: number;
  decisionId?: string;
  decisionKind?: MutationProposalDecisionKind;
  decisionClaimedAt?: number;
  decidedAt?: number;
  receiptId?: string;
  /** Present only on the canonical first proposal while a commit is in flight. */
  decisionIntent?: MutationCommitDecisionIntent;
}

export interface PersistedMutationReceiptRecord extends MutationCommitReceipt {
  schemaVersion: typeof AGENT_RUN_LEDGER_SCHEMA_VERSION;
  sourceRunId?: string;
  updatedAt: number;
}

export type PutMutationProposalInput = MutationProposalEntry & {
  updatedAt?: number;
};

export type PutMutationReceiptInput = MutationCommitReceipt & {
  sourceRunId?: string;
  updatedAt?: number;
};

export type MutationRecordChange =
  | { kind: "proposal_saved" | "proposal_deleted"; id: string }
  | { kind: "receipt_saved" | "receipt_deleted"; id: string }
  | { kind: "artifacts_cleared" };

export type MutationRecordListener = (change: MutationRecordChange) => void;

export type ClaimMutationProposalDecisionInput =
  | {
      proposalIds: readonly string[];
      decisionId: string;
      decisionKind: "committed";
      intent: MutationCommitDecisionIntent;
      claimedAt?: number;
    }
  | {
      proposalIds: readonly string[];
      decisionId: string;
      decisionKind: "discarded";
      intent?: never;
      claimedAt?: number;
    };

export interface SettleMutationProposalDecisionInput {
  proposalIds: readonly string[];
  decisionId: string;
  decisionKind: MutationProposalDecisionKind;
  decidedAt?: number;
  receipt?: PutMutationReceiptInput;
}

export interface MutationRecordRepository {
  putProposal(input: PutMutationProposalInput): Promise<PersistedMutationProposalRecord>;
  claimProposalDecision(
    input: ClaimMutationProposalDecisionInput,
  ): Promise<PersistedMutationProposalRecord[]>;
  settleProposalDecision(
    input: SettleMutationProposalDecisionInput,
  ): Promise<PersistedMutationProposalRecord[]>;
  releaseProposalDecision(input: {
    proposalIds: readonly string[];
    decisionId: string;
    releasedAt?: number;
    requireArchiveDecisionUnapplied?: boolean;
  }): Promise<PersistedMutationProposalRecord[]>;
  getProposal(id: string): Promise<PersistedMutationProposalRecord | undefined>;
  listProposals(options?: {
    sourceRunId?: string;
    status?: MutationProposalStatus;
    /** `null` selects only records created before scopes or by an unscoped coordinator. */
    scope?: string | null;
  }): Promise<PersistedMutationProposalRecord[]>;
  deleteProposal(id: string): Promise<boolean>;
  putReceipt(input: PutMutationReceiptInput): Promise<PersistedMutationReceiptRecord>;
  getReceipt(id: string): Promise<PersistedMutationReceiptRecord | undefined>;
  listReceipts(options?: {
    sourceRunId?: string;
    scope?: string | null;
  }): Promise<PersistedMutationReceiptRecord[]>;
  deleteReceipt(id: string): Promise<boolean>;
  clear(): Promise<void>;
  subscribe(listener: MutationRecordListener): () => void;
}

export type CreateAgentRunInput = Omit<
  AgentRunRecord,
  | "schemaVersion"
  | "nextSequence"
  | "revision"
  | "proposalRefs"
  | "receiptRefs"
  | "createdAt"
  | "updatedAt"
  | "lease"
  | "status"
> & {
  status?: AgentLedgerRunStatus;
  proposalRefs?: string[];
  receiptRefs?: string[];
  createdAt?: number;
};

export type CreateAgentObservationInput = Omit<AgentObservationRecord, "schemaVersion" | "runId">;

export type CreateAgentCheckpointInput = Omit<
  AgentCheckpointRecord,
  "schemaVersion" | "id" | "runId" | "afterSequence" | "createdAt"
> & {
  id?: string;
  createdAt?: number;
};

export interface AgentRunTransition {
  status?: AgentLedgerRunStatus;
  usage?: AgentRunTokenTotals;
  proposalRefs?: readonly string[];
  receiptRefs?: readonly string[];
  resumable?: boolean;
  endedAt?: number;
}

export interface AppendAgentRunInput {
  runId: string;
  expectedRevision: number;
  lease: AgentRunLeaseToken;
  events?: readonly AgentRunEventInput[];
  observations?: readonly CreateAgentObservationInput[];
  checkpoint?: CreateAgentCheckpointInput;
  transition?: AgentRunTransition;
}

export interface AppendAgentRunResult {
  run: AgentRunRecord;
  events: AgentRunEvent[];
  observations: AgentObservationRecord[];
  checkpoint?: AgentCheckpointRecord;
}

export type StartClaimedAgentRunRecordInput = Omit<CreateAgentRunInput, "ordinal" | "status"> & {
  /** Allocated atomically per thread when omitted. */
  ordinal?: number;
};

/**
 * Creates the run, acquires its first lease and optionally writes the first
 * checkpoint in one storage transaction. A caller can therefore clear its
 * input only after this operation succeeds without opening an intent-loss
 * window between `createRun`, `claimRun` and `append`.
 */
export interface StartClaimedAgentRunInput {
  run: StartClaimedAgentRunRecordInput;
  ownerId: string;
  leaseDurationMs: number;
  events?: readonly AgentRunEventInput[];
  checkpoint?: CreateAgentCheckpointInput;
}

export interface StartClaimedAgentRunResult {
  run: AgentRunRecord;
  lease: AgentRunLeaseToken;
  events: AgentRunEvent[];
  checkpoint?: AgentCheckpointRecord;
}

export type AgentRunLedgerChangeKind =
  | "run_created"
  | "run_started"
  | "run_claimed"
  | "lease_renewed"
  | "lease_released"
  | "run_appended"
  | "run_deleted"
  | "ledger_cleared";

export interface AgentRunLedgerChange {
  kind: AgentRunLedgerChangeKind;
  runId: string;
  revision: number;
}

export type AgentRunLedgerListener = (change: AgentRunLedgerChange) => void;

export interface AgentRunLedgerRepository {
  createRun(input: CreateAgentRunInput): Promise<AgentRunRecord>;
  startClaimedRun(input: StartClaimedAgentRunInput): Promise<StartClaimedAgentRunResult>;
  getRun(runId: string): Promise<AgentRunRecord | undefined>;
  listRuns(options?: {
    threadId?: string;
    status?: AgentLedgerRunStatus;
  }): Promise<AgentRunRecord[]>;
  listEvents(runId: string): Promise<AgentRunEvent[]>;
  listObservations(runId: string): Promise<AgentObservationRecord[]>;
  listCheckpoints(runId: string): Promise<AgentCheckpointRecord[]>;
  getCheckpoint(checkpointId: string): Promise<AgentCheckpointRecord | undefined>;
  claimRun(input: {
    runId: string;
    ownerId: string;
    expectedRevision: number;
    leaseDurationMs: number;
  }): Promise<{ run: AgentRunRecord; lease: AgentRunLeaseToken }>;
  renewLease(input: {
    lease: AgentRunLeaseToken;
    expectedRevision: number;
    leaseDurationMs: number;
  }): Promise<{ run: AgentRunRecord; lease: AgentRunLeaseToken }>;
  releaseLease(input: {
    lease: AgentRunLeaseToken;
    expectedRevision: number;
  }): Promise<AgentRunRecord>;
  append(input: AppendAgentRunInput): Promise<AppendAgentRunResult>;
  deleteRun(runId: string): Promise<boolean>;
  clear(): Promise<void>;
  subscribe(listener: AgentRunLedgerListener): () => void;
}

export type AgentRunLedgerConflictCode =
  | "RUN_NOT_FOUND"
  | "RUN_ALREADY_EXISTS"
  | "REVISION_MISMATCH"
  | "RUN_TERMINAL"
  | "LEASE_HELD"
  | "LEASE_LOST"
  | "PROPOSAL_NOT_FOUND"
  | "PROPOSAL_DECISION_CONFLICT"
  | "DUPLICATE_RECORD"
  | "INVALID_REFERENCE"
  | "CREDENTIAL_PRESENT";

export class AgentRunLedgerConflictError extends Error {
  constructor(
    readonly code: AgentRunLedgerConflictCode,
    message: string,
  ) {
    super(message);
    this.name = "AgentRunLedgerConflictError";
  }
}

const TERMINAL_STATUSES = new Set<AgentLedgerRunStatus>([
  "completed",
  "failed",
  "cancelled",
  "budget_exceeded",
]);

const CREDENTIAL_KEYS = new Set([
  "apikey",
  "authorization",
  "cookie",
  "setcookie",
  "password",
  "passwd",
  "secret",
  "token",
  "accesstoken",
  "refreshtoken",
  "sessiontoken",
  "credential",
]);

function normalizedKey(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function assertCredentialFree(value: unknown, path = "value", seen = new WeakSet<object>()): void {
  if (typeof value === "string") {
    if (containsAgentCredential(value)) {
      throw new AgentRunLedgerConflictError(
        "CREDENTIAL_PRESENT",
        `${path} contains a credential and cannot be stored in the Agent run ledger`,
      );
    }
    return;
  }
  if (!value || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertCredentialFree(item, `${path}[${index}]`, seen));
    return;
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (CREDENTIAL_KEYS.has(normalizedKey(key))) {
      throw new AgentRunLedgerConflictError(
        "CREDENTIAL_PRESENT",
        `${path}.${key} is a credential field and cannot be stored in the Agent run ledger`,
      );
    }
    assertCredentialFree(item, `${path}.${key}`, seen);
  }
}

function copyForLedger<T>(value: T): T {
  assertCredentialFree(value);
  return structuredClone(value);
}

type PreparedAgentRunEventInput = Omit<AgentRunEventInput, "redact">;

/**
 * Runs an event-specific redactor before cloning. Function values are runtime
 * behavior and must never be handed to structuredClone or persisted.
 */
function prepareEventInputs(
  inputs: readonly AgentRunEventInput[] | undefined,
): PreparedAgentRunEventInput[] {
  return (inputs ?? []).map((input) => {
    const { redact, payload, ...details } = input;
    const safeDetails = copyForLedger(details);
    const redactedPayload = redact ? redact(payload) : payload;
    if (redactedPayload === undefined) return safeDetails;
    return {
      ...safeDetails,
      payload: copyForLedger(redactedPayload),
    };
  });
}

function unique(values: readonly string[] | undefined, fallback: readonly string[] = []) {
  return [...new Set(values ?? fallback)];
}

function randomId() {
  return (
    globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

function isPositiveInteger(value: number) {
  return Number.isInteger(value) && value > 0;
}

function validateRunInput(input: CreateAgentRunInput) {
  if (
    !input.id.trim() ||
    !input.threadId.trim() ||
    !input.agentName.trim() ||
    !input.entrypoint.trim()
  ) {
    throw new TypeError("Agent run identifiers, name and entrypoint must be non-empty");
  }
  if (!Number.isInteger(input.ordinal) || input.ordinal < 0) {
    throw new TypeError("Agent run ordinal must be a non-negative integer");
  }
  const budget = input.budget;
  if (
    !isPositiveInteger(budget.maxRounds) ||
    !Number.isInteger(budget.maxToolCalls) ||
    budget.maxToolCalls < 0 ||
    !isPositiveInteger(budget.maxInputTokens) ||
    !isPositiveInteger(budget.maxOutputTokens) ||
    !isPositiveInteger(budget.maxWallTimeMs)
  ) {
    throw new TypeError("Agent run budget is invalid");
  }
}

function validateLeaseDuration(value: number) {
  if (!isPositiveInteger(value)) throw new TypeError("leaseDurationMs must be a positive integer");
}

function cloneRun(run: AgentRunRecord) {
  return structuredClone(run);
}

function checkpointId(runId: string, sequence: number) {
  return `${runId}:checkpoint:${sequence}:${randomId()}`;
}

/**
 * Deterministic in-memory implementation of the durable repository contract.
 * Its mutation methods do not await internally, so validation and commit form
 * one atomic JavaScript turn, mirroring one IndexedDB readwrite transaction.
 */
export class MemoryAgentRunLedgerRepository implements AgentRunLedgerRepository {
  private readonly runs = new Map<string, AgentRunRecord>();
  private readonly events = new Map<string, AgentRunEvent[]>();
  private readonly observations = new Map<string, AgentObservationRecord>();
  private readonly checkpoints = new Map<string, AgentCheckpointRecord>();
  private readonly listeners = new Set<AgentRunLedgerListener>();
  private readonly now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
  }

  private requiredRun(runId: string) {
    const run = this.runs.get(runId);
    if (!run) {
      throw new AgentRunLedgerConflictError("RUN_NOT_FOUND", `Agent run ${runId} does not exist`);
    }
    return run;
  }

  private matchingRevision(run: AgentRunRecord, expectedRevision: number) {
    if (run.revision !== expectedRevision) {
      throw new AgentRunLedgerConflictError(
        "REVISION_MISMATCH",
        `Agent run ${run.id} revision is ${run.revision}, expected ${expectedRevision}`,
      );
    }
  }

  private activeLease(run: AgentRunRecord, now = this.now()) {
    return run.lease && run.lease.expiresAt > now ? run.lease : undefined;
  }

  private matchingLease(run: AgentRunRecord, token: AgentRunLeaseToken) {
    const active = this.activeLease(run);
    if (
      !active ||
      token.runId !== run.id ||
      active.ownerId !== token.ownerId ||
      active.epoch !== token.epoch
    ) {
      throw new AgentRunLedgerConflictError(
        "LEASE_LOST",
        `Agent run ${run.id} is no longer leased by this executor`,
      );
    }
    return active;
  }

  private emit(kind: AgentRunLedgerChangeKind, run: AgentRunRecord) {
    const change = { kind, runId: run.id, revision: run.revision } satisfies AgentRunLedgerChange;
    this.listeners.forEach((listener) => listener(change));
  }

  async createRun(input: CreateAgentRunInput) {
    validateRunInput(input);
    if (this.runs.has(input.id)) {
      throw new AgentRunLedgerConflictError(
        "RUN_ALREADY_EXISTS",
        `Agent run ${input.id} already exists`,
      );
    }
    const safe = copyForLedger(input);
    const now = safe.createdAt ?? this.now();
    const run: AgentRunRecord = {
      ...safe,
      schemaVersion: AGENT_RUN_LEDGER_SCHEMA_VERSION,
      status: safe.status ?? "pending",
      nextSequence: 1,
      revision: 1,
      proposalRefs: unique(safe.proposalRefs),
      receiptRefs: unique(safe.receiptRefs),
      createdAt: now,
      updatedAt: now,
    };
    this.runs.set(run.id, run);
    this.events.set(run.id, []);
    this.emit("run_created", run);
    return cloneRun(run);
  }

  async startClaimedRun(input: StartClaimedAgentRunInput): Promise<StartClaimedAgentRunResult> {
    validateLeaseDuration(input.leaseDurationMs);
    const ordinal =
      input.run.ordinal ??
      [...this.runs.values()]
        .filter((candidate) => candidate.threadId === input.run.threadId)
        .reduce((highest, candidate) => Math.max(highest, candidate.ordinal), 0) + 1;
    const safeRun = copyForLedger({ ...input.run, ordinal } satisfies CreateAgentRunInput);
    validateRunInput(safeRun);
    if (this.runs.has(safeRun.id)) {
      throw new AgentRunLedgerConflictError(
        "RUN_ALREADY_EXISTS",
        `Agent run ${safeRun.id} already exists`,
      );
    }
    const eventInputs = prepareEventInputs(input.events);
    const checkpointInput = input.checkpoint ? copyForLedger(input.checkpoint) : undefined;
    if (checkpointInput?.observationIds.length) {
      throw new AgentRunLedgerConflictError(
        "INVALID_REFERENCE",
        "An initial checkpoint cannot reference observations that do not exist yet",
      );
    }

    const now = safeRun.createdAt ?? this.now();
    let sequence = 1;
    const events = eventInputs.map((item): AgentRunEvent => {
      const { at, payload, ...details } = item;
      const event: AgentRunEvent = {
        ...details,
        id: `${safeRun.id}:${sequence}`,
        runId: safeRun.id,
        sequence,
        at: at ?? now,
        ...(payload === undefined ? {} : { payload: structuredClone(payload) }),
      };
      sequence += 1;
      return event;
    });
    const checkpoint = checkpointInput
      ? ({
          ...checkpointInput,
          id: checkpointInput.id ?? checkpointId(safeRun.id, sequence - 1),
          schemaVersion: AGENT_RUN_LEDGER_SCHEMA_VERSION,
          runId: safeRun.id,
          afterSequence: sequence - 1,
          createdAt: checkpointInput.createdAt ?? now,
        } satisfies AgentCheckpointRecord)
      : undefined;
    if (checkpoint && this.checkpoints.has(checkpoint.id)) {
      throw new AgentRunLedgerConflictError(
        "DUPLICATE_RECORD",
        `Agent checkpoint ${checkpoint.id} already exists`,
      );
    }
    const epoch = 1;
    const run: AgentRunRecord = {
      ...safeRun,
      schemaVersion: AGENT_RUN_LEDGER_SCHEMA_VERSION,
      status: "running",
      nextSequence: sequence,
      revision: 1,
      latestCheckpointId: checkpoint?.id,
      proposalRefs: unique(safeRun.proposalRefs),
      receiptRefs: unique(safeRun.receiptRefs),
      createdAt: now,
      updatedAt: now,
      endedAt: undefined,
      lease: {
        ownerId: input.ownerId,
        epoch,
        acquiredAt: now,
        expiresAt: now + input.leaseDurationMs,
      },
    };
    this.runs.set(run.id, run);
    this.events.set(run.id, events);
    if (checkpoint) this.checkpoints.set(checkpoint.id, checkpoint);
    this.emit("run_started", run);
    return {
      run: cloneRun(run),
      lease: { runId: run.id, ownerId: input.ownerId, epoch },
      events: structuredClone(events),
      checkpoint: checkpoint ? structuredClone(checkpoint) : undefined,
    };
  }

  async getRun(runId: string) {
    const run = this.runs.get(runId);
    return run ? cloneRun(run) : undefined;
  }

  async listRuns(options: { threadId?: string; status?: AgentLedgerRunStatus } = {}) {
    return [...this.runs.values()]
      .filter((run) => !options.threadId || run.threadId === options.threadId)
      .filter((run) => !options.status || run.status === options.status)
      .sort((left, right) => right.updatedAt - left.updatedAt || right.ordinal - left.ordinal)
      .map(cloneRun);
  }

  async listEvents(runId: string) {
    this.requiredRun(runId);
    return structuredClone(this.events.get(runId) ?? []);
  }

  async listObservations(runId: string) {
    this.requiredRun(runId);
    return [...this.observations.values()]
      .filter((observation) => observation.runId === runId)
      .sort((left, right) => left.obtainedAt - right.obtainedAt)
      .map((observation) => structuredClone(observation));
  }

  async listCheckpoints(runId: string) {
    this.requiredRun(runId);
    return [...this.checkpoints.values()]
      .filter((checkpoint) => checkpoint.runId === runId)
      .sort((left, right) => left.afterSequence - right.afterSequence)
      .map((checkpoint) => structuredClone(checkpoint));
  }

  async getCheckpoint(id: string) {
    const checkpoint = this.checkpoints.get(id);
    return checkpoint ? structuredClone(checkpoint) : undefined;
  }

  async claimRun(input: {
    runId: string;
    ownerId: string;
    expectedRevision: number;
    leaseDurationMs: number;
  }) {
    validateLeaseDuration(input.leaseDurationMs);
    const current = this.requiredRun(input.runId);
    this.matchingRevision(current, input.expectedRevision);
    if (TERMINAL_STATUSES.has(current.status)) {
      throw new AgentRunLedgerConflictError(
        "RUN_TERMINAL",
        `Agent run ${current.id} is already ${current.status}`,
      );
    }
    const active = this.activeLease(current);
    if (active && active.ownerId !== input.ownerId) {
      throw new AgentRunLedgerConflictError(
        "LEASE_HELD",
        `Agent run ${current.id} is already leased by another executor`,
      );
    }
    const now = this.now();
    const epoch = (current.lease?.epoch ?? 0) + 1;
    const run: AgentRunRecord = {
      ...current,
      status: "running",
      revision: current.revision + 1,
      updatedAt: now,
      endedAt: undefined,
      lease: {
        ownerId: input.ownerId,
        epoch,
        acquiredAt: now,
        expiresAt: now + input.leaseDurationMs,
      },
    };
    this.runs.set(run.id, run);
    this.emit("run_claimed", run);
    return {
      run: cloneRun(run),
      lease: { runId: run.id, ownerId: input.ownerId, epoch },
    };
  }

  async renewLease(input: {
    lease: AgentRunLeaseToken;
    expectedRevision: number;
    leaseDurationMs: number;
  }) {
    validateLeaseDuration(input.leaseDurationMs);
    const current = this.requiredRun(input.lease.runId);
    this.matchingRevision(current, input.expectedRevision);
    const active = this.matchingLease(current, input.lease);
    const now = this.now();
    const run: AgentRunRecord = {
      ...current,
      revision: current.revision + 1,
      updatedAt: now,
      lease: { ...active, expiresAt: now + input.leaseDurationMs },
    };
    this.runs.set(run.id, run);
    this.emit("lease_renewed", run);
    return { run: cloneRun(run), lease: { ...input.lease } };
  }

  async releaseLease(input: { lease: AgentRunLeaseToken; expectedRevision: number }) {
    const current = this.requiredRun(input.lease.runId);
    this.matchingRevision(current, input.expectedRevision);
    this.matchingLease(current, input.lease);
    const run = cloneRun(current);
    delete run.lease;
    run.revision += 1;
    run.updatedAt = this.now();
    this.runs.set(run.id, run);
    this.emit("lease_released", run);
    return cloneRun(run);
  }

  async append(input: AppendAgentRunInput): Promise<AppendAgentRunResult> {
    const current = this.requiredRun(input.runId);
    this.matchingRevision(current, input.expectedRevision);
    this.matchingLease(current, input.lease);
    if (TERMINAL_STATUSES.has(current.status)) {
      throw new AgentRunLedgerConflictError(
        "RUN_TERMINAL",
        `Agent run ${current.id} is already ${current.status}`,
      );
    }

    const eventInputs = prepareEventInputs(input.events);
    const observationInputs = copyForLedger(input.observations ?? []);
    const checkpointInput = input.checkpoint ? copyForLedger(input.checkpoint) : undefined;
    const transition = input.transition ? copyForLedger(input.transition) : undefined;
    const existingEvents = this.events.get(current.id) ?? [];
    let sequence = current.nextSequence;
    const events = eventInputs.map((eventInput): AgentRunEvent => {
      const { at, payload, ...details } = eventInput;
      const event: AgentRunEvent = {
        ...details,
        id: `${current.id}:${sequence}`,
        runId: current.id,
        sequence,
        at: at ?? this.now(),
        ...(payload === undefined ? {} : { payload: structuredClone(payload) }),
      };
      sequence += 1;
      return event;
    });

    const candidateObservationIds = new Set<string>();
    const observations = observationInputs.map((observation): AgentObservationRecord => {
      if (this.observations.has(observation.id) || candidateObservationIds.has(observation.id)) {
        throw new AgentRunLedgerConflictError(
          "DUPLICATE_RECORD",
          `Agent observation ${observation.id} already exists`,
        );
      }
      candidateObservationIds.add(observation.id);
      return {
        ...observation,
        schemaVersion: AGENT_RUN_LEDGER_SCHEMA_VERSION,
        runId: current.id,
      };
    });

    let checkpoint: AgentCheckpointRecord | undefined;
    if (checkpointInput) {
      const id = checkpointInput.id ?? checkpointId(current.id, sequence - 1);
      if (this.checkpoints.has(id)) {
        throw new AgentRunLedgerConflictError(
          "DUPLICATE_RECORD",
          `Agent checkpoint ${id} already exists`,
        );
      }
      const knownObservationIds = new Set([
        ...[...this.observations.values()]
          .filter((observation) => observation.runId === current.id)
          .map((observation) => observation.id),
        ...candidateObservationIds,
      ]);
      const missing = checkpointInput.observationIds.find((id) => !knownObservationIds.has(id));
      if (missing) {
        throw new AgentRunLedgerConflictError(
          "INVALID_REFERENCE",
          `Agent checkpoint references unknown observation ${missing}`,
        );
      }
      checkpoint = {
        ...checkpointInput,
        id,
        schemaVersion: AGENT_RUN_LEDGER_SCHEMA_VERSION,
        runId: current.id,
        afterSequence: sequence - 1,
        createdAt: checkpointInput.createdAt ?? this.now(),
      };
    }

    const now = this.now();
    const nextStatus = transition?.status ?? current.status;
    const run: AgentRunRecord = {
      ...current,
      status: nextStatus,
      nextSequence: sequence,
      revision: current.revision + 1,
      latestCheckpointId: checkpoint?.id ?? current.latestCheckpointId,
      proposalRefs: unique(transition?.proposalRefs, current.proposalRefs),
      receiptRefs: unique(transition?.receiptRefs, current.receiptRefs),
      resumable: transition?.resumable ?? current.resumable,
      usage: transition?.usage ?? current.usage,
      updatedAt: now,
      endedAt: transition?.endedAt ?? (TERMINAL_STATUSES.has(nextStatus) ? now : current.endedAt),
    };
    if (
      nextStatus === "awaiting_approval" ||
      nextStatus === "suspended" ||
      TERMINAL_STATUSES.has(nextStatus)
    ) {
      delete run.lease;
    }

    this.events.set(current.id, [...existingEvents, ...events]);
    observations.forEach((observation) => this.observations.set(observation.id, observation));
    if (checkpoint) this.checkpoints.set(checkpoint.id, checkpoint);
    this.runs.set(run.id, run);
    this.emit("run_appended", run);
    return {
      run: cloneRun(run),
      events: structuredClone(events),
      observations: structuredClone(observations),
      checkpoint: checkpoint ? structuredClone(checkpoint) : undefined,
    };
  }

  async deleteRun(runId: string) {
    const run = this.runs.get(runId);
    if (!run) return false;
    this.runs.delete(runId);
    this.events.delete(runId);
    for (const [id, observation] of this.observations) {
      if (observation.runId === runId) this.observations.delete(id);
    }
    for (const [id, checkpoint] of this.checkpoints) {
      if (checkpoint.runId === runId) this.checkpoints.delete(id);
    }
    this.emit("run_deleted", run);
    return true;
  }

  async clear() {
    this.runs.clear();
    this.events.clear();
    this.observations.clear();
    this.checkpoints.clear();
    const change = {
      kind: "ledger_cleared",
      runId: "*",
      revision: 0,
    } satisfies AgentRunLedgerChange;
    this.listeners.forEach((listener) => listener(change));
  }

  subscribe(listener: AgentRunLedgerListener) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

function idbRequest<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function idbTransactionDone(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction failed"));
  });
}

async function runIdbTransaction<T>(
  transaction: IDBTransaction,
  operation: () => Promise<T>,
): Promise<T> {
  const completed = idbTransactionDone(transaction);
  try {
    const result = await operation();
    await completed;
    return result;
  } catch (error) {
    try {
      transaction.abort();
    } catch {
      // A transaction that already aborted or completed needs no second action.
    }
    await completed.catch(() => undefined);
    throw error;
  }
}

function requiredRunRecord(run: AgentRunRecord | undefined, runId: string) {
  if (!run) {
    throw new AgentRunLedgerConflictError("RUN_NOT_FOUND", `Agent run ${runId} does not exist`);
  }
  return run;
}

function assertRunRevision(run: AgentRunRecord, expectedRevision: number) {
  if (run.revision !== expectedRevision) {
    throw new AgentRunLedgerConflictError(
      "REVISION_MISMATCH",
      `Agent run ${run.id} revision is ${run.revision}, expected ${expectedRevision}`,
    );
  }
}

function activeRunLease(run: AgentRunRecord, now: number) {
  return run.lease && run.lease.expiresAt > now ? run.lease : undefined;
}

function assertRunLease(run: AgentRunRecord, token: AgentRunLeaseToken, now: number) {
  const active = activeRunLease(run, now);
  if (
    !active ||
    token.runId !== run.id ||
    active.ownerId !== token.ownerId ||
    active.epoch !== token.epoch
  ) {
    throw new AgentRunLedgerConflictError(
      "LEASE_LOST",
      `Agent run ${run.id} is no longer leased by this executor`,
    );
  }
  return active;
}

function assertRunOpen(run: AgentRunRecord) {
  if (TERMINAL_STATUSES.has(run.status)) {
    throw new AgentRunLedgerConflictError(
      "RUN_TERMINAL",
      `Agent run ${run.id} is already ${run.status}`,
    );
  }
}

/**
 * IndexedDB implementation used by the application runtime. Every state
 * transition and its events/observations/checkpoint commit in one transaction.
 */
export class IndexedDbAgentRunLedgerRepository implements AgentRunLedgerRepository {
  private readonly listeners = new Set<AgentRunLedgerListener>();
  private readonly now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
  }

  private emit(kind: AgentRunLedgerChangeKind, runId: string, revision: number) {
    const change = { kind, runId, revision } satisfies AgentRunLedgerChange;
    this.listeners.forEach((listener) => listener(change));
  }

  async createRun(input: CreateAgentRunInput) {
    validateRunInput(input);
    const safe = copyForLedger(input);
    const now = safe.createdAt ?? this.now();
    const run: AgentRunRecord = {
      ...safe,
      schemaVersion: AGENT_RUN_LEDGER_SCHEMA_VERSION,
      status: safe.status ?? "pending",
      nextSequence: 1,
      revision: 1,
      proposalRefs: unique(safe.proposalRefs),
      receiptRefs: unique(safe.receiptRefs),
      createdAt: now,
      updatedAt: now,
    };
    const database = await openFacesDbDatabase();
    const transaction = database.transaction(AGENT_RUNS, "readwrite");
    await runIdbTransaction(transaction, async () => {
      const store = transaction.objectStore(AGENT_RUNS);
      if (await idbRequest(store.get(run.id))) {
        throw new AgentRunLedgerConflictError(
          "RUN_ALREADY_EXISTS",
          `Agent run ${run.id} already exists`,
        );
      }
      await idbRequest(store.add(run));
    });
    this.emit("run_created", run.id, run.revision);
    return cloneRun(run);
  }

  async startClaimedRun(input: StartClaimedAgentRunInput): Promise<StartClaimedAgentRunResult> {
    validateLeaseDuration(input.leaseDurationMs);
    const safeInput = copyForLedger(input.run);
    validateRunInput({
      ...safeInput,
      ordinal: safeInput.ordinal ?? 0,
    } satisfies CreateAgentRunInput);
    const eventInputs = prepareEventInputs(input.events);
    const checkpointInput = input.checkpoint ? copyForLedger(input.checkpoint) : undefined;
    if (checkpointInput?.observationIds.length) {
      throw new AgentRunLedgerConflictError(
        "INVALID_REFERENCE",
        "An initial checkpoint cannot reference observations that do not exist yet",
      );
    }

    const database = await openFacesDbDatabase();
    const transaction = database.transaction(
      [AGENT_RUNS, AGENT_RUN_EVENTS, AGENT_CHECKPOINTS],
      "readwrite",
    );
    const result = await runIdbTransaction(transaction, async () => {
      const runStore = transaction.objectStore(AGENT_RUNS);
      const eventStore = transaction.objectStore(AGENT_RUN_EVENTS);
      const checkpointStore = transaction.objectStore(AGENT_CHECKPOINTS);
      if (await idbRequest(runStore.get(safeInput.id))) {
        throw new AgentRunLedgerConflictError(
          "RUN_ALREADY_EXISTS",
          `Agent run ${safeInput.id} already exists`,
        );
      }
      const siblings = await idbRequest<AgentRunRecord[]>(
        runStore.index("threadId").getAll(safeInput.threadId),
      );
      const ordinal =
        safeInput.ordinal ??
        siblings.reduce((highest, candidate) => Math.max(highest, candidate.ordinal), 0) + 1;
      const now = safeInput.createdAt ?? this.now();
      let sequence = 1;
      const events = eventInputs.map((item): AgentRunEvent => {
        const { at, payload, ...details } = item;
        const event: AgentRunEvent = {
          ...details,
          id: `${safeInput.id}:${sequence}`,
          runId: safeInput.id,
          sequence,
          at: at ?? now,
          ...(payload === undefined ? {} : { payload: structuredClone(payload) }),
        };
        sequence += 1;
        return event;
      });
      const checkpoint = checkpointInput
        ? ({
            ...checkpointInput,
            id: checkpointInput.id ?? checkpointId(safeInput.id, sequence - 1),
            schemaVersion: AGENT_RUN_LEDGER_SCHEMA_VERSION,
            runId: safeInput.id,
            afterSequence: sequence - 1,
            createdAt: checkpointInput.createdAt ?? now,
          } satisfies AgentCheckpointRecord)
        : undefined;
      if (checkpoint && (await idbRequest(checkpointStore.get(checkpoint.id)))) {
        throw new AgentRunLedgerConflictError(
          "DUPLICATE_RECORD",
          `Agent checkpoint ${checkpoint.id} already exists`,
        );
      }
      const epoch = 1;
      const run: AgentRunRecord = {
        ...safeInput,
        ordinal,
        schemaVersion: AGENT_RUN_LEDGER_SCHEMA_VERSION,
        status: "running",
        nextSequence: sequence,
        revision: 1,
        latestCheckpointId: checkpoint?.id,
        proposalRefs: unique(safeInput.proposalRefs),
        receiptRefs: unique(safeInput.receiptRefs),
        createdAt: now,
        updatedAt: now,
        endedAt: undefined,
        lease: {
          ownerId: input.ownerId,
          epoch,
          acquiredAt: now,
          expiresAt: now + input.leaseDurationMs,
        },
      };
      for (const event of events) await idbRequest(eventStore.add(event));
      if (checkpoint) await idbRequest(checkpointStore.add(checkpoint));
      await idbRequest(runStore.add(run));
      return {
        run: cloneRun(run),
        lease: { runId: run.id, ownerId: input.ownerId, epoch } satisfies AgentRunLeaseToken,
        events: structuredClone(events),
        checkpoint: checkpoint ? structuredClone(checkpoint) : undefined,
      };
    });
    this.emit("run_started", result.run.id, result.run.revision);
    return result;
  }

  async getRun(runId: string) {
    const database = await openFacesDbDatabase();
    const transaction = database.transaction(AGENT_RUNS, "readonly");
    return runIdbTransaction(transaction, async () => {
      const run = await idbRequest<AgentRunRecord | undefined>(
        transaction.objectStore(AGENT_RUNS).get(runId),
      );
      return run ? cloneRun(run) : undefined;
    });
  }

  async listRuns(options: { threadId?: string; status?: AgentLedgerRunStatus } = {}) {
    const database = await openFacesDbDatabase();
    const transaction = database.transaction(AGENT_RUNS, "readonly");
    return runIdbTransaction(transaction, async () => {
      const store = transaction.objectStore(AGENT_RUNS);
      const rows = options.threadId
        ? await idbRequest<AgentRunRecord[]>(store.index("threadId").getAll(options.threadId))
        : options.status
          ? await idbRequest<AgentRunRecord[]>(store.index("status").getAll(options.status))
          : await idbRequest<AgentRunRecord[]>(store.getAll());
      return rows
        .filter((run) => !options.threadId || run.threadId === options.threadId)
        .filter((run) => !options.status || run.status === options.status)
        .sort((left, right) => right.updatedAt - left.updatedAt || right.ordinal - left.ordinal)
        .map(cloneRun);
    });
  }

  async listEvents(runId: string) {
    const database = await openFacesDbDatabase();
    const transaction = database.transaction([AGENT_RUNS, AGENT_RUN_EVENTS], "readonly");
    return runIdbTransaction(transaction, async () => {
      requiredRunRecord(
        await idbRequest<AgentRunRecord | undefined>(
          transaction.objectStore(AGENT_RUNS).get(runId),
        ),
        runId,
      );
      const rows = await idbRequest<AgentRunEvent[]>(
        transaction.objectStore(AGENT_RUN_EVENTS).index("runId").getAll(runId),
      );
      return structuredClone(rows.sort((left, right) => left.sequence - right.sequence));
    });
  }

  async listObservations(runId: string) {
    const database = await openFacesDbDatabase();
    const transaction = database.transaction([AGENT_RUNS, AGENT_OBSERVATIONS], "readonly");
    return runIdbTransaction(transaction, async () => {
      requiredRunRecord(
        await idbRequest<AgentRunRecord | undefined>(
          transaction.objectStore(AGENT_RUNS).get(runId),
        ),
        runId,
      );
      const rows = await idbRequest<AgentObservationRecord[]>(
        transaction.objectStore(AGENT_OBSERVATIONS).index("runId").getAll(runId),
      );
      return structuredClone(rows.sort((left, right) => left.obtainedAt - right.obtainedAt));
    });
  }

  async listCheckpoints(runId: string) {
    const database = await openFacesDbDatabase();
    const transaction = database.transaction([AGENT_RUNS, AGENT_CHECKPOINTS], "readonly");
    return runIdbTransaction(transaction, async () => {
      requiredRunRecord(
        await idbRequest<AgentRunRecord | undefined>(
          transaction.objectStore(AGENT_RUNS).get(runId),
        ),
        runId,
      );
      const rows = await idbRequest<AgentCheckpointRecord[]>(
        transaction.objectStore(AGENT_CHECKPOINTS).index("runId").getAll(runId),
      );
      return structuredClone(rows.sort((left, right) => left.afterSequence - right.afterSequence));
    });
  }

  async getCheckpoint(checkpointId: string) {
    const database = await openFacesDbDatabase();
    const transaction = database.transaction(AGENT_CHECKPOINTS, "readonly");
    return runIdbTransaction(transaction, async () => {
      const checkpoint = await idbRequest<AgentCheckpointRecord | undefined>(
        transaction.objectStore(AGENT_CHECKPOINTS).get(checkpointId),
      );
      return checkpoint ? structuredClone(checkpoint) : undefined;
    });
  }

  async claimRun(input: {
    runId: string;
    ownerId: string;
    expectedRevision: number;
    leaseDurationMs: number;
  }) {
    validateLeaseDuration(input.leaseDurationMs);
    const database = await openFacesDbDatabase();
    const transaction = database.transaction(AGENT_RUNS, "readwrite");
    const result = await runIdbTransaction(transaction, async () => {
      const store = transaction.objectStore(AGENT_RUNS);
      const current = requiredRunRecord(
        await idbRequest<AgentRunRecord | undefined>(store.get(input.runId)),
        input.runId,
      );
      assertRunRevision(current, input.expectedRevision);
      assertRunOpen(current);
      const now = this.now();
      const active = activeRunLease(current, now);
      if (active && active.ownerId !== input.ownerId) {
        throw new AgentRunLedgerConflictError(
          "LEASE_HELD",
          `Agent run ${current.id} is already leased by another executor`,
        );
      }
      const epoch = (current.lease?.epoch ?? 0) + 1;
      const run: AgentRunRecord = {
        ...current,
        status: "running",
        revision: current.revision + 1,
        updatedAt: now,
        endedAt: undefined,
        lease: {
          ownerId: input.ownerId,
          epoch,
          acquiredAt: now,
          expiresAt: now + input.leaseDurationMs,
        },
      };
      await idbRequest(store.put(run));
      return {
        run: cloneRun(run),
        lease: { runId: run.id, ownerId: input.ownerId, epoch } satisfies AgentRunLeaseToken,
      };
    });
    this.emit("run_claimed", result.run.id, result.run.revision);
    return result;
  }

  async renewLease(input: {
    lease: AgentRunLeaseToken;
    expectedRevision: number;
    leaseDurationMs: number;
  }) {
    validateLeaseDuration(input.leaseDurationMs);
    const database = await openFacesDbDatabase();
    const transaction = database.transaction(AGENT_RUNS, "readwrite");
    const result = await runIdbTransaction(transaction, async () => {
      const store = transaction.objectStore(AGENT_RUNS);
      const current = requiredRunRecord(
        await idbRequest<AgentRunRecord | undefined>(store.get(input.lease.runId)),
        input.lease.runId,
      );
      assertRunRevision(current, input.expectedRevision);
      const now = this.now();
      const active = assertRunLease(current, input.lease, now);
      const run: AgentRunRecord = {
        ...current,
        revision: current.revision + 1,
        updatedAt: now,
        lease: { ...active, expiresAt: now + input.leaseDurationMs },
      };
      await idbRequest(store.put(run));
      return { run: cloneRun(run), lease: { ...input.lease } };
    });
    this.emit("lease_renewed", result.run.id, result.run.revision);
    return result;
  }

  async releaseLease(input: { lease: AgentRunLeaseToken; expectedRevision: number }) {
    const database = await openFacesDbDatabase();
    const transaction = database.transaction(AGENT_RUNS, "readwrite");
    const run = await runIdbTransaction(transaction, async () => {
      const store = transaction.objectStore(AGENT_RUNS);
      const current = requiredRunRecord(
        await idbRequest<AgentRunRecord | undefined>(store.get(input.lease.runId)),
        input.lease.runId,
      );
      assertRunRevision(current, input.expectedRevision);
      assertRunLease(current, input.lease, this.now());
      const updated = cloneRun(current);
      delete updated.lease;
      updated.revision += 1;
      updated.updatedAt = this.now();
      await idbRequest(store.put(updated));
      return updated;
    });
    this.emit("lease_released", run.id, run.revision);
    return cloneRun(run);
  }

  async append(input: AppendAgentRunInput): Promise<AppendAgentRunResult> {
    const eventInputs = prepareEventInputs(input.events);
    const observationInputs = copyForLedger(input.observations ?? []);
    const checkpointInput = input.checkpoint ? copyForLedger(input.checkpoint) : undefined;
    const transition = input.transition ? copyForLedger(input.transition) : undefined;
    const database = await openFacesDbDatabase();
    const transaction = database.transaction(
      [AGENT_RUNS, AGENT_RUN_EVENTS, AGENT_OBSERVATIONS, AGENT_CHECKPOINTS],
      "readwrite",
    );
    const result = await runIdbTransaction(transaction, async () => {
      const runStore = transaction.objectStore(AGENT_RUNS);
      const eventStore = transaction.objectStore(AGENT_RUN_EVENTS);
      const observationStore = transaction.objectStore(AGENT_OBSERVATIONS);
      const checkpointStore = transaction.objectStore(AGENT_CHECKPOINTS);
      const current = requiredRunRecord(
        await idbRequest<AgentRunRecord | undefined>(runStore.get(input.runId)),
        input.runId,
      );
      assertRunRevision(current, input.expectedRevision);
      assertRunLease(current, input.lease, this.now());
      assertRunOpen(current);

      let sequence = current.nextSequence;
      const events = eventInputs.map((eventInput): AgentRunEvent => {
        const { at, payload, ...details } = eventInput;
        const event: AgentRunEvent = {
          ...details,
          id: `${current.id}:${sequence}`,
          runId: current.id,
          sequence,
          at: at ?? this.now(),
          ...(payload === undefined ? {} : { payload: structuredClone(payload) }),
        };
        sequence += 1;
        return event;
      });

      const candidateObservationIds = new Set<string>();
      for (const observation of observationInputs) {
        if (
          candidateObservationIds.has(observation.id) ||
          (await idbRequest(observationStore.get(observation.id)))
        ) {
          throw new AgentRunLedgerConflictError(
            "DUPLICATE_RECORD",
            `Agent observation ${observation.id} already exists`,
          );
        }
        candidateObservationIds.add(observation.id);
      }
      const observations = observationInputs.map((observation): AgentObservationRecord => ({
        ...observation,
        schemaVersion: AGENT_RUN_LEDGER_SCHEMA_VERSION,
        runId: current.id,
      }));

      let checkpoint: AgentCheckpointRecord | undefined;
      if (checkpointInput) {
        const id = checkpointInput.id ?? checkpointId(current.id, sequence - 1);
        if (await idbRequest(checkpointStore.get(id))) {
          throw new AgentRunLedgerConflictError(
            "DUPLICATE_RECORD",
            `Agent checkpoint ${id} already exists`,
          );
        }
        const existingObservations = await idbRequest<AgentObservationRecord[]>(
          observationStore.index("runId").getAll(current.id),
        );
        const knownObservationIds = new Set([
          ...existingObservations.map((observation) => observation.id),
          ...candidateObservationIds,
        ]);
        const missing = checkpointInput.observationIds.find(
          (observationId) => !knownObservationIds.has(observationId),
        );
        if (missing) {
          throw new AgentRunLedgerConflictError(
            "INVALID_REFERENCE",
            `Agent checkpoint references unknown observation ${missing}`,
          );
        }
        checkpoint = {
          ...checkpointInput,
          id,
          schemaVersion: AGENT_RUN_LEDGER_SCHEMA_VERSION,
          runId: current.id,
          afterSequence: sequence - 1,
          createdAt: checkpointInput.createdAt ?? this.now(),
        };
      }

      const now = this.now();
      const nextStatus = transition?.status ?? current.status;
      const run: AgentRunRecord = {
        ...current,
        status: nextStatus,
        nextSequence: sequence,
        revision: current.revision + 1,
        latestCheckpointId: checkpoint?.id ?? current.latestCheckpointId,
        proposalRefs: unique(transition?.proposalRefs, current.proposalRefs),
        receiptRefs: unique(transition?.receiptRefs, current.receiptRefs),
        resumable: transition?.resumable ?? current.resumable,
        usage: transition?.usage ?? current.usage,
        updatedAt: now,
        endedAt: transition?.endedAt ?? (TERMINAL_STATUSES.has(nextStatus) ? now : current.endedAt),
      };
      if (
        nextStatus === "awaiting_approval" ||
        nextStatus === "suspended" ||
        TERMINAL_STATUSES.has(nextStatus)
      ) {
        delete run.lease;
      }

      for (const event of events) await idbRequest(eventStore.add(event));
      for (const observation of observations) {
        await idbRequest(observationStore.add(observation));
      }
      if (checkpoint) await idbRequest(checkpointStore.add(checkpoint));
      await idbRequest(runStore.put(run));
      return {
        run: cloneRun(run),
        events: structuredClone(events),
        observations: structuredClone(observations),
        checkpoint: checkpoint ? structuredClone(checkpoint) : undefined,
      };
    });
    this.emit("run_appended", result.run.id, result.run.revision);
    return result;
  }

  async deleteRun(runId: string) {
    const database = await openFacesDbDatabase();
    const transaction = database.transaction(
      [AGENT_RUNS, AGENT_RUN_EVENTS, AGENT_OBSERVATIONS, AGENT_CHECKPOINTS],
      "readwrite",
    );
    const deleted = await runIdbTransaction(transaction, async () => {
      const runStore = transaction.objectStore(AGENT_RUNS);
      const run = await idbRequest<AgentRunRecord | undefined>(runStore.get(runId));
      if (!run) return undefined;
      const dependentStores = [
        transaction.objectStore(AGENT_RUN_EVENTS),
        transaction.objectStore(AGENT_OBSERVATIONS),
        transaction.objectStore(AGENT_CHECKPOINTS),
      ];
      for (const store of dependentStores) {
        const keys = await idbRequest<IDBValidKey[]>(store.index("runId").getAllKeys(runId));
        keys.forEach((key) => store.delete(key));
      }
      await idbRequest(runStore.delete(runId));
      return run;
    });
    if (!deleted) return false;
    this.emit("run_deleted", deleted.id, deleted.revision);
    return true;
  }

  async clear() {
    const database = await openFacesDbDatabase();
    const transaction = database.transaction(
      [AGENT_RUNS, AGENT_RUN_EVENTS, AGENT_OBSERVATIONS, AGENT_CHECKPOINTS],
      "readwrite",
    );
    await runIdbTransaction(transaction, async () => {
      await Promise.all([
        idbRequest(transaction.objectStore(AGENT_RUNS).clear()),
        idbRequest(transaction.objectStore(AGENT_RUN_EVENTS).clear()),
        idbRequest(transaction.objectStore(AGENT_OBSERVATIONS).clear()),
        idbRequest(transaction.objectStore(AGENT_CHECKPOINTS).clear()),
      ]);
    });
    this.emit("ledger_cleared", "*", 0);
  }

  subscribe(listener: AgentRunLedgerListener) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

/** Durable proposal/receipt storage kept separate from the Agent execution log. */
export class IndexedDbMutationRecordRepository implements MutationRecordRepository {
  private readonly now: () => number;
  private readonly listeners = new Set<MutationRecordListener>();

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
  }

  private emit(change: MutationRecordChange) {
    this.listeners.forEach((listener) => listener(change));
  }

  async putProposal(input: PutMutationProposalInput) {
    const safe = copyForLedger(input);
    const record: PersistedMutationProposalRecord = {
      ...safe,
      schemaVersion: AGENT_RUN_LEDGER_SCHEMA_VERSION,
      status: "pending",
      revision: 0,
      updatedAt: safe.updatedAt ?? this.now(),
    };
    const database = await openFacesDbDatabase();
    const transaction = database.transaction(MUTATION_PROPOSALS, "readwrite");
    const saved = await runIdbTransaction(transaction, async () => {
      const store = transaction.objectStore(MUTATION_PROPOSALS);
      const existing = await idbRequest<PersistedMutationProposalRecord | undefined>(
        store.get(record.id),
      );
      if (existing) {
        const sameProposal =
          existing.status === "pending" &&
          !existing.decisionId &&
          existing.enqueuedAt === record.enqueuedAt &&
          existing.sourceRunId === record.sourceRunId &&
          existing.scope === record.scope &&
          JSON.stringify(existing.plan) === JSON.stringify(record.plan);
        if (sameProposal) return existing;
        throw new AgentRunLedgerConflictError(
          "DUPLICATE_RECORD",
          `Mutation proposal ${record.id} already exists`,
        );
      }
      await idbRequest(store.add(record));
      return record;
    });
    this.emit({ kind: "proposal_saved", id: record.id });
    return structuredClone(saved);
  }

  async claimProposalDecision(input: ClaimMutationProposalDecisionInput) {
    const safe = copyForLedger(input);
    const proposalIds = unique(safe.proposalIds);
    if (!proposalIds.length) {
      throw new AgentRunLedgerConflictError(
        "INVALID_REFERENCE",
        "A proposal decision must include at least one proposal",
      );
    }
    const canonicalProposalIds = [...proposalIds].sort();
    if (
      safe.decisionKind === "committed" &&
      (safe.intent.decisionId !== safe.decisionId ||
        safe.intent.kind !== safe.decisionKind ||
        JSON.stringify([...safe.intent.proposalIds].sort()) !==
          JSON.stringify(canonicalProposalIds))
    ) {
      throw new AgentRunLedgerConflictError(
        "INVALID_REFERENCE",
        "The commit intent does not match its proposal decision",
      );
    }
    const claimedAt = safe.claimedAt ?? this.now();
    const database = await openFacesDbDatabase();
    const transaction = database.transaction(MUTATION_PROPOSALS, "readwrite");
    const records = await runIdbTransaction(transaction, async () => {
      const store = transaction.objectStore(MUTATION_PROPOSALS);
      const existing = await Promise.all(
        proposalIds.map((id) =>
          idbRequest<PersistedMutationProposalRecord | undefined>(store.get(id)),
        ),
      );
      const missingIndex = existing.findIndex((record) => !record);
      if (missingIndex >= 0) {
        throw new AgentRunLedgerConflictError(
          "PROPOSAL_NOT_FOUND",
          `Mutation proposal ${proposalIds[missingIndex]} does not exist`,
        );
      }
      const claimed = (existing as PersistedMutationProposalRecord[]).map((record) => {
        if (record.decisionId === safe.decisionId && record.decisionKind === safe.decisionKind) {
          const expectedIntent =
            safe.decisionKind === "committed" && record.id === canonicalProposalIds[0]
              ? safe.intent
              : undefined;
          if (JSON.stringify(record.decisionIntent) !== JSON.stringify(expectedIntent)) {
            throw new AgentRunLedgerConflictError(
              "PROPOSAL_DECISION_CONFLICT",
              `Mutation proposal ${record.id} has a different decision intent`,
            );
          }
          return record;
        }
        if (record.status !== "pending" || record.decisionId) {
          throw new AgentRunLedgerConflictError(
            "PROPOSAL_DECISION_CONFLICT",
            `Mutation proposal ${record.id} is already claimed or decided`,
          );
        }
        const next = {
          ...record,
          revision: (record.revision ?? 0) + 1,
          decisionId: safe.decisionId,
          decisionKind: safe.decisionKind,
          decisionClaimedAt: claimedAt,
          updatedAt: claimedAt,
        } satisfies PersistedMutationProposalRecord;
        if (safe.decisionKind === "committed" && record.id === canonicalProposalIds[0]) {
          next.decisionIntent = safe.intent;
        }
        return next;
      });
      await Promise.all(claimed.map((record) => idbRequest(store.put(record))));
      return claimed;
    });
    records.forEach((record) => this.emit({ kind: "proposal_saved", id: record.id }));
    return structuredClone(records);
  }

  async settleProposalDecision(input: SettleMutationProposalDecisionInput) {
    const safe = copyForLedger(input);
    const proposalIds = unique(safe.proposalIds);
    if (!proposalIds.length) {
      throw new AgentRunLedgerConflictError(
        "INVALID_REFERENCE",
        "A proposal decision must include at least one proposal",
      );
    }
    if (safe.decisionKind === "committed" && !safe.receipt) {
      throw new AgentRunLedgerConflictError(
        "INVALID_REFERENCE",
        "A committed proposal decision must include its receipt",
      );
    }
    if (safe.decisionKind === "discarded" && safe.receipt) {
      throw new AgentRunLedgerConflictError(
        "INVALID_REFERENCE",
        "A discarded proposal decision cannot include a receipt",
      );
    }
    if (
      safe.receipt &&
      (safe.receipt.proposalIds.length !== proposalIds.length ||
        proposalIds.some((id) => !safe.receipt!.proposalIds.includes(id)))
    ) {
      throw new AgentRunLedgerConflictError(
        "INVALID_REFERENCE",
        "The receipt does not cover the claimed proposal set",
      );
    }
    const decidedAt = safe.decidedAt ?? this.now();
    const receipt = safe.receipt
      ? ({
          ...safe.receipt,
          schemaVersion: AGENT_RUN_LEDGER_SCHEMA_VERSION,
          updatedAt: safe.receipt.updatedAt ?? decidedAt,
        } satisfies PersistedMutationReceiptRecord)
      : undefined;
    const database = await openFacesDbDatabase();
    const transaction = database.transaction([MUTATION_PROPOSALS, MUTATION_RECEIPTS], "readwrite");
    const records = await runIdbTransaction(transaction, async () => {
      const proposalStore = transaction.objectStore(MUTATION_PROPOSALS);
      const receiptStore = transaction.objectStore(MUTATION_RECEIPTS);
      const existing = await Promise.all(
        proposalIds.map((id) =>
          idbRequest<PersistedMutationProposalRecord | undefined>(proposalStore.get(id)),
        ),
      );
      const missingIndex = existing.findIndex((record) => !record);
      if (missingIndex >= 0) {
        throw new AgentRunLedgerConflictError(
          "PROPOSAL_NOT_FOUND",
          `Mutation proposal ${proposalIds[missingIndex]} does not exist`,
        );
      }
      const proposalRecords = existing as PersistedMutationProposalRecord[];
      if (
        safe.decisionKind === "committed" &&
        proposalRecords.some((record) => record.status === "pending")
      ) {
        const persistedIntent = proposalRecords.find(
          (record) => record.decisionIntent,
        )?.decisionIntent;
        if (
          !persistedIntent ||
          JSON.stringify(persistedIntent.receipt) !== JSON.stringify(safe.receipt)
        ) {
          throw new AgentRunLedgerConflictError(
            "PROPOSAL_DECISION_CONFLICT",
            "The commit receipt does not match the claimed decision intent",
          );
        }
      }
      const settled = proposalRecords.map((record) => {
        const sameDecision =
          record.decisionId === safe.decisionId && record.decisionKind === safe.decisionKind;
        if (!sameDecision) {
          throw new AgentRunLedgerConflictError(
            "PROPOSAL_DECISION_CONFLICT",
            `Mutation proposal ${record.id} belongs to another decision`,
          );
        }
        if (record.status === safe.decisionKind) return record;
        if (record.status !== "pending") {
          throw new AgentRunLedgerConflictError(
            "PROPOSAL_DECISION_CONFLICT",
            `Mutation proposal ${record.id} has already reached ${record.status}`,
          );
        }
        return {
          ...record,
          status: safe.decisionKind,
          revision: (record.revision ?? 0) + 1,
          decidedAt,
          receiptId: receipt?.id,
          updatedAt: decidedAt,
          decisionIntent: undefined,
        } satisfies PersistedMutationProposalRecord;
      });
      if (receipt) {
        const existingReceipt = await idbRequest<PersistedMutationReceiptRecord | undefined>(
          receiptStore.get(receipt.id),
        );
        if (existingReceipt && JSON.stringify(existingReceipt) !== JSON.stringify(receipt)) {
          throw new AgentRunLedgerConflictError(
            "DUPLICATE_RECORD",
            `Mutation receipt ${receipt.id} belongs to another proposal set`,
          );
        }
        if (!existingReceipt) await idbRequest(receiptStore.add(receipt));
      }
      await Promise.all(settled.map((record) => idbRequest(proposalStore.put(record))));
      return settled;
    });
    records.forEach((record) => this.emit({ kind: "proposal_saved", id: record.id }));
    if (receipt) this.emit({ kind: "receipt_saved", id: receipt.id });
    return structuredClone(records);
  }

  async releaseProposalDecision(input: {
    proposalIds: readonly string[];
    decisionId: string;
    releasedAt?: number;
    requireArchiveDecisionUnapplied?: boolean;
  }) {
    const safe = copyForLedger(input);
    const proposalIds = unique(safe.proposalIds);
    const releasedAt = safe.releasedAt ?? this.now();
    const database = await openFacesDbDatabase();
    const transaction = database.transaction(
      safe.requireArchiveDecisionUnapplied ? [MUTATION_PROPOSALS, APP_META] : [MUTATION_PROPOSALS],
      "readwrite",
    );
    const records = await runIdbTransaction(transaction, async () => {
      const store = transaction.objectStore(MUTATION_PROPOSALS);
      if (safe.requireArchiveDecisionUnapplied) {
        const marker = await idbRequest(
          transaction.objectStore(APP_META).get(archiveMutationDecisionMarkerId(safe.decisionId)),
        );
        if (marker) {
          throw new AgentRunLedgerConflictError(
            "PROPOSAL_DECISION_CONFLICT",
            "The archive mutation has already been applied and cannot be released",
          );
        }
      }
      const existing = await Promise.all(
        proposalIds.map((id) =>
          idbRequest<PersistedMutationProposalRecord | undefined>(store.get(id)),
        ),
      );
      const missingIndex = existing.findIndex((record) => !record);
      if (missingIndex >= 0) {
        throw new AgentRunLedgerConflictError(
          "PROPOSAL_NOT_FOUND",
          `Mutation proposal ${proposalIds[missingIndex]} does not exist`,
        );
      }
      const released = (existing as PersistedMutationProposalRecord[]).map((record) => {
        if (record.status !== "pending" || record.decisionId !== safe.decisionId) {
          throw new AgentRunLedgerConflictError(
            "PROPOSAL_DECISION_CONFLICT",
            `Mutation proposal ${record.id} cannot release this decision`,
          );
        }
        const next = { ...record };
        delete next.decisionId;
        delete next.decisionKind;
        delete next.decisionClaimedAt;
        delete next.decisionIntent;
        next.revision = (record.revision ?? 0) + 1;
        next.updatedAt = releasedAt;
        return next;
      });
      await Promise.all(released.map((record) => idbRequest(store.put(record))));
      return released;
    });
    records.forEach((record) => this.emit({ kind: "proposal_saved", id: record.id }));
    return structuredClone(records);
  }

  async getProposal(id: string) {
    const database = await openFacesDbDatabase();
    const transaction = database.transaction(MUTATION_PROPOSALS, "readonly");
    return runIdbTransaction(transaction, async () => {
      const record = await idbRequest<PersistedMutationProposalRecord | undefined>(
        transaction.objectStore(MUTATION_PROPOSALS).get(id),
      );
      return record ? structuredClone(record) : undefined;
    });
  }

  async listProposals(
    options: {
      sourceRunId?: string;
      status?: MutationProposalStatus;
      scope?: string | null;
    } = {},
  ) {
    const database = await openFacesDbDatabase();
    const transaction = database.transaction(MUTATION_PROPOSALS, "readonly");
    return runIdbTransaction(transaction, async () => {
      const store = transaction.objectStore(MUTATION_PROPOSALS);
      const rows = options.sourceRunId
        ? await idbRequest<PersistedMutationProposalRecord[]>(
            store.index("sourceRunId").getAll(options.sourceRunId),
          )
        : options.status
          ? await idbRequest<PersistedMutationProposalRecord[]>(
              store.index("status").getAll(options.status),
            )
          : await idbRequest<PersistedMutationProposalRecord[]>(store.getAll());
      return structuredClone(
        rows
          .filter((record) => !options.sourceRunId || record.sourceRunId === options.sourceRunId)
          .filter((record) => !options.status || record.status === options.status)
          .filter((record) =>
            options.scope === undefined
              ? true
              : options.scope === null
                ? !record.scope
                : record.scope === options.scope,
          )
          .sort((left, right) => right.updatedAt - left.updatedAt),
      );
    });
  }

  async deleteProposal(id: string) {
    const existing = await this.getProposal(id);
    if (!existing) return false;
    const database = await openFacesDbDatabase();
    const transaction = database.transaction(MUTATION_PROPOSALS, "readwrite");
    await runIdbTransaction(transaction, () =>
      idbRequest(transaction.objectStore(MUTATION_PROPOSALS).delete(id)),
    );
    this.emit({ kind: "proposal_deleted", id });
    return true;
  }

  async putReceipt(input: PutMutationReceiptInput) {
    const safe = copyForLedger(input);
    const record: PersistedMutationReceiptRecord = {
      ...safe,
      schemaVersion: AGENT_RUN_LEDGER_SCHEMA_VERSION,
      updatedAt: safe.updatedAt ?? this.now(),
    };
    const database = await openFacesDbDatabase();
    const transaction = database.transaction(MUTATION_RECEIPTS, "readwrite");
    await runIdbTransaction(transaction, () =>
      idbRequest(transaction.objectStore(MUTATION_RECEIPTS).put(record)),
    );
    this.emit({ kind: "receipt_saved", id: record.id });
    return structuredClone(record);
  }

  async getReceipt(id: string) {
    const database = await openFacesDbDatabase();
    const transaction = database.transaction(MUTATION_RECEIPTS, "readonly");
    return runIdbTransaction(transaction, async () => {
      const record = await idbRequest<PersistedMutationReceiptRecord | undefined>(
        transaction.objectStore(MUTATION_RECEIPTS).get(id),
      );
      return record ? structuredClone(record) : undefined;
    });
  }

  async listReceipts(options: { sourceRunId?: string; scope?: string | null } = {}) {
    const database = await openFacesDbDatabase();
    const transaction = database.transaction(MUTATION_RECEIPTS, "readonly");
    return runIdbTransaction(transaction, async () => {
      const store = transaction.objectStore(MUTATION_RECEIPTS);
      const rows = options.sourceRunId
        ? await idbRequest<PersistedMutationReceiptRecord[]>(
            store.index("sourceRunId").getAll(options.sourceRunId),
          )
        : await idbRequest<PersistedMutationReceiptRecord[]>(store.getAll());
      return structuredClone(
        rows
          .filter((record) =>
            options.scope === undefined
              ? true
              : options.scope === null
                ? !record.scope
                : record.scope === options.scope,
          )
          .sort((left, right) => right.committedAt - left.committedAt),
      );
    });
  }

  async deleteReceipt(id: string) {
    const existing = await this.getReceipt(id);
    if (!existing) return false;
    const database = await openFacesDbDatabase();
    const transaction = database.transaction(MUTATION_RECEIPTS, "readwrite");
    await runIdbTransaction(transaction, () =>
      idbRequest(transaction.objectStore(MUTATION_RECEIPTS).delete(id)),
    );
    this.emit({ kind: "receipt_deleted", id });
    return true;
  }

  async clear() {
    const database = await openFacesDbDatabase();
    const transaction = database.transaction([MUTATION_PROPOSALS, MUTATION_RECEIPTS], "readwrite");
    await runIdbTransaction(transaction, async () => {
      await Promise.all([
        idbRequest(transaction.objectStore(MUTATION_PROPOSALS).clear()),
        idbRequest(transaction.objectStore(MUTATION_RECEIPTS).clear()),
      ]);
    });
    this.emit({ kind: "artifacts_cleared" });
  }

  subscribe(listener: MutationRecordListener) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

export const indexedDbAgentRunLedger = new IndexedDbAgentRunLedgerRepository();
export const indexedDbMutationArtifactRepository = new IndexedDbMutationRecordRepository();
