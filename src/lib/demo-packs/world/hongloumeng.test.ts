import { expect } from "vitest";

import { describeDemoPackContract } from "../contract";
import { hongloumengPack } from "./hongloumeng";

describeDemoPackContract(() => hongloumengPack, {
  minPeople: 26,
  maxPeople: 36,
  minRelations: 40,
  minEvents: 12,
  extra: (pack) => {
    const predicates = new Set(pack.relations.map((relation) => relation.predicate));
    // 亲属谓词覆盖：宗族库的灵魂是父女、配偶、同胞、堂表与宗亲并存。
    for (const predicate of [
      "parent_of",
      "spouse_of",
      "sibling_of",
      "half_sibling_of",
      "grandparent_of",
      "uncle_aunt_of",
      "cousin_of",
      "clan_of",
      "reports_to",
    ]) {
      expect(predicates.has(predicate as (typeof pack.relations)[number]["predicate"])).toBe(true);
    }

    // 妾室用 spouse_of + partnerRole: concubine 表达（赵姨娘、平儿）。
    const concubines = pack.relations.filter(
      (relation) => relation.qualifiers?.partnerRole === "concubine",
    );
    expect(concubines.length).toBeGreaterThanOrEqual(2);

    // 姑表与姨表的 cousinBranch 方向正确（以宝玉为 from）。
    const baoyuDaiyu = pack.relations.find(
      (relation) =>
        relation.from === "jiabaoyu" &&
        relation.to === "lindaiyu" &&
        relation.predicate === "cousin_of",
    );
    expect(baoyuDaiyu?.qualifiers).toMatchObject({
      cousinBranch: "paternal_aunt",
      inverseCousinBranch: "maternal_uncle",
    });
    const baoyuBaochai = pack.relations.find(
      (relation) =>
        relation.from === "jiabaoyu" &&
        relation.to === "xuebaochai" &&
        relation.predicate === "cousin_of",
    );
    expect(baoyuBaochai?.qualifiers).toMatchObject({
      cousinBranch: "maternal_aunt",
      inverseCousinBranch: "maternal_aunt",
    });

    // 待确认关系：小红与贾芸的手帕情愫。
    const pendingHandkerchief = pack.relations.find(
      (relation) =>
        relation.pending &&
        ((relation.from === "xiaohong" && relation.to === "jiayun") ||
          (relation.from === "jiayun" && relation.to === "xiaohong")),
    );
    expect(pendingHandkerchief).toBeDefined();

    // 已结束关系：秦可卿与贾蓉，措辞克制。
    const endedQinrong = pack.relations.find(
      (relation) => relation.predicate === "spouse_of" && relation.validity?.status === "ended",
    );
    expect(endedQinrong?.from).toBe("qinkeqing");
    expect(endedQinrong?.to).toBe("jiarong");

    // 诗社别号作为身份史。
    const aliases = pack.people.flatMap((person) =>
      (person.profile.identities ?? [])
        .filter((identity) => identity.platform === "大观园诗社（模拟）")
        .map((identity) => identity.alias),
    );
    expect(aliases).toEqual(expect.arrayContaining(["怡红公子", "潇湘妃子", "蘅芜君"]));

    // 同名消歧：贾宝玉与甄宝玉。
    const baoyuNamed = pack.people.filter((person) => person.name.endsWith("宝玉"));
    expect(baoyuNamed.map((person) => person.key).sort()).toEqual(["jiabaoyu", "zhenbaoyu"]);

    // 联系方式口径：要么留空，要么 demo-<key>@example.invalid。
    for (const person of pack.people) {
      if (!person.profile.contact) continue;
      expect(person.profile.contact).toBe(`demo-${person.key}@example.invalid`);
    }
    expect(pack.people.filter((person) => !person.profile.contact).length).toBeGreaterThanOrEqual(
      3,
    );

    // canon 生日抽查：黛玉二月十二、宝钗正月廿一、凤姐九月初二。
    const birthdayByKey = new Map(
      pack.people.map((person) => [person.key, person.profile.birthday]),
    );
    expect(birthdayByKey.get("lindaiyu")).toBe("02-12");
    expect(birthdayByKey.get("xuebaochai")).toBe("01-21");
    expect(birthdayByKey.get("wangxifeng")).toBe("09-02");

    // 事件年份映射到 1720 年代，且有非 day 精度与原文时间说法。
    for (const event of pack.events) {
      expect(event.date.startsWith("17")).toBe(true);
    }
    expect(
      pack.events.filter(
        (event) => (event.precision && event.precision !== "day") || event.dateText,
      ).length,
    ).toBeGreaterThanOrEqual(5);

    // 提醒都在宝玉视角的当季窗口内。
    for (const reminder of pack.reminders) {
      expect((reminder.due ?? "").localeCompare("2026-09-20")).toBeGreaterThanOrEqual(0);
      expect((reminder.due ?? "").localeCompare("2026-10-15")).toBeLessThanOrEqual(0);
    }
  },
});
