import { describe, expect, it } from "vitest";

import {
  buildDraftGraphProjection,
  CREATE_NEW_PERSON_ID,
  resolveDraftRelationEndpoints,
  type BuildDraftGraphProjectionInput,
} from "./draft-graph-projection";

function makeInput(
  patch: Partial<BuildDraftGraphProjectionInput> = {},
): BuildDraftGraphProjectionInput {
  return {
    draftPeople: [],
    draftRelations: [],
    archivePeople: [],
    archiveRelations: [],
    circles: [],
    memberships: [],
    ...patch,
  };
}

describe("buildDraftGraphProjection node identity", () => {
  it("exposes the same create-new marker the intake form uses", () => {
    expect(CREATE_NEW_PERSON_ID).toBe("__create_new_person__");
  });

  it("puts archive people first by id, then draft people by name", () => {
    const projection = buildDraftGraphProjection(
      makeInput({
        archivePeople: [
          { id: "p2", name: "Bob" },
          { id: "p1", name: "Alice" },
        ],
        draftPeople: [
          { _draftId: "d2", name: "Carol" },
          { _draftId: "d1", name: "Dave" },
          { _draftId: "d3", name: "Eve", targetPersonId: CREATE_NEW_PERSON_ID },
        ],
      }),
    );

    expect(projection.nodes.map((node) => node.id)).toEqual([
      "p1",
      "p2",
      "draft:d2",
      "draft:d1",
      "draft:d3",
    ]);
    expect(projection.nodes.map((node) => node.name)).toEqual([
      "Alice",
      "Bob",
      "Carol",
      "Dave",
      "Eve",
    ]);
    expect(projection.nodes.filter((node) => node.isNew).map((node) => node.id)).toEqual([
      "draft:d2",
      "draft:d1",
      "draft:d3",
    ]);
  });

  it("marks a draft person that targets an archive person as a haloed update", () => {
    const projection = buildDraftGraphProjection(
      makeInput({
        archivePeople: [{ id: "p1", name: "Alice" }],
        draftPeople: [
          { _draftId: "d1", name: "Alice", targetPersonId: "p1" },
          { _draftId: "d2", name: "Zoe", targetPersonId: "missing" },
        ],
      }),
    );

    expect(projection.nodes.find((node) => node.id === "p1")).toMatchObject({
      name: "Alice",
      isNew: false,
      haloed: true,
    });
    expect(projection.nodes.find((node) => node.id === "draft:d2")).toMatchObject({
      name: "Zoe",
      isNew: true,
      haloed: false,
    });
  });
});

describe("buildDraftGraphProjection edges", () => {
  it("keeps archive edges first and marks draft edges as new", () => {
    const projection = buildDraftGraphProjection(
      makeInput({
        archivePeople: [
          { id: "p1", name: "Alice" },
          { id: "p2", name: "Bob" },
        ],
        archiveRelations: [{ id: "r1", fromId: "p1", toId: "p2", label: "同事" }],
        draftPeople: [{ _draftId: "d1", name: "Carol" }],
        draftRelations: [{ from: "Alice", to: "Carol", label: "朋友" }],
      }),
    );

    expect(projection.edges.map((edge) => [edge.id, edge.from, edge.to, edge.isNew])).toEqual([
      ["r1", "p1", "p2", false],
      ["draft:p1->draft:d1:朋友", "p1", "draft:d1", true],
    ]);
  });

  it("resolves endpoints by personId, then draftId, then a unique name", () => {
    const projection = buildDraftGraphProjection(
      makeInput({
        archivePeople: [
          { id: "p1", name: "Alice" },
          { id: "p2", name: "Bob" },
        ],
        draftPeople: [{ _draftId: "d1", name: "Carol" }],
        draftRelations: [
          {
            from: "whatever",
            to: "whoever",
            label: "同事",
            fromPersonId: "p1",
            fromDraftId: "d1",
            toDraftId: "d1",
          },
          { from: "Alice", to: "Bob", label: "朋友" },
        ],
      }),
    );

    expect(projection.edges.map((edge) => [edge.from, edge.to, edge.label])).toEqual([
      ["p1", "draft:d1", "同事"],
      ["p1", "p2", "朋友"],
    ]);
  });

  it("resolves a draftId that targets an existing archive person to the archive node", () => {
    const projection = buildDraftGraphProjection(
      makeInput({
        archivePeople: [
          { id: "p1", name: "Alice" },
          { id: "p2", name: "Bob" },
        ],
        draftPeople: [{ _draftId: "d1", name: "Alice", targetPersonId: "p1" }],
        draftRelations: [
          { from: "Alice", to: "Bob", label: "同事", fromDraftId: "d1", toPersonId: "p2" },
        ],
      }),
    );

    expect(projection.edges).toHaveLength(1);
    expect(projection.edges[0]).toMatchObject({ from: "p1", to: "p2", isNew: true });
  });

  it("drops ambiguous names, self loops and edges with an unresolved end", () => {
    const projection = buildDraftGraphProjection(
      makeInput({
        archivePeople: [{ id: "p1", name: "Alice" }],
        draftPeople: [
          { _draftId: "d1", name: "Same" },
          { _draftId: "d2", name: "Same" },
        ],
        draftRelations: [
          { from: "Same", to: "Alice", label: "同事" },
          { from: "p1", to: "p1", label: "自己" },
          { from: "Nobody", to: "Alice", label: "同事" },
          { from: "Alice", to: "Same", label: "只能靠草稿 id", toDraftId: "d2" },
        ],
      }),
    );

    expect(projection.edges).toHaveLength(1);
    expect(projection.edges[0]).toMatchObject({
      from: "p1",
      to: "draft:d2",
      label: "只能靠草稿 id",
    });
  });

  it("folds identical directed duplicates but keeps reversed or relabelled edges", () => {
    const projection = buildDraftGraphProjection(
      makeInput({
        archivePeople: [{ id: "p1", name: "Alice" }],
        draftPeople: [{ _draftId: "d1", name: "Carol" }],
        draftRelations: [
          { from: "Alice", to: "Carol", label: "同事" },
          { from: "Alice", to: "Carol", label: "同事" },
          { from: "Alice", to: "Carol", label: "朋友" },
          { from: "Carol", to: "Alice", label: "同事" },
        ],
      }),
    );

    expect(projection.edges.map((edge) => [edge.from, edge.to, edge.label])).toEqual([
      ["p1", "draft:d1", "同事"],
      ["p1", "draft:d1", "朋友"],
      ["draft:d1", "p1", "同事"],
    ]);
  });

  it("drops archive edges whose people or endpoints are missing", () => {
    const projection = buildDraftGraphProjection(
      makeInput({
        archivePeople: [{ id: "p1", name: "Alice" }],
        archiveRelations: [
          { id: "r1", fromId: "p1", toId: "p1", label: "自己" },
          { id: "r2", fromId: "p1", toId: "missing", label: "同事" },
        ],
      }),
    );

    expect(projection.edges).toEqual([]);
  });
});

describe("buildDraftGraphProjection circles", () => {
  it("keeps only non-computed memberships and resolves draft members by id or name", () => {
    const projection = buildDraftGraphProjection(
      makeInput({
        archivePeople: [
          { id: "p1", name: "Alice" },
          { id: "p2", name: "Bob" },
        ],
        draftPeople: [
          { _draftId: "d1", name: "Carol" },
          { _draftId: "d2", name: "Dave" },
        ],
        circles: [
          { id: "c1", name: "老同学" },
          { id: "c2", name: "同事圈" },
          { id: "c3", name: "空圈" },
        ],
        memberships: [
          { collectionId: "c1", personId: "d1" },
          { collectionId: "c1", personId: "p1" },
          { collectionId: "c1", personId: "Carol" },
          { collectionId: "c2", personId: "d2", source: "manual" },
          { collectionId: "c1", personId: "p2", source: "computed" },
          { collectionId: "c3", personId: "nobody" },
        ],
      }),
    );

    expect(
      projection.circles.map((circle) => [circle.key, circle.label, circle.memberIds]),
    ).toEqual([
      ["c1", "老同学", ["draft:d1", "p1"]],
      ["c2", "同事圈", ["draft:d2"]],
    ]);
    expect(projection.nodes.find((node) => node.id === "draft:d1")?.circles).toEqual(["老同学"]);
    expect(projection.nodes.find((node) => node.id === "p1")?.circles).toEqual(["老同学"]);
    expect(projection.nodes.find((node) => node.id === "p2")?.circles).toEqual([]);
  });

  it("dedupes circle names on a node and keeps at most three", () => {
    const projection = buildDraftGraphProjection(
      makeInput({
        archivePeople: [{ id: "p1", name: "Alice" }],
        circles: [
          { id: "c1", name: "同学" },
          { id: "c2", name: "同事" },
          { id: "c3", name: "球友" },
          { id: "c4", name: "邻居" },
          { id: "c5", name: "同学" },
        ],
        memberships: [
          { collectionId: "c1", personId: "p1" },
          { collectionId: "c5", personId: "p1" },
          { collectionId: "c2", personId: "p1" },
          { collectionId: "c3", personId: "p1" },
          { collectionId: "c4", personId: "p1" },
        ],
      }),
    );

    expect(projection.nodes[0].circles).toEqual(["同学", "同事", "球友"]);
  });

  it("keeps one circle when the archive and the draft point at the same collection", () => {
    const projection = buildDraftGraphProjection(
      makeInput({
        archivePeople: [{ id: "p1", name: "Alice" }],
        circles: [
          { id: "c1", name: "老同学" },
          { id: "c1", name: "大学同学" },
        ],
        memberships: [{ collectionId: "c1", personId: "p1" }],
      }),
    );

    expect(projection.circles).toEqual([{ key: "c1", label: "大学同学", memberIds: ["p1"] }]);
    expect(projection.nodes[0].circles).toEqual(["大学同学"]);
  });

  it("does not guess a draft member whose name matches two draft people", () => {
    const projection = buildDraftGraphProjection(
      makeInput({
        draftPeople: [
          { _draftId: "d1", name: "Same" },
          { _draftId: "d2", name: "Same" },
        ],
        circles: [{ id: "c1", name: "同学" }],
        memberships: [{ collectionId: "c1", personId: "Same" }],
      }),
    );

    expect(projection.circles).toEqual([]);
  });
});

describe("resolveDraftRelationEndpoints", () => {
  const nodes = [
    { id: "p1", name: "Alice" },
    { id: "draft:d1", name: "Carol" },
  ];

  it("falls back from personId to draftId to a unique name", () => {
    expect(
      resolveDraftRelationEndpoints(
        { from: "Alice", to: "Carol", label: "同事", fromPersonId: "p1" },
        [{ _draftId: "d1", name: "Carol" }],
        nodes,
      ),
    ).toEqual({ from: "p1", to: "draft:d1" });

    expect(
      resolveDraftRelationEndpoints(
        { from: "Alice", to: "Carol", label: "同事", toDraftId: "d1" },
        [{ _draftId: "d1", name: "Carol" }],
        nodes,
      ),
    ).toEqual({ from: "p1", to: "draft:d1" });
  });

  it("returns null when a name matches more than one node", () => {
    expect(
      resolveDraftRelationEndpoints(
        { from: "Alice", to: "Carol", label: "同事" },
        [],
        [...nodes, { id: "p2", name: "Alice" }],
      ),
    ).toBeNull();
  });
});
