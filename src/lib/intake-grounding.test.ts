import { describe, expect, test } from "vitest";

import { enforceSensitiveFieldGrounding, markSensitiveFieldsManual } from "./intake-grounding";

describe("sensitive intake grounding", () => {
  test("keeps and flags AI values that have no input evidence", () => {
    const result = enforceSensitiveFieldGrounding(
      {
        people: [
          {
            name: "张伟",
            contact: "zhangwei@example.com",
            birthday: "03-12",
            title: "摄影师",
            projects: ["商业摄影"],
            likes: ["人像摄影"],
            tags: ["摄影专家"],
            closeness: 5,
            identities: [{ platform: "微信", account: "zhangwei_88", alias: "阿伟" }],
          },
        ],
      },
      "张伟是我的大学同学。",
    );

    expect(result.people?.[0]).toMatchObject({
      name: "张伟",
      contact: "zhangwei@example.com",
      birthday: "03-12",
      title: "摄影师",
      projects: ["商业摄影"],
      likes: ["人像摄影"],
      tags: ["摄影专家"],
      closeness: 5,
      identities: [{ platform: "微信", account: "zhangwei_88", alias: "阿伟" }],
    });
    expect(result.people?.[0]?._fieldGrounding).toMatchObject({
      contact: { status: "unverified" },
      birthday: { status: "unverified" },
      title: { status: "unverified" },
      projects: { status: "unverified" },
      likes: { status: "unverified" },
      tags: { status: "unverified" },
      closeness: { status: "unverified" },
      identities: { status: "unverified" },
    });
    expect(result._groundingWarnings?.map((item) => item.field)).toEqual([
      "contact",
      "birthday",
      "title",
      "projects",
      "likes",
      "tags",
      "closeness",
      "identities",
      "identities",
      "identities",
    ]);
  });

  test("keeps normalized values only when the material contains explicit evidence", () => {
    const result = enforceSensitiveFieldGrounding(
      {
        people: [
          {
            name: "张伟",
            contact: "微信：zhangwei_88",
            birthday: "03-12",
            title: "人像摄影师",
            likes: ["人像摄影"],
            closeness: 4,
            identities: [{ platform: "微信", account: "zhangwei_88", alias: "阿伟" }],
          },
        ],
      },
      "张伟的微信号是 zhangwei_88，微信昵称阿伟，生日是 1998 年 3 月 12 日，职业是人像摄影师，擅长人像摄影；亲密度 4/5。",
    );

    expect(result._groundingWarnings).toEqual([]);
    expect(result.people?.[0]).toMatchObject({
      contact: "微信：zhangwei_88",
      birthday: "03-12",
      title: "人像摄影师",
      likes: ["人像摄影"],
      closeness: 4,
    });
    expect(result.people?.[0]?._fieldGrounding).toMatchObject({
      contact: { status: "supported" },
      birthday: { status: "supported" },
      title: { status: "supported" },
      likes: { status: "supported" },
      closeness: { status: "supported" },
      identities: { status: "supported" },
    });
  });

  test("does not treat an unrelated calendar date as birthday evidence", () => {
    const result = enforceSensitiveFieldGrounding(
      { people: [{ name: "张伟", birthday: "03-12" }] },
      "3 月 12 日和张伟一起开会。",
    );
    expect(result.people?.[0]?.birthday).toBe("03-12");
    expect(result._groundingWarnings?.[0]?.field).toBe("birthday");
  });

  test("does not attach a nearby meeting date to a later birthday keyword", () => {
    const result = enforceSensitiveFieldGrounding(
      { people: [{ name: "张伟", birthday: "03-12" }] },
      "张伟 3 月 12 日开会，生日还不知道。",
    );
    expect(result.people?.[0]?.birthday).toBe("03-12");
  });

  test("does not turn a mere organisation mention into a skill claim", () => {
    const result = enforceSensitiveFieldGrounding(
      { people: [{ name: "张伟", title: "摄影师", likes: ["摄影"] }] },
      "张伟是摄影社的大学同学。",
    );
    expect(result.people?.[0]?.title).toBe("摄影师");
    expect(result.people?.[0]?.likes).toEqual(["摄影"]);
    expect(result._groundingWarnings?.map((item) => item.field)).toEqual(["title", "likes"]);
  });

  test("does not promote an interest into a professional title", () => {
    const result = enforceSensitiveFieldGrounding(
      { people: [{ name: "张伟", title: "摄影师", likes: ["摄影"] }] },
      "张伟喜欢摄影。",
    );
    expect(result.people?.[0]?.title).toBe("摄影师");
    expect(result.people?.[0]?.likes).toEqual(["摄影"]);
  });

  test("does not treat negated profession or interest statements as positive evidence", () => {
    const result = enforceSensitiveFieldGrounding(
      { people: [{ name: "张伟", title: "摄影师", likes: ["摄影"] }] },
      "张伟的职业不是摄影师，也不喜欢摄影。",
    );

    expect([result.people?.[0]?.title, result.people?.[0]?.likes]).toEqual(["摄影师", ["摄影"]]);
    expect(result._groundingWarnings?.map((item) => item.field)).toEqual(["title", "likes"]);
  });

  test("does not reuse another person's evidence", () => {
    const result = enforceSensitiveFieldGrounding(
      {
        people: [
          { name: "李雷" },
          {
            name: "张伟",
            contact: "lilei@example.com",
            birthday: "03-12",
            title: "摄影师",
            likes: ["摄影"],
            closeness: 5,
          },
        ],
      },
      "李雷的邮箱是 lilei@example.com，生日 3 月 12 日，职业是摄影师，喜欢摄影，亲密度 5/5。张伟是大学同学。",
    );
    expect(result.people?.[1]).toMatchObject({ name: "张伟" });
    expect(result.people?.[1]).toMatchObject({
      contact: "lilei@example.com",
      birthday: "03-12",
      title: "摄影师",
      likes: ["摄影"],
      closeness: 5,
    });
  });

  test("does not let a later explicitly named non-candidate person ground the candidate", () => {
    const result = enforceSensitiveFieldGrounding(
      { people: [{ name: "张伟", contact: "lilei@example.com" }] },
      "张伟是大学同学。李雷的邮箱是 lilei@example.com。",
    );

    expect(result.people?.[0]?.contact).toBe("lilei@example.com");
    expect(result._groundingWarnings).toEqual([
      expect.objectContaining({
        personName: "张伟",
        field: "contact",
        rejectedValue: "lilei@example.com",
      }),
    ]);
  });

  test("requires labelled, person-owned evidence for exact demographic and profile fields", () => {
    const candidate = {
      people: [
        {
          name: "张伟",
          age: "28 岁",
          gender: "男性",
          address: "创意园",
          employeeId: "A-1024",
        },
      ],
    };
    const unlabelled = enforceSensitiveFieldGrounding(
      candidate,
      "张伟是大学同学。资料模板示例：28 岁、男性、创意园、A-1024。",
    );
    const otherOwned = enforceSensitiveFieldGrounding(
      {
        people: candidate.people.map((person) => ({ ...person })),
      },
      "张伟是大学同学。李雷 28 岁，男性，在创意园工作，工号 A-1024。",
    );

    expect([
      [
        unlabelled.people?.[0]?.age,
        unlabelled.people?.[0]?.gender,
        unlabelled.people?.[0]?.address,
        unlabelled.people?.[0]?.employeeId,
      ],
      [
        otherOwned.people?.[0]?.age,
        otherOwned.people?.[0]?.gender,
        otherOwned.people?.[0]?.address,
        otherOwned.people?.[0]?.employeeId,
      ],
    ]).toEqual([
      ["28 岁", "男性", "创意园", "A-1024"],
      ["28 岁", "男性", "创意园", "A-1024"],
    ]);
  });

  test("keeps and flags an identity whose platform and alias are not in the person's source", () => {
    const result = enforceSensitiveFieldGrounding(
      {
        people: [
          {
            name: "张伟",
            identities: [{ platform: "微信", alias: "阿伟", validFrom: "2020-01-01" }],
          },
        ],
      },
      "张伟是大学同学。",
    );
    expect(result.people?.[0]?.identities).toEqual([
      { platform: "微信", alias: "阿伟", validFrom: "2020-01-01" },
    ]);
    expect(result._groundingWarnings?.filter((item) => item.field === "identities")).toHaveLength(
      3,
    );
  });

  test("checks identity validity dates independently and flags an unsupported date", () => {
    const result = enforceSensitiveFieldGrounding(
      {
        people: [
          {
            name: "张伟",
            identities: [
              {
                platform: "微信",
                alias: "阿伟",
                account: "zhangwei_88",
                validFrom: "2020-01-01",
                validTo: "2099-12-31",
              },
            ],
          },
        ],
      },
      "张伟的微信昵称是阿伟，账号 zhangwei_88，从 2020-01-01 开始使用。",
    );

    expect(result.people?.[0]?.identities).toEqual([
      {
        platform: "微信",
        alias: "阿伟",
        account: "zhangwei_88",
        validFrom: "2020-01-01",
        validTo: "2099-12-31",
      },
    ]);
    expect(result._groundingWarnings).toEqual([
      expect.objectContaining({ field: "identities", rejectedValue: "validTo: 2099-12-31" }),
    ]);
  });

  test("does not construct an identity from a negated platform and another person's alias", () => {
    const result = enforceSensitiveFieldGrounding(
      {
        people: [
          {
            name: "张伟",
            identities: [{ platform: "微信", alias: "阿伟" }],
          },
        ],
      },
      "张伟没有微信。李雷的微信昵称是阿伟。",
    );

    expect(result.people?.[0]?.identities).toEqual([{ platform: "微信", alias: "阿伟" }]);
    expect(result._groundingWarnings?.some((item) => item.field === "identities")).toBe(true);
  });

  test("requires each fact validity boundary to appear in that person's source", () => {
    const result = enforceSensitiveFieldGrounding(
      {
        people: [{ name: "张伟" }],
        facts: [
          {
            person: "张伟",
            key: "档期状态",
            value: "可预约",
            validFrom: "2026-08-01",
            validTo: "2026-09-30",
          },
          {
            person: "张伟",
            key: "办公地点",
            value: "创意园",
            validFrom: "2099-01-01",
          },
        ],
      },
      "张伟的档期状态是可预约，有效期从 2026-08-01 到 2026-09-30；办公地点是创意园。",
    );

    expect(result.facts).toEqual([
      expect.objectContaining({
        person: "张伟",
        key: "档期状态",
        value: "可预约",
        validFrom: "2026-08-01",
        validTo: "2026-09-30",
      }),
      expect.objectContaining({
        person: "张伟",
        key: "办公地点",
        value: "创意园",
        validFrom: "2099-01-01",
      }),
    ]);
    expect(result._groundingWarnings).toEqual([
      expect.objectContaining({ field: "facts", rejectedValue: "办公地点: 创意园" }),
    ]);
  });

  test("does not reuse one person's fact evidence for another person", () => {
    const result = enforceSensitiveFieldGrounding(
      {
        people: [{ name: "李雷" }, { name: "张伟" }],
        facts: [
          {
            person: "张伟",
            key: "档期状态",
            value: "可预约",
            validFrom: "2026-08-01",
          },
        ],
      },
      "李雷的档期状态是可预约，从 2026-08-01 起生效。张伟是大学同学。",
    );

    expect(result.facts).toEqual([
      expect.objectContaining({
        person: "张伟",
        key: "档期状态",
        value: "可预约",
        validFrom: "2026-08-01",
      }),
    ]);
    expect(result._groundingWarnings).toEqual([
      expect.objectContaining({
        personName: "张伟",
        field: "facts",
        rejectedValue: "档期状态: 可预约",
      }),
    ]);
  });

  test("does not treat a negated fact as positive evidence", () => {
    const result = enforceSensitiveFieldGrounding(
      {
        people: [{ name: "张伟" }],
        facts: [{ person: "张伟", key: "档期状态", value: "可预约" }],
      },
      "张伟的档期状态不是可预约。",
    );

    expect(result.people?.[0]).toMatchObject({ name: "张伟" });
    expect(result.facts).toEqual([
      expect.objectContaining({ person: "张伟", key: "档期状态", value: "可预约" }),
    ]);
    expect(result._groundingWarnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          personName: "张伟",
          field: "facts",
          rejectedValue: "档期状态: 可预约",
        }),
      ]),
    );
  });

  test("only marks fully evidenced events eligible for low-risk batching", () => {
    const result = enforceSensitiveFieldGrounding(
      {
        events: [
          {
            title: "讨论校园记忆展",
            date: "2026-08-29",
            people: ["张伟"],
            confidence: 0.95,
          },
          {
            title: "不存在的会议",
            date: "2026-08-30",
            people: ["张伟"],
            confidence: 0.99,
          },
        ],
      },
      "张伟将在 2026 年 8 月 29 日讨论校园记忆展。",
    );
    expect(result.events?.map((event) => event._groundingVerified)).toEqual([true, false]);
  });

  test("does not borrow an event field from a separate non-title clause", () => {
    const result = enforceSensitiveFieldGrounding(
      {
        events: [
          {
            title: "讨论校园记忆展",
            date: "2026-08-29",
            place: "创意园",
            people: ["张伟"],
            confidence: 0.99,
          },
        ],
      },
      "张伟将在 2026 年 8 月 29 日讨论校园记忆展。另一次活动的地点是创意园。",
    );

    expect(result.events?.[0]?._groundingVerified).toBe(false);
  });

  test("does not verify negated or wrong-subject events", () => {
    const negated = enforceSensitiveFieldGrounding(
      {
        events: [
          {
            title: "讨论校园记忆展",
            date: "2026-08-29",
            people: ["张伟"],
            confidence: 0.99,
          },
        ],
      },
      "张伟不会在 2026 年 8 月 29 日讨论校园记忆展。",
    );
    const wrongSubject = enforceSensitiveFieldGrounding(
      {
        events: [
          {
            title: "讨论校园记忆展",
            date: "2026-08-29",
            people: ["张伟"],
            confidence: 0.99,
          },
        ],
      },
      "李雷而不是张伟将在 2026 年 8 月 29 日讨论校园记忆展。",
    );

    expect([
      negated.events?.[0]?._groundingVerified,
      wrongSubject.events?.[0]?._groundingVerified,
    ]).toEqual([false, false]);
  });

  test("preserves a user-restored value as manual rather than AI-grounded", () => {
    const grounded = enforceSensitiveFieldGrounding(
      { people: [{ name: "张伟", contact: "zhangwei@example.com" }] },
      "张伟是大学同学。",
    );
    const restored = markSensitiveFieldsManual(
      { ...grounded.people![0], contact: "zhangwei@example.com" },
      ["contact"],
    );
    const rechecked = enforceSensitiveFieldGrounding({ people: [restored] }, "张伟是大学同学。");

    expect(rechecked.people?.[0]?.contact).toBe("zhangwei@example.com");
    expect(rechecked.people?.[0]?._fieldGrounding?.contact).toEqual({ status: "manual" });
    expect(rechecked._groundingWarnings).toEqual([]);
  });

  test("preserves an untouched grounding warning when a soft-warning draft is revalidated", () => {
    const firstPass = enforceSensitiveFieldGrounding(
      { people: [{ name: "张伟", contact: "zhangwei@example.com" }] },
      "张伟是大学同学。",
    );
    const secondPass = enforceSensitiveFieldGrounding(firstPass, "张伟是大学同学。");

    expect(firstPass._groundingWarnings).toHaveLength(1);
    expect(secondPass._groundingWarnings).toEqual(firstPass._groundingWarnings);
  });
});
