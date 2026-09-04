import { describe, expect, it } from "vitest";

import { compileAssistantSemanticMutation } from "./assistant-semantic-mutation-compiler";
import type { ArchiveRecordResolverSnapshot } from "./archive-record-resolver";

function person(id: string, name: string, org?: string, alias?: string) {
  return {
    id,
    name,
    note: "",
    profile: {
      ...(org ? { org } : {}),
      ...(alias ? { identities: [{ platform: "微信", alias }] } : {}),
    },
    descriptors: [],
    thumb: "",
    createdAt: 1,
  };
}

function snapshot(
  persons: ArchiveRecordResolverSnapshot["persons"],
): ArchiveRecordResolverSnapshot {
  return { persons, relations: [], events: [], collections: [], collectionMemberships: [] };
}

describe("assistant semantic mutation compiler", () => {
  it("resolves an aliased person at the tail of a 500-person archive locally", () => {
    const tailId = "4ec23e68-d96c-48ab-bf2a-c8ac0d1d79d2";
    const persons = [
      ...Array.from({ length: 499 }, (_, index) => person(`person-${index}`, `合成人物${index}`)),
      person(tailId, "周明远", "北辰设计院", "老周"),
    ];
    const candidate = {
      title: "更新周明远职位",
      reason: "用户明确说明职位变化",
      operations: [
        {
          operationRef: "update-tail-person",
          kind: "update_person",
          target: { kind: "person", name: "老周", hints: { org: "北辰设计院" } },
          reason: "用户明确说明职位变化",
          changes: { set: { profile: { title: "设计总监" } } },
        },
      ],
    };

    expect(JSON.stringify(candidate)).not.toContain(tailId);
    expect(compileAssistantSemanticMutation({ candidate, snapshot: snapshot(persons) })).toEqual({
      request: {
        title: "更新周明远职位",
        reason: "用户明确说明职位变化",
        operations: [
          {
            kind: "update_person",
            personId: tailId,
            reason: "用户明确说明职位变化",
            changes: { set: { profile: { title: "设计总监" } } },
          },
        ],
      },
      issues: [],
      resolvedOperationRefs: ["update-tail-person"],
    });
  });

  it("uses semantic hints to disambiguate same-name people", () => {
    const result = compileAssistantSemanticMutation({
      candidate: {
        title: "更新王晨职位",
        reason: "用户指出了所在机构",
        operations: [
          {
            kind: "update_person",
            target: { kind: "person", name: "王晨", hints: { org: "知脉工作室" } },
            reason: "用户指出了所在机构",
            changes: { set: { profile: { title: "产品经理" } } },
          },
        ],
      },
      snapshot: snapshot([
        person("wang-school", "王晨", "第一中学"),
        person("wang-zhimai", "王晨", "知脉工作室"),
      ]),
    });

    expect(result.issues).toEqual([]);
    expect(result.request?.operations).toContainEqual(
      expect.objectContaining({ kind: "update_person", personId: "wang-zhimai" }),
    );
  });

  it("keeps resolved siblings when another semantic target is ambiguous", () => {
    const result = compileAssistantSemanticMutation({
      candidate: {
        title: "批量更新人物",
        reason: "用户一次说明了两项变化",
        operations: [
          {
            operationRef: "ambiguous-wang",
            kind: "update_person",
            target: { kind: "person", name: "王晨" },
            reason: "用户要求更新",
            changes: { set: { profile: { title: "负责人" } } },
          },
          {
            operationRef: "resolved-zhou",
            kind: "update_person",
            target: { kind: "person", name: "周宁" },
            reason: "用户要求更新",
            changes: { set: { profile: { title: "设计师" } } },
          },
        ],
      },
      snapshot: snapshot([
        person("wang-a", "王晨", "甲公司"),
        person("wang-b", "王晨", "乙公司"),
        person("zhou", "周宁", "知脉工作室"),
      ]),
    });

    expect(result.request?.operations).toEqual([
      expect.objectContaining({ kind: "update_person", personId: "zhou" }),
    ]);
    expect(result.resolvedOperationRefs).toEqual(["resolved-zhou"]);
    expect(result.issues).toEqual([
      expect.objectContaining({
        operationRef: "ambiguous-wang",
        code: "ambiguous",
        path: "target",
        candidates: [
          { label: "王晨", domain: "person" },
          { label: "王晨", domain: "person" },
        ],
      }),
    ]);
  });

  it("rejects a raw ID even when it points to an existing but wrong person", () => {
    const result = compileAssistantSemanticMutation({
      candidate: {
        title: "更新小雨职位",
        reason: "用户要求更新小雨",
        operations: [
          {
            kind: "update_person",
            personId: "another-existing-person",
            reason: "用户要求更新小雨",
            changes: { set: { profile: { title: "品牌总监" } } },
          },
        ],
      },
      snapshot: snapshot([person("xiaoyu", "小雨"), person("another-existing-person", "周宁")]),
    });

    expect(result.request).toBeUndefined();
    expect(result.resolvedOperationRefs).toEqual([]);
    expect(result.issues).toEqual([
      expect.objectContaining({
        code: "raw_id_forbidden",
        path: "personId",
        message: expect.stringContaining("不接受稳定 ID 字段"),
      }),
    ]);
  });

  it("compiles relation, event, collection, migration and deletion references without model IDs", () => {
    const fullSnapshot: ArchiveRecordResolverSnapshot = {
      persons: [person("p-a", "唐悦"), person("p-b", "周宁")],
      relations: [{ id: "relation-a-b", fromId: "p-a", toId: "p-b", label: "同事", createdAt: 1 }],
      events: [
        {
          id: "event-exhibition",
          title: "校园记忆展",
          date: "2026-09-02",
          personIds: ["p-a"],
          createdAt: 1,
        },
      ],
      collections: [
        {
          id: "collection-colleagues",
          name: "同事",
          kind: "relationship_circle",
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: "collection-project",
          name: "记忆展项目",
          kind: "context",
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      collectionMemberships: [
        {
          id: "membership-a",
          collectionId: "collection-colleagues",
          personId: "p-a",
          source: "manual",
          createdAt: 1,
        },
      ],
    };
    const candidate = {
      title: "整理关系与事件",
      reason: "用户明确提出整批修改",
      operations: [
        {
          kind: "update_relation",
          target: {
            kind: "relation",
            from: { kind: "person", name: "唐悦" },
            to: { kind: "person", name: "周宁" },
            label: "同事",
          },
          reason: "两人已经离职",
          changes: { label: "前同事" },
        },
        {
          kind: "update_event",
          target: {
            kind: "event",
            title: "校园记忆展",
            date: "2026-09-02",
            person: { kind: "person", name: "唐悦" },
          },
          reason: "补充地点与参与人",
          changes: {
            set: { place: "校史馆", people: [{ kind: "person", name: "周宁" }] },
          },
        },
        {
          kind: "organize_collection",
          target: { kind: "collection", name: "同事" },
          reason: "补充圈层成员",
          addPeople: [{ kind: "person", name: "周宁" }],
        },
        {
          kind: "migrate_collection_members",
          source: { kind: "collection", name: "同事" },
          target: { kind: "collection", name: "记忆展项目" },
          selectedPeople: [{ kind: "person", name: "唐悦" }],
          reason: "调整圈层",
        },
        {
          kind: "delete_person",
          target: { kind: "person", name: "周宁" },
          reason: "用户明确要求删除",
        },
      ],
    };

    expect(JSON.stringify(candidate)).not.toMatch(
      /personId|relationId|eventId|collectionId|sourceCollectionId|selectedPersonIds/u,
    );
    const result = compileAssistantSemanticMutation({ candidate, snapshot: fullSnapshot });
    expect(result.issues).toEqual([]);
    expect(result.request?.operations).toEqual([
      expect.objectContaining({ kind: "update_relation", relationId: "relation-a-b" }),
      expect.objectContaining({
        kind: "update_event",
        eventId: "event-exhibition",
        changes: { set: { place: "校史馆", personIds: ["p-b"] } },
      }),
      expect.objectContaining({
        kind: "organize_collection",
        collectionId: "collection-colleagues",
        addPersonIds: ["p-b"],
      }),
      expect.objectContaining({
        kind: "migrate_collection_members",
        sourceCollectionId: "collection-colleagues",
        target: expect.objectContaining({ collectionId: "collection-project" }),
        selectedPersonIds: ["p-a"],
      }),
      expect.objectContaining({ kind: "delete_person", personId: "p-b" }),
    ]);
  });
});
