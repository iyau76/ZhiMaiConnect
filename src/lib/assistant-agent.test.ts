import { beforeEach, describe, expect, it, vi } from "vitest";

import { runAssistantAgent } from "./assistant-agent";

const { askModelMock } = vi.hoisted(() => ({ askModelMock: vi.fn() }));

vi.mock("./vision-client", () => ({ askModel: askModelMock }));

const preset = {
  id: "test",
  name: "测试模型",
  kind: "lovable" as const,
  baseUrl: "",
  model: "test-model",
  apiKey: "",
};

describe("assistant agent", () => {
  beforeEach(() => askModelMock.mockReset());

  it("runs a multi-round tool request and emits user-facing trace events", async () => {
    askModelMock
      .mockImplementationOnce(async (...args: unknown[]) => {
        const onChunk = args[4] as (chunk: string) => void;
        onChunk(
          JSON.stringify({
            type: "tool",
            summary: "先核对当前日期",
            tool: "get_datetime",
            args: { timeZone: "Asia/Shanghai" },
          }),
        );
      })
      .mockImplementationOnce(async (...args: unknown[]) => {
        const onChunk = args[4] as (chunk: string) => void;
        onChunk(
          JSON.stringify({
            type: "final",
            summary: "日期已经核对",
            answer: "今天的日期已经通过本地时间工具核对。",
          }),
        );
      });
    const trace: string[] = [];

    const result = await runAssistantAgent({
      preset,
      question: "今天几号？",
      persons: [],
      relations: [],
      events: [],
      includeArchive: false,
      onTrace: (event) => trace.push(event.text),
    });

    expect(result).toMatchObject({ rounds: 2, toolCalls: 1 });
    expect(result.answer).toContain("本地时间工具");
    expect(trace).toContain("核对日期时间完成");
    expect(trace.at(-1)).toContain("回答完成");
  });

  it("blocks local archive tools when the checkbox is not authorised", async () => {
    askModelMock
      .mockImplementationOnce(async (...args: unknown[]) => {
        const onChunk = args[4] as (chunk: string) => void;
        onChunk(
          JSON.stringify({
            type: "tool",
            summary: "尝试读取本机档案",
            tool: "search_profiles",
            args: { query: "摄影" },
          }),
        );
      })
      .mockImplementationOnce(async (...args: unknown[]) => {
        expect(String(args[1])).toContain("用户未授权本轮访问本机资料");
        const onChunk = args[4] as (chunk: string) => void;
        onChunk(
          JSON.stringify({
            type: "final",
            summary: "未读取本机资料",
            answer: "请先启用本机资料访问，或换成一般问题。",
          }),
        );
      });

    const result = await runAssistantAgent({
      preset,
      question: "谁会摄影？",
      persons: [],
      relations: [],
      events: [],
      includeArchive: false,
    });

    expect(result.answer).toContain("启用本机资料访问");
  });
});
