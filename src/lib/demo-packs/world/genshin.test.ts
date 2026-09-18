import { expect } from "vitest";

import { describeDemoPackContract } from "../contract";
import { genshinPack } from "./genshin";

describeDemoPackContract(() => genshinPack, {
  maxPeople: 36,
  minRelations: 40,
  minEvents: 12,
  extra: (pack) => {
    // 元数据须与 registry.ts 预留的卡片逐字一致。
    expect(pack).toMatchObject({
      id: "genshin",
      group: "world",
      name: "元素大陆",
      description: "七国城邦与跨城协作",
      example: "要在璃月办一场灯会，找谁统筹？",
      egoKey: "traveler",
    });
    expect(pack.universe?.trim().length ?? 0).toBeGreaterThan(0);

    // 主角档案：名字与 key 对得上，生日与性别按原作留空（玩家自定）。
    const traveler = pack.people.find((person) => person.key === "traveler");
    expect(traveler?.name).toBe("旅行者");
    expect(traveler?.profile.birthday).toBeUndefined();
    expect(traveler?.profile.gender).toBeUndefined();

    // 每条关系都要写明依据，不写裸关系。
    for (const relation of pack.relations) {
      expect(relation.note?.trim().length ?? 0).toBeGreaterThan(0);
    }

    // 演示邮箱一律用 example.invalid 域名。
    for (const person of pack.people) {
      if (person.profile.contact) {
        expect(person.profile.contact).toMatch(/^demo-[a-z-]+@example\.invalid$/);
      }
    }
    // 至少三位没有联系方式（旅行者、温迪、雷电将军、万叶）。
    expect(pack.people.filter((person) => !person.profile.contact).length).toBeGreaterThanOrEqual(
      3,
    );

    // 钟离的身份史：同一人不同时期的两段身份，前段收尾、后段接续。
    const zhongli = pack.people.find((person) => person.key === "zhongli");
    const identities = zhongli?.profile.identities ?? [];
    expect(identities.length).toBeGreaterThanOrEqual(2);
    const emperor = identities.find((identity) => identity.alias === "岩王帝君");
    const consultant = identities.find((identity) => identity.alias === "客卿");
    expect(emperor?.validFrom).toBeTruthy();
    expect(emperor?.validTo).toBeTruthy();
    expect(consultant?.validFrom).toBeTruthy();
    expect(consultant?.validTo).toBeUndefined();
    // 行秋的笔名与胡桃的堂主身份也登记在案。
    expect(
      pack.people.find((person) => person.key === "xingqiu")?.profile.identities?.[0]?.alias,
    ).toBe("枕玉");

    // 已结束关系：万叶与故友、迪卢克与骑士团。
    const ended = pack.relations.filter((relation) => relation.validity?.status === "ended");
    expect(ended.length).toBeGreaterThanOrEqual(2);
    expect(ended.some((relation) => relation.from === "kazuha" && relation.to === "guyou")).toBe(
      true,
    );

    // 待确认关系：刻晴与北斗的接洽传闻。
    const pending = pack.relations.filter((relation) => relation.pending);
    expect(pending.length).toBeGreaterThanOrEqual(1);
    expect(
      pending.some((relation) => {
        const pair = [relation.from, relation.to];
        return pair.includes("keqing") && pair.includes("beidou");
      }),
    ).toBe(true);

    // 组织结构：琴、北斗、八重神子各管一摊。
    const edges = pack.relations.map((relation) => `${relation.from}>${relation.to}`);
    for (const edge of [
      "lisa>jean",
      "amber>jean",
      "kaeya>jean",
      "albedo>jean",
      "beidou>kazuha",
      "yaemiko>kuroda",
    ]) {
      expect(edges).toContain(edge);
    }

    // 提醒都在演示窗口内，且旅行者视角可执行。
    expect(pack.reminders.length).toBeGreaterThanOrEqual(2);
    for (const reminder of pack.reminders) {
      expect(reminder.due ?? "").toMatch(/^2026-(09-2\d|09-3\d|10-0\d|10-1[0-5])$/);
    }

    // 界面文案不出现商标词。
    const surface = [pack.name, pack.description, pack.example, pack.universe ?? ""].join("\n");
    expect(surface).not.toMatch(/原神|米哈游|提瓦特|崩坏/);
  },
});
