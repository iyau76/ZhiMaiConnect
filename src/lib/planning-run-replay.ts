import type { AgentRun, AgentStep } from "./agent-run-log";
import type { AgentBudget } from "./agent-runtime";
import type { PlanningAgentError, PlanningErrorCode } from "./planning-agent";
import type { ModelRequestOptions } from "./vision-client";
import type { ChatTurn, ProviderPreset } from "./vision-providers";

type AskModelTransport = (
  preset: ProviderPreset,
  prompt: string,
  image: string | null,
  history: ChatTurn[],
  onChunk: (chunk: string) => void,
  signal: AbortSignal,
  options?: ModelRequestOptions,
) => Promise<void>;

export interface PlanningRunToolStepV1 {
  name: string;
  input?: unknown;
  output?: unknown;
  status?: string;
}

export interface PlanningRunRoundV1 {
  prompt: string;
  response: string;
  tools: PlanningRunToolStepV1[];
}

export interface PlanningRunErrorV1 {
  code: PlanningErrorCode;
  phase?: string;
  message: string;
  needsInput: boolean;
}

export interface PlanningRunSampleV1 {
  schemaVersion: 1;
  kind: "planning-run";
  capturedAt: string;
  goal: string;
  archiveCounts: {
    persons: number;
    relations: number;
    events: number;
  };
  preset: {
    kind: ProviderPreset["kind"];
    name: string;
    model: string;
  };
  budget: AgentBudget | null;
  error?: PlanningRunErrorV1;
  run: {
    id: string;
    status: AgentRun["status"];
    rounds?: number;
    tokenUsage?: AgentRun["tokenUsage"];
  };
  rounds: PlanningRunRoundV1[];
}

function textValue(value: unknown, key: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" ? candidate : "";
}

function modelPrompt(step: AgentStep) {
  return textValue(step.input, "prompt");
}

function modelResponse(step: AgentStep) {
  const output = step.output;
  if (typeof output === "string") return output;
  return textValue(output, "response");
}

function toolStatus(step: AgentStep) {
  return step.status ?? (step.output !== undefined ? "completed" : "started");
}

export function createPlanningRunSample(input: {
  goal: string;
  archiveCounts: PlanningRunSampleV1["archiveCounts"];
  preset: ProviderPreset;
  run: AgentRun;
  budget?: AgentBudget | null;
  error?: PlanningAgentError | null;
}): PlanningRunSampleV1 {
  const rounds: PlanningRunRoundV1[] = [];
  for (const step of input.run.steps) {
    if (step.kind === "model") {
      rounds.push({
        prompt: modelPrompt(step),
        response: modelResponse(step),
        tools: [],
      });
      continue;
    }
    if (step.kind !== "tool" || !rounds.length) continue;
    const current = rounds.at(-1)!;
    current.tools.push({
      name: step.toolName ?? step.title ?? "unknown_tool",
      input: step.input,
      output: step.output,
      status: toolStatus(step),
    });
  }

  const error = input.error
    ? {
        code: input.error.code,
        phase: input.error.phase,
        message: input.error.message,
        needsInput: input.error.needsInput,
      }
    : undefined;

  return {
    schemaVersion: 1,
    kind: "planning-run",
    capturedAt: new Date().toISOString(),
    goal: input.goal,
    archiveCounts: input.archiveCounts,
    preset: {
      kind: input.preset.kind,
      name: input.preset.name,
      model: input.preset.model,
    },
    budget: input.budget ?? null,
    ...(error ? { error } : {}),
    run: {
      id: input.run.id,
      status: input.run.status,
      rounds: input.run.rounds,
      tokenUsage: input.run.tokenUsage,
    },
    rounds,
  };
}

export function parsePlanningRunSample(value: unknown): PlanningRunSampleV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("行动规划回放样本必须是 JSON 对象");
  }
  const parsed = value as Partial<PlanningRunSampleV1>;
  if (
    parsed.schemaVersion !== 1 ||
    parsed.kind !== "planning-run" ||
    typeof parsed.goal !== "string" ||
    !parsed.archiveCounts ||
    !parsed.preset ||
    !parsed.run ||
    !Array.isArray(parsed.rounds) ||
    parsed.rounds.some(
      (round) => typeof round.prompt !== "string" || typeof round.response !== "string",
    )
  ) {
    throw new Error("行动规划回放样本格式无效，只接受 schemaVersion=1 的 planning-run 样本");
  }
  return value as PlanningRunSampleV1;
}

export function recordedModelPrompts(sample: PlanningRunSampleV1) {
  return sample.rounds.map((round) => round.prompt);
}

export function recordedModelResponses(sample: PlanningRunSampleV1) {
  return sample.rounds.map((round) => round.response);
}

/** Feed an exported sample back through askModel in recorded order. */
export function createPlanningRunReplayTransport(sample: PlanningRunSampleV1): AskModelTransport {
  const responses = recordedModelResponses(sample);
  let index = 0;
  return async (_preset, _prompt, _image, _history, onChunk, _signal, _options) => {
    const response = responses[index] ?? "";
    index += 1;
    if (!response) throw new Error("回放样本缺少本轮模型回复");
    onChunk(response);
  };
}
