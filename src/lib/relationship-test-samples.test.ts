import { describe, expect, it } from "vitest";

import {
  getRelationshipTestSample,
  RELATIONSHIP_TEST_SAMPLES,
  type RelationshipTestSampleId,
} from "./relationship-test-samples";

function sectionLines(material: string, heading: string, nextHeading: string) {
  const section = material.match(
    new RegExp(`${heading}\\r?\\n([\\s\\S]*?)\\r?\\n\\r?\\n${nextHeading}`),
  )?.[1];
  return section?.split(/\r?\n/).filter((line) => line.trim()) ?? [];
}

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
      expect(sample.material).toContain("【圈层】");
      expect(sample.material).toContain("【关系事实】");
      expect(sample.material).toContain("【材料与待核验】");
      if (sample.contactPolicy === "none") {
        expect(sample.material).not.toMatch(/@example\.invalid|010-\d{4}-\d{4}/);
      } else {
        expect(sample.material).toMatch(/@example\.invalid|010-\d{4}-\d{4}/);
      }
    }
  });

  it("keeps every person in at least one circle and each sample reasonably dense", () => {
    for (const sample of RELATIONSHIP_TEST_SAMPLES) {
      const people = sectionLines(sample.material, "【人物】", "【圈层】").map((line) =>
        line.split("，", 1)[0].trim(),
      );
      const circleLines = sectionLines(sample.material, "【圈层】", "【关系事实】");
      const circles = circleLines.join("\n");

      expect(people.length, `${sample.id} should include a broad cast`).toBeGreaterThanOrEqual(15);
      expect(
        circleLines.length,
        `${sample.id} should have meaningful circle structure`,
      ).toBeGreaterThanOrEqual(5);
      for (const person of people) {
        expect(circles, `${sample.id} circle references should include ${person}`).toContain(
          person,
        );
      }
    }
  });

  it("only uses synthetic contacts in modern settings", () => {
    expect(
      RELATIONSHIP_TEST_SAMPLES.filter((sample) => sample.contactPolicy === "synthetic").map(
        (sample) => sample.id,
      ),
    ).toEqual(["three-body", "reply-1988"]);
  });

  it("resolves a sample by its stable id", () => {
    const id = "nirvana-in-fire" satisfies RelationshipTestSampleId;
    expect(getRelationshipTestSample(id)?.title).toBe("琅琊榜");
    expect(getRelationshipTestSample("missing" as RelationshipTestSampleId)).toBeUndefined();
  });
});
