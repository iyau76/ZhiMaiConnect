import { beforeEach, describe, expect, it, vi } from "vitest";

const { listRelations, putRelation } = vi.hoisted(() => ({
  listRelations: vi.fn(),
  putRelation: vi.fn(),
}));
vi.mock("./face-db", async (importOriginal) => {
  const original = await importOriginal<typeof import("./face-db")>();
  return { ...original, facesDb: { ...original.facesDb, listRelations, putRelation } };
});

import {
  applyRelationUpdateProposal,
  createRelationUpdateProposal,
  relationUpdateDiff,
} from "./relation-update-tool";

const relation = {
  id: "r1",
  fromId: "p1",
  toId: "p2",
  label: "同事",
  basis: "原文：两人是同事",
  createdAt: 1,
  updatedAt: 2,
};
const people = [
  { id: "p1", name: "甲", note: "", descriptors: [], thumb: "", createdAt: 1 },
  { id: "p2", name: "乙", note: "", descriptors: [], thumb: "", createdAt: 1 },
];

describe("relation update approval tool", () => {
  beforeEach(() => {
    listRelations.mockReset().mockResolvedValue([relation]);
    putRelation.mockReset().mockResolvedValue(undefined);
  });

  it("creates a non-executing proposal and applies it only after approval", async () => {
    const proposal = createRelationUpdateProposal(
      { relationId: "r1", reason: "材料纠正", changes: { label: "前同事" } },
      [relation],
      people,
    );
    expect(proposal.endpointNames).toEqual(["甲", "乙"]);
    expect(relationUpdateDiff(proposal, relation)).toEqual([
      { field: "关系标签", before: "同事", after: "前同事" },
    ]);
    expect(putRelation).not.toHaveBeenCalled();
    await applyRelationUpdateProposal(proposal);
    expect(putRelation).toHaveBeenCalledWith(
      expect.objectContaining({ id: "r1", label: "前同事", semanticKind: "work" }),
    );
  });

  it("rejects a stale proposal", async () => {
    const proposal = createRelationUpdateProposal(
      { relationId: "r1", changes: { note: "新备注" } },
      [relation],
      people,
    );
    listRelations.mockResolvedValue([{ ...relation, updatedAt: 3 }]);
    await expect(applyRelationUpdateProposal(proposal)).rejects.toThrow("已发生变化");
  });
});
