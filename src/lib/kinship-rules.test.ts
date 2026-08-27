import { describe, expect, it } from "vitest";

import {
  isInferredRelationBasis,
  KINSHIP_RULES_ZH,
  normalizeRelationConfidence,
  relationNeedsInferenceReview,
} from "./kinship-rules";

describe("kinship inference contract", () => {
  it("recognises only explicitly labelled inference bases", () => {
    expect(isInferredRelationBasis("推断依据：同为贾母之子")).toBe(true);
    expect(isInferredRelationBasis("原文：贾母有两个儿子")).toBe(false);
    expect(isInferredRelationBasis(undefined)).toBe(false);
  });

  it("defaults and caps inferred confidence without changing explicit confidence", () => {
    expect(normalizeRelationConfidence("推断依据：共同母亲", undefined)).toBe(0.7);
    expect(normalizeRelationConfidence("推断依据：共同母亲", 0.94)).toBe(0.75);
    expect(normalizeRelationConfidence("推断依据：共同母亲", 0.62)).toBe(0.62);
    expect(normalizeRelationConfidence("原文：两人是夫妻", 0.96)).toBe(0.96);
  });

  it("flags low-confidence or explicitly derived relations for inference review", () => {
    expect(relationNeedsInferenceReview({ confidence: 0.7 })).toBe(true);
    expect(relationNeedsInferenceReview({ note: "AI 亲属推导，需核验" })).toBe(true);
    expect(relationNeedsInferenceReview({ basis: "推断依据：共同母亲" })).toBe(true);
    expect(relationNeedsInferenceReview({ basis: "原文：两人是夫妻", confidence: 0.96 })).toBe(
      false,
    );
  });

  it.each(["共同", "祖孙", "同父异母", "姻亲", "姑表", "补建", "confidence", "basis"])(
    "ships the required kinship instruction: %s",
    (term) => expect(KINSHIP_RULES_ZH).toContain(term),
  );

  it("contains both required few-shot scenarios", () => {
    expect(KINSHIP_RULES_ZH).toContain("贾母有两个儿子贾赦和贾政");
    expect(KINSHIP_RULES_ZH).toContain("我大姑有一个儿子和一个女儿");
  });
});
