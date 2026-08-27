import { describe, expect, it } from "vitest";

import { inferMutual, isMutualRelation } from "./relation-kind";

describe("inferMutual", () => {
  it.each(["大学同学", "多年好友", "女朋友", "合作伙伴", "ROOMMATE", "co-worker", "SchoolMate"])(
    "recognizes a peer relationship: %s",
    (label) => {
      expect(inferMutual(label)).toBe(true);
    },
  );

  it.each(["直属上司", "父子", "导师带学生", "reports to", "Supplier", "客户介绍人"])(
    "recognizes a directed relationship: %s",
    (label) => {
      expect(inferMutual(label)).toBe(false);
    },
  );

  it("uses the longest matching phrase so 女朋友 is not mistaken for 女", () => {
    expect(inferMutual("女朋友")).toBe(true);
  });

  it.each(["", "   ", "偶遇", "unknown"])(
    "defaults an empty or unknown relationship to directed: %s",
    (label) => {
      expect(inferMutual(label)).toBe(false);
    },
  );
});

describe("isMutualRelation", () => {
  it("honors an explicit direction even when the label suggests otherwise", () => {
    expect(isMutualRelation({ label: "朋友", mutual: false })).toBe(false);
    expect(isMutualRelation({ label: "直属上司", mutual: true })).toBe(true);
  });

  it("infers the direction only when the explicit field is absent", () => {
    expect(isMutualRelation({ label: "朋友" })).toBe(true);
    expect(isMutualRelation({ label: "直属上司" })).toBe(false);
  });
});
