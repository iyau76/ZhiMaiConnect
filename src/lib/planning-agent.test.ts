import { beforeEach, describe, expect, it, vi } from "vitest";

import { MemoryAgentRunRecorder } from "./agent-run-log";
import type { PersonRecord } from "./face-db";

const askModelMock = vi.hoisted(() => vi.fn());
vi.mock("./vision-client", () => ({ askModel: askModelMock }));

import { PlanningContractError, runPlanningAgent, type PlanningTraceEvent } from "./planning-agent";

const preset = {
  id: "planner-test",
  name: "测试模型",
  kind: "openai" as const,
  baseUrl: "https://api.example.com/v1",
  model: "test-model",
  apiKey: "test-key",
};

const photographer: PersonRecord = {
  id: "person-photographer",
  name: "唐悦",
  note: "愿意帮校园记忆展拍摄",
  descriptors: [],
  thumb: "",
  profile: { title: "摄影师", contact: "13800138000", likes: ["人像摄影"] },
  createdAt: 1,
};

function replyWith(value: unknown) {
  return async (...args: unknown[]) => {
    (args[4] as (chunk: string) => void)(typeof value === "string" ? value : JSON.stringify(value));
  };
}

describe("planning agent", () => {
  beforeEach(() => {
    askModelMock.mockReset();
  });

  it("uses the shared tool scope and reinjects a duplicate read from the result cache", async () => {
    askModelMock
      .mockImplementationOnce(async (...args: unknown[]) => {
        const prompt = String(args[1]);
        expect(prompt).toContain('"persons":1');
        expect(prompt).toContain("search_profiles");
        expect(prompt).not.toContain("search_web");
        expect(prompt).not.toContain("13800138000");
        expect(prompt).not.toContain("愿意帮校园记忆展拍摄");
        (args[4] as (chunk: string) => void)(
          JSON.stringify({
            type: "tool",
            summary: "查找摄影相关人物",
            tool: "search_profiles",
            args: { query: "摄影", limit: 8 },
          }),
        );
      })
      .mockImplementationOnce(
        replyWith({
          type: "tool",
          summary: "再次查看相同结果",
          tool: "search_profiles",
          args: { query: "摄影", limit: 8 },
        }),
      )
      .mockImplementationOnce(async (...args: unknown[]) => {
        const prompt = String(args[1]);
        expect(prompt).toMatch(/"personRef":"ref_[a-f0-9]{32}"/u);
        expect(prompt).not.toContain("already_available");
        (args[4] as (chunk: string) => void)(
          JSON.stringify({
            type: "final",
            summary: "形成活动准备计划",
            tasks: [
              {
                title: "联系唐悦确认拍摄清单",
                detail: "确认交付范围",
                priority: "high",
                due: "2026-09-08",
                people: [{ kind: "person", name: "唐悦", hints: { title: "摄影师" } }],
              },
            ],
          }),
        );
      });

    const trace: PlanningTraceEvent[] = [];
    const result = await runPlanningAgent({
      preset,
      goal: "筹备校园记忆展开幕活动",
      archive: { persons: [photographer], relations: [], events: [] },
      onTrace: (event) => trace.push(event),
    });

    expect(result).toMatchObject({ rounds: 3, toolCalls: 1, summary: "形成活动准备计划" });
    expect(result.tasks).toEqual([
      {
        title: "联系唐悦确认拍摄清单",
        detail: "确认交付范围",
        priority: "high",
        due: "2026-09-08",
        personIds: ["person-photographer"],
      },
    ]);
    expect(result.warnings).toEqual([]);
    expect(result.issues).toEqual([]);
    expect(result.run.status).toBe("completed");
    expect(trace).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "check", text: expect.stringContaining("完整缓存结果") }),
        expect.objectContaining({ kind: "done", text: expect.stringContaining("等待用户批准") }),
      ]),
    );
  });

  it("recovers a malformed response without discarding the user goal", async () => {
    askModelMock.mockImplementationOnce(replyWith("这不是 JSON")).mockImplementationOnce(
      replyWith({
        type: "final",
        tasks: [
          {
            title: "列出活动必须交付的三项结果",
            detail: "先明确范围，再决定找谁参与",
            priority: "normal",
            people: [],
          },
        ],
      }),
    );

    const result = await runPlanningAgent({
      preset,
      goal: "先把活动目标理清楚",
      archive: { persons: [], relations: [], events: [] },
    });

    expect(result.rounds).toBe(2);
    expect(result.tasks[0].title).toBe("列出活动必须交付的三项结果");
    expect(askModelMock.mock.calls[1][1]).toContain("先把活动目标理清楚");
    expect(askModelMock.mock.calls[1][1]).toContain("上一轮没有返回可解析的协议对象");
  });

  it("strictly rejects extra response-envelope fields and corrects once", async () => {
    askModelMock
      .mockImplementationOnce(
        replyWith({
          type: "final",
          debug: "legacy wrapper field",
          tasks: [
            {
              title: "确认活动范围",
              priority: "normal",
              people: [],
            },
          ],
        }),
      )
      .mockImplementationOnce(async (...args: unknown[]) => {
        const prompt = String(args[1]);
        expect(prompt).toContain("invalid_envelope");
        expect(prompt).toContain("planning.response.v2");
        (args[4] as (chunk: string) => void)(
          JSON.stringify({
            type: "final",
            tasks: [
              {
                title: "确认活动范围",
                priority: "normal",
                people: [],
              },
            ],
          }),
        );
      });

    const result = await runPlanningAgent({
      preset,
      goal: "安排活动",
      archive: { persons: [], relations: [], events: [] },
      budget: {
        maxRounds: 2,
        maxToolCalls: 2,
        maxInputTokens: 10_000,
        maxOutputTokens: 4_000,
        maxWallTimeMs: 60_000,
      },
    });

    expect(result.tasks).toHaveLength(1);
    expect(result.warnings).toEqual([expect.stringContaining("planning.response.v2")]);
  });

  it("rejects an undisclosed person binding instead of silently dropping it", async () => {
    askModelMock.mockImplementationOnce(
      replyWith({
        type: "final",
        tasks: [
          {
            title: "确认活动参与人",
            priority: "normal",
            people: [{ kind: "person", name: "唐悦" }],
          },
        ],
      }),
    );

    const recorder = new MemoryAgentRunRecorder({ runId: "planning-undisclosed" });
    const promise = runPlanningAgent({
      preset,
      goal: "安排活动参与人",
      archive: { persons: [photographer], relations: [], events: [] },
      recorder,
      budget: {
        maxRounds: 1,
        maxToolCalls: 2,
        maxInputTokens: 10_000,
        maxOutputTokens: 4_000,
        maxWallTimeMs: 60_000,
      },
    });

    await expect(promise).rejects.toMatchObject({
      name: "PlanningContractError",
      issues: [expect.objectContaining({ code: "undisclosed_person_reference" })],
    });
    expect(recorder.events()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "validation",
          status: "failed",
          issueCategory: "contract",
        }),
      ]),
    );
  });

  it("preserves valid sibling tasks and asks for only the invalid legacy-ID task to be corrected", async () => {
    const leakedId = "8de3dfd3-feb1-4e38-a493-3c8f606c70ce";
    const recorder = new MemoryAgentRunRecorder({ runId: "planning-mixed-contract" });
    askModelMock
      .mockImplementationOnce(
        replyWith({
          type: "final",
          summary: "先生成两项",
          tasks: [
            {
              title: "列出活动交付清单",
              detail: "明确照片、海报和复盘材料",
              priority: "high",
              people: [],
            },
            {
              title: "联系摄影负责人",
              priority: "normal",
              people: [],
              personIds: [leakedId],
            },
          ],
        }),
      )
      .mockImplementationOnce(async (...args: unknown[]) => {
        const prompt = String(args[1]);
        expect(prompt).toContain("planning.response.v2");
        expect(prompt).toContain("已经合格的任务由本地保留");
        expect(prompt).toContain("列出活动交付清单");
        expect(prompt).toContain("personIds");
        expect(prompt).not.toContain(leakedId);
        (args[4] as (chunk: string) => void)(
          JSON.stringify({
            type: "final",
            summary: "已修正",
            tasks: [
              {
                title: "确认摄影负责人",
                detail: "请用户确认由谁负责，再绑定人物档案",
                priority: "normal",
                people: [],
              },
            ],
          }),
        );
      });

    const result = await runPlanningAgent({
      preset,
      goal: "筹备活动",
      archive: { persons: [], relations: [], events: [] },
      recorder,
      budget: {
        maxRounds: 2,
        maxToolCalls: 2,
        maxInputTokens: 20_000,
        maxOutputTokens: 6_000,
        maxWallTimeMs: 60_000,
      },
    });

    expect(result.tasks.map((task) => task.title)).toEqual(["列出活动交付清单", "确认摄影负责人"]);
    expect(result.issues).toEqual([]);
    expect(result.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining("旧协议字段 personIds")]),
    );
    const validation = recorder.events().find((event) => event.kind === "validation");
    expect(validation).toMatchObject({ status: "failed", issueCategory: "contract" });
    expect(validation?.payload).toMatchObject({
      contract: "planning.response.v2",
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "legacy_identifier", taskIndex: 1 }),
      ]),
    });
  });

  it("rejects an all-invalid raw-ID response after one final round without entering a loop", async () => {
    const leakedId = "8de3dfd3-feb1-4e38-a493-3c8f606c70ce";
    askModelMock.mockImplementationOnce(
      replyWith({
        type: "final",
        tasks: [
          {
            title: "联系摄影负责人",
            priority: "high",
            people: [leakedId],
            personIds: [leakedId],
          },
        ],
      }),
    );

    const error = await runPlanningAgent({
      preset,
      goal: "安排摄影",
      archive: { persons: [photographer], relations: [], events: [] },
      budget: {
        maxRounds: 1,
        maxToolCalls: 2,
        maxInputTokens: 10_000,
        maxOutputTokens: 4_000,
        maxWallTimeMs: 60_000,
      },
    }).catch((caught) => caught);

    expect(error).toBeInstanceOf(PlanningContractError);
    expect(error).toMatchObject({
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "legacy_identifier", taskIndex: 0 }),
        expect.objectContaining({
          code: "legacy_identifier",
          path: ["tasks", 0, "people", 0],
        }),
      ]),
    });
    expect(askModelMock).toHaveBeenCalledTimes(1);
  });

  it("accepts a disclosed opaque person ref and restores it only after validation", async () => {
    askModelMock
      .mockImplementationOnce(
        replyWith({
          type: "tool",
          tool: "search_profiles",
          args: { query: "摄影", limit: 8 },
        }),
      )
      .mockImplementationOnce(async (...args: unknown[]) => {
        const prompt = String(args[1]);
        const personRef = prompt.match(/"personRef":"(ref_[a-f0-9]{32})"/u)?.[1];
        expect(personRef).toBeTruthy();
        (args[4] as (chunk: string) => void)(
          JSON.stringify({
            type: "final",
            tasks: [
              {
                title: "联系唐悦确认拍摄范围",
                priority: "high",
                people: [personRef],
              },
            ],
          }),
        );
      });

    const result = await runPlanningAgent({
      preset,
      goal: "安排摄影",
      archive: { persons: [photographer], relations: [], events: [] },
    });

    expect(result.tasks[0]?.personIds).toEqual([photographer.id]);
  });

  it("turns the last available round into a final-answer round", async () => {
    askModelMock
      .mockImplementationOnce(
        replyWith({
          type: "tool",
          summary: "先确认当前日期",
          tool: "get_datetime",
          args: {},
        }),
      )
      .mockImplementationOnce(async (...args: unknown[]) => {
        const prompt = String(args[1]);
        expect(prompt).toContain("保留的最终草案轮");
        expect(prompt).not.toContain('"type":"tool"');
        expect(prompt).not.toContain("search_profiles");
        (args[4] as (chunk: string) => void)(
          JSON.stringify({
            type: "final",
            summary: "形成可执行草案",
            tasks: [
              {
                title: "确认活动范围和截止时间",
                detail: "已有日期信息；参与人仍待用户确认",
                priority: "normal",
                people: [],
              },
            ],
          }),
        );
      });

    const result = await runPlanningAgent({
      preset,
      goal: "安排一次活动",
      archive: { persons: [], relations: [], events: [] },
      budget: {
        maxRounds: 2,
        maxToolCalls: 2,
        maxInputTokens: 10_000,
        maxOutputTokens: 4_000,
        maxWallTimeMs: 60_000,
      },
    });

    expect(result).toMatchObject({ rounds: 2, toolCalls: 1, summary: "形成可执行草案" });
  });

  it("does not execute a tool returned during the reserved final round", async () => {
    askModelMock.mockImplementationOnce(
      replyWith({
        type: "tool",
        summary: "仍想查询日期",
        tool: "get_datetime",
        args: {},
      }),
    );
    const recorder = new MemoryAgentRunRecorder({ runId: "planning-final-only" });

    await expect(
      runPlanningAgent({
        preset,
        goal: "安排一次活动",
        archive: { persons: [], relations: [], events: [] },
        recorder,
        budget: {
          maxRounds: 1,
          maxToolCalls: 2,
          maxInputTokens: 10_000,
          maxOutputTokens: 4_000,
          maxWallTimeMs: 60_000,
        },
      }),
    ).rejects.toThrow("最终草案轮仍请求工具");
    expect(askModelMock).toHaveBeenCalledTimes(1);
    expect(recorder.events().filter((event) => event.kind === "tool_call")).toHaveLength(0);
  });

  it("resolves a person at the tail of 500 records without exposing the database id", async () => {
    const targetId = "8de3dfd3-feb1-4e38-a493-3c8f606c70ce";
    const persons: PersonRecord[] = Array.from({ length: 499 }, (_, index) => ({
      id: `filler-${index + 1}`,
      name: `占位人物${index + 1}`,
      note: "",
      descriptors: [],
      thumb: "",
      createdAt: index + 1,
    }));
    persons.push({
      id: targetId,
      name: "林柚",
      note: "校园记忆展摄影师",
      descriptors: [],
      thumb: "",
      createdAt: 500,
    });
    const modelOutputs: string[] = [];
    askModelMock
      .mockImplementationOnce(async (...args: unknown[]) => {
        const prompt = String(args[1]);
        expect(prompt).not.toContain(targetId);
        const output = JSON.stringify({
          type: "tool",
          tool: "search_profiles",
          args: { query: "林柚 摄影师", limit: 8 },
        });
        modelOutputs.push(output);
        (args[4] as (chunk: string) => void)(output);
      })
      .mockImplementationOnce(async (...args: unknown[]) => {
        const prompt = String(args[1]);
        expect(prompt).toContain("林柚");
        expect(prompt).toMatch(/"personRef":"ref_[a-f0-9]{32}"/u);
        expect(prompt).not.toContain(targetId);
        const output = JSON.stringify({
          type: "final",
          summary: "已形成拍摄确认计划",
          tasks: [
            {
              title: "联系林柚确认拍摄交付",
              priority: "high",
              people: [{ kind: "person", name: "林柚" }],
            },
          ],
        });
        modelOutputs.push(output);
        (args[4] as (chunk: string) => void)(output);
      });

    const result = await runPlanningAgent({
      preset,
      goal: "请安排林柚确认校园记忆展摄影交付",
      archive: { persons, relations: [], events: [] },
    });

    expect(result.tasks[0]?.personIds).toEqual([targetId]);
    expect(modelOutputs.join("\n")).not.toContain(targetId);
    expect(modelOutputs.join("\n")).not.toContain("personIds");
  });
});
