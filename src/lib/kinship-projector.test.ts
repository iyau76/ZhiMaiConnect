import { describe, expect, it } from "vitest";

import { projectKinshipRelations, type RelationshipAssertionInput } from "./kinship-projector";

const fact = (
  id: string,
  fromId: string,
  toId: string,
  label: string,
): RelationshipAssertionInput => ({
  id,
  fromId,
  toId,
  label,
  basis: `原文：${label}`,
  confidence: 0.96,
  confirmationStatus: "confirmed",
  evidenceMode: "explicit",
});

const people = [
  { id: "grandma", name: "贾母", profile: { gender: "女" } },
  { id: "she", name: "贾赦", profile: { gender: "男" } },
  { id: "zheng", name: "贾政", profile: { gender: "男" } },
  { id: "baoyu", name: "贾宝玉", profile: { gender: "男" } },
  { id: "min", name: "贾敏", profile: { gender: "女" } },
  { id: "daiyu", name: "林黛玉", profile: { gender: "女" } },
];

describe("assertion-only kinship projection", () => {
  it("is deterministic across assertion order and cites exact fact ids", () => {
    const assertions = [
      fact("r1", "grandma", "she", "母子"),
      fact("r2", "grandma", "zheng", "母子"),
      fact("r3", "zheng", "baoyu", "父子"),
    ];
    const first = projectKinshipRelations({ assertions, persons: people });
    const second = projectKinshipRelations({
      assertions: [...assertions].reverse(),
      persons: people,
    });
    expect(first).toEqual(second);
    expect(first.relations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fromId: "she",
          toId: "zheng",
          predicate: "sibling_of",
          supportingRelationIds: ["r1", "r2"],
        }),
        expect.objectContaining({
          fromId: "grandma",
          toId: "baoyu",
          predicate: "grandparent_of",
          supportingRelationIds: ["r2", "r3"],
        }),
      ]),
    );
  });

  it("never consumes an old derived edge as a new proof", () => {
    const projection = projectKinshipRelations({
      assertions: [
        fact("r1", "grandma", "zheng", "母子"),
        fact("r2", "zheng", "baoyu", "父子"),
        {
          ...fact("ghost", "she", "zheng", "兄弟"),
          evidenceMode: "inferred",
          derivedFromRelationIds: ["r1"],
        },
      ],
      persons: people,
    });
    expect(projection.diagnostics.ignoredLegacyDerived).toBe(1);
    expect(projection.relations.some((relation) => relation.fromId === "she")).toBe(false);
  });

  it("does not promote pending assertions into confirmed-looking derived projections", () => {
    const projection = projectKinshipRelations({
      assertions: [
        { ...fact("pending", "grandma", "zheng", "母子"), confirmationStatus: "pending" },
        fact("confirmed", "zheng", "baoyu", "父子"),
      ],
      persons: people,
    });
    expect(projection.diagnostics.ignoredPending).toBe(1);
    expect(projection.relations).toHaveLength(0);
  });

  it("rebuilds sibling classification instead of retaining a stale generic edge", () => {
    const sharedFather = [
      fact("father-a", "father", "a", "父子"),
      fact("father-b", "father", "b", "父女"),
    ];
    const first = projectKinshipRelations({ assertions: sharedFather });
    expect(first.relations).toEqual(
      expect.arrayContaining([expect.objectContaining({ predicate: "sibling_of" })]),
    );

    const second = projectKinshipRelations({
      assertions: [
        ...sharedFather,
        fact("mother-a", "mother-a", "a", "母子"),
        fact("mother-b", "mother-b", "b", "母女"),
      ],
    });
    expect(second.relations.some((relation) => relation.predicate === "sibling_of")).toBe(false);
    expect(second.relations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          predicate: "half_sibling_of",
          supportingRelationIds: ["father-a", "father-b", "mother-a", "mother-b"],
        }),
      ]),
    );
  });

  it("combines archived and newly committed assertions by id without names or model inference", () => {
    const projection = projectKinshipRelations({
      assertions: [fact("old", "grandma", "min", "母女"), fact("new", "min", "daiyu", "母女")],
      persons: people,
    });
    expect(projection.relations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fromId: "grandma",
          toId: "daiyu",
          predicate: "grandparent_of",
          label: "外祖孙",
          supportingRelationIds: ["new", "old"],
        }),
      ]),
    );
  });

  it("does not create cross-family ghost edges for equal display names with different ids", () => {
    const projection = projectKinshipRelations({
      assertions: [
        fact("a1", "family-a-dad", "family-a-child", "父子"),
        fact("b1", "family-b-dad", "family-b-child", "父子"),
      ],
      persons: [
        { id: "family-a-dad", name: "爸爸" },
        { id: "family-b-dad", name: "爸爸" },
      ],
    });
    expect(projection.relations).toHaveLength(0);
  });

  it.each([
    ["男", "男", "paternal_uncle", "paternal_uncle", "堂亲"],
    ["男", "女", "paternal_aunt", "maternal_uncle", "姑表亲"],
    ["女", "男", "maternal_uncle", "paternal_aunt", "舅表亲"],
    ["女", "女", "maternal_aunt", "maternal_aunt", "姨表亲"],
  ] as const)(
    "preserves the four cousin branches from both directions (%s/%s)",
    (leftGender, rightGender, branch, inverseBranch, label) => {
      const projection = projectKinshipRelations({
        assertions: [
          fact("siblings", "left-parent", "right-parent", "兄弟姐妹"),
          fact("left-child", "left-parent", "left-child", leftGender === "男" ? "父子" : "母子"),
          fact(
            "right-child",
            "right-parent",
            "right-child",
            rightGender === "男" ? "父女" : "母女",
          ),
        ],
        persons: [
          { id: "left-parent", name: "左侧父母", profile: { gender: leftGender } },
          { id: "right-parent", name: "右侧父母", profile: { gender: rightGender } },
        ],
      });
      expect(projection.relations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            fromId: "left-child",
            toId: "right-child",
            predicate: "cousin_of",
            label,
            qualifiers: expect.objectContaining({
              cousinBranch: branch,
              inverseCousinBranch: inverseBranch,
            }),
          }),
        ]),
      );
    },
  );
});
