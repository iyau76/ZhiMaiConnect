import { describe, expect, it } from "vitest";

import type { PersonRecord } from "./face-db";
import { compileSemanticIntakePlan } from "./intake-semantic-compiler";

function person(id: string, name: string, org?: string): PersonRecord {
  return {
    id,
    name,
    note: "",
    descriptors: [],
    thumb: "",
    createdAt: 1,
    profile: org ? { org } : undefined,
  };
}

const emptySnapshot = {
  persons: [],
  relations: [],
  events: [],
  collections: [],
  collectionMemberships: [],
};

describe("semantic intake compiler", () => {
  it("keeps resolvable siblings when one same-name target is ambiguous", () => {
    const compilation = compileSemanticIntakePlan({
      candidate: {
        version: 1,
        type: "semantic_plan",
        summary: "更新张伟，并新增林柚",
        tasks: [
          {
            id: "ambiguous-zhang",
            domain: "person",
            intent: "update",
            target: { kind: "person", name: "张伟" },
            changes: { title: "产品经理" },
          },
          {
            id: "create-lin",
            domain: "person",
            intent: "create",
            target: { kind: "person", name: "林柚" },
            changes: { title: "设计师" },
          },
        ],
      },
      snapshot: {
        ...emptySnapshot,
        persons: [person("zhang-design", "张伟", "设计院"), person("zhang-school", "张伟", "学校")],
      },
    });

    expect(compilation.draft.people).toEqual([
      expect.objectContaining({ name: "林柚", title: "设计师" }),
    ]);
    expect(compilation.issues).toEqual([
      expect.objectContaining({ taskId: "ambiguous-zhang", code: "ambiguous" }),
    ]);
    expect(compilation.state.tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          task: expect.objectContaining({ id: "ambiguous-zhang" }),
          status: "needs_input",
        }),
        expect.objectContaining({
          task: expect.objectContaining({ id: "create-lin" }),
          status: "proposed",
        }),
      ]),
    );
  });

  it("resolves a new person locally for a relation in the same semantic plan", () => {
    const compilation = compileSemanticIntakePlan({
      candidate: {
        version: 1,
        type: "semantic_plan",
        tasks: [
          {
            id: "create-lin",
            domain: "person",
            intent: "create",
            target: { kind: "person", name: "林柚" },
            changes: { title: "设计师" },
          },
          {
            id: "relation-lin",
            domain: "relation",
            intent: "create",
            target: {
              kind: "relation",
              from: { kind: "self" },
              to: { kind: "person", name: "林柚" },
            },
            changes: { label: "同学", basis: "原文：林柚是我的同学" },
          },
        ],
      },
      snapshot: emptySnapshot,
    });

    expect(compilation.issues).toEqual([]);
    expect(compilation.draft.people?.[0]?._draftId).toBe("draft:person:create-lin");
    expect(compilation.draft.relations?.[0]).toMatchObject({
      fromPersonId: "zhimai:self",
      toDraftId: "draft:person:create-lin",
      label: "同学",
    });
  });

  it("updates workspace records without leaking or dropping their local bindings", () => {
    const compilation = compileSemanticIntakePlan({
      candidate: {
        version: 1,
        type: "semantic_plan",
        tasks: [
          {
            id: "update-fact",
            domain: "fact",
            intent: "update",
            target: { kind: "workspace", domain: "fact", recordRef: "draft:fact:role" },
            changes: { value: "品牌总监" },
          },
          {
            id: "update-relation",
            domain: "relation",
            intent: "update",
            target: { kind: "workspace", domain: "relation", recordRef: "draft:relation:peer" },
            changes: { label: "前同事" },
          },
          {
            id: "update-event",
            domain: "event",
            intent: "update",
            target: { kind: "workspace", domain: "event", recordRef: "draft:event:review" },
            changes: { date: "2026-09-04" },
          },
          {
            id: "update-reminder",
            domain: "reminder",
            intent: "update",
            target: {
              kind: "workspace",
              domain: "reminder",
              recordRef: "draft:reminder:follow-up",
            },
            changes: { due: "2026-09-05" },
          },
        ],
      },
      snapshot: {
        ...emptySnapshot,
        workspace: {
          people: [
            { name: "唐悦", _draftId: "draft:person:tang", targetPersonId: "archive-tang" },
            { name: "周宁", _draftId: "draft:person:zhou", targetPersonId: "archive-zhou" },
          ],
          facts: [
            {
              person: "唐悦",
              key: "职务",
              value: "设计师",
              _draftId: "draft:fact:role",
              personDraftId: "draft:person:tang",
              personId: "archive-tang",
            },
          ],
          relations: [
            {
              from: "唐悦",
              to: "周宁",
              label: "同事",
              _draftId: "draft:relation:peer",
              fromDraftId: "draft:person:tang",
              toDraftId: "draft:person:zhou",
              fromPersonId: "archive-tang",
              toPersonId: "archive-zhou",
            },
          ],
          events: [
            {
              title: "项目复盘",
              people: ["唐悦"],
              _draftId: "draft:event:review",
              peopleDraftIds: ["draft:person:tang"],
              peoplePersonIds: ["archive-tang"],
            },
          ],
          reminders: [
            {
              title: "跟进项目",
              people: ["周宁"],
              _draftId: "draft:reminder:follow-up",
              peopleDraftIds: ["draft:person:zhou"],
              peoplePersonIds: ["archive-zhou"],
            },
          ],
        },
      },
    });

    expect(compilation.issues).toEqual([]);
    expect(compilation.draft.facts?.[0]).toMatchObject({
      value: "品牌总监",
      personDraftId: "draft:person:tang",
      personId: "archive-tang",
    });
    expect(compilation.draft.relations?.[0]).toMatchObject({
      label: "前同事",
      fromDraftId: "draft:person:tang",
      toDraftId: "draft:person:zhou",
      fromPersonId: "archive-tang",
      toPersonId: "archive-zhou",
    });
    expect(compilation.draft.events?.[0]).toMatchObject({
      date: "2026-09-04",
      peopleDraftIds: ["draft:person:tang"],
      peoplePersonIds: ["archive-tang"],
    });
    expect(compilation.draft.reminders?.[0]).toMatchObject({
      due: "2026-09-05",
      peopleDraftIds: ["draft:person:zhou"],
      peoplePersonIds: ["archive-zhou"],
    });
  });

  it("preserves untouched manual person fields and their provenance across supplements", () => {
    const compilation = compileSemanticIntakePlan({
      candidate: {
        version: 1,
        type: "semantic_plan",
        tasks: [
          {
            id: "supplement-note",
            domain: "person",
            intent: "update",
            target: { kind: "workspace", domain: "person", recordRef: "draft:person:tang" },
            changes: { note: "愿意帮校园记忆展拍摄" },
          },
        ],
      },
      snapshot: {
        ...emptySnapshot,
        workspace: {
          people: [
            {
              name: "唐悦",
              note: "摄影社搭档",
              closeness: 4,
              _draftId: "draft:person:tang",
              targetPersonId: "archive-tang",
              _fieldGrounding: { closeness: { status: "manual" } },
              _audit: {
                confirmationStatus: "pending",
                humanEdited: true,
                sourceSummary: "草稿中人工编辑",
                extractedAt: 1,
              },
            },
          ],
        },
      },
    });

    expect(compilation.draft.people?.[0]).toMatchObject({
      name: "唐悦",
      note: "愿意帮校园记忆展拍摄",
      closeness: 4,
      targetPersonId: "archive-tang",
      _fieldGrounding: { closeness: { status: "manual" } },
      _audit: { humanEdited: true },
    });
  });

  it("compiles collection membership into the formal mutation domain", () => {
    const compilation = compileSemanticIntakePlan({
      candidate: {
        version: 1,
        type: "semantic_plan",
        summary: "把所有联系人加入同事圈",
        tasks: [
          {
            id: "organize-colleagues",
            domain: "collection",
            intent: "organize",
            target: {
              kind: "collection",
              name: "同事",
              collectionKind: "relationship_circle",
            },
            memberships: [{ people: { kind: "person_selection", scope: "all" }, action: "add" }],
          },
        ],
      },
      snapshot: {
        ...emptySnapshot,
        persons: [person("p1", "唐悦"), person("p2", "周宁")],
        collections: [
          {
            id: "circle-work",
            name: "同事",
            kind: "relationship_circle" as const,
            createdAt: 1,
            updatedAt: 1,
          },
        ],
        collectionMemberships: [
          {
            id: "circle-work\0p1",
            collectionId: "circle-work",
            personId: "p1",
            source: "manual" as const,
            createdAt: 1,
          },
        ],
      },
    });

    expect(compilation.proposal?.operations).toEqual([
      expect.objectContaining({
        kind: "organize_collection",
        targetId: "circle-work",
        memberships: [
          expect.objectContaining({ personId: "p2", action: "add", expectedRevision: null }),
        ],
      }),
    ]);
    expect(JSON.stringify(compilation.plan)).not.toMatch(
      /[a-z]+PersonId|collectionId|membershipId/,
    );
  });

  it("compiles local classifier results for same-name people without using names as keys", () => {
    const compilation = compileSemanticIntakePlan({
      candidate: {
        version: 1,
        type: "semantic_plan",
        summary: "重新整理圈层",
        tasks: [
          {
            id: "classify-all",
            domain: "collection",
            intent: "classify",
            target: { kind: "person_selection", scope: "all" },
          },
        ],
      },
      snapshot: {
        ...emptySnapshot,
        persons: [person("same-a", "王晨", "设计院"), person("same-b", "王晨", "出版社")],
        collections: [
          {
            id: "circle-design",
            name: "设计",
            kind: "relationship_circle" as const,
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      },
      collectionClassifications: [
        {
          taskId: "classify-all",
          issues: [],
          assignments: [
            { personId: "same-a", collections: [{ name: "设计" }] },
            { personId: "same-b", collections: [{ name: "出版" }] },
          ],
        },
      ],
    });

    expect(compilation.issues).toEqual([]);
    expect(compilation.proposal?.operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "organize_collection",
          targetId: "circle-design",
          memberships: [expect.objectContaining({ personId: "same-a", action: "add" })],
        }),
        expect.objectContaining({
          kind: "organize_collection",
          replacement: expect.objectContaining({ name: "出版" }),
          memberships: [expect.objectContaining({ personId: "same-b", action: "add" })],
        }),
      ]),
    );
    expect(JSON.stringify(compilation.plan)).not.toContain("same-a");
    expect(JSON.stringify(compilation.plan)).not.toContain("same-b");
  });

  it("leaves an unclassified bad item in its original circle while applying valid siblings", () => {
    const compilation = compileSemanticIntakePlan({
      candidate: {
        version: 1,
        type: "semantic_plan",
        tasks: [
          {
            id: "classify-partial",
            domain: "collection",
            intent: "classify",
            target: { kind: "person_selection", scope: "all" },
          },
        ],
      },
      snapshot: {
        ...emptySnapshot,
        persons: [person("valid", "唐悦"), person("unclassified", "叶青")],
        collections: [
          {
            id: "old-circle",
            name: "旧圈层",
            kind: "relationship_circle" as const,
            createdAt: 1,
            updatedAt: 1,
          },
        ],
        collectionMemberships: [
          {
            id: "old-circle\0valid",
            collectionId: "old-circle",
            personId: "valid",
            source: "manual" as const,
            createdAt: 1,
          },
          {
            id: "old-circle\0unclassified",
            collectionId: "old-circle",
            personId: "unclassified",
            source: "manual" as const,
            createdAt: 1,
          },
        ],
      },
      collectionClassifications: [
        {
          taskId: "classify-partial",
          assignments: [{ personId: "valid", collections: [{ name: "项目伙伴" }] }],
          issues: [
            {
              taskId: "classify-partial",
              stage: "RESOLVE",
              code: "missing",
              message: "叶青所在批次未返回分类",
            },
          ],
        },
      ],
    });

    const oldCircle = compilation.proposal?.operations.find(
      (operation) =>
        operation.kind === "organize_collection" && operation.targetId === "old-circle",
    );
    expect(oldCircle).toMatchObject({
      memberships: [expect.objectContaining({ personId: "valid", action: "remove" })],
    });
    expect(JSON.stringify(oldCircle)).not.toContain("unclassified");
    expect(compilation.issues).toEqual([
      expect.objectContaining({ taskId: "classify-partial", code: "missing" }),
    ]);
  });

  it("turns one malformed task into an issue without discarding valid tasks", () => {
    const compilation = compileSemanticIntakePlan({
      candidate: {
        version: 1,
        type: "semantic_plan",
        tasks: [
          {
            id: "valid-person",
            domain: "person",
            intent: "create",
            target: { kind: "person", name: "叶青" },
            changes: {},
          },
          {
            id: "invalid-event",
            domain: "event",
            intent: "create",
            target: { kind: "event", title: "展览" },
            changes: { personId: "forbidden-id" },
          },
        ],
      },
      snapshot: emptySnapshot,
    });

    expect(compilation.draft.people?.map((item) => item.name)).toEqual(["叶青"]);
    expect(compilation.issues).toEqual([
      expect.objectContaining({ taskId: "invalid-event", stage: "UNDERSTAND", code: "invalid" }),
    ]);
  });
});
