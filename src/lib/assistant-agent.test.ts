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

  it("returns a person update proposal without writing anything", async () => {
    askModelMock.mockImplementationOnce(async (...args: unknown[]) => {
      const onChunk = args[4] as (chunk: string) => void;
      onChunk(
        JSON.stringify({
          type: "tool",
          summary: "准备更新职位",
          tool: "update_person",
          args: {
            personId: "person-1",
            reason: "用户明确说职位变更",
            changes: { title: "品牌总监" },
          },
        }),
      );
    });
    const person = {
      id: "person-1",
      name: "小雨",
      note: "",
      profile: { title: "品牌经理" },
      descriptors: [],
      thumb: "",
      createdAt: 10,
    };

    const result = await runAssistantAgent({
      preset,
      question: "把小雨的职位改成品牌总监",
      persons: [person],
      relations: [],
      events: [],
      includeArchive: true,
    });

    expect(result.pendingApproval).toMatchObject({
      personId: "person-1",
      changes: { profile: { title: "品牌总监" } },
    });
    expect(result.answer).toContain("尚未执行");
    expect(person.profile.title).toBe("品牌经理");
  });

  it("returns a relation update proposal that still requires user approval", async () => {
    askModelMock.mockImplementationOnce(async (...args: unknown[]) => {
      (args[4] as (chunk: string) => void)(
        JSON.stringify({
          type: "tool",
          tool: "update_relation",
          args: {
            relationId: "r1",
            reason: "用户纠正关系",
            changes: { label: "前同事", basis: "原文：两人已经离职" },
          },
        }),
      );
    });
    const persons = [
      { id: "p1", name: "甲", note: "", descriptors: [], thumb: "", createdAt: 1 },
      { id: "p2", name: "乙", note: "", descriptors: [], thumb: "", createdAt: 1 },
    ];
    const relations = [{ id: "r1", fromId: "p1", toId: "p2", label: "同事", createdAt: 1 }];
    const result = await runAssistantAgent({
      preset,
      question: "把甲乙的关系改成前同事",
      persons,
      relations,
      events: [],
      includeArchive: true,
    });
    expect(result.pendingApproval).toMatchObject({
      tool: "update_relation",
      relationId: "r1",
      changes: { label: "前同事" },
    });
    expect(relations[0].label).toBe("同事");
  });

  it("does not treat one empty keyword search as proof that the archive has no record", async () => {
    askModelMock
      .mockImplementationOnce(async (...args: unknown[]) => {
        (args[4] as (chunk: string) => void)(
          JSON.stringify({
            type: "tool",
            tool: "search_profiles",
            args: { query: "拍照" },
          }),
        );
      })
      .mockImplementationOnce(async (...args: unknown[]) => {
        (args[4] as (chunk: string) => void)(
          JSON.stringify({
            type: "final",
            answer: "当前本地人物档案中没有与拍照直接关联的记录。",
          }),
        );
      })
      .mockImplementationOnce(async (...args: unknown[]) => {
        expect(String(args[1])).toContain("一次关键词检索为空不能证明");
        (args[4] as (chunk: string) => void)(
          JSON.stringify({ type: "tool", tool: "list_profiles", args: { limit: 12 } }),
        );
      })
      .mockImplementationOnce(async (...args: unknown[]) => {
        (args[4] as (chunk: string) => void)(
          JSON.stringify({ type: "final", answer: "索引中有小雨，建议再查看她的详细档案。" }),
        );
      });

    const result = await runAssistantAgent({
      preset,
      question: "谁会拍照？",
      persons: [
        {
          id: "p1",
          name: "小雨",
          note: "喜欢摄影",
          descriptors: [],
          thumb: "",
          createdAt: 1,
        },
      ],
      relations: [],
      events: [],
      includeArchive: true,
    });

    expect(result.rounds).toBe(4);
    expect(result.answer).toContain("小雨");
  });
});
