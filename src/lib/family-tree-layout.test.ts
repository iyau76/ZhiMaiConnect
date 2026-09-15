import { describe, expect, it } from "vitest";

import type { PersonRecord, RelationRecord } from "./face-db";
import { buildFamilyTreeLayout, isFamilyTreeRelation } from "./family-tree-layout";

function person(id: string, name: string): PersonRecord {
  return {
    id,
    name,
    note: "",
    descriptors: [],
    thumb: "",
    createdAt: 1,
  };
}

function relation(
  id: string,
  fromId: string,
  toId: string,
  predicate: RelationRecord["predicate"],
  label: string,
): RelationRecord {
  return {
    id,
    fromId,
    toId,
    predicate,
    label,
    createdAt: 1,
  };
}

describe("family tree layout", () => {
  it("keeps spouses together and places children below their parents", () => {
    const people = [
      person("grandfather", "Grandfather"),
      person("grandmother", "Grandmother"),
      person("father", "Father"),
      person("mother", "Mother"),
      person("child", "Child"),
      person("aunt", "Aunt"),
    ];
    const relations = [
      relation("gp-m", "grandfather", "father", "parent_of", "父子"),
      relation("gp-f", "grandmother", "father", "parent_of", "母子"),
      relation("gp-a", "grandfather", "aunt", "parent_of", "父女"),
      relation("gp-a2", "grandmother", "aunt", "parent_of", "母女"),
      relation("parents", "father", "mother", "spouse_of", "夫妻"),
      relation("father-c", "father", "child", "parent_of", "父女"),
      relation("mother-c", "mother", "child", "parent_of", "母女"),
    ];

    const layout = buildFamilyTreeLayout({ people, relations });
    const byId = new Map(layout.nodes.map((node) => [node.id, node]));

    expect(byId.get("grandfather")?.generation).toBe(byId.get("grandmother")?.generation);
    expect(byId.get("father")?.generation).toBe(byId.get("mother")?.generation);
    expect(byId.get("father")?.generation).toBe((byId.get("grandfather")?.generation ?? 0) + 1);
    expect(byId.get("child")?.generation).toBe((byId.get("father")?.generation ?? 0) + 1);
    expect(byId.get("father")?.y).toBeLessThan(byId.get("child")?.y ?? 0);
    expect(layout.generationCount).toBe(3);
    expect(layout.edges.map((edge) => edge.kind)).toEqual(
      expect.arrayContaining(["parent", "spouse"]),
    );
  });

  it("starts disconnected families at generation zero and ignores social edges", () => {
    const people = [person("a", "A"), person("b", "B"), person("c", "C")];
    const relations = [
      relation("friends", "a", "b", "friend_of", "朋友"),
      relation("parent", "b", "c", "parent_of", "父子"),
    ];

    const layout = buildFamilyTreeLayout({ people, relations });
    const byId = new Map(layout.nodes.map((node) => [node.id, node]));

    expect(byId.get("a")?.generation).toBe(0);
    expect(byId.get("b")?.generation).toBe(0);
    expect(byId.get("c")?.generation).toBe(1);
    expect(layout.edges.map((edge) => edge.relationId)).toEqual(["parent"]);
    expect(isFamilyTreeRelation(relations[0])).toBe(false);
    expect(isFamilyTreeRelation(relations[1])).toBe(true);
  });
});
