import { describe, expect, it } from "vitest";

import type { LifeEventRecord, PersonRecord } from "./face-db";
import { rankCandidates, recommendationPrompt, staleContacts } from "./recommendation";

const NOW = new Date(2026, 7, 26, 12);

function person(id: string, overrides: Partial<PersonRecord> = {}): PersonRecord {
  return {
    id,
    name: id,
    note: "",
    descriptors: [],
    thumb: "",
    createdAt: new Date(2026, 0, 1).getTime(),
    profile: { contact: `${id}@example.com` },
    ...overrides,
  };
}

function event(
  id: string,
  personId: string,
  overrides: Partial<LifeEventRecord> = {},
): LifeEventRecord {
  return {
    id,
    date: "2026-08-16",
    title: "最近通话",
    kind: "通话",
    personIds: [personId],
    createdAt: 1,
    ...overrides,
  };
}

describe("rankCandidates", () => {
  it("combines skill, closeness, recency, cooperation, and contact evidence", () => {
    const target = person("photo-helper", {
      name: "周宁",
      profile: {
        title: "摄影师",
        projects: ["校园活动拍摄"],
        likes: ["相机"],
        closeness: 5,
        contact: "zhou@example.com",
      },
    });
    const cooperation = event("event-1", target.id, {
      title: "共同完成迎新活动",
      kind: "帮忙",
      personIds: [target.id, "me"],
    });

    const [result] = rankCandidates("组织校园活动，找人拍照", [target], [cooperation], NOW);

    expect(result.score).toBe(93);
    expect(result.confidence).toBe("高");
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        expect.stringContaining("任务匹配"),
        "亲密度 5/5",
        expect.stringContaining("最近互动"),
      ]),
    );
    expect(result.evidence).toEqual(expect.arrayContaining([expect.stringContaining("人物档案")]));
    expect(result.risks).toEqual([]);
  });

  it("uses a manually updated profile timestamp in the evidence freshness display", () => {
    const updated = person("p1", {
      name: "Updated",
      profile: { title: "摄影师", contact: "demo@example.invalid" },
    });
    updated.updatedAt = new Date("2026-08-20T00:00:00Z").getTime();
    const [result] = rankCandidates("找摄影师", [updated], [], new Date("2026-08-26"));
    expect(result?.updatedAt).toBe(updated.updatedAt);
  });

  it("applies explainable penalties for missing contact, stale evidence, and inferred sources", () => {
    const risky = person("risky", {
      profile: { title: "摄影师", contact: "" },
      source: { kind: "ai", at: new Date(2023, 0, 1).getTime() },
    });
    const oldInteraction = event("old", risky.id, { date: "2023-01-01" });
    const [result] = rankCandidates("需要摄影", [risky], [oldInteraction], NOW);

    expect(result.score).toBe(9);
    expect(result.risks).toEqual(
      expect.arrayContaining([
        "缺少可用联系方式",
        expect.stringContaining("信息可能过期"),
        "档案含待人工复核的推断来源",
      ]),
    );
  });

  it("uses score, then freshest evidence, then Chinese name for deterministic ordering", () => {
    const older = person("older", { name: "周宁", createdAt: 100 });
    const newerZ = person("newer-z", { name: "赵敏", createdAt: 200 });
    const newerA = person("newer-a", { name: "安然", createdAt: 200 });

    expect(
      rankCandidates("未知任务", [older, newerZ, newerA], [], NOW).map((row) => row.person.id),
    ).toEqual(["newer-a", "newer-z", "older"]);
  });

  it("never mutates the input person or event order", () => {
    const persons = [person("b"), person("a")];
    const events = [
      event("old", "a", { date: "2025-01-01" }),
      event("new", "a", { date: "2026-08-01" }),
    ];
    const personIds = persons.map((row) => row.id);
    const eventIds = events.map((row) => row.id);

    rankCandidates("未知任务", persons, events, NOW);

    expect(persons.map((row) => row.id)).toEqual(personIds);
    expect(events.map((row) => row.id)).toEqual(eventIds);
  });
});

describe("staleContacts", () => {
  it("uses the latest interaction, applies the inclusive threshold, and sorts stalest first", () => {
    const persons = [person("very-stale"), person("at-threshold"), person("recent")];
    const events = [
      event("very-old", "very-stale", { date: "2025-01-01" }),
      event("threshold", "at-threshold", { date: "2026-05-28" }),
      event("recent-old", "recent", { date: "2025-01-01" }),
      event("recent-new", "recent", { date: "2026-08-20" }),
    ];

    const rows = staleContacts(persons, events, 90, NOW);

    expect(rows.map((row) => row.person.id)).toEqual(["very-stale", "at-threshold"]);
    expect(rows[0]).toMatchObject({ days: 602, lastDate: "2025-01-01" });
    expect(rows[1]).toMatchObject({ days: 90, lastDate: "2026-05-28" });
  });

  it("falls back to the profile creation time when no interaction exists", () => {
    const createdAt = new Date(2026, 4, 28).getTime();
    const [row] = staleContacts([person("new", { createdAt })], [], 90, NOW);
    expect(row).toMatchObject({ days: 90, lastDate: undefined });
  });
});

describe("recommendationPrompt", () => {
  it("limits AI context to the deterministic top three and forbids changing or auto-sending it", () => {
    const candidates = rankCandidates(
      "未知任务",
      [person("A"), person("B"), person("C"), person("D")],
      [],
      NOW,
    );
    const prompt = recommendationPrompt("请人协助", candidates);

    expect(prompt).toContain("不得添加名单外人物或改变排序");
    expect(prompt).toContain("不要声称自动发送");
    expect(prompt).toContain("1. A");
    expect(prompt).toContain("3. C");
    expect(prompt).not.toContain("4. D");
  });
});
