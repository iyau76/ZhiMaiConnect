import { describe, expect, it } from "vitest";

import type { LifeEventRecord } from "./face-db";
import type { FuzzyParse } from "./fuzzy-date";
import {
  eventSpan,
  formatFuzzy,
  fuzzyPrompt,
  isExact,
  normalizeFuzzy,
  parseFuzzyLocal,
  precisionOf,
  touchesMonth,
  yearOf,
} from "./fuzzy-date";

function event(overrides: Partial<LifeEventRecord> = {}): LifeEventRecord {
  return {
    id: "event-1",
    date: "2024-02-29",
    title: "一次见面",
    createdAt: 1,
    ...overrides,
  };
}

describe("fuzzy event spans", () => {
  it("treats legacy events without precision as exact days", () => {
    const row = event();
    expect(precisionOf(row)).toBe("day");
    expect(isExact(row)).toBe(true);
    expect(eventSpan(row)).toEqual({ start: "2024-02-29", end: "2024-02-29" });
  });

  it("expands month precision through the actual last day, including leap years", () => {
    expect(eventSpan(event({ date: "2024-02-01", precision: "month" }))).toEqual({
      start: "2024-02-01",
      end: "2024-02-29",
    });
    expect(eventSpan(event({ date: "2025-02-01", precision: "month" }))).toEqual({
      start: "2025-02-01",
      end: "2025-02-28",
    });
  });

  it("expands a year and preserves an explicit range", () => {
    expect(eventSpan(event({ date: "2023-01-01", precision: "year" }))).toEqual({
      start: "2023-01-01",
      end: "2023-12-31",
    });
    expect(
      eventSpan(event({ date: "2023-11-15", dateEnd: "2024-02-20", precision: "range" })),
    ).toEqual({ start: "2023-11-15", end: "2024-02-20" });
  });

  it("detects every month touched by a cross-year range", () => {
    const row = event({ date: "2023-11-15", dateEnd: "2024-02-20", precision: "range" });
    expect(touchesMonth(row, "2023-10")).toBe(false);
    expect(touchesMonth(row, "2023-11")).toBe(true);
    expect(touchesMonth(row, "2024-01")).toBe(true);
    expect(touchesMonth(row, "2024-02")).toBe(true);
    expect(touchesMonth(row, "2024-03")).toBe(false);
    expect(yearOf(row)).toBe("2023");
  });

  it.each([
    [event({ date: "2026-08-26" }), "2026 年 8 月 26 日"],
    [event({ date: "2026-08-01", precision: "month" }), "2026 年 8 月"],
    [event({ date: "2026-01-01", precision: "year" }), "2026 年"],
    [
      event({ date: "2025-11-01", dateEnd: "2026-02-28", precision: "range" }),
      "2025 年 11 月 — 2026 年 2 月 28 日",
    ],
  ])("formats fuzzy event labels", (row, expected) => {
    expect(formatFuzzy(row)).toBe(expected);
  });
});

describe("parseFuzzyLocal", () => {
  const now = new Date(2026, 7, 26, 12);

  it.each([
    ["2024 年 5 月左右", { date: "2024-05-01", precision: "month" }],
    ["去年十二月", { date: "2025-12-01", precision: "month" }],
    ["前年", { date: "2024-01-01", precision: "year" }],
    ["三年前", { date: "2023-01-01", precision: "year" }],
    ["十一年前", { date: "2015-01-01", precision: "year" }],
    ["2019 到 2021", { date: "2019-01-01", dateEnd: "2021-12-31", precision: "range" }],
    ["去年暑假", { date: "2025-07-01", dateEnd: "2025-08-31", precision: "range" }],
    ["2027 年冬天", { date: "2027-12-01", dateEnd: "2028-02-29", precision: "range" }],
    ["上个月", { date: "2026-07-01", precision: "month" }],
    ["十个月前", { date: "2025-10-01", precision: "month" }],
    ["十一个月前", { date: "2025-09-01", precision: "month" }],
    ["明年三月", { date: "2027-03-01", precision: "month" }],
    ["明年春节", { date: "2027-02-06", precision: "day" }],
    ["明年除夕", { date: "2027-02-05", precision: "day" }],
  ])("parses %s", (input, expected) => {
    expect(parseFuzzyLocal(input, now)).toEqual(expected);
  });

  it("uses the most recent occurrence when a month has no explicit year", () => {
    expect(parseFuzzyLocal("12 月", now)).toEqual({ date: "2025-12-01", precision: "month" });
    expect(parseFuzzyLocal("7 月", now)).toEqual({ date: "2026-07-01", precision: "month" });
  });

  it("uses the narrower configured season for 开春", () => {
    expect(parseFuzzyLocal("去年开春", now)).toEqual({
      date: "2025-03-01",
      dateEnd: "2025-04-30",
      precision: "range",
    });
  });

  it.each(["", "   ", "记不清了"])(
    "returns null when local parsing has no evidence: %s",
    (input) => {
      expect(parseFuzzyLocal(input, now)).toBeNull();
    },
  );
});

describe("AI fuzzy-date normalization", () => {
  it("normalizes supported precisions and drops dateEnd outside a range", () => {
    expect(normalizeFuzzy({ date: "2026-08-26", precision: "day", dateEnd: "2026-09-01" })).toEqual(
      {
        date: "2026-08-26",
        dateEnd: undefined,
        precision: "day",
      },
    );
  });

  it("falls back to year for an unknown precision", () => {
    expect(normalizeFuzzy({ date: "2026-01-01", precision: "unknown" as never })).toEqual({
      date: "2026-01-01",
      dateEnd: undefined,
      precision: "year",
    });
  });

  it("downgrades an incomplete range to month precision", () => {
    expect(normalizeFuzzy({ date: "2026-08-01", precision: "range" })).toEqual({
      date: "2026-08-01",
      precision: "month",
    });
  });

  it.each([null, {}, { date: "2026-8-1", precision: "month" }])(
    "rejects malformed AI output",
    (raw) => {
      expect(normalizeFuzzy(raw as Partial<FuzzyParse> | null)).toBeNull();
    },
  );

  it("builds a deterministic JSON-only prompt with the reference date", () => {
    const prompt = fuzzyPrompt("去年冬天", new Date("2026-08-26T12:00:00.000Z"));
    expect(prompt).toContain("只输出 JSON");
    expect(prompt).toContain("今天是 2026-08-26");
    expect(prompt).toContain("用户描述：去年冬天");
  });

  it("rejects impossible calendar dates and reversed ranges returned by AI", () => {
    expect(normalizeFuzzy({ date: "2026-02-30", precision: "day" })).toBeNull();
    expect(
      normalizeFuzzy({ date: "2026-08-01", dateEnd: "2026-07-31", precision: "range" }),
    ).toBeNull();
    expect(
      normalizeFuzzy({ date: "2026-08-01", dateEnd: "2026-13-01", precision: "range" }),
    ).toBeNull();
  });
});
