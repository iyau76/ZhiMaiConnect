import { describe, expect, it } from "vitest";

import type { PersonRecord, RelationRecord } from "./face-db";
import { rankConnectionPaths } from "./connection-paths";
import { selectVisibleRelations } from "./relation-graph";

const NOW = new Date("2026-08-28T00:00:00Z");

function fixture() {
  const persons: PersonRecord[] = Array.from({ length: 200 }, (_, index) => ({
    id: `person-${index}`,
    name: `合成人物${index}`,
    note: "性能测试合成人物",
    profile: index === 0 ? { closeness: 5, contact: "synthetic@example.invalid" } : {},
    descriptors: [],
    thumb: "",
    createdAt: 1,
  }));
  const relations: RelationRecord[] = [];
  for (let index = 0; index < persons.length; index += 1) {
    for (const offset of [1, 7, 31]) {
      const target = (index + offset) % persons.length;
      if (index >= target) continue;
      relations.push({
        id: `relation-${index}-${target}`,
        fromId: persons[index].id,
        toId: persons[target].id,
        label: "合成测试关系",
        evidenceMode: "explicit",
        confidence: 0.9,
        confirmationStatus: "confirmed",
        recommendationPolicy: "allow",
        visibility: "auto",
        createdAt: 1,
      });
    }
  }
  relations.push({
    id: "short-path-a",
    fromId: "person-0",
    toId: "person-100",
    label: "合成引荐关系",
    evidenceMode: "explicit",
    confidence: 0.95,
    confirmationStatus: "confirmed",
    createdAt: 1,
  });
  relations.push({
    id: "short-path-b",
    fromId: "person-100",
    toId: "person-199",
    label: "合成引荐关系",
    evidenceMode: "explicit",
    confidence: 0.95,
    confirmationStatus: "confirmed",
    createdAt: 1,
  });
  return { persons, relations };
}

describe("200-person graph performance guard", () => {
  it("filters the graph and ranks bounded paths without an algorithmic blow-up", () => {
    const { persons, relations } = fixture();
    const started = performance.now();
    const graph = selectVisibleRelations({ relations, mode: "overview", now: NOW });
    const paths = rankConnectionPaths({
      persons,
      relations,
      events: [],
      targetId: "person-199",
      maxHops: 3,
      now: NOW,
    });
    const elapsed = performance.now() - started;

    expect(graph.visible.length).toBeGreaterThan(0);
    expect(paths[0]?.path?.personIds).toEqual(["person-0", "person-100", "person-199"]);
    // 宽松的回归门槛：目的是捕获无界全路径枚举，而不是宣称固定设备性能。
    expect(elapsed).toBeLessThan(1_000);
  });
});
