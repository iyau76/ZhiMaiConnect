import { describe, expect, it } from "vitest";

import {
  parseSemanticCollectionClassificationBatch,
  semanticIntakePlanSchema,
  semanticRecordRefSchema,
} from "./intake-semantic-plan";

describe("semantic intake plan", () => {
  it("expresses archive changes without model-visible UUIDs", () => {
    const plan = semanticIntakePlanSchema.parse({
      version: 1,
      type: "semantic_plan",
      summary: "更新人物关系与圈层",
      tasks: [
        {
          id: "person-1",
          domain: "person",
          intent: "update",
          target: { kind: "person", name: "张伟", hints: { org: "设计院" } },
          changes: { title: "品牌总监" },
        },
        {
          id: "relation-1",
          domain: "relation",
          intent: "update",
          target: {
            kind: "relation",
            from: { kind: "self" },
            to: { kind: "person", name: "张伟", hints: { alias: "阿伟" } },
            label: "同事",
          },
          changes: { label: "前同事", predicate: "colleague_of" },
        },
        {
          id: "collection-1",
          domain: "collection",
          intent: "organize",
          target: { kind: "collection", name: "同事", collectionKind: "relationship_circle" },
          memberships: [{ people: { kind: "person_selection", scope: "all" }, action: "add" }],
        },
      ],
    });

    expect(plan.tasks).toHaveLength(3);
    expect(JSON.stringify(plan)).not.toContain("personId");
  });

  it("accepts workspace refs and rejects archive UUID fields", () => {
    expect(
      semanticRecordRefSchema.parse({
        kind: "workspace",
        domain: "event",
        recordRef: "draft:event:meeting",
      }),
    ).toMatchObject({ kind: "workspace", domain: "event" });

    expect(() =>
      semanticRecordRefSchema.parse({
        kind: "person",
        name: "唐悦",
        personId: "a-fixed-archive-id",
      }),
    ).toThrow();

    expect(() =>
      semanticIntakePlanSchema.parse({
        version: 1,
        type: "semantic_plan",
        tasks: [
          {
            id: "bad-id-copy",
            domain: "person",
            intent: "update",
            target: { kind: "person", name: "唐悦" },
            changes: { id: "a-fixed-archive-id", title: "品牌总监" },
          },
        ],
      }),
    ).toThrow("稳定 ID 字段");
  });

  it("rejects duplicate task ids", () => {
    const task = {
      id: "same",
      domain: "event",
      intent: "update",
      target: { kind: "event", title: "校庆" },
      changes: { date: "2026-09-02" },
    };
    expect(() =>
      semanticIntakePlanSchema.parse({
        version: 1,
        type: "semantic_plan",
        tasks: [task, task],
      }),
    ).toThrow("重复任务 ID");
  });

  it("declares whole-library classification without enumerating people", () => {
    const plan = semanticIntakePlanSchema.parse({
      version: 1,
      type: "semantic_plan",
      tasks: [
        {
          id: "classify-all",
          domain: "collection",
          intent: "classify",
          target: { kind: "person_selection", scope: "all" },
          guidance: "按真实生活关系整理圈层",
        },
      ],
    });
    expect(plan.tasks[0]).toMatchObject({ intent: "classify", target: { scope: "all" } });
    expect(JSON.stringify(plan)).not.toMatch(/personId|collectionId|membershipId/);
  });

  it("keeps valid classifier rows when a sibling row is malformed", () => {
    const parsed = parseSemanticCollectionClassificationBatch({
      version: 1,
      type: "collection_classification_batch",
      taskRef: "classify-all",
      batchRef: "batch-0001",
      assignments: [
        { ref: "person-000001", collections: [{ name: "同事" }] },
        { ref: "person-000002", personId: "archive-id", collections: [{ name: "朋友" }] },
      ],
    });
    expect(parsed.assignments).toEqual([
      expect.objectContaining({ ref: "person-000001", collections: [{ name: "同事" }] }),
    ]);
    expect(parsed.issues).toEqual([
      expect.objectContaining({ ref: "person-000002", assignmentIndex: 1 }),
    ]);
  });
});
