/**
 * 演示数据门面：剧本在 demo-packs/ 下按库维护，这里只做装配与读写。
 * 所有记录 id 仍带 demo-zhimai- 前缀，清除与状态统计按前缀工作。
 */

import { facesDb } from "./face-db";
import {
  buildDemoBridges,
  buildDemoPackData,
  mergeDemoPackData,
  type DemoPackData,
} from "./demo-packs/assemble";
import { LIFE_BRIDGE_EVENTS, LIFE_BRIDGE_RELATIONS } from "./demo-packs/life/bridges";
import {
  DEMO_SCENARIOS,
  loadLifePacks,
  loadPack,
  type DemoScenarioId,
} from "./demo-packs/registry";

export { DEMO_SCENARIOS };
export type { DemoScenarioId };

/** 载入完整生活库：四个场景 + 跨包桥。世界剧场不并入，只能单独载入。 */
async function buildCompleteLifeData(): Promise<DemoPackData> {
  const parts = (await loadLifePacks()).map((pack) => buildDemoPackData(pack));
  return mergeDemoPackData(
    parts,
    buildDemoBridges({
      packs: parts,
      relations: LIFE_BRIDGE_RELATIONS,
      events: LIFE_BRIDGE_EVENTS,
    }),
  );
}

export async function buildDemoData(scenarioId: DemoScenarioId = "all"): Promise<DemoPackData> {
  if (scenarioId === "all") return buildCompleteLifeData();
  return buildDemoPackData(await loadPack(scenarioId));
}

export async function loadDemoData(scenarioId: DemoScenarioId = "all") {
  const { people, relations, collections, memberships, events, reminders } =
    await buildDemoData(scenarioId);
  await clearDemoData();
  await facesDb.applyArchiveMutationBatch({
    persons: people,
    assertions: relations,
    collections,
    collectionMemberships: memberships,
    lifeEvents: events,
    reminders,
  });
  return {
    scenarioId,
    people: people.length,
    relations: relations.length,
    events: events.length,
  };
}

export async function clearDemoData() {
  const [people, relations, events, reminders, collections, memberships] = await Promise.all([
    facesDb.listPersons(),
    facesDb.listRelationAssertions(),
    facesDb.listLifeEvents(),
    facesDb.listReminders(),
    facesDb.listCollections(),
    facesDb.listCollectionMemberships(),
  ]);
  await facesDb.applyArchiveMutationBatch({
    deletePersonIds: people
      .filter((item) => item.id.startsWith("demo-zhimai-"))
      .map((item) => item.id),
    deleteAssertionIds: relations
      .filter((item) => item.id.startsWith("demo-zhimai-"))
      .map((item) => item.id),
    deleteLifeEventIds: events
      .filter((item) => item.id.startsWith("demo-zhimai-"))
      .map((item) => item.id),
    deleteReminderIds: reminders
      .filter((item) => item.id.startsWith("demo-zhimai-"))
      .map((item) => item.id),
    deleteCollectionIds: collections
      .filter((item) => item.id.startsWith("demo-zhimai-"))
      .map((item) => item.id),
    deleteCollectionMembershipIds: memberships
      .filter((item) => item.id.startsWith("demo-zhimai-"))
      .map((item) => item.id),
  });
}

export async function getDemoDataStatus() {
  const [people, relations] = await Promise.all([
    facesDb.listPersons(),
    facesDb.listRelationAssertions(),
  ]);
  return {
    people: people.filter((item) => item.id.startsWith("demo-zhimai-")).length,
    relations: relations.filter((item) => item.id.startsWith("demo-zhimai-")).length,
  };
}
