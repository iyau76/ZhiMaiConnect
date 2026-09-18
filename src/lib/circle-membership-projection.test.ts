import { describe, expect, it } from "vitest";
import { santiPack } from "./demo-packs/world/santi";
import type { CollectionMembershipRecord, CollectionRecord } from "./face-db";
import {
  buildCircleMembershipProjection,
  circleSimilarity,
  intersectionMemberIdsOf,
} from "./circle-membership-projection";

function person(id: string) {
  return { id };
}

function circle(id: string, name = id, kind = "relationship_circle") {
  return {
    id,
    name,
    kind: kind as CollectionRecord["kind"],
    createdAt: 0,
    updatedAt: 0,
  } satisfies CollectionRecord;
}

function membership(
  collectionId: string,
  personId: string,
  source: CollectionMembershipRecord["source"] = "manual",
  id = `${collectionId}:${personId}`,
) {
  return { id, collectionId, personId, source, createdAt: 0 } satisfies CollectionMembershipRecord;
}

/** 三体演示库的真实结构：25 人 / 9 圈层 / 33 条成员关系 / 6 组交集 */
function santiFixture() {
  const keys = [...new Set(santiPack.collections.flatMap((item) => item.members))].sort();
  const persons = santiPack.people.map((item) => person(item.key));
  const collections = santiPack.collections.map((item, index) => circle(`c${index}`, item.name));
  const memberships = santiPack.collections.flatMap((item, index) =>
    item.members.map((member) => membership(`c${index}`, member)),
  );
  return { keys, persons, collections, memberships };
}

describe("buildCircleMembershipProjection", () => {
  it("还原三体演示库：25 人不复制、9 个圈层、33 条成员关系", () => {
    const { persons, collections, memberships } = santiFixture();
    const projection = buildCircleMembershipProjection(persons, collections, memberships);

    expect(persons).toHaveLength(25);
    expect(projection.circles).toHaveLength(9);
    expect(projection.circles.reduce((sum, item) => sum + item.memberIds.length, 0)).toBe(33);
    expect(projection.membershipsByPersonId.size).toBe(25);
    expect(
      [...projection.membershipsByPersonId.values()].reduce((sum, ids) => sum + ids.length, 0),
    ).toBe(33);
    expect(projection.unassignedPersonIds).toEqual([]);
    expect(projection.warnings).toEqual([]);
  });

  it("只保留真实存在的 6 组交集，且共同成员与成员表一致", () => {
    const { persons, collections, memberships } = santiFixture();
    const projection = buildCircleMembershipProjection(persons, collections, memberships);
    const nameOf = (id: string) => projection.circles.find((item) => item.id === id)!.name;

    expect(projection.intersections).toHaveLength(6);
    expect(
      projection.intersections.map((item) => [
        item.circleIds.map(nameOf).join(" ∩ "),
        item.memberIds.join("、"),
      ]),
    ).toEqual([
      ["面壁计划 ∩ 罗辑的小家庭", "luoji"],
      ["行星防御理事会 ∩ 阶梯计划", "sayi"],
      ["舰队国际 ∩ 黄金时代旧识", "dingyi"],
      ["舰队国际 ∩ 威慑纪元·星环", "guanyifan"],
      ["红岸基地 ∩ 黄金时代亲属圈", "yangweining、yewenjie"],
      ["阶梯计划 ∩ 威慑纪元·星环", "chengxin、weide"],
    ]);
  });

  it("不把成员组合物化成新圈层，一个人可以有多个圈层", () => {
    const projection = buildCircleMembershipProjection(
      [person("a"), person("b")],
      [circle("c1", "同学"), circle("c2", "同事")],
      [membership("c1", "a"), membership("c2", "a")],
    );
    expect(projection.circles.map((item) => item.id)).toEqual(["c1", "c2"]);
    expect(projection.circles.map((item) => item.memberIds)).toEqual([["a"], ["a"]]);
    expect(projection.membershipsByPersonId.get("a")).toEqual(["c1", "c2"]);
    expect(projection.membershipsByPersonId.get("b")).toEqual([]);
    expect(projection.unassignedPersonIds).toEqual(["b"]);
  });

  it("跳过 context 集合与 computed 成员，重复成员关系只算一次", () => {
    const projection = buildCircleMembershipProjection(
      [person("a")],
      [
        circle("c1", "同学"),
        circle("ctx", "某次活动", "context"),
        circle("cc", "拓扑社区", "computed_community"),
      ],
      [
        membership("c1", "a"),
        membership("c1", "a", "manual", "dup"),
        membership("c1", "a", "ai_approved", "dup2"),
        membership("c1", "a", "computed", "computed-row"),
        membership("ctx", "a"),
        membership("cc", "a"),
      ],
    );
    expect(projection.circles.map((item) => item.id)).toEqual(["c1"]);
    expect(projection.circles[0].memberIds).toEqual(["a"]);
    expect(projection.intersections).toEqual([]);
  });

  it("指不到人的成员关系进 warnings，不静默丢", () => {
    const projection = buildCircleMembershipProjection(
      [person("a")],
      [circle("c1")],
      [membership("c1", "a"), membership("c1", "ghost")],
    );
    expect(projection.circles[0].memberIds).toEqual(["a"]);
    expect(projection.warnings).toEqual(["成员关系指向不存在的人物：ghost"]);
  });

  it("同名不同 ID 是两个人，不是合并键", () => {
    const projection = buildCircleMembershipProjection(
      [person("p1"), person("p2")],
      [circle("c1")],
      [membership("c1", "p1"), membership("c1", "p2")],
    );
    expect(projection.circles[0].memberIds).toEqual(["p1", "p2"]);
  });

  it("支持三重与更多圈层，交集按对列出", () => {
    const circleIds = Array.from({ length: 5 }, (_, index) => `c${index}`);
    const projection = buildCircleMembershipProjection(
      [person("a"), person("b")],
      circleIds.map((id) => circle(id)),
      circleIds.map((id) => membership(id, "a")).concat(membership("c0", "b")),
    );
    expect(projection.membershipsByPersonId.get("a")).toHaveLength(5);
    expect(projection.intersections).toHaveLength(10);
    expect(intersectionMemberIdsOf(projection, ["c0", "c1", "c2", "c3", "c4"])).toEqual(["a"]);
    expect(intersectionMemberIdsOf(projection, ["c0", "c1", "c9"])).toEqual([]);
  });

  it("完全相同的圈层与真子集都按成员表求交集", () => {
    const projection = buildCircleMembershipProjection(
      [person("a"), person("b")],
      [circle("c1", "甲"), circle("c2", "甲（副本）"), circle("c3", "子集")],
      [
        membership("c1", "a"),
        membership("c1", "b"),
        membership("c2", "a"),
        membership("c2", "b"),
        membership("c3", "a"),
      ],
    );
    expect(intersectionMemberIdsOf(projection, ["c1", "c2"])).toEqual(["a", "b"]);
    expect(intersectionMemberIdsOf(projection, ["c1", "c3"])).toEqual(["a"]);
    expect(circleSimilarity(projection, "c1", "c2")).toBe(1);
    expect(circleSimilarity(projection, "c1", "c3")).toBeCloseTo(0.5, 6);
  });

  it("空圈层、孤立人物与互斥圈层都不报错", () => {
    const projection = buildCircleMembershipProjection(
      [person("a"), person("b"), person("lonely")],
      [circle("empty", "空"), circle("c1"), circle("c2")],
      [membership("c1", "a"), membership("c2", "b")],
    );
    expect(projection.circles.map((item) => [item.id, item.memberIds])).toEqual([
      ["c1", ["a"]],
      ["c2", ["b"]],
      ["empty", []],
    ]);
    expect(projection.intersections).toEqual([]);
    expect(projection.unassignedPersonIds).toEqual(["lonely"]);
    expect(circleSimilarity(projection, "c1", "c2")).toBe(0);
    expect(intersectionMemberIdsOf(projection, [])).toEqual([]);
  });

  it("输入顺序不影响输出（同一份档案同一结果）", () => {
    const { persons, collections, memberships } = santiFixture();
    const forward = buildCircleMembershipProjection(persons, collections, memberships);
    const backward = buildCircleMembershipProjection(
      [...persons].reverse(),
      [...collections].reverse(),
      [...memberships].reverse(),
    );
    expect(backward.circles).toEqual(forward.circles);
    expect(backward.intersections).toEqual(forward.intersections);
    expect(backward.unassignedPersonIds).toEqual(forward.unassignedPersonIds);
    expect([...backward.membershipsByPersonId.entries()]).toEqual([
      ...forward.membershipsByPersonId.entries(),
    ]);
  });
});
