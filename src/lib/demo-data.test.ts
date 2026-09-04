import { describe, expect, it } from "vitest";

import { buildDemoData, DEMO_SCENARIOS, type DemoScenarioId } from "./demo-data";

const EXPECTED_PERSON: Record<Exclude<DemoScenarioId, "all">, string> = {
  campus: "唐悦",
  family: "苏琴",
  workplace: "江禾",
  small_business: "袁野",
};

describe("demo scenario packs", () => {
  it("keeps the complete 50-person fixture as the default", () => {
    const data = buildDemoData();
    expect(data.people).toHaveLength(50);
    expect(data.relations).toHaveLength(80);
    expect(data.events).toHaveLength(25);
  });

  it("defines four self-contained life scenarios with valid references", () => {
    expect(DEMO_SCENARIOS.map((scenario) => scenario.id)).toEqual([
      "campus",
      "family",
      "workplace",
      "small_business",
    ]);

    for (const scenario of DEMO_SCENARIOS) {
      const data = buildDemoData(scenario.id);
      const personIds = new Set(data.people.map((person) => person.id));
      const collectionIds = new Set(data.collections.map((collection) => collection.id));

      expect(data.people.map((person) => person.name)).toContain(EXPECTED_PERSON[scenario.id]);
      expect(data.people.length).toBeGreaterThanOrEqual(10);
      expect(data.relations.length).toBeGreaterThanOrEqual(10);
      expect(data.events.length).toBeGreaterThanOrEqual(1);
      expect(
        data.relations.every(
          (relation) => personIds.has(relation.fromId) && personIds.has(relation.toId),
        ),
      ).toBe(true);
      expect(
        data.memberships.every(
          (membership) =>
            personIds.has(membership.personId) && collectionIds.has(membership.collectionId),
        ),
      ).toBe(true);
      expect(
        data.events.every((event) =>
          (event.personIds ?? []).every((personId) => personIds.has(personId)),
        ),
      ).toBe(true);
      expect(
        data.reminders.every((reminder) =>
          (reminder.personIds ?? []).every((personId) => personIds.has(personId)),
        ),
      ).toBe(true);
    }
  });
});
