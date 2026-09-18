/**
 * 装配器：把一份 DemoPack 展开成可直接写入 IndexedDB 的记录。
 *
 * 规则：
 * - 所有 id 带 demo-zhimai- 前缀（含包 id），clearDemoData 仍按前缀整批清除；
 * - 时间戳全部锚定在冻结的 DEMO_AT，保证开发机与 CI 字节级一致；
 * - 语义归 seed 的 predicate/qualifiers，装配器不猜。
 */

import type {
  CollectionMembershipRecord,
  CollectionRecord,
  LifeEventRecord,
  PersonRecord,
  ReminderRecord,
  RelationAssertionRecord,
} from "@/lib/face-db";
import type { Provenance } from "@/lib/provenance";
import type {
  DemoCrossEventSeed,
  DemoCrossRelationSeed,
  DemoPack,
  DemoRelationSeed,
} from "./types";

export const DEMO_AT = Date.UTC(2026, 8, 18, 2);
const demoSource: Provenance = { kind: "manual", detail: "合成演示数据", at: DEMO_AT };

export interface DemoPackData {
  people: PersonRecord[];
  relations: RelationAssertionRecord[];
  collections: CollectionRecord[];
  memberships: CollectionMembershipRecord[];
  events: LifeEventRecord[];
  reminders: ReminderRecord[];
}

function personId(packId: string, key: string) {
  return `demo-zhimai-${packId}-${key}`;
}

function pad(value: number, width = 2) {
  return String(value).padStart(width, "0");
}

function buildPerson(pack: DemoPack): PersonRecord[] {
  const seen = new Set<string>();
  return pack.people.map((seed, index) => {
    if (seen.has(seed.key)) throw new Error(`演示包 ${pack.id} 人物 key 重复：${seed.key}`);
    seen.add(seed.key);
    const { profile } = seed;
    const note =
      seed.note ??
      (profile.likes?.length
        ? `合成角色：${profile.relation}，可协助${profile.likes[0]}。`
        : `合成角色：${profile.relation}。`);
    const at = DEMO_AT - index * 36_000;
    return {
      id: personId(pack.id, seed.key),
      name: seed.name,
      note,
      profile: { ...profile },
      rawProfileText: "本条为合成演示资料，不对应真实个人。",
      descriptors: [],
      thumb: "",
      createdAt: at,
      updatedAt: seed.touched ? at + 1_000 : undefined,
      source: seed.lowConfidence
        ? { kind: "ai", detail: "合成演示中的低置信度资料，待复核", at }
        : demoSource,
    } satisfies PersonRecord;
  });
}

function buildCollections(pack: DemoPack) {
  const knownKeys = new Set(pack.people.map((seed) => seed.key));
  const collections: CollectionRecord[] = pack.collections.map((collection, index) => ({
    id: `demo-zhimai-${pack.id}-collection-${pad(index + 1)}`,
    name: collection.name,
    kind: "relationship_circle",
    createdAt: DEMO_AT,
    updatedAt: DEMO_AT,
  }));
  const memberships: CollectionMembershipRecord[] = [];
  pack.collections.forEach((collection, index) => {
    for (const member of collection.members) {
      if (!knownKeys.has(member)) {
        throw new Error(
          `演示包 ${pack.id} 圈层「${collection.name}」引用了不存在的人物：${member}`,
        );
      }
      memberships.push({
        id: `${collections[index].id}\u0000${personId(pack.id, member)}`,
        collectionId: collections[index].id,
        personId: personId(pack.id, member),
        source: "manual",
        createdAt: DEMO_AT,
      });
    }
  });
  // 防御笔误：每个人物至少归属一个圈层。
  const memberKeys = new Set(pack.collections.flatMap((collection) => collection.members));
  for (const seed of pack.people) {
    if (!memberKeys.has(seed.key)) {
      throw new Error(`演示包 ${pack.id} 人物 ${seed.key} 未加入任何圈层`);
    }
  }
  return { collections, memberships };
}

function buildRelation(
  seed: DemoRelationSeed,
  fromId: string,
  toId: string,
  id: string,
  index: number,
): RelationAssertionRecord {
  const at = DEMO_AT - index * 60_000;
  const pending = seed.pending === true;
  return {
    id,
    recordType: "assertion",
    fromId,
    toId,
    predicate: seed.predicate,
    qualifiers: { temporalStatus: "current", ...seed.qualifiers },
    label: seed.label,
    direction: "ontology",
    note: seed.note,
    evidence: {
      mode: pending ? "source_claim" : "manual",
      basis: pending
        ? `推断依据：${seed.note ?? seed.label}`
        : `合成演示设定：${seed.note ?? seed.label}`,
      sourceIds: [],
    },
    validity: seed.validity ?? { status: "active" },
    createdAt: at,
    updatedAt: at,
    confirmationStatus: pending ? "pending" : "confirmed",
    confidence: seed.confidence ?? (pending ? 0.62 : 0.96),
    source: pending ? { kind: "ai", detail: "合成低置信度关系", at } : demoSource,
  } satisfies RelationAssertionRecord;
}

function buildRelations(pack: DemoPack, people: PersonRecord[]): RelationAssertionRecord[] {
  const knownKeys = new Set(pack.people.map((seed) => seed.key));
  return pack.relations.map((seed, index) => {
    for (const endpoint of [seed.from, seed.to]) {
      if (!knownKeys.has(endpoint)) {
        throw new Error(`演示包 ${pack.id} 关系「${seed.label}」引用了不存在的人物：${endpoint}`);
      }
    }
    return buildRelation(
      seed,
      personId(pack.id, seed.from),
      personId(pack.id, seed.to),
      `demo-zhimai-${pack.id}-relation-${pad(index + 1)}`,
      index,
    );
  });
}

function buildEvents(pack: DemoPack, people: PersonRecord[]): LifeEventRecord[] {
  const knownKeys = new Set(pack.people.map((seed) => seed.key));
  return pack.events.map(({ people: keys, ...seed }, index) => {
    for (const key of keys) {
      if (!knownKeys.has(key)) {
        throw new Error(`演示包 ${pack.id} 事件「${seed.title}」引用了不存在的人物：${key}`);
      }
    }
    const at = DEMO_AT - index * 86_400_000;
    return {
      ...seed,
      id: `demo-zhimai-${pack.id}-event-${pad(index + 1)}`,
      personIds: keys.map((key) => personId(pack.id, key)),
      createdAt: at,
      updatedAt: at,
      source: demoSource,
    } satisfies LifeEventRecord;
  });
}

function buildReminders(pack: DemoPack): ReminderRecord[] {
  const knownKeys = new Set(pack.people.map((seed) => seed.key));
  return pack.reminders.map((seed, index) => {
    for (const key of seed.people) {
      if (!knownKeys.has(key)) {
        throw new Error(`演示包 ${pack.id} 提醒「${seed.title}」引用了不存在的人物：${key}`);
      }
    }
    return {
      id: `demo-zhimai-${pack.id}-reminder-${index + 1}`,
      title: seed.title,
      due: seed.due,
      personIds: seed.people.map((key) => personId(pack.id, key)),
      kind: seed.kind,
      done: false,
      createdAt: DEMO_AT + index,
      source: demoSource,
    } satisfies ReminderRecord;
  });
}

/** 展开一份自包含 pack；跨包引用在此处直接抛错。 */
export function buildDemoPackData(pack: DemoPack): DemoPackData {
  const people = buildPerson(pack);
  const { collections, memberships } = buildCollections(pack);
  return {
    people,
    relations: buildRelations(pack, people),
    collections,
    memberships,
    events: buildEvents(pack, people),
    reminders: buildReminders(pack),
  };
}

/** 合并多份已装配的 pack 并附加跨包桥；「完整生活库」走这条路。 */
export function mergeDemoPackData(
  parts: DemoPackData[],
  bridges: ReturnType<typeof buildDemoBridges>,
): DemoPackData {
  return {
    people: parts.flatMap((part) => part.people),
    relations: [...parts.flatMap((part) => part.relations), ...bridges.relations],
    collections: parts.flatMap((part) => part.collections),
    memberships: parts.flatMap((part) => part.memberships),
    events: [...parts.flatMap((part) => part.events), ...bridges.events],
    reminders: parts.flatMap((part) => part.reminders),
  };
}

/**
 * 装配跨包桥接：from/to 与 people 使用 `<packId>/<key>` 复合键，
 * 只在载入完整生活库时与各包结果合并。
 */
export function buildDemoBridges(input: {
  packs: DemoPackData[];
  relations: DemoCrossRelationSeed[];
  events: DemoCrossEventSeed[];
}): Pick<DemoPackData, "relations" | "events"> {
  const ids = new Map<string, string>();
  for (const data of input.packs) {
    for (const person of data.people) {
      const rest = person.id.slice("demo-zhimai-".length);
      const slash = rest.indexOf("-");
      const packId = rest.slice(0, slash);
      const key = rest.slice(slash + 1);
      ids.set(`${packId}/${key}`, person.id);
    }
  }
  const resolve = (composite: string) => {
    const id = ids.get(composite);
    if (!id) throw new Error(`跨包桥接引用了不存在的人物：${composite}`);
    return id;
  };
  const offset = input.packs.reduce((sum, data) => sum + data.relations.length, 0);
  return {
    relations: input.relations.map((seed, index) =>
      buildRelation(
        seed,
        resolve(seed.from),
        resolve(seed.to),
        `demo-zhimai-bridge-relation-${pad(index + 1)}`,
        offset + index,
      ),
    ),
    events: input.events.map(({ people: composites, ...seed }, index) => ({
      ...seed,
      id: `demo-zhimai-bridge-event-${pad(index + 1)}`,
      personIds: composites.map(resolve),
      createdAt: DEMO_AT - (offset + index) * 86_400_000,
      updatedAt: DEMO_AT - (offset + index) * 86_400_000,
      source: demoSource,
    })),
  };
}
