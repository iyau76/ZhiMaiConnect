import { afterEach, describe, expect, it, vi } from "vitest";

import type { PersonRecord } from "./face-db";
import {
  FESTIVALS,
  birthdayMd,
  blessingPrompt,
  daysUntilMd,
  festivalsForYear,
  lunarDateLabel,
  pad,
  todayStr,
  upcoming,
} from "./personal";

function person(overrides: Partial<PersonRecord> = {}): PersonRecord {
  return {
    id: "person-1",
    name: "林晓",
    note: "大学同学",
    descriptors: [],
    thumb: "",
    createdAt: 1,
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("personal date helpers", () => {
  it("pads single digit values and formats a local calendar date", () => {
    expect(pad(7)).toBe("07");
    expect(pad(12)).toBe("12");
    expect(todayStr(new Date(2026, 7, 6, 23, 59))).toBe("2026-08-06");
  });

  it.each([
    ["7-9", "07-09"],
    ["07/09", "07-09"],
    ["7月9日", "07-09"],
    ["07.09", "07-09"],
    ["1998-07-09", "07-09"],
  ])("extracts the month and day from %s", (raw, expected) => {
    expect(birthdayMd(raw)).toBe(expected);
  });

  it.each([undefined, "", "七月九日", "not-a-date"])(
    "rejects an unsupported birthday value: %s",
    (raw) => {
      expect(birthdayMd(raw)).toBeNull();
    },
  );

  it("counts today as zero and rolls a past month-day into the next year", () => {
    expect(daysUntilMd("08-26", new Date(2026, 7, 26, 21, 30))).toBe(0);
    expect(daysUntilMd("01-01", new Date(2026, 11, 31, 12))).toBe(1);
    expect(daysUntilMd("12-31", new Date(2026, 0, 1, 12))).toBe(364);
  });

  it.each(["", "not-a-date", "00-12", "12-00"])("rejects an unusable month-day: %s", (raw) => {
    expect(daysUntilMd(raw, new Date(2026, 7, 26))).toBeNull();
  });
});

describe("upcoming reminders", () => {
  it("combines birthdays and festivals inside the window in chronological order", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 11, 20, 12));

    const rows = upcoming(
      [
        person({ id: "birthday-soon", name: "周宁", profile: { birthday: "12-25" } }),
        person({ id: "birthday-later", name: "许言", profile: { birthday: "01-01" } }),
        person({ id: "no-birthday", name: "陈青" }),
      ],
      5,
    );

    expect(rows.map((row) => row.days)).toEqual(
      [...rows.map((row) => row.days)].sort((a, b) => a - b),
    );
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "f-平安夜", kind: "festival", md: "12-24", days: 4 }),
        expect.objectContaining({ key: "b-birthday-soon", kind: "birthday", md: "12-25", days: 5 }),
        expect.objectContaining({ key: "f-圣诞节", kind: "festival", md: "12-25", days: 5 }),
      ]),
    );
    expect(rows.some((row) => row.key === "b-birthday-later")).toBe(false);
  });

  it("builds an evidence-aware birthday prompt", () => {
    const target = person({
      name: "周宁",
      note: "偏好实用礼物",
      profile: {
        circle: "同学",
        closeness: 4,
        likes: ["摄影", "咖啡"],
        dislikes: ["甜食"],
        gifts: ["相册"],
      },
    });

    const prompt = blessingPrompt({
      key: "b-person-1",
      kind: "birthday",
      title: "周宁 生日",
      md: "12-25",
      days: 5,
      person: target,
    });

    expect(prompt).toContain("周宁");
    expect(prompt).toContain("关系：同学");
    expect(prompt).toContain("亲密度：4/5");
    expect(prompt).toContain("喜好：摄影、咖啡");
    expect(prompt).toContain("不喜欢：甜食");
    expect(prompt).toContain("以前送过：相册");
    expect(prompt).toContain("备注：偏好实用礼物");
  });

  it("keeps every configured fixed festival month-day well formed and unique", () => {
    expect(FESTIVALS.length).toBeGreaterThan(0);
    expect(FESTIVALS.every((festival) => /^\d{2}-\d{2}$/.test(festival.md))).toBe(true);
    expect(new Set(FESTIVALS.map((festival) => festival.name)).size).toBe(FESTIVALS.length);
  });

  it.each([
    [2025, { 母亲节: "05-11", 父亲节: "06-15", 感恩节: "11-27" }],
    [2026, { 母亲节: "05-10", 父亲节: "06-21", 感恩节: "11-26" }],
  ])("computes weekday-based festivals for %i", (year, expected) => {
    const byName = Object.fromEntries(
      festivalsForYear(year).map((festival) => [festival.name, festival.md]),
    );
    expect(byName).toMatchObject(expected);
  });

  it.each([
    [2025, { 春节: "01-29", 端午节: "05-31", 中秋节: "10-06" }],
    [2026, { 春节: "02-17", 端午节: "06-19", 中秋节: "09-25" }],
    [2030, { 春节: "02-03", 端午节: "06-05", 中秋节: "09-12" }],
    [2031, { 春节: "01-23", 端午节: "06-24", 中秋节: "10-01" }],
    [2050, { 春节: "01-23", 端午节: "06-23", 中秋节: "09-30" }],
  ])("converts major lunar festivals accurately for %i", (year, expected) => {
    const byName = Object.fromEntries(
      festivalsForYear(year).map((festival) => [festival.name, festival.md]),
    );

    expect(byName).toMatchObject(expected);
  });

  it("omits dates outside the verified lunar calendar range instead of guessing", () => {
    const names = new Set(["春节", "端午节", "中秋节"]);
    expect(festivalsForYear(2101).filter((festival) => names.has(festival.name))).toEqual([]);
  });

  it.each([
    ["2026-02-17", { lunarMonth: 1, lunarDay: 1, short: "正月", full: "农历二零二六年正月初一" }],
    ["2026-08-27", { lunarMonth: 7, lunarDay: 15, short: "十五" }],
    ["2025-07-25", { lunarMonth: 6, lunarDay: 1, isLeap: true, short: "闰六月" }],
  ])("converts solar day %s into an exact lunar label", (date, expected) => {
    expect(lunarDateLabel(date)).toMatchObject(expected);
  });

  it("does not label invalid or unsupported calendar days", () => {
    expect(lunarDateLabel("2026-02-30")).toBeNull();
    expect(lunarDateLabel("2101-01-01")).toBeNull();
  });

  it("includes exactly converted lunar festivals in upcoming reminders", () => {
    const rows = upcoming([], 5, new Date(2026, 8, 20, 12));
    expect(rows).toContainEqual(expect.objectContaining({ title: "中秋节", md: "09-25", days: 5 }));
  });
});
