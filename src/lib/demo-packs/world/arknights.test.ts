import { expect } from "vitest";

import { describeDemoPackContract } from "../contract";
import { arknightsPack } from "./arknights";

/**
 * 矿石病都市包级专项断言（在契约工厂的同一个 it 内执行）：
 * - 元数据与注册表逐字一致；
 * - 规模落在设计区间（24-34 人 / 35-65 关系 / 12-20 事件 / 2-4 提醒）；
 * - 异格身份史：临光必须有两段身份（耀骑士 → 临光），另有两人带「另一条时间线」身份；
 * - pending / ended 两条张力关系落在指定人物之间；
 * - 提醒窗口 2026-09-20 ~ 2026-10-15；
 * - key 全小写，联系方式一律 example.invalid 域，且至少三人无联系方式。
 */
describeDemoPackContract(() => arknightsPack, {
  extra: (pack) => {
    // 元数据与注册表逐字一致。
    expect(pack.id).toBe("arknights");
    expect(pack.group).toBe("world");
    expect(pack.name).toBe("矿石病都市");
    expect(pack.description).toBe("干员、阵营与跨阵营合作");
    expect(pack.example).toBe("突发聚集感染，该找谁处理？");
    expect(pack.egoKey).toBe("doctor");
    expect(pack.universe?.trim().length ?? 0).toBeGreaterThan(0);

    // 规模预算。
    expect(pack.people.length).toBeGreaterThanOrEqual(24);
    expect(pack.people.length).toBeLessThanOrEqual(34);
    expect(pack.relations.length).toBeGreaterThanOrEqual(35);
    expect(pack.relations.length).toBeLessThanOrEqual(65);
    expect(pack.events.length).toBeGreaterThanOrEqual(12);
    expect(pack.events.length).toBeLessThanOrEqual(20);
    expect(pack.reminders.length).toBeGreaterThanOrEqual(2);
    expect(pack.reminders.length).toBeLessThanOrEqual(4);

    // key 全小写；联系方式只用 example.invalid；至少三人无联系方式。
    for (const person of pack.people) {
      expect(person.key).toMatch(/^[a-z][a-z0-9-]*$/);
      if (person.profile.contact) {
        expect(person.profile.contact).toMatch(/^demo-[a-z0-9-]+@example\.invalid$/);
      }
    }
    const contactless = pack.people.filter((person) => !person.profile.contact);
    expect(contactless.length).toBeGreaterThanOrEqual(3);

    // 异格身份史：耀骑士 → 临光，外加至少两条「另一条时间线」式身份。
    const nearl = pack.people.find((person) => person.key === "nearl");
    expect(nearl).toBeDefined();
    const identities = nearl?.profile.identities ?? [];
    expect(identities.length).toBeGreaterThanOrEqual(2);
    const radiant = identities.find((identity) => identity.alias === "耀骑士");
    const current = identities.find((identity) => identity.alias === "临光");
    expect(radiant?.platform).toBe("卡西米尔骑士竞技（模拟）");
    expect(radiant?.validTo).toBeTruthy();
    expect(current?.platform).toBe("罗德岛作战记录（模拟）");
    expect(current?.validFrom).toBeTruthy();
    const alter = pack.people.filter((person) =>
      person.profile.identities?.some((identity) => identity.platform.includes("另一条时间线")),
    );
    expect(alter.length).toBeGreaterThanOrEqual(2);

    // pending 张力：拉普兰德 ↔ 德克萨斯；ended 旧合作：W ↔ 塔露拉。
    const pending = pack.relations.filter((relation) => relation.pending);
    expect(pending.length).toBeGreaterThanOrEqual(1);
    expect(
      pending.some(
        (relation) =>
          relation.predicate === "knows" &&
          ((relation.from === "lappland" && relation.to === "texas") ||
            (relation.from === "texas" && relation.to === "lappland")),
      ),
    ).toBe(true);
    const ended = pack.relations.filter((relation) => relation.validity?.status === "ended");
    expect(ended.length).toBeGreaterThanOrEqual(1);
    expect(
      ended.some(
        (relation) =>
          relation.predicate === "collaborates_with" &&
          ((relation.from === "w" && relation.to === "talulah") ||
            (relation.from === "talulah" && relation.to === "w")),
      ),
    ).toBe(true);

    // 提醒窗口 2026-09-20 ~ 2026-10-15。
    expect(pack.reminders.length).toBeGreaterThanOrEqual(1);
    for (const reminder of pack.reminders) {
      expect(reminder.due ?? "").toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(reminder.due! >= "2026-09-20").toBe(true);
      expect(reminder.due! <= "2026-10-15").toBe(true);
    }

    // 至少四条事件带泰拉纪年的原文时间说法。
    const terraDated = pack.events.filter((event) => event.dateText?.includes("泰拉历") ?? false);
    expect(terraDated.length).toBeGreaterThanOrEqual(4);
  },
});
