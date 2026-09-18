import { describe, expect, it } from "vitest";
import { santiPack } from "./demo-packs/world/santi";
import { buildCircleMembershipProjection } from "./circle-membership-projection";
import type { CollectionMembershipRecord, CollectionRecord } from "./face-db";
import {
  GRAPH_ASPECT_BY_CLASS,
  GRAPH_NODE_SPACING,
  applyGraphPins,
  graphAspectClass,
  layoutRelationGraph,
} from "./relation-graph-layout";

function santiInputs() {
  const persons = santiPack.people.map((item) => ({ id: item.key }));
  const collections = santiPack.collections.map(
    (item, index) =>
      ({
        id: `c${index}`,
        name: item.name,
        kind: "relationship_circle",
        createdAt: 0,
        updatedAt: 0,
      }) satisfies CollectionRecord,
  );
  const memberships = santiPack.collections.flatMap((item, index) =>
    item.members.map(
      (member) =>
        ({
          id: `c${index}:${member}`,
          collectionId: `c${index}`,
          personId: member,
          source: "manual",
          createdAt: 0,
        }) satisfies CollectionMembershipRecord,
    ),
  );
  const projection = buildCircleMembershipProjection(persons, collections, memberships);
  return {
    nodes: persons,
    groups: projection.circles.map((circle) => ({
      id: circle.id,
      memberIds: circle.memberIds,
    })),
    links: santiPack.relations
      .map((relation) => [relation.from, relation.to] as [string, string])
      .filter(
        ([from, to]) =>
          persons.some((person) => person.id === from) &&
          persons.some((person) => person.id === to),
      ),
  };
}

function distances(result: ReturnType<typeof layoutRelationGraph>) {
  const nodes = result.nodes;
  let min = Number.POSITIVE_INFINITY;
  for (let left = 0; left < nodes.length; left += 1) {
    for (let right = left + 1; right < nodes.length; right += 1) {
      min = Math.min(
        min,
        Math.hypot(nodes[left].x - nodes[right].x, nodes[left].y - nodes[right].y),
      );
    }
  }
  return min;
}

function radialSpread(result: ReturnType<typeof layoutRelationGraph>) {
  const nodes = result.nodes;
  const centerX = nodes.reduce((sum, node) => sum + node.x, 0) / nodes.length;
  const centerY = nodes.reduce((sum, node) => sum + node.y, 0) / nodes.length;
  const radii = nodes.map((node) => Math.hypot(node.x - centerX, node.y - centerY));
  const mean = radii.reduce((sum, value) => sum + value, 0) / radii.length;
  const deviation = Math.sqrt(
    radii.reduce((sum, value) => sum + (value - mean) ** 2, 0) / radii.length,
  );
  return { mean, deviation, ratio: mean > 0 ? deviation / mean : 0, minRadius: Math.min(...radii) };
}

describe("layoutRelationGraph 确定性", () => {
  it("同一份输入得到完全相同的坐标", () => {
    const input = santiInputs();
    const first = layoutRelationGraph(input.nodes, {
      groups: input.groups,
      links: input.links,
      aspect: GRAPH_ASPECT_BY_CLASS.wide,
    });
    const second = layoutRelationGraph(input.nodes, {
      groups: input.groups,
      links: input.links,
      aspect: GRAPH_ASPECT_BY_CLASS.wide,
    });
    expect(second.nodes).toEqual(first.nodes);
    expect(second.groups).toEqual(first.groups);
  });

  it("打乱输入顺序不改变结果", () => {
    const input = santiInputs();
    const forward = layoutRelationGraph(input.nodes, { groups: input.groups, links: input.links });
    const backward = layoutRelationGraph([...input.nodes].reverse(), {
      groups: [...input.groups]
        .reverse()
        .map((group) => ({ ...group, memberIds: [...group.memberIds].reverse() })),
      links: [...input.links].reverse(),
    });
    expect(backward.nodes).toEqual(forward.nodes);
  });

  it("不多不少地保留每一个人，一个人只有一个节点", () => {
    const input = santiInputs();
    const result = layoutRelationGraph(input.nodes, { groups: input.groups, links: input.links });
    expect(result.nodes).toHaveLength(25);
    expect(new Set(result.nodes.map((node) => node.id)).size).toBe(25);
    expect(result.nodes.map((node) => node.id)).toEqual(
      [...input.nodes.map((node) => node.id)].sort(),
    );
  });
});

describe("layoutRelationGraph 几何", () => {
  it("节点之间保持最小间距，圈层成员不会叠在一起", () => {
    const input = santiInputs();
    const result = layoutRelationGraph(input.nodes, { groups: input.groups, links: input.links });
    expect(distances(result)).toBeGreaterThan(GRAPH_NODE_SPACING * 0.45);
  });

  it("按圈层时不再围成一个大圆环：中心有人，半径明显不均匀", () => {
    const input = santiInputs();
    const result = layoutRelationGraph(input.nodes, { groups: input.groups, links: input.links });
    const spread = radialSpread(result);
    expect(spread.ratio).toBeGreaterThan(0.25);
    expect(spread.minRadius).toBeLessThan(spread.mean);
  });

  it("不分组时也用二维面积铺开，而不是排在一个圆周上", () => {
    const nodes = Array.from({ length: 40 }, (_, index) => ({
      id: `p${String(index).padStart(2, "0")}`,
    }));
    const result = layoutRelationGraph(nodes, {});
    const spread = radialSpread(result);
    expect(spread.ratio).toBeGreaterThan(0.3);
    expect(spread.minRadius).toBeLessThan(spread.mean * 0.5);
    expect(result.groups).toEqual([]);
  });

  it("包围盒包含所有节点，且宽高比跟随布局类别", () => {
    const input = santiInputs();
    const wide = layoutRelationGraph(input.nodes, {
      groups: input.groups,
      aspect: GRAPH_ASPECT_BY_CLASS.wide,
    });
    const tall = layoutRelationGraph(input.nodes, {
      groups: input.groups,
      aspect: GRAPH_ASPECT_BY_CLASS.tall,
    });
    for (const result of [wide, tall]) {
      for (const node of result.nodes) {
        expect(node.x).toBeGreaterThanOrEqual(result.bounds.x);
        expect(node.y).toBeGreaterThanOrEqual(result.bounds.y);
        expect(node.x).toBeLessThanOrEqual(result.bounds.x + result.bounds.width);
        expect(node.y).toBeLessThanOrEqual(result.bounds.y + result.bounds.height);
      }
    }
    expect(wide.bounds.width / wide.bounds.height).toBeGreaterThan(
      tall.bounds.width / tall.bounds.height,
    );
  });

  it("用户固定过的坐标原样保留", () => {
    const input = santiInputs();
    const pinned = { [input.nodes[0].id]: { x: 1234.5, y: -678.25 } };
    const result = layoutRelationGraph(input.nodes, { groups: input.groups, pins: pinned });
    expect(result.nodes.find((node) => node.id === input.nodes[0].id)).toEqual({
      id: input.nodes[0].id,
      x: 1234.5,
      y: -678.25,
    });
  });

  it("拖动只走 applyGraphPins：不重跑迭代，也不改动自动边界", () => {
    const input = santiInputs();
    const base = layoutRelationGraph(input.nodes, { groups: input.groups, links: input.links });
    const pinnedId = input.nodes[3].id;
    const moved = applyGraphPins(base, { [pinnedId]: { x: 999, y: 999 } });
    expect(moved.nodes.find((node) => node.id === pinnedId)).toEqual({
      id: pinnedId,
      x: 999,
      y: 999,
    });
    expect(moved.nodes.filter((node) => node.id !== pinnedId)).toEqual(
      base.nodes.filter((node) => node.id !== pinnedId),
    );
    expect(moved.bounds).toEqual(base.bounds);
    expect(applyGraphPins(base, {})).toBe(base);
  });

  it("空图与单人不报错", () => {
    expect(layoutRelationGraph([]).nodes).toEqual([]);
    const single = layoutRelationGraph([{ id: "only" }], {});
    expect(single.nodes).toHaveLength(1);
    expect(single.nodes[0].id).toBe("only");
    expect(single.bounds.width).toBeGreaterThan(0);
    expect(single.bounds.height).toBeGreaterThan(0);
  });

  it("共享成员的圈层会被放到一起，交集人物落在两者之间", () => {
    const nodes = [
      { id: "shared" },
      ...Array.from({ length: 6 }, (_, index) => ({ id: `a${index}` })),
      ...Array.from({ length: 6 }, (_, index) => ({ id: `b${index}` })),
      ...Array.from({ length: 6 }, (_, index) => ({ id: `c${index}` })),
    ];
    const result = layoutRelationGraph(nodes, {
      groups: [
        { id: "A", memberIds: ["shared", ...Array.from({ length: 6 }, (_, index) => `a${index}`)] },
        { id: "B", memberIds: ["shared", ...Array.from({ length: 6 }, (_, index) => `b${index}`)] },
        { id: "C", memberIds: Array.from({ length: 6 }, (_, index) => `c${index}`) },
      ],
    });
    const at = (id: string) => result.nodes.find((node) => node.id === id)!;
    const anchorOf = (id: string) => result.groups.find((group) => group.id === id)!;
    const distance = (left: { x: number; y: number }, right: { x: number; y: number }) =>
      Math.hypot(left.x - right.x, left.y - right.y);
    expect(distance(anchorOf("A"), anchorOf("B"))).toBeLessThan(
      distance(anchorOf("A"), anchorOf("C")),
    );
    // 交集人物离两个圈层都近，离第三个远
    expect(distance(at("shared"), anchorOf("A"))).toBeLessThan(distance(at("a0"), anchorOf("C")));
  });

  it("200 人 / 20 圈层规模下仍在可接受的迭代预算内", () => {
    const nodes = Array.from({ length: 200 }, (_, index) => ({
      id: `p${String(index).padStart(3, "0")}`,
    }));
    const groups = Array.from({ length: 20 }, (_, group) => ({
      id: `g${group}`,
      memberIds: nodes
        .filter((_, index) => index % 20 === group || index % 97 === group)
        .map((node) => node.id),
    }));
    const started = performance.now();
    const result = layoutRelationGraph(nodes, { groups });
    const elapsed = performance.now() - started;
    console.log("[layout] 200 人 / 20 圈层耗时", elapsed.toFixed(1), "ms");
    expect(result.nodes).toHaveLength(200);
    expect(elapsed).toBeLessThan(2000);
  });
});

describe("graphAspectClass", () => {
  it("按宽高比区分横屏与竖屏布局类别", () => {
    expect(graphAspectClass(1050, 430)).toBe("wide");
    expect(graphAspectClass(390, 520)).toBe("tall");
    expect(graphAspectClass(0, 0)).toBe("wide");
  });
});
