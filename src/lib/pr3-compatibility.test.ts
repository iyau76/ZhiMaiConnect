import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { LifeEventRecord, RelationRecord } from "./face-db";
import {
  buildFamilyTreeLayout,
  familyTreeEdgeKind,
  isFamilyTreeRelation,
} from "./family-tree-layout";
import { RELATION_PREDICATES, relationCategoryFor } from "./relation-ontology";

beforeEach(() => {
  vi.resetModules();
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    writable: true,
    value: new IDBFactory(),
  });
});

describe("PR #3 event mutation compatibility", () => {
  const precisions: Array<LifeEventRecord["precision"]> = [
    undefined,
    "day",
    "month",
    "year",
    "range",
  ];

  it.each(precisions)(
    "preserves existing %s precision for a full-date-only update",
    async (precision) => {
      const { facesDb } = await import("./face-db");
      const {
        applyArchiveMutationPlan,
        createArchiveMutationPlan,
        createUpdateEventOperation,
        eventMutationPatchSchema,
        loadArchiveMutationSnapshot,
      } = await import("./archive-mutation-plan");
      const event: LifeEventRecord = {
        id: "legacy-event",
        date: "2026-06-01",
        precision,
        dateEnd: precision === "range" ? "2026-08-31" : undefined,
        dateText: "原始时间描述",
        title: "合成事件",
        createdAt: 1,
        updatedAt: 1,
      };
      await facesDb.putLifeEvent(event);
      const changes = { set: { date: "2026-07-01" } };
      expect(eventMutationPatchSchema.parse(changes)).toEqual(changes);
      const operation = createUpdateEventOperation(await loadArchiveMutationSnapshot(), {
        eventId: event.id,
        reason: "只调整起始日期",
        changes,
      });
      expect(operation.changes.set).not.toHaveProperty("precision");
      await applyArchiveMutationPlan(
        createArchiveMutationPlan({
          title: "更新旧事件",
          reason: "保持旧请求的含义",
          operations: [operation],
        }),
        { now: 2 },
      );
      const [stored] = await facesDb.listLifeEvents();
      expect(stored.date).toBe("2026-07-01");
      expect(stored.precision).toBe(precision);
      expect(stored.dateEnd).toBe(event.dateEnd);
      expect(stored.dateText).toBe(event.dateText);
    },
  );

  it("allows setting a full date while explicitly unsetting precision", async () => {
    const { facesDb } = await import("./face-db");
    const {
      applyArchiveMutationPlan,
      createArchiveMutationPlan,
      createUpdateEventOperation,
      loadArchiveMutationSnapshot,
    } = await import("./archive-mutation-plan");
    await facesDb.putLifeEvent({
      id: "clear-precision",
      date: "2020-01-01",
      precision: "year",
      title: "合成事件",
      createdAt: 1,
    });
    const operation = createUpdateEventOperation(await loadArchiveMutationSnapshot(), {
      eventId: "clear-precision",
      reason: "用户明确清除精度",
      changes: { set: { date: "2020-06-12" }, unset: ["precision"] },
    });
    await applyArchiveMutationPlan(
      createArchiveMutationPlan({
        title: "清除精度",
        reason: "旧版支持的组合请求",
        operations: [operation],
      }),
      { now: 2 },
    );
    const [stored] = await facesDb.listLifeEvents();
    expect(stored.date).toBe("2020-06-12");
    expect(stored).not.toHaveProperty("precision");
  });

  it.each([
    { date: "2020", normalized: "2020-01-01", precision: "year" },
    { date: "2026-08", normalized: "2026-08-01", precision: "month" },
  ])(
    "retains shorthand inference for $date and remains idempotent",
    async ({ date, normalized, precision }) => {
      const { eventMutationPatchSchema } = await import("./archive-mutation-plan");
      const parsed = eventMutationPatchSchema.parse({ set: { date } });
      expect(parsed).toEqual({ set: { date: normalized, precision } });
      expect(eventMutationPatchSchema.parse(parsed)).toEqual(parsed);
    },
  );

  it("honors explicit precision and still rejects a real set/unset conflict", async () => {
    const { eventMutationPatchSchema } = await import("./archive-mutation-plan");
    expect(
      eventMutationPatchSchema.parse({ set: { date: "2020-06-12", precision: "day" } }),
    ).toEqual({
      set: { date: "2020-06-12", precision: "day" },
    });
    expect(() =>
      eventMutationPatchSchema.parse({
        set: { date: "2020-06-12", precision: "day" },
        unset: ["precision"],
      }),
    ).toThrow(/同时/);
  });
});

function relation(predicate: RelationRecord["predicate"], id = "relation"): RelationRecord {
  return { id, fromId: "a", toId: "b", predicate, label: "合成亲属关系", createdAt: 1 };
}

const people = [
  { id: "a", name: "甲" },
  { id: "b", name: "乙" },
  { id: "c", name: "丙" },
];

describe("PR #3 family-tree edge completeness", () => {
  it.each(RELATION_PREDICATES.filter((predicate) => relationCategoryFor(predicate) === "kinship"))(
    "renders every accepted %s relation without changing source records",
    (predicate) => {
      const record = relation(predicate);
      const before = structuredClone(record);
      expect(isFamilyTreeRelation(record)).toBe(true);
      expect(familyTreeEdgeKind(record)).not.toBeNull();
      const layout = buildFamilyTreeLayout({ people, relations: [record] });
      expect(layout.edges).toHaveLength(1);
      expect(layout.edges[0]).toMatchObject({
        relationId: record.id,
        fromId: "a",
        toId: "b",
        label: record.label,
      });
      expect(layout.nodes.map((node) => node.id)).toEqual(["a", "b", "c"]);
      expect(record).toEqual(before);
    },
  );

  it("keeps the cousin connected in a parent/daughter plus cousin graph", () => {
    const parent = { ...relation("parent_of", "parent"), label: "父女" };
    const cousin = { ...relation("cousin_of", "cousin"), fromId: "b", toId: "c", label: "表亲" };
    const layout = buildFamilyTreeLayout({ people, relations: [parent, cousin] });
    expect(layout.edges.map((edge) => edge.relationId)).toEqual(["cousin", "parent"]);
    expect(layout.edges.find((edge) => edge.relationId === "cousin")).toMatchObject({
      fromId: "b",
      toId: "c",
      kind: "kinship",
    });
    expect(layout.nodes.find((node) => node.id === "b")?.generation).toBe(1);
  });

  it.each([
    "grandparent_of",
    "great_grandparent_of",
    "uncle_aunt_of",
    "in_law_of",
    "clan_of",
  ] as const)("does not force %s endpoints into the same generation", (predicate) => {
    const layout = buildFamilyTreeLayout({
      people,
      relations: [relation("parent_of", "parent"), relation(predicate, "extended")],
    });
    expect(layout.edges).toHaveLength(2);
    expect(layout.nodes.find((node) => node.id === "a")?.generation).toBe(0);
    expect(layout.nodes.find((node) => node.id === "b")?.generation).toBe(1);
  });

  it("also keeps legacy label-only kinship and excludes social relationships", () => {
    const legacy = { ...relation(undefined, "legacy"), label: "祖孙" };
    const social = relation("friend_of", "social");
    const layout = buildFamilyTreeLayout({ people, relations: [legacy, social] });
    expect(layout.edges.map((edge) => edge.relationId)).toEqual(["legacy"]);
    expect(familyTreeEdgeKind(social)).toBeNull();
  });
});
