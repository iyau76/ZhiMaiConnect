import { createArchiveV2, type ArchiveV2, type ArchiveV2Source } from "../../src/lib/archive-data";
import { buildDemoData } from "../../src/lib/demo-data";
import { projectKinshipRelations } from "../../src/lib/kinship-projector";

const FIXTURE_EXPORTED_AT = "2026-09-04T00:00:00.000Z";
const FIXTURE_APP_VERSION = "stage-zero-fixture";
const STRESS_COHORTS = 10;

export type ArchiveFixtureId = "empty" | "demo-50" | "stress-500";

export interface ArchiveFixtureCounts {
  persons: number;
  relationAssertions: number;
  derivedRelations: number;
  collections: number;
  collectionMemberships: number;
  lifeEvents: number;
  reminders: number;
}

export const ARCHIVE_FIXTURE_COUNTS: Record<ArchiveFixtureId, ArchiveFixtureCounts> = {
  empty: {
    persons: 0,
    relationAssertions: 0,
    derivedRelations: 0,
    collections: 0,
    collectionMemberships: 0,
    lifeEvents: 0,
    reminders: 0,
  },
  "demo-50": {
    persons: 50,
    relationAssertions: 80,
    derivedRelations: 7,
    collections: 6,
    collectionMemberships: 50,
    lifeEvents: 25,
    reminders: 3,
  },
  "stress-500": {
    persons: 500,
    relationAssertions: 809,
    derivedRelations: 70,
    collections: 6,
    collectionMemberships: 500,
    lifeEvents: 250,
    reminders: 30,
  },
};

function emptySource(): ArchiveV2Source {
  return {
    persons: [],
    relationAssertions: [],
    derivedRelations: [],
    relationEvidenceLinks: [],
    relationViewPreferences: [],
    referralPolicies: [],
    collections: [],
    collectionMemberships: [],
    evidence: [],
    caseEvents: [],
    tasks: [],
    projects: [],
    lifeEvents: [],
    reminders: [],
  };
}

function withCurrentProjection(source: ArchiveV2Source): ArchiveV2Source {
  return {
    ...source,
    derivedRelations: projectKinshipRelations({
      assertions: source.relationAssertions,
      persons: source.persons,
    }).relations,
  };
}

function archive(source: ArchiveV2Source) {
  return createArchiveV2(withCurrentProjection(source), {
    exportedAt: FIXTURE_EXPORTED_AT,
    appVersion: FIXTURE_APP_VERSION,
  });
}

function demoSource(): ArchiveV2Source {
  const { people, relations, collections, memberships, events, reminders } = buildDemoData();
  return {
    ...emptySource(),
    persons: people,
    relationAssertions: relations,
    collections,
    collectionMemberships: memberships,
    lifeEvents: events,
    reminders,
  };
}

function cohortPrefix(cohort: number) {
  return `fixture:stress:${String(cohort + 1).padStart(2, "0")}`;
}

function stressSource(): ArchiveV2Source {
  const base = demoSource();
  const source = emptySource();
  const collectionIdByBaseId = new Map<string, string>();

  source.collections = base.collections.map((collection, index) => {
    const id = `fixture:stress:collection:${String(index + 1).padStart(2, "0")}`;
    collectionIdByBaseId.set(collection.id, id);
    return { ...collection, id };
  });

  for (let cohort = 0; cohort < STRESS_COHORTS; cohort += 1) {
    const prefix = cohortPrefix(cohort);
    const personIdByBaseId = new Map<string, string>();
    const assertionIdByBaseId = new Map<string, string>();

    base.persons.forEach((person, index) => {
      const id = `${prefix}:person:${String(index + 1).padStart(2, "0")}`;
      personIdByBaseId.set(person.id, id);
      source.persons.push({
        ...person,
        id,
        name: `${person.name}·${cohort + 1}`,
        profile: person.profile
          ? {
              ...person.profile,
              identities: person.profile.identities?.map((identity) => ({
                ...identity,
                account: identity.account ? `${identity.account}-${cohort + 1}` : undefined,
              })),
              contact: person.profile.contact
                ? person.profile.contact.replace("@", `+${cohort + 1}@`)
                : undefined,
            }
          : undefined,
      });
    });

    base.relationAssertions.forEach((relation, index) => {
      assertionIdByBaseId.set(
        relation.id,
        `${prefix}:relation:${String(index + 1).padStart(2, "0")}`,
      );
    });
    base.relationAssertions.forEach((relation) => {
      source.relationAssertions.push({
        ...relation,
        id: assertionIdByBaseId.get(relation.id)!,
        fromId: personIdByBaseId.get(relation.fromId)!,
        toId: personIdByBaseId.get(relation.toId)!,
        supersedesAssertionId: relation.supersedesAssertionId
          ? assertionIdByBaseId.get(relation.supersedesAssertionId)
          : undefined,
      });
    });

    base.collectionMemberships.forEach((membership, index) => {
      source.collectionMemberships.push({
        ...membership,
        id: `${prefix}:membership:${String(index + 1).padStart(2, "0")}`,
        collectionId: collectionIdByBaseId.get(membership.collectionId)!,
        personId: personIdByBaseId.get(membership.personId)!,
      });
    });

    base.lifeEvents.forEach((event, index) => {
      source.lifeEvents.push({
        ...event,
        id: `${prefix}:event:${String(index + 1).padStart(2, "0")}`,
        title: `${event.title}（第 ${cohort + 1} 组）`,
        personIds: event.personIds?.map((id) => personIdByBaseId.get(id)!),
      });
    });

    base.reminders.forEach((reminder, index) => {
      source.reminders.push({
        ...reminder,
        id: `${prefix}:reminder:${String(index + 1).padStart(2, "0")}`,
        title: `${reminder.title}（第 ${cohort + 1} 组）`,
        personIds: reminder.personIds?.map((id) => personIdByBaseId.get(id)!),
      });
    });
  }

  for (let cohort = 0; cohort < STRESS_COHORTS - 1; cohort += 1) {
    const at = Date.UTC(2026, 7, 20, 10, cohort);
    source.relationAssertions.push({
      id: `fixture:stress:bridge:${String(cohort + 1).padStart(2, "0")}`,
      recordType: "assertion",
      fromId: `${cohortPrefix(cohort)}:person:50`,
      toId: `${cohortPrefix(cohort + 1)}:person:01`,
      predicate: "collaborates_with",
      qualifiers: { temporalStatus: "current" },
      label: "跨组协作",
      direction: "ontology",
      note: "合成压力库中的跨组连接",
      evidence: {
        mode: "manual",
        basis: "合成压力测试设定：相邻组共同筹备活动",
        sourceIds: [],
      },
      validity: { status: "active" },
      confidence: 0.96,
      confirmationStatus: "confirmed",
      createdAt: at,
      updatedAt: at,
      source: { kind: "manual", detail: "合成压力测试数据", at },
    });
  }

  return source;
}

export function emptyArchiveFixture(): ArchiveV2 {
  return archive(emptySource());
}

export function demo50ArchiveFixture(): ArchiveV2 {
  return archive(demoSource());
}

export function stress500ArchiveFixture(): ArchiveV2 {
  return archive(stressSource());
}

export function archiveFixture(id: ArchiveFixtureId): ArchiveV2 {
  if (id === "empty") return emptyArchiveFixture();
  if (id === "demo-50") return demo50ArchiveFixture();
  return stress500ArchiveFixture();
}
