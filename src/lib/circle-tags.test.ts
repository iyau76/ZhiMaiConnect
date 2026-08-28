import { describe, expect, it } from "vitest";

import type { PersonRecord } from "./face-db";
import { displayTagsOf, tagsOf } from "./circle-tags";

function person(input: Partial<PersonRecord>): PersonRecord {
  return {
    id: "person-1",
    name: "测试人物",
    note: "",
    descriptors: [],
    thumb: "",
    createdAt: 1,
    ...input,
  };
}

describe("confirmed person tags", () => {
  it("does not infer tags from negated or incidental free text", () => {
    expect(
      tagsOf(
        person({
          note: "我们不在同一家公司，也不是大学同学；他说他没有爸爸。",
          profile: { org: "一家咨询公司" },
        }),
      ),
    ).toEqual([]);
  });

  it("uses confirmed tags only and leaves legacy circle grouping to collections", () => {
    const record = person({ profile: { tags: ["朋友", " 朋友 ", "摄影"], circle: "亲戚" } });
    expect(tagsOf(record)).toEqual(["朋友", "摄影"]);
    expect(displayTagsOf(record)).toEqual(["朋友", "摄影"]);
  });
});
