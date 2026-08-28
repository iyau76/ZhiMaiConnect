import { z } from "zod";

import { raceAgentAbort } from "./agent-deadline";
import { projectToolResultForHistory } from "./agent-history";
import type { AgentRunRecorder } from "./agent-run-log";

export type AgentToolCapability = "public_read" | "private_read" | "network" | "proposal" | "write";
/** @deprecated Declare public_read or private_read explicitly in new tools. */
export type AgentToolPermission = AgentToolCapability | "read";
export type AgentToolRedactionPhase = "input" | "output";

export const AGENT_TOOL_CAPABILITY_GUIDE: Record<AgentToolCapability, string> = {
  public_read: "reads non-private local state such as time or app capabilities",
  private_read: "reads the user's private local archive and requires explicit consent",
  network: "sends a request to an external network service",
  proposal: "creates a reversible change proposal without committing it",
  write: "commits an approved mutation",
};

export interface AgentToolContext<TServices> {
  services: TServices;
  recorder: AgentRunRecorder;
  runId: string;
  round?: number;
  invocationId?: string;
  signal?: AbortSignal;
}

export interface AgentToolDefinition<
  TInputSchema extends z.ZodTypeAny = z.ZodTypeAny,
  TOutput = unknown,
  TServices = unknown,
> {
  name: string;
  label: string;
  description: string;
  input: TInputSchema;
  permission: AgentToolPermission;
  redact?: (payload: unknown, phase: AgentToolRedactionPhase) => unknown;
  toModelResult?: (output: TOutput, maxCharacters: number) => unknown;
  handler: (
    input: z.infer<TInputSchema>,
    context: AgentToolContext<TServices>,
  ) => TOutput | Promise<TOutput>;
}

export function defineAgentTool<TInputSchema extends z.ZodTypeAny, TOutput, TServices = unknown>(
  definition: AgentToolDefinition<TInputSchema, TOutput, TServices>,
) {
  return definition;
}

export interface AgentToolInputContract {
  type?: string;
  description?: string;
  properties?: Record<string, AgentToolInputContract>;
  required?: string[];
  items?: AgentToolInputContract;
  enum?: unknown[];
  const?: unknown;
  anyOf?: AgentToolInputContract[];
  additionalProperties?: boolean | AgentToolInputContract;
}

export interface AgentModelToolDefinition {
  name: string;
  label: string;
  description: string;
  permission: AgentToolCapability;
  /** Present only for a legacy declaration normalized by the registry. */
  declaredPermission?: AgentToolPermission;
  inputSchema: AgentToolInputContract;
}

export interface AgentToolGuideOptions {
  compact?: boolean;
  allowedToolNames?: ReadonlySet<string> | readonly string[];
}

type ZodInternals = {
  typeName?: string;
  shape?: (() => Record<string, z.ZodTypeAny>) | Record<string, z.ZodTypeAny>;
  innerType?: z.ZodTypeAny;
  schema?: z.ZodTypeAny;
  type?: z.ZodTypeAny;
  element?: z.ZodTypeAny;
  valueType?: z.ZodTypeAny;
  options?: z.ZodTypeAny[] | Map<unknown, z.ZodTypeAny>;
  values?: unknown[];
  value?: unknown;
  checks?: Array<{ kind?: string }>;
};

function zodInternals(schema: z.ZodTypeAny) {
  return (schema as unknown as { _def: ZodInternals })._def;
}

function withDescription(schema: z.ZodTypeAny, contract: AgentToolInputContract) {
  return schema.description ? { ...contract, description: schema.description } : contract;
}

/**
 * Produce a small JSON-Schema-compatible contract from the same Zod schema
 * used at execution time. Unsupported refinements remain runtime validated.
 */
export function describeAgentToolInput(schema: z.ZodTypeAny): AgentToolInputContract {
  const definition = zodInternals(schema);
  const kind = definition.typeName;

  if (kind === "ZodString") return withDescription(schema, { type: "string" });
  if (kind === "ZodNumber") {
    const integer = definition.checks?.some((check) => check.kind === "int");
    return withDescription(schema, { type: integer ? "integer" : "number" });
  }
  if (kind === "ZodBoolean") return withDescription(schema, { type: "boolean" });
  if (kind === "ZodDate") return withDescription(schema, { type: "string" });
  if (kind === "ZodNull") return withDescription(schema, { type: "null" });
  if (kind === "ZodLiteral") {
    return withDescription(schema, { const: definition.value });
  }
  if (kind === "ZodEnum") {
    return withDescription(schema, { type: "string", enum: definition.values ?? [] });
  }
  if (kind === "ZodNativeEnum") {
    const enumValues = definition.values
      ? Object.values(definition.values).filter(
          (value, index, values) =>
            (typeof value === "string" || typeof value === "number") &&
            values.indexOf(value) === index,
        )
      : [];
    return withDescription(schema, { enum: enumValues });
  }
  if (kind === "ZodArray") {
    const item = definition.type ?? definition.element;
    return withDescription(schema, {
      type: "array",
      items: item ? describeAgentToolInput(item) : {},
    });
  }
  if (kind === "ZodObject") {
    const shape =
      typeof definition.shape === "function" ? definition.shape() : (definition.shape ?? {});
    const properties = Object.fromEntries(
      Object.entries(shape).map(([key, value]) => [key, describeAgentToolInput(value)]),
    );
    const required = Object.entries(shape)
      .filter(([, value]) => !value.safeParse(undefined).success)
      .map(([key]) => key);
    return withDescription(schema, {
      type: "object",
      properties,
      ...(required.length ? { required } : {}),
    });
  }
  if (kind === "ZodRecord") {
    return withDescription(schema, {
      type: "object",
      additionalProperties: definition.valueType
        ? describeAgentToolInput(definition.valueType)
        : true,
    });
  }
  if (kind === "ZodUnion" || kind === "ZodDiscriminatedUnion") {
    const rawOptions = definition.options;
    const options = rawOptions instanceof Map ? [...rawOptions.values()] : (rawOptions ?? []);
    return withDescription(schema, { anyOf: options.map(describeAgentToolInput) });
  }
  if (kind === "ZodNullable") {
    return withDescription(schema, {
      anyOf: [
        definition.innerType ? describeAgentToolInput(definition.innerType) : {},
        { type: "null" },
      ],
    });
  }
  if (
    kind === "ZodOptional" ||
    kind === "ZodDefault" ||
    kind === "ZodCatch" ||
    kind === "ZodBranded" ||
    kind === "ZodReadonly"
  ) {
    return definition.innerType ? describeAgentToolInput(definition.innerType) : {};
  }
  if (kind === "ZodEffects" || kind === "ZodPipeline") {
    const inner = definition.schema ?? definition.innerType ?? definition.type;
    return inner ? describeAgentToolInput(inner) : {};
  }

  return withDescription(schema, {});
}

function compactInputContract(contract: AgentToolInputContract): string {
  if (contract.anyOf?.length) {
    return contract.anyOf.map(compactInputContract).join(" | ");
  }
  if (contract.const !== undefined) return JSON.stringify(contract.const);
  if (contract.enum?.length) return contract.enum.map((value) => JSON.stringify(value)).join(" | ");
  if (contract.type === "array") return `Array<${compactInputContract(contract.items ?? {})}>`;
  if (contract.type === "object") {
    if (contract.properties) {
      const required = new Set(contract.required ?? []);
      const properties = Object.entries(contract.properties).map(
        ([name, value]) => `${name}${required.has(name) ? "" : "?"}:${compactInputContract(value)}`,
      );
      return `{${properties.join(",")}}`;
    }
    if (contract.additionalProperties) {
      return `Record<string,${
        contract.additionalProperties === true
          ? "unknown"
          : compactInputContract(contract.additionalProperties)
      }>`;
    }
    return "{}";
  }
  return contract.type ?? "unknown";
}

export class AgentToolRegistryError extends Error {}

export class AgentToolNotFoundError extends AgentToolRegistryError {
  constructor(readonly toolName: string) {
    super(`Unknown agent tool: ${toolName}`);
    this.name = "AgentToolNotFoundError";
  }
}

export class AgentToolPermissionError extends AgentToolRegistryError {
  constructor(
    readonly toolName: string,
    readonly requiredPermission: AgentToolCapability,
  ) {
    super(`Tool ${toolName} requires ${requiredPermission} permission`);
    this.name = "AgentToolPermissionError";
  }
}

export class AgentToolScopeError extends AgentToolRegistryError {
  constructor(readonly toolName: string) {
    super(`Tool ${toolName} is not available in this Agent scope`);
    this.name = "AgentToolScopeError";
  }
}

export class AgentToolValidationError extends AgentToolRegistryError {
  constructor(
    readonly toolName: string,
    readonly issues: z.ZodIssue[],
  ) {
    super(`Invalid input for agent tool: ${toolName}`);
    this.name = "AgentToolValidationError";
  }
}

export interface ExecuteAgentToolOptions<TServices> {
  services: TServices;
  recorder: AgentRunRecorder;
  permissions?: ReadonlySet<AgentToolPermission> | readonly AgentToolPermission[];
  allowedToolNames?: ReadonlySet<string> | readonly string[];
  round?: number;
  invocationId?: string;
  signal?: AbortSignal;
  now?: () => number;
}

type AnyAgentTool<TServices> = AgentToolDefinition<z.ZodTypeAny, unknown, TServices>;

export function canonicalAgentToolPermission(permission: AgentToolPermission): AgentToolCapability {
  return permission === "read" ? "private_read" : permission;
}

function normalizePermissions(
  permissions?: ReadonlySet<AgentToolPermission> | readonly AgentToolPermission[],
) {
  const declared = permissions ?? ["public_read"];
  const allowed = new Set<AgentToolCapability>();
  declared.forEach((permission) => {
    if (permission === "read") {
      // Old read access covered local records; retain that behavior only for callers
      // that explicitly use the deprecated alias.
      allowed.add("public_read");
      allowed.add("private_read");
    } else {
      allowed.add(permission);
    }
  });
  return allowed;
}

function normalizeToolNames(names?: ReadonlySet<string> | readonly string[]) {
  if (!names) return undefined;
  return names instanceof Set ? names : new Set(names);
}

export class AgentToolRegistry<TServices = unknown> {
  private readonly tools = new Map<string, AnyAgentTool<TServices>>();

  register<TSchema extends z.ZodTypeAny, TOutput>(
    definition: AgentToolDefinition<TSchema, TOutput, TServices>,
  ) {
    if (!/^[a-z][a-z0-9_]*$/.test(definition.name)) {
      throw new AgentToolRegistryError(
        `Tool name must use lowercase snake_case: ${definition.name}`,
      );
    }
    if (this.tools.has(definition.name)) {
      throw new AgentToolRegistryError(`Duplicate agent tool: ${definition.name}`);
    }
    this.tools.set(definition.name, definition as unknown as AnyAgentTool<TServices>);
    return this;
  }

  get(name: string) {
    return this.tools.get(name);
  }

  modelResult(name: string, output: unknown, maxCharacters = 3_800) {
    const definition = this.tools.get(name);
    return definition?.toModelResult
      ? definition.toModelResult(output, maxCharacters)
      : projectToolResultForHistory(output, maxCharacters);
  }

  list(
    permissions?: ReadonlySet<AgentToolPermission> | readonly AgentToolPermission[],
    allowedToolNames?: ReadonlySet<string> | readonly string[],
  ) {
    const allowed = permissions ? normalizePermissions(permissions) : undefined;
    const names = normalizeToolNames(allowedToolNames);
    return [...this.tools.values()].filter(
      (tool) =>
        (!allowed || allowed.has(canonicalAgentToolPermission(tool.permission))) &&
        (!names || names.has(tool.name)),
    );
  }

  modelDefinitions(
    permissions?: ReadonlySet<AgentToolPermission> | readonly AgentToolPermission[],
    allowedToolNames?: ReadonlySet<string> | readonly string[],
  ): AgentModelToolDefinition[] {
    return this.list(permissions, allowedToolNames).map((tool) => {
      const permission = canonicalAgentToolPermission(tool.permission);
      return {
        name: tool.name,
        label: tool.label,
        description: tool.description,
        permission,
        ...(permission !== tool.permission ? { declaredPermission: tool.permission } : {}),
        inputSchema: describeAgentToolInput(tool.input),
      };
    });
  }

  modelGuide(
    permissions?: ReadonlySet<AgentToolPermission> | readonly AgentToolPermission[],
    options: AgentToolGuideOptions = {},
  ) {
    const definitions = this.modelDefinitions(permissions, options.allowedToolNames);
    if (!definitions.length) return "No tools are available for this run.";
    if (options.compact) {
      return definitions
        .map(
          (tool) => `- ${tool.name} ${compactInputContract(tool.inputSchema)}：${tool.description}`,
        )
        .join("\n");
    }
    const scopes = [...new Set(definitions.map((tool) => tool.permission))]
      .map((permission) => `- ${permission}: ${AGENT_TOOL_CAPABILITY_GUIDE[permission]}`)
      .join("\n");
    const tools = definitions
      .map(
        (tool) =>
          `- ${tool.name} [${tool.permission}] ${tool.label}: ${tool.description}\n  input: ${JSON.stringify(tool.inputSchema)}`,
      )
      .join("\n");
    return `Permission scopes:\n${scopes}\nTools:\n${tools}`;
  }

  async execute(
    name: string,
    rawInput: unknown,
    options: ExecuteAgentToolOptions<TServices>,
  ): Promise<unknown> {
    const startedAt = (options.now ?? Date.now)();
    const invocationId = options.invocationId ?? crypto.randomUUID();
    const definition = this.tools.get(name);
    options.recorder.record({
      kind: "tool_call",
      status: "started",
      round: options.round,
      toolName: name,
      invocationId,
      payload: rawInput,
      redact: definition?.redact ? (payload) => definition.redact?.(payload, "input") : undefined,
    });

    if (!definition) {
      options.recorder.record({
        kind: "validation",
        status: "failed",
        round: options.round,
        toolName: name,
        invocationId,
        payload: { reason: "unknown_tool" },
      });
      options.recorder.record({
        kind: "tool_result",
        status: "failed",
        round: options.round,
        toolName: name,
        invocationId,
        durationMs: (options.now ?? Date.now)() - startedAt,
        payload: { reason: "unknown_tool" },
      });
      throw new AgentToolNotFoundError(name);
    }

    const allowedToolNames = normalizeToolNames(options.allowedToolNames);
    if (allowedToolNames && !allowedToolNames.has(name)) {
      const payload = { reason: "tool_outside_agent_scope" };
      options.recorder.record({
        kind: "validation",
        status: "blocked",
        round: options.round,
        toolName: name,
        invocationId,
        payload,
      });
      options.recorder.record({
        kind: "tool_result",
        status: "blocked",
        round: options.round,
        toolName: name,
        invocationId,
        durationMs: (options.now ?? Date.now)() - startedAt,
        payload,
      });
      throw new AgentToolScopeError(name);
    }

    const permissions = normalizePermissions(options.permissions);
    const requiredPermission = canonicalAgentToolPermission(definition.permission);
    if (!permissions.has(requiredPermission)) {
      options.recorder.record({
        kind: "validation",
        status: "blocked",
        round: options.round,
        toolName: name,
        invocationId,
        payload: {
          reason: "permission_denied",
          requiredPermission,
        },
      });
      options.recorder.record({
        kind: "tool_result",
        status: "blocked",
        round: options.round,
        toolName: name,
        invocationId,
        durationMs: (options.now ?? Date.now)() - startedAt,
        payload: {
          reason: "permission_denied",
          requiredPermission,
        },
      });
      throw new AgentToolPermissionError(name, requiredPermission);
    }

    const parsed = definition.input.safeParse(rawInput);
    if (!parsed.success) {
      options.recorder.record({
        kind: "validation",
        status: "failed",
        round: options.round,
        toolName: name,
        invocationId,
        payload: {
          reason: "invalid_input",
          issues: parsed.error.issues.map((issue) => ({
            code: issue.code,
            path: issue.path,
            message: issue.message,
          })),
        },
      });
      options.recorder.record({
        kind: "tool_result",
        status: "failed",
        round: options.round,
        toolName: name,
        invocationId,
        durationMs: (options.now ?? Date.now)() - startedAt,
        payload: { reason: "invalid_input" },
      });
      throw new AgentToolValidationError(name, parsed.error.issues);
    }

    options.recorder.record({
      kind: "validation",
      status: "succeeded",
      round: options.round,
      toolName: name,
      invocationId,
      payload: { reason: "input_valid" },
    });

    try {
      const operation = Promise.resolve(
        definition.handler(parsed.data, {
          services: options.services,
          recorder: options.recorder,
          runId: options.recorder.runId,
          round: options.round,
          invocationId,
          signal: options.signal,
        }),
      );
      const output = options.signal
        ? await raceAgentAbort(operation, options.signal)
        : await operation;
      options.recorder.record({
        kind: "tool_result",
        status: "succeeded",
        round: options.round,
        toolName: name,
        invocationId,
        durationMs: (options.now ?? Date.now)() - startedAt,
        payload: output,
        redact: definition.redact ? (payload) => definition.redact?.(payload, "output") : undefined,
      });
      return output;
    } catch (error) {
      options.recorder.record({
        kind: "tool_result",
        status: "failed",
        round: options.round,
        toolName: name,
        invocationId,
        durationMs: (options.now ?? Date.now)() - startedAt,
        payload: error instanceof Error ? error : { error },
      });
      throw error;
    }
  }
}
