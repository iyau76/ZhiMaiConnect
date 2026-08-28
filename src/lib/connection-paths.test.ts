import { describe, expect, it } from "vitest";

import type { PersonRecord, RelationRecord } from "./face-db";
import { detectTargetIntent, rankConnectionPaths, rankTargetSideEntries } from "./connection-paths";

const NOW = new Date("2026-08-28T00:00:00Z");

function person(id: string, name: string, closeness?: number): PersonRecord {
  return {
    id,
    name,
    note: "",
    descriptors: [],
    thumb: "",
    createdAt: 1,
    profile: closeness === undefined ? {} : { closeness },
  };
}

function relation(id: string, fromId: string, toId: string, patch: Partial<RelationRecord> = {}) {
  return {
    id,
    fromId,
    toId,
    label: "亲属",
    createdAt: 1,
    confirmationStatus: "confirmed",
    evidenceMode: "explicit",
    confidence: 0.95,
    ...patch,
  } satisfies RelationRecord;
}

describe("target intent", () => {
  const persons = [person("jia-mu", "贾母"), person("jia-lian", "贾琏")];

  it("recognizes an archived person as a target", () => {
    expect(detectTargetIntent("我想找贾母办事，应该通过谁联系？", persons)).toMatchObject({
      mode: "target",
      target: { id: "jia-mu" },
    });
  });

  it("never offers the ego record as a target in a first-person question", () => {
    const self = { ...person("self", "我"), entityRole: "ego" as const };
    expect(
      detectTargetIntent("我想找贾母办事，应该通过谁联系？", [self, ...persons]),
    ).toMatchObject({ mode: "target", target: { id: "jia-mu" } });
  });

  it("keeps a skill request in open recommendation mode", () => {
    expect(detectTargetIntent("找一个懂摄影的人", persons).mode).toBe("open");
  });

  it("does not guess when multiple named targets are requested", () => {
    expect(detectTargetIntent("想联系贾母和贾琏", persons).mode).toBe("ambiguous");
  });

  it("recognizes a one-character archived name", () => {
    expect(detectTargetIntent("我想找婷办事", [person("ting", "婷")])).toMatchObject({
      mode: "target",
      target: { id: "ting" },
    });
  });
});

describe("connection path ranking", () => {
  const selfContact = person("jia-lian", "贾琏", 5);
  const target = person("jia-mu", "贾母");
  const classmateA = person("classmate-a", "同学甲", 5);
  const classmateB = person("classmate-b", "同学乙", 5);

  it("returns only connectors with a real path to the target", () => {
    const result = rankConnectionPaths({
      persons: [selfContact, target, classmateA, classmateB],
      relations: [relation("family", selfContact.id, target.id)],
      events: [],
      targetId: target.id,
      now: NOW,
    });
    expect(result.map((item) => item.person.id)).toEqual(["jia-lian"]);
    expect(result[0].reasons[0]).toContain("我 → 贾琏 → 贾母");
    expect(result[0].path?.relationIds).toEqual(["family"]);
  });

  it("traverses semantic one-way relations in either direction for referral reachability", () => {
    const parent = relation("parent", target.id, selfContact.id, { label: "祖孙", mutual: false });
    const result = rankConnectionPaths({
      persons: [selfContact, target],
      relations: [parent],
      events: [],
      targetId: target.id,
      now: NOW,
    });
    expect(result[0].path?.personIds).toEqual([selfContact.id, target.id]);
  });

  it("excludes pending, inferred, and blocked edges by default", () => {
    const policies: RelationRecord[] = [
      relation("pending", selfContact.id, target.id, { confirmationStatus: "pending" }),
      relation("inferred", classmateA.id, target.id, { evidenceMode: "inferred" }),
      relation("blocked", classmateB.id, target.id, { recommendationPolicy: "block" }),
    ];
    expect(
      rankConnectionPaths({
        persons: [selfContact, target, classmateA, classmateB],
        relations: policies,
        events: [],
        targetId: target.id,
        now: NOW,
      }),
    ).toEqual([]);
  });

  it("does not confuse visual hiding with recommendation blocking", () => {
    const hidden = relation("hidden", selfContact.id, target.id, { visibility: "hidden" });
    expect(
      rankConnectionPaths({
        persons: [selfContact, target],
        relations: [hidden],
        events: [],
        targetId: target.id,
        now: NOW,
      }),
    ).toHaveLength(1);
  });

  it("treats an explicit ego relationship as verified access", () => {
    const self = { ...person("self", "我"), entityRole: "ego" as const };
    const result = rankConnectionPaths({
      persons: [self, selfContact, target],
      relations: [
        relation("access", self.id, selfContact.id, { label: "大学室友" }),
        relation("family", selfContact.id, target.id),
      ],
      events: [],
      targetId: target.id,
      now: NOW,
    });
    expect(result[0].person.id).toBe(selfContact.id);
    expect(result[0].evidence).toContain("与我的已记录关系：大学室友");
  });

  it("returns target-side leads without claiming they are reachable", () => {
    const result = rankTargetSideEntries({
      persons: [target, selfContact, classmateA],
      relations: [relation("family", selfContact.id, target.id)],
      events: [],
      targetId: target.id,
      now: NOW,
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      person: { id: "jia-lian" },
      mode: "target_side",
      targetEntry: { targetId: "jia-mu", relationIds: ["family"] },
    });
    expect(result[0].risks.join(" ")).toContain("尚未证明你能联系此人");
  });

  it("enforces the total-hop limit including the virtual self edge", () => {
    const middle = person("middle", "中间人");
    const second = person("second", "第二中间人");
    const relations = [
      relation("one", selfContact.id, middle.id),
      relation("two", middle.id, second.id),
      relation("three", second.id, target.id),
    ];
    expect(
      rankConnectionPaths({
        persons: [selfContact, middle, second, target],
        relations,
        events: [],
        targetId: target.id,
        maxHops: 3,
        now: NOW,
      }),
    ).toEqual([]);
    expect(
      rankConnectionPaths({
        persons: [selfContact, middle, second, target],
        relations,
        events: [],
        targetId: target.id,
        maxHops: 4,
        now: NOW,
      }),
    ).toHaveLength(1);
  });

  it("keeps a dense 40-person graph bounded at five hops", () => {
    const persons = Array.from({ length: 40 }, (_, index) =>
      person(`p${index}`, `人物${index}`, index === 0 ? 5 : undefined),
    );
    const relations: RelationRecord[] = [];
    for (let left = 0; left < persons.length; left += 1) {
      for (let right = left + 1; right < persons.length; right += 1) {
        relations.push(relation(`r${left}-${right}`, persons[left].id, persons[right].id));
      }
    }
    const started = performance.now();
    const result = rankConnectionPaths({
      persons,
      relations,
      events: [],
      targetId: "p39",
      maxHops: 5,
      now: NOW,
    });
    expect(result.length).toBeGreaterThan(0);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});
