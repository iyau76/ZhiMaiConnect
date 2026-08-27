import { beforeEach, describe, expect, it, vi } from "vitest";

import { runIntakeAgent } from "./intake-agent";

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
});
