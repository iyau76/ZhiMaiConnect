import { describe, expect, it } from "vitest";

import {
  getRelationshipTestSample,
  RELATIONSHIP_TEST_SAMPLES,
  type RelationshipTestSampleId,
} from "./relationship-test-samples";

describe("complex relationship test samples", () => {
  it("ships ten distinct, paste-ready materials", () => {
    expect(RELATIONSHIP_TEST_SAMPLES).toHaveLength(10);
    expect(new Set(RELATIONSHIP_TEST_SAMPLES.map((sample) => sample.id)).size).toBe(10);

    for (const sample of RELATIONSHIP_TEST_SAMPLES) {
      expect(sample.title.trim()).not.toBe("");
      expect(sample.audience.trim()).not.toBe("");
      expect(sample.featureFocus.length).toBeGreaterThanOrEqual(4);
      expect(sample.demoPrompts).toHaveLength(3);
      expect(sample.material.length).toBeGreaterThan(700);
      expect(sample.material).toContain("【人物】");
      expect(sample.material).toContain("【关系事实】");
      expect(sample.material).toContain("【材料与待核验】");
      expect(sample.material).toContain("example.invalid");
    }
  });

  it("resolves a sample by its stable id", () => {
    const id = "nirvana-in-fire" satisfies RelationshipTestSampleId;
    expect(getRelationshipTestSample(id)?.title).toBe("琅琊榜");
    expect(getRelationshipTestSample("missing" as RelationshipTestSampleId)).toBeUndefined();
  });
});
