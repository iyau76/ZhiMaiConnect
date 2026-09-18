import { expect } from "vitest";

import { describeDemoPackContract } from "../contract";
import { hogwartsPack } from "./hogwarts";

/**
 * 魔法门库专项断言：注册表元数据逐字一致、韦斯莱家谱齐全、
 * 三条 ended 时间线、活点地图身份、canon 生日、1991-1998 学年事件
 * 与演示窗口内的提醒。契约公共部分由 describeDemoPackContract 覆盖。
 */
describeDemoPackContract(() => hogwartsPack, {
  extra: (pack) => {
    // 元数据与 registry.PACK_META 保持逐字一致。
    expect(pack.id).toBe("hogwarts");
    expect(pack.group).toBe("world");
    expect(pack.name).toBe("魔法学院");
    expect(pack.description).toBe("学院、社团与师生协作网");
    expect(pack.example).toBe("想学一项新咒语，该找谁请教？");
    expect(pack.egoKey).toBe("harry");
    expect(pack.universe?.trim().length ?? 0).toBeGreaterThan(0);

    // 韦斯莱家谱：七名子女的父母边齐全，再补四条有戏的 sibling 边。
    const children = ["bill", "charlie", "percy", "fred", "george", "ron", "ginny"];
    for (const child of children) {
      for (const parent of ["arthur", "molly"]) {
        const edge = pack.relations.find(
          (relation) =>
            relation.from === parent && relation.to === child && relation.predicate === "parent_of",
        );
        expect(edge, `${parent} parent_of ${child}`).toBeDefined();
      }
    }
    const hasSibling = (from: string, to: string) =>
      pack.relations.some(
        (relation) =>
          relation.from === from && relation.to === to && relation.predicate === "sibling_of",
      );
    expect(hasSibling("fred", "george")).toBe(true);
    expect(hasSibling("ron", "ginny")).toBe(true);
    expect(hasSibling("bill", "charlie")).toBe(true);
    expect(
      pack.relations.some(
        (relation) =>
          relation.from === "lucius" &&
          relation.to === "draco" &&
          relation.predicate === "parent_of",
      ),
    ).toBe(true);

    // 待确认与已结束：赫敏-伍德 pending；珀西疏远、多比获自由、金妮放下暗恋。
    const pending = pack.relations.filter((relation) => relation.pending);
    expect(pending.length).toBeGreaterThanOrEqual(1);
    expect(
      pending.some(
        (relation) =>
          relation.predicate === "knows" &&
          ((relation.from === "hermione" && relation.to === "wood") ||
            (relation.from === "wood" && relation.to === "hermione")),
      ),
    ).toBe(true);

    const ended = pack.relations.filter((relation) => relation.validity?.status === "ended");
    expect(ended.length).toBeGreaterThanOrEqual(3);
    expect(
      ended.some(
        (relation) =>
          relation.predicate === "sibling_of" &&
          relation.qualifiers?.temporalStatus === "former" &&
          [relation.from, relation.to].sort().join("+") === "percy+ron",
      ),
    ).toBe(true);
    expect(
      ended.some(
        (relation) =>
          relation.predicate === "reports_to" &&
          relation.from === "dobby" &&
          relation.to === "lucius",
      ),
    ).toBe(true);
    expect(
      ended.some(
        (relation) =>
          relation.predicate === "has_crush_on" &&
          relation.from === "ginny" &&
          relation.to === "harry",
      ),
    ).toBe(true);

    // 身份史：活点地图别名 + 哈利的找球手身份。
    const aliases = new Set(
      pack.people.flatMap(
        (person) => person.profile.identities?.map((identity) => identity.alias) ?? [],
      ),
    );
    expect(aliases.has("大脚板")).toBe(true);
    expect(aliases.has("月亮脸")).toBe(true);
    expect(aliases.has("找球手")).toBe(true);
    const sirius = pack.people.find((person) => person.key === "sirius");
    expect(
      sirius?.profile.identities?.some((identity) => identity.platform === "活点地图（模拟）"),
    ).toBe(true);

    // 联系方式口径：demo-<key>@example.invalid；至少三人留空。
    for (const person of pack.people) {
      if (person.profile.contact) {
        expect(person.profile.contact.startsWith("demo-")).toBe(true);
        expect(person.profile.contact.endsWith("@example.invalid")).toBe(true);
      }
    }
    expect(pack.people.filter((person) => !person.profile.contact).length).toBeGreaterThanOrEqual(
      3,
    );

    // canon 生日抽查（完整清单见 doc/research/demo-packs/hogwarts.md）。
    const birthdayOf = (key: string) =>
      pack.people.find((person) => person.key === key)?.profile.birthday;
    expect(birthdayOf("harry")).toBe("07-31");
    expect(birthdayOf("ron")).toBe("03-01");
    expect(birthdayOf("hermione")).toBe("09-19");
    expect(birthdayOf("ginny")).toBe("08-11");
    expect(birthdayOf("fred")).toBe("04-01");
    expect(birthdayOf("george")).toBe("04-01");
    expect(birthdayOf("luna")).toBe("02-13");
    expect(birthdayOf("neville")).toBe("07-30");
    expect(birthdayOf("draco")).toBe("06-05");
    expect(birthdayOf("snape")).toBe("01-09");

    // 事件落在 1991-1998 学年，三强争霸赛用区间，复活节带原文说法。
    for (const event of pack.events) {
      const year = Number(event.date.slice(0, 4));
      expect(year).toBeGreaterThanOrEqual(1991);
      expect(year).toBeLessThanOrEqual(1998);
    }
    const triwizard = pack.events.find((event) => event.title === "三强争霸赛");
    expect(triwizard?.precision).toBe("range");
    expect(triwizard?.date).toBe("1994-11-24");
    expect(triwizard?.dateEnd).toBe("1995-06-24");
    expect(pack.events.some((event) => event.dateText === "复活节假期")).toBe(true);
    expect(pack.events.some((event) => event.kind === "约会")).toBe(true);
    expect(pack.events.some((event) => event.kind === "送礼")).toBe(true);

    // 提醒在演示窗口内（2026-09-19 ~ 2026-10-15），赫敏生日是第一条。
    expect(pack.reminders.length).toBeGreaterThanOrEqual(2);
    expect(pack.reminders.length).toBeLessThanOrEqual(4);
    for (const reminder of pack.reminders) {
      expect((reminder.due ?? "") >= "2026-09-19").toBe(true);
      expect((reminder.due ?? "") <= "2026-10-15").toBe(true);
    }
    expect(
      pack.reminders.some(
        (reminder) => reminder.kind === "birthday" && reminder.people.includes("hermione"),
      ),
    ).toBe(true);

    // 圈层主题齐全，每个人至少归属一个圈层。
    const circleNames = pack.collections.map((collection) => collection.name);
    expect(circleNames).toContain("格兰芬多学院");
    expect(circleNames).toContain("凤凰社");
    expect(circleNames).toContain("教职员工");
    for (const person of pack.people) {
      const joined = pack.collections.filter((collection) =>
        collection.members.includes(person.key),
      );
      expect(joined.length, person.key).toBeGreaterThanOrEqual(1);
    }
  },
});
