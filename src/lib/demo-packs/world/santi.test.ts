import { expect } from "vitest";

import { describeDemoPackContract } from "../contract";
import { santiPack } from "./santi";

describeDemoPackContract(() => santiPack, {
  minPeople: 22,
  maxPeople: 32,
  minRelations: 35,
  minEvents: 12,
  extra: (pack) => {
    // 本库元数据须与 registry.ts 的 PACK_META 一致。
    expect(pack.id).toBe("santi");
    expect(pack.group).toBe("world");
    expect(pack.name).toBe("黑暗森林");
    expect(pack.description).toBe("跨越世纪的协作与抉择");
    expect(pack.example).toBe("末日之战前，该找谁了解敌人？");
    expect(pack.egoKey).toBe("luoji");

    // 灵魂：绝大多数事件保留原著纪年原文（dateText），公历 date 只负责排序。
    const withDateText = pack.events.filter((event) => event.dateText);
    expect(withDateText.length).toBeGreaterThanOrEqual(pack.events.length - 4);
    expect(
      withDateText.filter((event) => event.dateText?.includes("纪元")).length,
    ).toBeGreaterThanOrEqual(10);

    // 时间精度谱系：year 与 range 是主角，个别时刻精确到日。
    const precisions = new Set(pack.events.map((event) => event.precision));
    expect(precisions.has("year")).toBe(true);
    expect(precisions.has("range")).toBe(true);
    expect(precisions.has("day")).toBe(true);

    // 时间跨度：从红岸发射（1971）到掩体纪元（2390 年代）。
    const years = pack.events.map((event) => Number(event.date.slice(0, 4)));
    expect(Math.min(...years)).toBeLessThanOrEqual(1971);
    expect(Math.max(...years)).toBeGreaterThanOrEqual(2398);

    // 主角身份史：面壁者 → 执剑人；云天明的阶梯计划别号。
    const luoji = pack.people.find((person) => person.key === "luoji");
    expect(luoji?.profile.identities?.map((identity) => identity.alias)).toEqual([
      "面壁者",
      "执剑人",
    ]);
    const yuntianming = pack.people.find((person) => person.key === "yuntianming");
    expect(yuntianming?.profile.identities?.[0]).toMatchObject({
      platform: "阶梯计划（模拟）",
      alias: "礼物",
    });

    // 送星星：云天明对程心的暗恋须带原著依据。
    const crush = pack.relations.find(
      (relation) =>
        relation.from === "yuntianming" &&
        relation.to === "chengxin" &&
        relation.predicate === "has_crush_on",
    );
    expect(crush?.note).toContain("DX3906");

    // 待确认关系：常伟思对章北海立场的存疑。
    expect(
      pack.relations.some(
        (relation) =>
          relation.pending && relation.from === "zhangbeihai" && relation.to === "changweiwei",
      ),
    ).toBe(true);

    // 已结束亲缘：叶文洁与杨冬的母女（杨冬已故）。
    expect(
      pack.relations.some(
        (relation) =>
          relation.from === "yewenjie" &&
          relation.to === "yangdong" &&
          relation.predicate === "parent_of" &&
          relation.validity?.status === "ended",
      ),
    ).toBe(true);

    // 联系方式口径：要么留空，要么 demo-<key>@example.invalid。
    for (const person of pack.people) {
      if (!person.profile.contact) continue;
      expect(person.profile.contact).toBe(`demo-${person.key}@example.invalid`);
    }
    expect(pack.people.filter((person) => !person.profile.contact).length).toBeGreaterThanOrEqual(
      3,
    );

    // 关系条目大多写明原著依据。
    expect(
      pack.relations.filter((relation) => relation.note?.includes("原著")).length,
    ).toBeGreaterThanOrEqual(Math.ceil(pack.relations.length * 0.8));

    // 提醒都在罗辑视角的当季窗口内。
    for (const reminder of pack.reminders) {
      expect(reminder.people).toContain("luoji");
      expect((reminder.due ?? "").localeCompare("2026-09-20")).toBeGreaterThanOrEqual(0);
      expect((reminder.due ?? "").localeCompare("2026-10-15")).toBeLessThanOrEqual(0);
    }
  },
});
