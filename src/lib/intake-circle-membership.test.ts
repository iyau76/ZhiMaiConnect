import { describe, expect, it } from "vitest";

import type { CollectionMembershipRecord, CollectionRecord } from "./face-db";
import type { IngestCollection } from "./intake-draft";
import {
  addableCircles,
  effectiveCircles,
  membershipEntry,
  metadataRepair,
  newCircleRow,
  resolvePersonRef,
  savedCircleRow,
} from "./intake-circle-membership";

/** 与 intake-panel 里 CREATE_NEW_PERSON 同义的哨兵，用来证明它不会被当成档案 id。 */
const CREATE_NEW = "__create_new__";

function savedCollection(
  id: string,
  name: string,
  kind: CollectionRecord["kind"] = "relationship_circle",
  color?: string,
): CollectionRecord {
  return { id, name, kind, color, createdAt: 1, updatedAt: 1 };
}

function membership(collectionId: string, personId: string): CollectionMembershipRecord {
  return {
    id: `${collectionId}\u0000${personId}`,
    collectionId,
    personId,
    source: "manual",
    createdAt: 1,
  };
}

const base = {
  drafts: undefined as IngestCollection[] | undefined,
  collections: [] as CollectionRecord[],
  memberships: [] as CollectionMembershipRecord[],
  createNewSentinel: CREATE_NEW,
  unnamedLabel: "未命名圈层",
};

describe("圈层成员投影", () => {
  it("人物卡里新建的圈层是关系圈层，不会退化成不参与布局的场景集合", () => {
    const row = newCircleRow({
      targetCollectionId: "collection:new",
      draftId: "draft:collection:new",
      name: "读书会",
      membership: membershipEntry({
        person: { name: "甲", _draftId: "d1" },
        existingId: null,
        action: "add",
      }),
      unnamedLabel: "未命名圈层",
    });

    expect(row.kind).toBe("relationship_circle");
    expect(row.name).toBe("读书会");
  });

  it("只给已有圈层加成员时保留原颜色与类型", () => {
    const saved = savedCollection("c1", "大学同学", "relationship_circle", "#aabbcc");
    const row = savedCircleRow({
      targetCollectionId: "c1",
      draftId: "draft:collection:c1",
      memberships: [
        membershipEntry({
          person: { name: "甲", _draftId: "d1" },
          existingId: null,
          action: "add",
        }),
      ],
      saved,
      unnamedLabel: "未命名圈层",
    });

    expect(row.color).toBe("#aabbcc");
    expect(row.kind).toBe("relationship_circle");
    expect(metadataRepair({ kind: "relationship_circle" }, saved)).toEqual({ color: "#aabbcc" });
  });

  it("已保存的场景集合只加成员时仍是场景集合，不被悄悄改类型", () => {
    const saved = savedCollection("c9", "毕业旅行", "context", "#123456");
    const row = savedCircleRow({
      targetCollectionId: "c9",
      draftId: "draft:collection:c9",
      memberships: [
        membershipEntry({
          person: { name: "甲", _draftId: "d1" },
          existingId: null,
          action: "add",
        }),
      ],
      saved,
      unnamedLabel: "未命名圈层",
    });

    expect(row.kind).toBe("context");
    expect(row.color).toBe("#123456");
  });

  it("只看这个人的备注更新时，也能看到他已经属于的圈层", () => {
    const input = {
      ...base,
      person: { targetPersonId: "p-alice" },
      collections: [savedCollection("c1", "大学同学")],
      memberships: [membership("c1", "p-alice")],
    };

    expect(effectiveCircles(input).map((row) => row.id)).toEqual(["c1"]);
    expect(addableCircles(input).map((row) => row.id)).toEqual([]);
  });

  it("草稿里用档案 id 写的加入与移出都会反映到成员状态", () => {
    const drafts: IngestCollection[] = [
      {
        _draftId: "draft:collection:c1",
        targetCollectionId: "c1",
        name: "大学同学",
        kind: "relationship_circle",
        memberships: [{ person: "甲", personId: "p-alice", action: "remove" }],
      },
      {
        _draftId: "draft:collection:c2",
        targetCollectionId: "c2",
        name: "读书会",
        kind: "relationship_circle",
        memberships: [{ person: "甲", personId: "p-alice", action: "add" }],
      },
    ];
    const input = {
      ...base,
      person: { targetPersonId: "p-alice" },
      collections: [savedCollection("c1", "大学同学"), savedCollection("c2", "读书会")],
      memberships: [membership("c1", "p-alice")],
      drafts,
    };

    expect(effectiveCircles(input).map((row) => row.id)).toEqual(["c2"]);
  });

  it("本批次刚给甲建的圈层，乙可以直接加入，不会被迫再建一个同名圈层", () => {
    const drafts: IngestCollection[] = [
      newCircleRow({
        targetCollectionId: "collection:new",
        draftId: "draft:collection:new",
        name: "共同项目",
        membership: membershipEntry({
          person: { name: "甲", _draftId: "d1" },
          existingId: null,
          action: "add",
        }),
        unnamedLabel: "未命名圈层",
      }),
    ];

    const forOther = { ...base, person: { targetPersonId: CREATE_NEW, _draftId: "d2" }, drafts };
    expect(addableCircles(forOther).map((row) => row.id)).toEqual(["collection:new"]);

    const forOwner = { ...base, person: { targetPersonId: CREATE_NEW, _draftId: "d1" }, drafts };
    expect(effectiveCircles(forOwner).map((row) => row.id)).toEqual(["collection:new"]);
    expect(addableCircles(forOwner).map((row) => row.id)).toEqual([]);
  });

  it("记录型圈层默认不参与圈层编辑", () => {
    const input = {
      ...base,
      person: { targetPersonId: "p-alice" },
      collections: [savedCollection("cc", "算法社区", "computed_community")],
      memberships: [membership("cc", "p-alice")],
    };

    expect(effectiveCircles(input)).toEqual([]);
    expect(addableCircles(input)).toEqual([]);
  });

  it("新建人物用草稿 id 追踪，哨兵不会被当成档案 id", () => {
    expect(resolvePersonRef({ targetPersonId: CREATE_NEW, _draftId: "d1" }, CREATE_NEW)).toEqual({
      existingId: null,
      draftId: "d1",
    });
    expect(resolvePersonRef({ targetPersonId: "p-alice", _draftId: "d1" }, CREATE_NEW)).toEqual({
      existingId: "p-alice",
      draftId: "d1",
    });
  });
});
