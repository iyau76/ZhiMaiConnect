import { beforeEach, describe, expect, it, vi } from "vitest";

const askModelMock = vi.hoisted(() => vi.fn());
vi.mock("./vision-client", () => ({ askModel: askModelMock }));

import { PlanningAgentError, runPlanningAgent } from "./planning-agent";
import {
  createPlanningRunReplayTransport,
  createPlanningRunSample,
  parsePlanningRunSample,
  recordedModelResponses,
} from "./planning-run-replay";

const preset = {
  id: "replay-preset",
  name: "回放测试模型",
  kind: "openai" as const,
  baseUrl: "https://api.example.com/v1",
  model: "replay-model",
  apiKey: "test-key",
};

const EMPTY_ARCHIVE = { persons: [], relations: [], events: [] };
const BUDGET = {
  maxRounds: 1,
  maxToolCalls: 2,
  maxInputTokens: 10_000,
  maxOutputTokens: 4_000,
  maxWallTimeMs: 60_000,
};

function reply(value: unknown) {
  return async (...args: unknown[]) => {
    (args[4] as (chunk: string) => void)(typeof value === "string" ? value : JSON.stringify(value));
  };
}

async function captureFailure(response: unknown, goal: string) {
  askModelMock.mockImplementation(reply(response));
  try {
    await runPlanningAgent({
      preset,
      goal,
      archive: EMPTY_ARCHIVE,
      budget: BUDGET,
    });
  } catch (error) {
    if (error instanceof PlanningAgentError && error.run) return error;
  }
  throw new Error(`预期失败样本：${goal}`);
}

function sampleFrom(error: PlanningAgentError, goal: string) {
  return createPlanningRunSample({
    goal,
    archiveCounts: { persons: 0, relations: 0, events: 0 },
    preset,
    budget: error.budget,
    run: error.run!,
    error,
  });
}

describe("planning run replay samples", () => {
  beforeEach(() => {
    askModelMock.mockReset();
  });

  it("exports a final-parse failure and replays the same transcript to the same error code", async () => {
    const error = await captureFailure("这不是 JSON", "触发最终轮解析失败");
    const sample = sampleFrom(error, "触发最终轮解析失败");

    expect(sample.schemaVersion).toBe(1);
    expect(sample.error).toMatchObject({ code: "final_parse" });
    expect(sample.rounds).toHaveLength(1);
    expect(sample.rounds[0].response).toContain("这不是 JSON");
    expect(sample.run.status).toBe("failed");

    const parsed = parsePlanningRunSample(JSON.parse(JSON.stringify(sample)));
    expect(parsed.error?.code).toBe("final_parse");
    expect(recordedModelResponses(parsed)).toEqual(["这不是 JSON"]);

    askModelMock.mockReset();
    askModelMock.mockImplementation(createPlanningRunReplayTransport(parsed));
    await expect(
      runPlanningAgent({
        preset,
        goal: "触发最终轮解析失败",
        archive: EMPTY_ARCHIVE,
        budget: BUDGET,
      }),
    ).rejects.toMatchObject({ code: "final_parse" });
  });

  it("exports a final-tool failure with prompt and response preserved", async () => {
    const toolResponse = {
      type: "tool",
      summary: "仍要读取日期",
      tool: "get_datetime",
      args: {},
    };
    const error = await captureFailure(toolResponse, "触发最终轮请求工具");
    const sample = sampleFrom(error, "触发最终轮请求工具");

    expect(sample.error?.code).toBe("final_tool");
    expect(sample.rounds[0].prompt).toContain("保留的最终草案轮");
    expect(JSON.parse(sample.rounds[0].response)).toMatchObject({ type: "tool" });
  });

  it("loads a no-draft sample through the v1 parser even when the agent loop is strict", async () => {
    const run = await captureFailure("这不是 JSON", "仅用于生成运行记录").then((error) => error);
    const noDraft = new PlanningAgentError({
      code: "no_draft",
      message: "预算内没有形成草案",
      phase: "final",
      needsInput: true,
      run: run.run,
      budget: run.budget,
    });
    const sample = sampleFrom(noDraft, "预算内没有形成草案");
    expect(sample.error?.code).toBe("no_draft");
    expect(sample.error?.needsInput).toBe(true);
    expect(parsePlanningRunSample(sample).goal).toBe("预算内没有形成草案");
  });
});
