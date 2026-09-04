import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ARCHIVE_FIXTURE_COUNTS,
  archiveFixture,
  type ArchiveFixtureId,
} from "./fixtures/archive-fixtures";
import {
  archiveRestorePlan,
  assertArchiveIntegrity,
  normalizeArchive,
  type ArchiveV2,
} from "../src/lib/archive-data";
import { projectKinshipRelations } from "../src/lib/kinship-projector";

const FIXTURES: ArchiveFixtureId[] = ["empty", "demo-50", "stress-500"];

function useFreshIndexedDb() {
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: new IDBFactory(),
    writable: true,
  });
}

function byId<T extends { id: string }>(rows: readonly T[]) {
  return [...rows].sort((left, right) => left.id.localeCompare(right.id));
}

function invariantCounts(archive: ArchiveV2) {
  return {
    persons: archive.records.persons.length,
    relationAssertions: archive.records.relationAssertions.length,
    derivedRelations: archive.projectionDiagnostics.derivedRelations.length,
    collections: archive.records.collections.length,
    collectionMemberships: archive.records.collectionMemberships.length,
    lifeEvents: archive.records.lifeEvents.length,
    reminders: archive.records.reminders.length,
  };
}

function danglingProjectionReferences(archive: ArchiveV2) {
  const personIds = new Set(archive.records.persons.map((person) => person.id));
  const assertionIds = new Set(archive.records.relationAssertions.map((assertion) => assertion.id));
  return archive.projectionDiagnostics.derivedRelations.flatMap((relation) => {
    const dangling = [] as string[];
    if (!personIds.has(relation.fromId)) dangling.push(`${relation.id}:fromId`);
    if (!personIds.has(relation.toId)) dangling.push(`${relation.id}:toId`);
    for (const supportingId of relation.supportingRelationIds) {
      if (!assertionIds.has(supportingId)) dangling.push(`${relation.id}:support:${supportingId}`);
    }
    return dangling;
  });
}

function rebuiltProjection(archive: ArchiveV2) {
  return projectKinshipRelations({
    assertions: archive.records.relationAssertions,
    persons: archive.records.persons,
  }).relations;
}

function expectSameDurableRecords(actual: ArchiveV2, expected: ArchiveV2) {
  for (const key of Object.keys(expected.records) as Array<keyof ArchiveV2["records"]>) {
    expect(byId(actual.records[key])).toEqual(byId(expected.records[key]));
  }
}

beforeEach(() => {
  vi.resetModules();
  useFreshIndexedDb();
});

describe("stage-zero archive@2 fixtures", () => {
  it.each(FIXTURES)("%s is deterministic and satisfies its pinned invariants", (fixtureId) => {
    const first = archiveFixture(fixtureId);
    const second = archiveFixture(fixtureId);

    expect(second).toEqual(first);
    expect(first.schema).toBe("zhimai-connect/archive@2");
    expect(first.exportedAt).toBe("2026-09-04T00:00:00.000Z");
    expect(invariantCounts(first)).toEqual(ARCHIVE_FIXTURE_COUNTS[fixtureId]);
    expect(() => assertArchiveIntegrity(first)).not.toThrow();
    expect(danglingProjectionReferences(first)).toEqual([]);
    expect(byId(first.projectionDiagnostics.derivedRelations)).toEqual(
      byId(rebuiltProjection(first)),
    );
    expect(first.projectionDiagnostics.importPolicy).toBe("discard-and-rebuild");
    expect(new Set(first.records.persons.map((person) => person.id)).size).toBe(
      first.records.persons.length,
    );
    expect(
      new Set(
        first.records.collectionMemberships.map(
          (membership) => `${membership.collectionId}\u0000${membership.personId}`,
        ),
      ).size,
    ).toBe(first.records.collectionMemberships.length);
    expect(
      first.records.relationAssertions.every((assertion) => assertion.fromId !== assertion.toId),
    ).toBe(true);

    const normalized = normalizeArchive(JSON.stringify(first));
    expect(normalized.sourceSchema).toBe("zhimai-connect/archive@2");
    expect(normalized.archive).toEqual(first);

    const serialized = JSON.stringify(first);
    expect(serialized).not.toMatch(/(?:api[_-]?key|bearer\s+|sk-[a-z0-9]{12,})/i);
    for (const person of first.records.persons) {
      if (person.profile?.contact) expect(person.profile.contact).toMatch(/@example\.invalid$/);
    }
  });

  it.each(FIXTURES)(
    "%s survives export, clear, restore and local projection rebuild",
    async (fixtureId) => {
      const fixture = archiveFixture(fixtureId);
      const { buildMachineArchive, restoreMachineArchive } = await import("../src/lib/export-data");
      const { facesDb } = await import("../src/lib/face-db");

      const seeded = await restoreMachineArchive(JSON.stringify(fixture));
      expect(seeded.recordCount).toBe(
        Object.values(fixture.records).reduce((sum, rows) => sum + rows.length, 0),
      );
      const firstExport = await buildMachineArchive();
      expectSameDurableRecords(firstExport, fixture);
      expect(byId(firstExport.projectionDiagnostics.derivedRelations)).toEqual(
        byId(fixture.projectionDiagnostics.derivedRelations),
      );

      const emptyRecords = archiveRestorePlan(archiveFixture("empty")).records;
      await facesDb.replaceArchiveSnapshot({
        ...emptyRecords,
        persons: emptyRecords.persons.map((person) => ({
          ...person,
          descriptors: [],
          thumb: "",
        })),
      });
      const cleared = await facesDb.readArchiveSnapshot();
      expect(Object.values(cleared).every((rows) => rows.length === 0)).toBe(true);

      const preview = await restoreMachineArchive(JSON.stringify(firstExport));
      expect(preview.recordCount).toBe(
        Object.values(fixture.records).reduce((sum, rows) => sum + rows.length, 0),
      );
      expect(preview.discardedProjectionCount).toBe(
        firstExport.projectionDiagnostics.derivedRelations.length,
      );

      const restored = await buildMachineArchive();
      expectSameDurableRecords(restored, fixture);
      expect(byId(restored.projectionDiagnostics.derivedRelations)).toEqual(
        byId(fixture.projectionDiagnostics.derivedRelations),
      );
      expect(danglingProjectionReferences(restored)).toEqual([]);
      expect(() => assertArchiveIntegrity(restored)).not.toThrow();
    },
    30_000,
  );
});
