import { describe, expect, it } from "vitest";

import { deriveKinshipRelations } from "./kinship-engine";

const explicit = (from: string, to: string, label: string) => ({
  from,
  to,
  label,
  basis: `原文：${from}与${to}是${label}`,
  confidence: 0.96,
});

describe("deterministic kinship closure", () => {
  it("derives siblings, grandparents and great-grandparents without guessing seniority", () => {
    const result = deriveKinshipRelations({
      relations: [
        explicit("太爷爷", "爷爷", "父子"),
        explicit("爷爷", "爸爸", "父子"),
        explicit("爸爸", "我", "父子"),
        explicit("爸爸", "妹妹", "父女"),
      ],
    });
    expect(result.relations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: "太爷爷", to: "我", label: "曾祖孙" }),
        expect.objectContaining({ from: "我", to: "妹妹", label: "兄弟姐妹" }),
      ]),
    );
    expect(result.relations?.find((item) => item.label === "兄弟姐妹")?.basis).toContain(
      "未依据材料猜测长幼",
    );
  });

  it("derives uncle/aunt relations and keeps spouse-side ties as in-laws", () => {
    const result = deriveKinshipRelations({
      people: [
        { name: "贾宝玉", gender: "男" },
        { name: "王夫人", gender: "女" },
        { name: "王熙凤", gender: "女" },
      ],
      relations: [
        explicit("王夫人", "贾珠", "母子"),
        explicit("贾珠", "贾宝玉", "兄弟"),
        explicit("贾珠", "贾兰", "父子"),
        explicit("贾琏", "王熙凤", "夫妻"),
        explicit("贾赦", "贾琏", "父子"),
      ],
    });
    expect(result.relations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: "贾宝玉", to: "贾兰", label: "叔伯侄" }),
        expect.objectContaining({ from: "贾赦", to: "王熙凤", label: "翁媳" }),
      ]),
    );
  });

  it("can combine a newly extracted edge with explicit archive support", () => {
    const result = deriveKinshipRelations({ relations: [explicit("贾政", "贾宝玉", "父子")] }, [
      explicit("贾母", "贾政", "母子"),
    ]);
    expect(result.relations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: "贾母", to: "贾宝玉", label: "祖孙" }),
      ]),
    );
    expect(result.relations).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ from: "贾母", to: "贾政" })]),
    );
  });

  it("distinguishes known half-siblings and step-siblings without claiming blood relation", () => {
    const result = deriveKinshipRelations({
      people: [{ name: "父亲", gender: "男" }],
      relations: [
        explicit("父亲", "甲", "父子"),
        explicit("父亲", "乙", "父女"),
        explicit("母亲甲", "甲", "母子"),
        explicit("母亲乙", "乙", "母女"),
        explicit("继母", "甲", "继母"),
        explicit("继母", "丙", "母女"),
      ],
    });
    expect(result.relations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: "甲", to: "乙", label: "同父异母兄弟姐妹" }),
        expect.objectContaining({ from: "甲", to: "丙", label: "继兄弟姐妹（无血缘）" }),
      ]),
    );
  });

  it("closes shared-parent evidence into uncle and cousin relations without an AI reasoning hop", () => {
    const result = deriveKinshipRelations({
      people: [
        { name: "祖父", gender: "男" },
        { name: "父亲", gender: "男" },
        { name: "叔叔", gender: "男" },
      ],
      relations: [
        explicit("祖父", "父亲", "父子"),
        explicit("祖父", "叔叔", "父子"),
        explicit("父亲", "我", "父子"),
        explicit("叔叔", "堂妹", "父女"),
      ],
    });
    expect(result.relations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: "叔叔", to: "我", label: "叔伯侄" }),
        expect.objectContaining({ from: "我", to: "堂妹", label: "堂亲" }),
      ]),
    );
  });
});
