import { describe, expect, it } from "vitest";
import { santiPack } from "./demo-packs/world/santi";
import { buildCircleMembershipProjection } from "./circle-membership-projection";
import type { CollectionMembershipRecord, CollectionRecord } from "./face-db";
import {
  CONTOUR_NODE_RADIUS,
  CONTOUR_PADDING,
  buildSetContours,
  contourDistance,
  contourVerdict,
  convexHull,
  distanceToPolygon,
} from "./set-contours";
import { layoutRelationGraph } from "./relation-graph-layout";

const PADDING = CONTOUR_NODE_RADIUS + CONTOUR_PADDING;

function santiProjection() {
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
  return buildCircleMembershipProjection(persons, collections, memberships);
}

describe("convexHull / distanceToPolygon", () => {
  it("凸包只保留外圈点", () => {
    expect(
      convexHull([
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
        { x: 0, y: 10 },
        { x: 5, y: 5 },
      ]),
    ).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ]);
    expect(convexHull([{ x: 1, y: 1 }])).toEqual([{ x: 1, y: 1 }]);
    expect(
      convexHull([
        { x: 0, y: 0 },
        { x: 4, y: 0 },
      ]),
    ).toEqual([
      { x: 0, y: 0 },
      { x: 4, y: 0 },
    ]);
  });

  it("点到退化多边形（点、线段）的距离", () => {
    expect(distanceToPolygon({ x: 3, y: 4 }, [{ x: 0, y: 0 }])).toBe(5);
    expect(
      distanceToPolygon({ x: 2, y: 3 }, [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ]),
    ).toBe(3);
    expect(
      distanceToPolygon({ x: -3, y: 4 }, [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ]),
    ).toBe(5);
  });
});

describe("buildSetContours", () => {
  it("单人圈层画出节点附近的小外形，不再保底一个大圆盘", () => {
    const contours = buildSetContours(
      [{ id: "c1", memberIds: ["a"] }],
      [{ id: "a", x: 100, y: 100 }],
    );
    expect(contours[0].fragments).toHaveLength(1);
    expect(contours[0].fragments[0].kind).toBe("dot");
    expect(contours[0].strategy).toBe("fragment");
    expect(contours[0].valid).toBe(true);
    expect(contourVerdict(contours[0], { x: 100 + PADDING - 1, y: 100 })).toBe("inside");
    expect(contourVerdict(contours[0], { x: 100 + PADDING + 60, y: 100 })).toBe("outside");
  });

  it("双人圈层是胶囊形", () => {
    const contours = buildSetContours(
      [{ id: "c1", memberIds: ["a", "b"] }],
      [
        { id: "a", x: 0, y: 0 },
        { id: "b", x: 200, y: 0 },
      ],
    );
    expect(contours[0].fragments[0].kind).toBe("capsule");
    expect(contours[0].fragments[0].path).toContain("M 0 0 L 200 0");
    expect(contourVerdict(contours[0], { x: 100, y: 0 })).toBe("inside");
    expect(contourVerdict(contours[0], { x: 100, y: PADDING + 40 })).toBe("outside");
  });

  it("成员围成的多边形里有非成员时，拆成同色分片而不是把人圈进去", () => {
    const points = [
      { id: "a", x: 0, y: 0 },
      { id: "b", x: 300, y: 0 },
      { id: "c", x: 300, y: 300 },
      { id: "d", x: 0, y: 300 },
      // 站在正方形正中的非成员
      { id: "outsider", x: 150, y: 150 },
    ];
    const contours = buildSetContours([{ id: "c1", memberIds: ["a", "b", "c", "d"] }], points);
    const contour = contours[0];
    expect(contour.valid).toBe(true);
    expect(contour.fragments.length).toBeGreaterThan(1);
    expect(contour.fragments.every((fragment) => !fragment.memberIds.includes("outsider"))).toBe(
      true,
    );
    for (const memberId of ["a", "b", "c", "d"]) {
      const point = points.find((item) => item.id === memberId)!;
      expect(contourVerdict(contour, point)).toBe("inside");
    }
    expect(contourVerdict(contour, { x: 150, y: 150 })).toBe("outside");
  });

  it("三体演示库：用真实布局坐标，9 个圈层全部通过成员与非成员校验", () => {
    const projection = santiProjection();
    const nameOf = (id: string) => projection.circles.find((circle) => circle.id === id)!.name;
    const layout = layoutRelationGraph(
      santiPack.people.map((item) => ({ id: item.key })),
      {
        groups: projection.circles.map((circle) => ({
          id: circle.id,
          memberIds: circle.memberIds,
        })),
        links: santiPack.relations.map(
          (relation) => [relation.from, relation.to] as [string, string],
        ),
      },
    );
    const contours = buildSetContours(
      projection.circles.map((circle) => ({ id: circle.id, memberIds: circle.memberIds })),
      layout.nodes,
    );
    expect(contours).toHaveLength(9);
    for (const contour of contours) {
      const circle = projection.circles.find((item) => item.id === contour.id)!;
      expect(
        contour.valid,
        `${nameOf(contour.id)} 未通过校验：${contour.violations.join(",")}`,
      ).toBe(true);
      for (const memberId of circle.memberIds) {
        const point = layout.nodes.find((node) => node.id === memberId)!;
        expect(contourVerdict(contour, point), `${nameOf(contour.id)} 漏包 ${memberId}`).toBe(
          "inside",
        );
      }
      for (const node of layout.nodes) {
        if (circle.memberIds.includes(node.id)) continue;
        expect(contourVerdict(contour, node), `${nameOf(contour.id)} 误包 ${node.id}`).toBe(
          "outside",
        );
      }
    }
  });

  it("空圈层不画外形", () => {
    const contours = buildSetContours([{ id: "empty", memberIds: [] }], [{ id: "a", x: 0, y: 0 }]);
    expect(contours[0].fragments).toEqual([]);
    expect(contours[0].strategy).toBe("none");
    expect(contours[0].valid).toBe(true);
  });

  it("输入顺序不影响形状", () => {
    const points = [
      { id: "a", x: 0, y: 0 },
      { id: "b", x: 120, y: 40 },
      { id: "c", x: 60, y: 200 },
      { id: "d", x: 400, y: 400 },
    ];
    const forward = buildSetContours([{ id: "c1", memberIds: ["a", "b", "c"] }], points);
    const backward = buildSetContours(
      [{ id: "c1", memberIds: ["c", "b", "a"] }],
      [...points].reverse(),
    );
    expect(backward[0].fragments).toEqual(forward[0].fragments);
  });

  it("成员缺失于可见节点时不报错，也不会误判", () => {
    const contours = buildSetContours(
      [{ id: "c1", memberIds: ["a", "ghost"] }],
      [
        { id: "a", x: 0, y: 0 },
        { id: "b", x: 500, y: 0 },
      ],
    );
    expect(contours[0].fragments).toHaveLength(1);
    expect(contours[0].valid).toBe(true);
    expect(contourDistance(contours[0], { x: 0, y: 0 })).toBe(0);
  });
});
