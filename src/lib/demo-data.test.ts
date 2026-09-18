import { describe, expect, it } from "vitest";

import { buildDemoData, DEMO_SCENARIOS, type DemoScenarioId } from "./demo-data";
import { describeDemoPackContract } from "./demo-packs/contract";
import {
  LIFE_PACK_IDS,
  loadPack,
  WORLD_PACK_IDS,
  WORLD_PACKS_ENABLED,
} from "./demo-packs/registry";
import { campusPack } from "./demo-packs/life/campus";
import { familyPack } from "./demo-packs/life/family";
import { workplacePack } from "./demo-packs/life/workplace";
import { smallBusinessPack } from "./demo-packs/life/small-business";

const EXPECTED_PERSON: Record<Exclude<DemoScenarioId, "all">, string> = {
  campus: "唐悦",
  family: "苏琴",
  workplace: "江禾",
  small_business: "袁野",
  hongloumeng: "贾宝玉",
  hogwarts: "哈利·波特",
  genshin: "派蒙",
  arknights: "阿米娅",
  santi: "罗辑",
};

describe("demo scenario packs", () => {
  it("keeps the complete life fixture at 51 people with bridges", async () => {
    const data = await buildDemoData();
    expect(data.people).toHaveLength(51);
    expect(data.relations.length).toBeGreaterThanOrEqual(80);
    expect(data.events.length).toBeGreaterThanOrEqual(25);
    const personIds = new Set(data.people.map((person) => person.id));
    for (const relation of data.relations) {
      expect(personIds.has(relation.fromId)).toBe(true);
      expect(personIds.has(relation.toId)).toBe(true);
    }
    for (const event of data.events) {
      for (const personId of event.personIds ?? []) expect(personIds.has(personId)).toBe(true);
    }
  });

  it("renders life scenarios first and world packs only when enabled", () => {
    expect(DEMO_SCENARIOS.map((scenario) => scenario.id)).toEqual(
      WORLD_PACKS_ENABLED ? [...LIFE_PACK_IDS, ...WORLD_PACK_IDS] : [...LIFE_PACK_IDS],
    );
  });

  it("loads every enabled scenario as a self-contained pack with valid references", async () => {
    for (const scenario of DEMO_SCENARIOS) {
      const data = await buildDemoData(scenario.id);
      const personIds = new Set(data.people.map((person) => person.id));
      const collectionIds = new Set(data.collections.map((collection) => collection.id));

      expect(data.people.map((person) => person.name)).toContain(EXPECTED_PERSON[scenario.id]);
      expect(data.people.length).toBeGreaterThanOrEqual(8);
      expect(data.relations.length).toBeGreaterThanOrEqual(10);
      expect(data.events.length).toBeGreaterThanOrEqual(1);
      expect(
        data.relations.every(
          (relation) => personIds.has(relation.fromId) && personIds.has(relation.toId),
        ),
      ).toBe(true);
      expect(
        data.memberships.every(
          (membership) =>
            personIds.has(membership.personId) && collectionIds.has(membership.collectionId),
        ),
      ).toBe(true);
      expect(
        data.events.every((event) =>
          (event.personIds ?? []).every((personId) => personIds.has(personId)),
        ),
      ).toBe(true);
      expect(
        data.reminders.every((reminder) =>
          (reminder.personIds ?? []).every((personId) => personIds.has(personId)),
        ),
      ).toBe(true);
    }
  });

  it("keeps the frozen finals cast in the campus pack", async () => {
    const data = await buildDemoData("campus");
    const names = data.people.map((person) => person.name);
    for (const name of ["唐悦", "佳欣", "梓涵", "嘉豪", "子轩"]) expect(names).toContain(name);
    // 两个王晨用于同名消歧。
    expect(names.filter((name) => name === "王晨")).toHaveLength(2);
    // 嘉豪没有联系方式，用于演示「待补」。
    const jiahao = data.people.find((person) => person.name === "嘉豪");
    expect(jiahao?.profile?.contact).toBeUndefined();
  });
});

describeDemoPackContract(() => campusPack, {
  minRelations: 25,
  minEvents: 15,
  extra: (pack) => {
    // 「找谁拍照」演示依赖的记忆展人物链。
    for (const key of ["tangyue", "yeqing", "qinyue"]) {
      expect(pack.people.some((person) => person.key === key)).toBe(true);
    }
  },
});
describeDemoPackContract(() => familyPack, {
  minPeople: 8,
  maxPeople: 20,
  minRelations: 15,
  minEvents: 3,
  extra: (pack) => {
    const predicates = new Set(pack.relations.map((relation) => relation.predicate));
    expect(predicates.has("grandparent_of")).toBe(true);
    expect(predicates.has("uncle_aunt_of")).toBe(true);
  },
});
describeDemoPackContract(() => workplacePack, {
  minPeople: 8,
  maxPeople: 20,
  minRelations: 10,
  minEvents: 3,
});
describeDemoPackContract(() => smallBusinessPack, {
  minPeople: 8,
  maxPeople: 20,
  minRelations: 10,
  minEvents: 3,
});
