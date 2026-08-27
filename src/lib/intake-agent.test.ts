import { beforeEach, describe, expect, it, vi } from "vitest";

import { runIntakeAgent, serializeIntakeHistory } from "./intake-agent";

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

describe("intake agent", () => {
  beforeEach(() => askModelMock.mockReset());

  it("searches an event and stages an update without writing it", async () => {
    askModelMock
      .mockImplementationOnce(async (...args: unknown[]) => {
        (args[4] as (chunk: string) => void)(
          JSON.stringify({
            type: "tool",
            tool: "search_events",
            args: { query: "聚餐" },
          }),
        );
      })
      .mockImplementationOnce(async (...args: unknown[]) => {
        expect(String(args[1])).toContain("event-1");
        (args[4] as (chunk: string) => void)(
          JSON.stringify({
            type: "tool",
            tool: "stage_event_update",
            args: { eventId: "event-1", changes: { date: "2026-09-02" } },
          }),
        );
      })
      .mockImplementationOnce(async (...args: unknown[]) => {
        (args[4] as (chunk: string) => void)(
          JSON.stringify({ type: "final", draft: { summary: "日期已更正" } }),
        );
      });
    const original = {
      id: "event-1",
      title: "团队聚餐",
      date: "2026-09-01",
      precision: "day" as const,
      createdAt: 1,
    };

    const result = await runIntakeAgent({
      preset,
      extractionPrompt: "把日期改到 9 月 2 日",
      persons: [],
      events: [original],
      includeArchive: true,
    });

    expect(result.events?.[0]).toMatchObject({
      targetEventId: "event-1",
      title: "团队聚餐",
      date: "2026-09-02",
    });
    expect(original.date).toBe("2026-09-01");
  });

  it("treats relations as first-class archive records and stages an update", async () => {
    askModelMock
      .mockImplementationOnce(async (...args: unknown[]) => {
        (args[4] as (chunk: string) => void)(
          JSON.stringify({ type: "tool", tool: "get_profile", args: { personId: "p1" } }),
        );
      })
      .mockImplementationOnce(async (...args: unknown[]) => {
        expect(String(args[1])).toContain("同事");
        (args[4] as (chunk: string) => void)(
          JSON.stringify({
            type: "tool",
            tool: "stage_relation_update",
            args: {
              relationId: "r1",
              changes: { label: "前同事", basis: "原文：两人已经不在同一家公司" },
            },
          }),
        );
      })
      .mockImplementationOnce(async (...args: unknown[]) => {
        (args[4] as (chunk: string) => void)(
          JSON.stringify({
            type: "final",
            draft: {
              summary: "关系已更正",
              relations: [
                {
                  from: "唐悦",
                  to: "周宁",
                  label: "前同事",
                  basis: "原文：两人已经不在同一家公司",
                },
              ],
            },
          }),
        );
      });
    const persons = [
      { id: "p1", name: "唐悦", note: "", descriptors: [], thumb: "", createdAt: 1 },
      { id: "p2", name: "周宁", note: "", descriptors: [], thumb: "", createdAt: 1 },
    ];
    const relations = [
      {
        id: "r1",
        fromId: "p1",
        toId: "p2",
        label: "同事",
        basis: "原文：两人同事",
        createdAt: 1,
      },
    ];
    const result = await runIntakeAgent({
      preset,
      extractionPrompt: "他们现在是前同事",
      persons,
      events: [],
      relations,
      includeArchive: true,
    });
    expect(result.relations).toEqual([
      expect.objectContaining({ targetRelationId: "r1", label: "前同事" }),
    ]);
  });

  it("executes a bounded batch of independent read tools in one model round", async () => {
    askModelMock
      .mockImplementationOnce(async (...args: unknown[]) => {
        (args[4] as (chunk: string) => void)(
          JSON.stringify({
            type: "tools",
            calls: [
              { tool: "get_profile", args: { personId: "p1" } },
              { tool: "get_relation", args: { relationId: "r1" } },
            ],
          }),
        );
      })
      .mockImplementationOnce(async (...args: unknown[]) => {
        const prompt = String(args[1]);
        expect(prompt).toContain("甲");
        expect(prompt).toContain("同事");
        (args[4] as (chunk: string) => void)(
          JSON.stringify({ type: "final", draft: { summary: "核对完成" } }),
        );
      });
    const persons = [
      { id: "p1", name: "甲", note: "", descriptors: [], thumb: "", createdAt: 1 },
      { id: "p2", name: "乙", note: "", descriptors: [], thumb: "", createdAt: 1 },
    ];
    const result = await runIntakeAgent({
      preset,
      extractionPrompt: "核对甲乙关系",
      persons,
      events: [],
      relations: [{ id: "r1", fromId: "p1", toId: "p2", label: "同事", createdAt: 1 }],
      includeArchive: true,
    });
    expect(result.summary).toBe("核对完成");
    expect(askModelMock).toHaveBeenCalledTimes(2);
  });

  it("asks the model to repair schema-valid JSON that violates relation evidence rules", async () => {
    askModelMock
      .mockImplementationOnce(async (...args: unknown[]) => {
        (args[4] as (chunk: string) => void)(
          JSON.stringify({
            type: "final",
            draft: { relations: [{ from: "甲", to: "乙", label: "同事" }] },
          }),
        );
      })
      .mockImplementationOnce(async (...args: unknown[]) => {
        expect(String(args[1])).toContain("缺少 basis");
        (args[4] as (chunk: string) => void)(
          JSON.stringify({
            type: "final",
            draft: {
              relations: [{ from: "甲", to: "乙", label: "同事", basis: "原文：甲和乙是同事" }],
            },
          }),
        );
      });
    const result = await runIntakeAgent({
      preset,
      extractionPrompt: "甲和乙是同事",
      persons: [],
      events: [],
      includeArchive: false,
    });
    expect(result.relations?.[0].basis).toBe("原文：甲和乙是同事");
  });

  it("serializes only complete tool-history entries", () => {
    const history = Array.from({ length: 20 }, (_, index) => ({
      call: { index },
      result: { text: "x".repeat(100) },
    }));
    const serialized = serializeIntakeHistory(history, 500);
    expect(() => JSON.parse(serialized)).not.toThrow();
    expect(JSON.parse(serialized).length).toBeGreaterThan(0);
    expect(serialized.length).toBeLessThanOrEqual(500);
  });
});
