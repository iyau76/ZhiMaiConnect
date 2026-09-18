/**
 * 契约测试工厂：任何一个演示包（生活场景或世界剧场）都必须通过这里
 * 的全部断言。加新库时新建 `<id>.test.ts`，调用 describeDemoPackContract。
 */

import { describe, expect, it } from "vitest";

import { isRelationPredicate } from "@/lib/relation-ontology";

import type { DemoPack } from "./types";

export interface DemoPackContractOptions {
  /** 人物数区间（默认 20-60） */
  minPeople?: number;
  maxPeople?: number;
  /** 关系数下限（默认 25） */
  minRelations?: number;
  /** 事件数下限（默认 8） */
  minEvents?: number;
  /** 附加断言，例如亲属库要求覆盖特定谓词 */
  extra?: (pack: DemoPack) => void;
}

export function describeDemoPackContract(
  load: () => Promise<DemoPack> | DemoPack,
  options: DemoPackContractOptions = {},
) {
  const { minPeople = 20, maxPeople = 60, minRelations = 25, minEvents = 8, extra } = options;

  describe("demo pack contract", () => {
    it("keeps people within budget and keys/names well-formed", async () => {
      const pack = await load();
      expect(pack.people.length).toBeGreaterThanOrEqual(minPeople);
      expect(pack.people.length).toBeLessThanOrEqual(maxPeople);
      expect(pack.relations.length).toBeGreaterThanOrEqual(minRelations);
      expect(pack.events.length).toBeGreaterThanOrEqual(minEvents);
      const keys = pack.people.map((person) => person.key);
      expect(new Set(keys).size).toBe(keys.length);
      for (const person of pack.people) {
        expect(person.name.trim().length).toBeGreaterThan(0);
        expect(person.profile.relation.trim().length).toBeGreaterThan(0);
      }
    });

    it("resolves every relation, event, reminder and collection reference", async () => {
      const pack = await load();
      const keys = new Set(pack.people.map((person) => person.key));
      for (const relation of pack.relations) {
        expect(isRelationPredicate(relation.predicate)).toBe(true);
        expect(keys.has(relation.from)).toBe(true);
        expect(keys.has(relation.to)).toBe(true);
        expect(relation.from).not.toBe(relation.to);
      }
      for (const event of pack.events) {
        expect(event.title.trim().length).toBeGreaterThan(0);
        expect(event.people.length).toBeGreaterThan(0);
        for (const key of event.people) expect(keys.has(key)).toBe(true);
      }
      for (const reminder of pack.reminders) {
        expect(reminder.people.length).toBeGreaterThan(0);
        for (const key of reminder.people) expect(keys.has(key)).toBe(true);
      }
      const memberKeys = pack.collections.flatMap((collection) => collection.members);
      for (const key of memberKeys) expect(keys.has(key)).toBe(true);
      for (const person of pack.people) expect(memberKeys).toContain(person.key);
    });

    it("stays connected from the anchor person within four hops", async () => {
      const pack = await load();
      const adjacency = new Map<string, Set<string>>();
      for (const person of pack.people) adjacency.set(person.key, new Set());
      for (const relation of pack.relations) {
        adjacency.get(relation.from)?.add(relation.to);
        adjacency.get(relation.to)?.add(relation.from);
      }
      const anchor = pack.egoKey ?? pack.people[0].key;
      const distances = new Map<string, number>([[anchor, 0]]);
      const queue = [anchor];
      while (queue.length) {
        const current = queue.shift()!;
        for (const next of adjacency.get(current) ?? []) {
          if (!distances.has(next)) {
            distances.set(next, distances.get(current)! + 1);
            queue.push(next);
          }
        }
      }
      const unreachable = pack.people.filter((person) => !distances.has(person.key));
      expect(unreachable.map((person) => person.key)).toEqual([]);
      const diameter = Math.max(...distances.values());
      expect(diameter).toBeLessThanOrEqual(4);
    });

    it("covers the eight demo features", async () => {
      const pack = await load();
      // 1. 低置信待确认关系
      expect(pack.relations.filter((relation) => relation.pending).length).toBeGreaterThanOrEqual(
        1,
      );
      // 2. 已结束关系（时间性）
      expect(
        pack.relations.filter((relation) => relation.validity?.status === "ended").length,
      ).toBeGreaterThanOrEqual(1);
      // 3/4. 身份史或同名消歧
      const identityPeople = pack.people.filter(
        (person) => (person.profile.identities?.length ?? 0) > 0,
      );
      const nameCounts = new Map<string, number>();
      for (const person of pack.people) {
        nameCounts.set(person.name, (nameCounts.get(person.name) ?? 0) + 1);
      }
      const duplicateNames = [...nameCounts.values()].filter((count) => count > 1).length;
      expect(identityPeople.length + duplicateNames).toBeGreaterThanOrEqual(1);
      // 5. 联系方式有无可见（至少一人没有 contact）
      expect(pack.people.some((person) => !person.profile.contact)).toBe(true);
      // 6. 生日覆盖（至少一半人物，喂给生日提醒）
      const birthdayPeople = pack.people.filter((person) => person.profile.birthday);
      expect(birthdayPeople.length).toBeGreaterThanOrEqual(Math.ceil(pack.people.length / 2));
      // 7. 事件时间精度（至少一条非 day 精度或带原文说法）
      expect(
        pack.events.filter(
          (event) => (event.precision && event.precision !== "day") || event.dateText,
        ).length,
      ).toBeGreaterThanOrEqual(1);
      // 8. 至少一条提醒
      expect(pack.reminders.length).toBeGreaterThanOrEqual(1);
    });

    it("keeps kinship qualifiers consistent with endpoint genders", async () => {
      const pack = await load();
      const genderByKey = new Map(pack.people.map((person) => [person.key, person.profile.gender]));
      for (const relation of pack.relations) {
        const { qualifiers } = relation;
        if (!qualifiers) continue;
        const fromGender = genderByKey.get(relation.from);
        const toGender = genderByKey.get(relation.to);
        if (qualifiers.parentRole === "father") expect(fromGender).toBe("男");
        if (qualifiers.parentRole === "mother") expect(fromGender).toBe("女");
        if (qualifiers.childRole === "son") expect(toGender).toBe("男");
        if (qualifiers.childRole === "daughter") expect(toGender).toBe("女");
        if (qualifiers.partnerRole === "husband") expect(fromGender).toBe("男");
        if (qualifiers.partnerRole === "wife" || qualifiers.partnerRole === "concubine") {
          expect(fromGender).toBe("女");
        }
        if (qualifiers.sharedParentRole === "father" || qualifiers.sharedParentRole === "mother") {
          // 半血缘关系不限定端点性别，只要求两个端点性别已声明。
          expect(fromGender && toGender).toBeTruthy();
        }
      }
    });

    if (extra) {
      it("passes pack-specific assertions", async () => {
        extra(await load());
      });
    }
  });
}
