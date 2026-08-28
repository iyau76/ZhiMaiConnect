import {
  redactAgentPayload,
  type AgentRun,
  type AgentRunEvent,
  type AgentStep,
} from "./agent-run-log";

export interface AgentKeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export class AgentStorageUnavailableError extends Error {
  constructor() {
    super("Browser storage is unavailable for Agent persistence");
    this.name = "AgentStorageUnavailableError";
  }
}

export class AgentRunStoreError extends Error {}

export function resolveAgentStorage(storage?: AgentKeyValueStorage) {
  if (storage) return storage;
  try {
    if (typeof globalThis.localStorage !== "undefined") return globalThis.localStorage;
  } catch {
    // Access itself can throw when storage is blocked by browser policy.
  }
  throw new AgentStorageUnavailableError();
}

export interface StoredAgentRun {
  run: AgentRun;
  events: AgentRunEvent[];
  privatePayload: boolean;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

export interface StoredAgentRunSummary {
  id: string;
  title?: string;
  status: AgentRun["status"];
  rounds?: number;
  eventCount: number;
  privatePayload: boolean;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

export interface SaveAgentRunOptions {
  /** Persist redacted free text. False stores event structure only. */
  privatePayload?: boolean;
}

export interface AgentRunStoreOptions {
  storage?: AgentKeyValueStorage;
  storageKey?: string;
  maxRuns?: number;
  maxAgeMs?: number;
  maxBytes?: number;
  now?: () => number;
}

interface AgentRunEnvelope {
  version: 1;
  runs: StoredAgentRun[];
}

const PRIVATE_PAYLOAD_HIDDEN = "[PRIVATE_PAYLOAD_HIDDEN]";
const DEFAULT_STORAGE_KEY = "zhimai.agent-runs.v1";
const DEFAULT_MAX_RUNS = 50;
const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_BYTES = 4_000_000;

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function serializedBytes(value: unknown) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function sanitizeStep(step: AgentStep, privatePayload: boolean): AgentStep {
  const baseline = redactAgentPayload(step) as AgentStep;
  if (privatePayload) return baseline;
  return {
    ...baseline,
    title: baseline.toolName ?? baseline.kind,
    message: baseline.message === undefined ? undefined : PRIVATE_PAYLOAD_HIDDEN,
    input: baseline.input === undefined ? undefined : PRIVATE_PAYLOAD_HIDDEN,
    output: baseline.output === undefined ? undefined : PRIVATE_PAYLOAD_HIDDEN,
  };
}

function sanitizeRun(run: AgentRun, privatePayload: boolean): AgentRun {
  const baseline = redactAgentPayload(run) as AgentRun;
  return {
    ...baseline,
    title: privatePayload || baseline.title === undefined ? baseline.title : PRIVATE_PAYLOAD_HIDDEN,
    steps: baseline.steps.map((step) => sanitizeStep(step, privatePayload)),
  };
}

function sanitizeEvent(event: AgentRunEvent, privatePayload: boolean): AgentRunEvent {
  const baseline = redactAgentPayload(event) as AgentRunEvent;
  return {
    ...baseline,
    payload:
      event.payload === undefined
        ? undefined
        : privatePayload
          ? redactAgentPayload(event.payload)
          : PRIVATE_PAYLOAD_HIDDEN,
  };
}

export class LocalAgentRunStore {
  private readonly storage: AgentKeyValueStorage;
  private readonly storageKey: string;
  private readonly maxRuns: number;
  private readonly maxAgeMs: number;
  private readonly maxBytes: number;
  private readonly now: () => number;

  constructor(options: AgentRunStoreOptions = {}) {
    this.storage = resolveAgentStorage(options.storage);
    this.storageKey = options.storageKey ?? DEFAULT_STORAGE_KEY;
    this.maxRuns = options.maxRuns ?? DEFAULT_MAX_RUNS;
    this.maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.now = options.now ?? Date.now;
    if (!Number.isInteger(this.maxRuns) || this.maxRuns <= 0) {
      throw new TypeError("maxRuns must be a positive integer");
    }
    if (!Number.isFinite(this.maxAgeMs) || this.maxAgeMs <= 0) {
      throw new TypeError("maxAgeMs must be positive");
    }
    if (!Number.isInteger(this.maxBytes) || this.maxBytes <= 0) {
      throw new TypeError("maxBytes must be a positive integer");
    }
  }

  private readEnvelope(): AgentRunEnvelope {
    let raw: string | null;
    try {
      raw = this.storage.getItem(this.storageKey);
    } catch (error) {
      throw new AgentRunStoreError(`Unable to read Agent runs: ${String(error)}`);
    }
    if (!raw) return { version: 1, runs: [] };
    try {
      const parsed = JSON.parse(raw) as Partial<AgentRunEnvelope>;
      return parsed.version === 1 && Array.isArray(parsed.runs)
        ? { version: 1, runs: parsed.runs }
        : { version: 1, runs: [] };
    } catch {
      return { version: 1, runs: [] };
    }
  }

  private retainedEnvelope(envelope: AgentRunEnvelope) {
    const oldest = this.now() - this.maxAgeMs;
    const runs = envelope.runs
      .filter((entry) => entry.updatedAt >= oldest)
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, this.maxRuns);
    while (runs.length && serializedBytes({ version: 1, runs }) > this.maxBytes) runs.pop();
    return { version: 1, runs } satisfies AgentRunEnvelope;
  }

  private writeEnvelope(envelope: AgentRunEnvelope) {
    try {
      if (!envelope.runs.length) this.storage.removeItem(this.storageKey);
      else this.storage.setItem(this.storageKey, JSON.stringify(envelope));
    } catch (error) {
      throw new AgentRunStoreError(`Unable to persist Agent runs: ${String(error)}`);
    }
  }

  private maintain() {
    const before = this.readEnvelope();
    const retained = this.retainedEnvelope(before);
    if (JSON.stringify(before) !== JSON.stringify(retained)) this.writeEnvelope(retained);
    return retained;
  }

  save(run: AgentRun, events: readonly AgentRunEvent[], options: SaveAgentRunOptions = {}) {
    const privatePayload = options.privatePayload ?? false;
    const now = this.now();
    const current = this.readEnvelope();
    const existing = current.runs.find((entry) => entry.run.id === run.id);
    const stored: StoredAgentRun = {
      run: sanitizeRun(run, privatePayload),
      events: events.map((event) => sanitizeEvent(event, privatePayload)),
      privatePayload,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      expiresAt: now + this.maxAgeMs,
    };
    const candidate = this.retainedEnvelope({
      version: 1,
      runs: [stored, ...current.runs.filter((entry) => entry.run.id !== run.id)],
    });
    if (!candidate.runs.some((entry) => entry.run.id === run.id)) {
      throw new AgentRunStoreError("Agent run exceeds the configured storage budget");
    }
    this.writeEnvelope(candidate);
    return cloneJson(candidate.runs.find((entry) => entry.run.id === run.id)!);
  }

  list(): StoredAgentRunSummary[] {
    return this.maintain().runs.map((entry) => ({
      id: entry.run.id,
      title: entry.run.title,
      status: entry.run.status,
      rounds: entry.run.rounds,
      eventCount: entry.events.length,
      privatePayload: entry.privatePayload,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      expiresAt: entry.expiresAt,
    }));
  }

  get(runId: string) {
    const entry = this.maintain().runs.find((candidate) => candidate.run.id === runId);
    return entry ? cloneJson(entry) : undefined;
  }

  remove(runId: string) {
    const current = this.maintain();
    const runs = current.runs.filter((entry) => entry.run.id !== runId);
    this.writeEnvelope({ version: 1, runs });
  }

  clear() {
    try {
      this.storage.removeItem(this.storageKey);
    } catch (error) {
      throw new AgentRunStoreError(`Unable to clear Agent runs: ${String(error)}`);
    }
  }
}
