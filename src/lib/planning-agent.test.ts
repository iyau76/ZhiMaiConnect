import { beforeEach, describe, expect, it, vi } from "vitest";

import { MemoryAgentRunRecorder } from "./agent-run-log";
import type { PersonRecord } from "./face-db";

const askModelMock = vi.hoisted(() => vi.fn());
vi.mock("./vision-client", () => ({ askModel: askModelMock }));

import { runPlanningAgent, type PlanningTraceEvent } from "./planning-agent";

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

  it("uses the shared tool scope, reuses duplicate reads and softens invalid references", async () => {
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
      .mockImplementationOnce(
        replyWith({
          type: "final",
          summary: "形成活动准备计划",
          tasks: [
            {
              title: "联系唐悦确认拍摄清单",
              detail: "确认交付范围",
              priority: "high",
              due: "下周三",
              personIds: ["person-photographer", "invented-person"],
            },
          ],
        }),
      );

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
        personIds: ["person-photographer"],
      },
    ]);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("无效人物引用"),
        expect.stringContaining("日期格式无效"),
      ]),
    );
    expect(result.run.status).toBe("completed");
    expect(trace).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "check", text: expect.stringContaining("重复读取") }),
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
            personIds: [],
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

  it("does not bind a person ID that was never disclosed by a tool result", async () => {
    askModelMock.mockImplementationOnce(
      replyWith({
        type: "final",
        tasks: [
          {
            title: "确认活动参与人",
            priority: "normal",
            personIds: [photographer.id],
          },
        ],
      }),
    );

    const result = await runPlanningAgent({
      preset,
      goal: "安排活动参与人",
      archive: { persons: [photographer], relations: [], events: [] },
    });

    expect(result.tasks[0].personIds).toEqual([]);
    expect(result.warnings).toEqual([expect.stringContaining("已移除 1 个无效人物引用")]);
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
                personIds: [],
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
});
