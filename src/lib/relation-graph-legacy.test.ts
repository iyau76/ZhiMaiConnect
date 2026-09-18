import { describe, expect, it } from "vitest";
import type { CollectionMembershipRecord, CollectionRecord } from "./face-db";
import {
  DEFAULT_GRAPH_MIN_EDGE,
  buildCircleLayoutProjection,
  layeredRingPoints,
  layoutRingGraph,
  ringRadiusFor,
} from "./relation-graph-legacy";

function circle(id: string, name: string, kind: CollectionRecord["kind"] = "relationship_circle") {
  return { id, name, kind, createdAt: 0, updatedAt: 0 } satisfies CollectionRecord;
}

function membership(
  collectionId: string,
  personId: string,
  source: CollectionMembershipRecord["source"] = "manual",
) {
  return {
    id: `${collectionId}:${personId}`,
    collectionId,
    personId,
    source,
    createdAt: 0,
  } satisfies CollectionMembershipRecord;
}

describe("原版环套环几何", () => {
  it("不分组时排成一个正圆，人多以后转成多层同心环", () => {
    const inner = layeredRingPoints(12, DEFAULT_GRAPH_MIN_EDGE);
    expect(inner.radius).toBeCloseTo(ringRadiusFor(12, DEFAULT_GRAPH_MIN_EDGE), 6);
    expect(inner.points).toHaveLength(12);

    const outer = layeredRingPoints(60, DEFAULT_GRAPH_MIN_EDGE);
    expect(outer.points).toHaveLength(60);
    expect(outer.radius).toBeGreaterThan(inner.radius);
  });

  it("单人簇落在圆心，不会退化成 NaN", () => {
    const layout = layoutRingGraph(
      [{ id: "solo", groupKey: "c1" }],
      [{ key: "c1", label: "圈层" }],
    );
    expect(layout.nodes).toEqual([
      { id: "solo", groupKey: "c1", x: layout.size / 2, y: layout.size / 2 },
    ]);
    expect(Number.isFinite(layout.size)).toBe(true);
  });

  it("分组时各簇互不重叠，画布随簇数变大", () => {
    const nodes = Array.from({ length: 18 }, (_, index) => ({
      id: `p${index}`,
      groupKey: `c${index % 6}`,
    }));
    const groups = Array.from({ length: 6 }, (_, index) => ({
      key: `c${index}`,
      label: `圈层${index}`,
    }));
    const layout = layoutRingGraph(nodes, groups);
    expect(layout.clusters).toHaveLength(6);
    for (const cluster of layout.clusters) {
      for (const other of layout.clusters) {
        if (cluster === other) continue;
        const distance = Math.hypot(cluster.x - other.x, cluster.y - other.y);
        expect(distance).toBeGreaterThan(cluster.r * 0.9);
      }
    }
    expect(layout.size).toBeGreaterThan(600);
  });
});

describe("原版组合簇投影", () => {
  const collections = [
    circle("work", "项目组", "context"),
    circle("family", "家人"),
    circle("computed", "算法社区", "computed_community"),
  ];
  const memberships = [
    membership("work", "alice"),
    membership("family", "alice", "ai_approved"),
    membership("family", "bob", "migration"),
    membership("computed", "bob", "computed"),
  ];

  it("只用已确认的关系圈，一个人多归属时合成一个稳定组合", () => {
    const projection = buildCircleLayoutProjection(
      [{ id: "alice" }, { id: "bob" }],
      [...collections].reverse(),
      [...memberships].reverse(),
    );
    expect(projection.groupByPersonId.get("alice")).toMatchObject({
      label: "家人",
      collectionIds: ["family"],
    });
    expect(projection.groupByPersonId.get("bob")).toMatchObject({
      label: "家人",
      collectionIds: ["family"],
    });
    expect(projection.groups[0].key).toBe("circles:family");
  });

  it("完全不推断圈层：自由文本与 computed 成员都不算", () => {
    const projection = buildCircleLayoutProjection([{ id: "alice" }, { id: "bob" }], collections, [
      membership("computed", "bob", "computed"),
    ]);
    expect(projection.groups).toHaveLength(1);
    expect(projection.groups[0]).toMatchObject({
      key: "circles:none",
      label: "未分圈层",
      memberIds: ["alice", "bob"],
      collectionIds: [],
    });
  });
});
