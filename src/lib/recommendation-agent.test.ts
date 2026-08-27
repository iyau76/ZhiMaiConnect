import { describe, expect, it } from "vitest";

import type { LifeEventRecord, PersonRecord, RelationRecord } from "./face-db";
import { executeRecommendationTool, planArchiveDisclosure } from "./recommendation-agent";

function person(id: string, note = ""): PersonRecord {
  return {
    id,
    name: id,
    note,
    descriptors: [[0.1, 0.2]],
    thumb: "data:image/png;base64,secret-image",
    photos: [{ id: "photo", dataUrl: "data:image/png;base64,private", addedAt: 1 }],
    createdAt: 1,
    profile: {
      title: note,
      contact: "13800138000",
      fingerprintRef: "fingerprint-secret",
      employeeId: "employee-secret",
      identities: [{ platform: "微信", account: "account-secret", alias: `${id}别名` }],
    },
  };
}

describe("archive disclosure", () => {
  it("uses one-shot full context for a small archive while excluding biometric and direct contact data", () => {
    const plan = planArchiveDisclosure({
      persons: [person("周宁", "摄影师")],
      relations: [],
      events: [],
    });

    expect(plan.mode).toBe("full");
    expect(plan.context).toContain("摄影师");
    expect(plan.context).toContain('"hasContact":true');
    expect(plan.context).not.toContain("13800138000");
    expect(plan.context).not.toContain("secret-image");
    expect(plan.context).not.toContain("fingerprint-secret");
    expect(plan.context).not.toContain("account-secret");
  });

  it("switches to progressive disclosure when the archive is large", () => {
    const persons = Array.from({ length: 20 }, (_, index) => person(`person-${index}`, "项目顾问"));
    const plan = planArchiveDisclosure({ persons, relations: [], events: [] });

    expect(plan.mode).toBe("progressive");
    expect(plan.context).toContain('"persons":20');
    expect(plan.context).toContain("已授权按需访问全库");
  });
});

describe("local recommendation tools", () => {
  const persons = [person("legal", "法律顾问 合同审查"), person("photo", "活动摄影")];
  const relations: RelationRecord[] = [
    {
      id: "r1",
      fromId: "legal",
      toId: "photo",
      label: "同事",
      createdAt: 1,
    },
  ];
  const events: LifeEventRecord[] = [
    {
      id: "e1",
      date: "2026-08-01",
      title: "一起审核合同",
      personIds: ["legal"],
      createdAt: 1,
    },
  ];

  it("searches the complete local archive and returns stable person ids", async () => {
    const result = (await executeRecommendationTool(
      "search_profiles",
      { query: "合同 法律" },
      { persons, relations, events },
    )) as { rows: Array<{ id: string }> };

    expect(result.rows.map((row) => row.id)).toEqual(["legal"]);
  });

  it("reveals connected relationships and events only for requested ids", async () => {
    const relationResult = (await executeRecommendationTool(
      "get_relationships",
      { personIds: ["legal"] },
      { persons, relations, events },
    )) as { rows: unknown[] };
    const eventResult = (await executeRecommendationTool(
      "get_events",
      { personIds: ["legal"] },
      { persons, relations, events },
    )) as { rows: unknown[] };

    expect(relationResult.rows).toHaveLength(1);
    expect(eventResult.rows).toHaveLength(1);
  });
});
