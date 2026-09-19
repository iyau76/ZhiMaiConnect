import { describe, expect, it } from "vitest";

import type { PersonRecord, RelationRecord } from "./face-db";
import {
  buildFamilyTreeLayout,
  familyTreeGenerationDelta,
  isFamilyTreeRelation,
  selectFamilyTreePeople,
} from "./family-tree-layout";

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

  it("omits people who have no kinship edge from the family tree", () => {
    const people = [person("jiamu", "贾母"), person("baoyu", "贾宝玉"), person("xiren", "袭人")];
    const relations = [
      relation("jiamu-baoyu", "jiamu", "baoyu", "parent_of", "祖孙"),
      relation("baoyu-xiren", "baoyu", "xiren", "custom", "近侍"),
    ];

    const familyTreePeople = selectFamilyTreePeople({ people, relations });
    const layout = buildFamilyTreeLayout({ people: familyTreePeople, relations });

    expect(familyTreePeople.map((item) => item.id)).toEqual(["jiamu", "baoyu"]);
    expect(layout.nodes.map((node) => node.id)).toEqual(["baoyu", "jiamu"]);
    expect(layout.edges.map((edge) => edge.relationId)).toEqual(["jiamu-baoyu"]);
  });

  it("connects the Ningguo and Shi branches back to Jia Mu's generation", () => {
    const people = [
      person("jiamu", "贾母"),
      person("jiadaishan", "贾代善"),
      person("jiadaihua", "贾代化"),
      person("jiajing", "贾敬"),
      person("shinai", "史鼐"),
      person("xiangyun", "史湘云"),
    ];
    const relations = [
      relation("daishan-jiamu", "jiadaishan", "jiamu", "spouse_of", "夫妻"),
      relation("daihua-daishan", "jiadaihua", "jiadaishan", "sibling_of", "兄弟"),
      relation("daihua-jing", "jiadaihua", "jiajing", "parent_of", "父子"),
      relation("jiamu-shinai", "jiamu", "shinai", "uncle_aunt_of", "姑侄"),
      relation("shinai-xiangyun", "shinai", "xiangyun", "uncle_aunt_of", "叔侄女"),
    ];

    const layout = buildFamilyTreeLayout({ people, relations });
    const generation = new Map(layout.nodes.map((node) => [node.id, node.generation]));

    expect(generation.get("jiadaihua")).toBe(generation.get("jiadaishan"));
    expect(generation.get("jiajing")).toBe((generation.get("jiadaihua") ?? 0) + 1);
    expect(generation.get("shinai")).toBe((generation.get("jiamu") ?? 0) + 1);
    expect(generation.get("xiangyun")).toBe((generation.get("shinai") ?? 0) + 1);
  });

  it("uses a directed aunt relation when the parent chain is incomplete", () => {
    const people = [person("wang-furen", "王夫人"), person("wang-xifeng", "王熙凤")];
    const aunt = relation("aunt", "wang-furen", "wang-xifeng", "uncle_aunt_of", "姑母");

    const layout = buildFamilyTreeLayout({ people, relations: [aunt] });
    const byId = new Map(layout.nodes.map((node) => [node.id, node]));

    expect(familyTreeGenerationDelta(aunt)).toBe(1);
    expect(byId.get("wang-furen")?.generation).toBe(0);
    expect(byId.get("wang-xifeng")?.generation).toBe(1);
    expect(byId.get("wang-furen")?.y).toBeLessThan(byId.get("wang-xifeng")?.y ?? 0);
  });

  it("applies ancestry depth without collapsing extended kin into one row", () => {
    const people = [person("elder", "长辈"), person("younger", "晚辈")];
    const grandparent = relation("grandparent", "elder", "younger", "grandparent_of", "祖孙");

    const layout = buildFamilyTreeLayout({ people, relations: [grandparent] });
    const byId = new Map(layout.nodes.map((node) => [node.id, node]));

    expect(byId.get("younger")?.generation).toBe((byId.get("elder")?.generation ?? 0) + 2);
  });

  it("ignores a reversed extended edge instead of inflating a valid parent chain", () => {
    const people = [person("jiamu", "贾母"), person("jiazheng", "贾政"), person("baoyu", "贾宝玉")];
    const relations = [
      relation("jiamu-jiazheng", "jiamu", "jiazheng", "parent_of", "母子"),
      relation("jiazheng-baoyu", "jiazheng", "baoyu", "parent_of", "父子"),
      relation("reversed-aunt", "baoyu", "jiamu", "uncle_aunt_of", "姑母"),
    ];

    const layout = buildFamilyTreeLayout({ people, relations });
    const byId = new Map(layout.nodes.map((node) => [node.id, node]));

    expect(byId.get("jiamu")?.generation).toBe(0);
    expect(byId.get("jiazheng")?.generation).toBe(1);
    expect(byId.get("baoyu")?.generation).toBe(2);
  });
});
