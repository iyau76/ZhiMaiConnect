/**
 * 录入草稿里的圈层成员投影。
 *
 * 人物卡片、可加入圈层列表和关系预览必须读同一个「提交后成员状态」，
 * 否则同一个人的归属会在不同入口给出不同答案（PR #8 复核第 1–4 条）。
 * 这里只做纯计算，写入仍然走 intake-collections 的编译通道。
 */

import type { CollectionMembershipRecord, CollectionRecord } from "@/lib/face-db";
import type { IngestCollection } from "@/lib/intake-draft";

export interface CircleRef {
  id: string;
  name: string;
}

type MemberEntry = IngestCollection["memberships"][number];

interface PersonRefInput {
  targetPersonId?: string;
  _draftId?: string;
}

/**
 * 草稿人物最终会落到哪个人物 id：更新已有的人用档案 id，新建的人只能用草稿 id 追踪。
 * `createNewSentinel` 是「新建独立人物档案」的哨兵值，不能当成档案 id 用。
 */
export function resolvePersonRef(
  person: PersonRefInput,
  createNewSentinel: string,
): { existingId: string | null; draftId: string } {
  const target = person.targetPersonId ?? "";
  const isExisting = target.length > 0 && target !== createNewSentinel;
  return { existingId: isExisting ? target : null, draftId: person._draftId ?? "" };
}

/** 草稿里针对这个人写下的最后一次圈层增删；档案 id 与草稿 id 两种形态都认。 */
export function draftCircleOps(
  person: PersonRefInput,
  drafts: IngestCollection[] | undefined,
  createNewSentinel: string,
): Array<{ collection: IngestCollection; action: MemberEntry["action"] | null }> {
  const { existingId, draftId } = resolvePersonRef(person, createNewSentinel);
  return (drafts ?? []).map((collection) => {
    const ops = collection.memberships.filter(
      (member) =>
        (draftId.length > 0 && member.personDraftId === draftId) ||
        (existingId !== null && member.personId === existingId),
    );
    return { collection, action: ops.at(-1)?.action ?? null };
  });
}

/**
 * 提交后这个人属于哪些圈层：已保存的成员关系叠加本次增删的结果。
 */
export function effectiveCircles(input: {
  person: PersonRefInput;
  drafts: IngestCollection[] | undefined;
  collections: CollectionRecord[];
  memberships: CollectionMembershipRecord[];
  createNewSentinel: string;
  unnamedLabel: string;
}): CircleRef[] {
  const { createNewSentinel, unnamedLabel } = input;
  const { existingId } = resolvePersonRef(input.person, createNewSentinel);
  const rows = new Map<string, CircleRef>();

  if (existingId !== null) {
    const savedIds = new Set(input.collections.map((collection) => collection.id));
    for (const membership of input.memberships) {
      if (membership.personId !== existingId) continue;
      if (!savedIds.has(membership.collectionId)) continue;
      const collection = input.collections.find((row) => row.id === membership.collectionId);
      if (!collection || collection.kind === "computed_community") continue;
      rows.set(collection.id, { id: collection.id, name: collection.name });
    }
  }

  for (const { collection, action } of draftCircleOps(
    input.person,
    input.drafts,
    createNewSentinel,
  )) {
    if (!action) continue;
    if (action === "remove") {
      rows.delete(collection.targetCollectionId);
      continue;
    }
    const saved = input.collections.find((row) => row.id === collection.targetCollectionId);
    rows.set(collection.targetCollectionId, {
      id: collection.targetCollectionId,
      name: collection.name || saved?.name || unnamedLabel,
    });
  }

  return [...rows.values()];
}

/** 下拉里可加入的圈层：已保存的 + 本批次还没保存的草稿，按同一个 id 去重。 */
export function addableCircles(input: {
  person: PersonRefInput;
  drafts: IngestCollection[] | undefined;
  collections: CollectionRecord[];
  memberships: CollectionMembershipRecord[];
  createNewSentinel: string;
  unnamedLabel: string;
}): CircleRef[] {
  const current = new Set(effectiveCircles(input).map((row) => row.id));
  const rows = new Map<string, CircleRef>();

  for (const collection of input.collections) {
    if (collection.kind === "computed_community") continue;
    if (current.has(collection.id)) continue;
    rows.set(collection.id, { id: collection.id, name: collection.name });
  }

  for (const collection of input.drafts ?? []) {
    if (current.has(collection.targetCollectionId)) continue;
    // 整条草稿都在做移除，没有可加入的内容
    if (collection.memberships.every((member) => member.action === "remove")) continue;
    const saved = input.collections.find((row) => row.id === collection.targetCollectionId);
    rows.set(collection.targetCollectionId, {
      id: collection.targetCollectionId,
      name: collection.name || saved?.name || input.unnamedLabel,
    });
  }

  return [...rows.values()];
}

/** 写进草稿的成员条目：能落到档案的人带上 personId，新建的人只带草稿 id。 */
export function membershipEntry(input: {
  person: { name?: string; _draftId?: string };
  existingId: string | null;
  action: MemberEntry["action"];
}): MemberEntry {
  return {
    person: input.person.name ?? "",
    ...(input.existingId !== null ? { personId: input.existingId } : {}),
    personDraftId: input.person._draftId,
    action: input.action,
  };
}

/**
 * 为「新圈层」建草稿行。人物卡里亲手新建的一律是关系圈层，
 * 场景集合（context）不会进入圈层布局，混进来就等于用户白点了。
 */
export function newCircleRow(input: {
  targetCollectionId: string;
  name?: string;
  membership: MemberEntry;
  draftId: string;
  unnamedLabel: string;
}): IngestCollection {
  return {
    _draftId: input.draftId,
    targetCollectionId: input.targetCollectionId,
    name: input.name?.trim() || input.unnamedLabel,
    kind: "relationship_circle",
    memberships: [input.membership],
  };
}

/**
 * 为「已保存圈层」建草稿行：带上原来的类型与颜色，
 * 否则编译器整行写回时会把用户没编辑过的元数据清掉。
 */
export function savedCircleRow(input: {
  targetCollectionId: string;
  draftId: string;
  memberships: MemberEntry[];
  saved: Pick<CollectionRecord, "name" | "kind" | "color"> | undefined;
  unnamedLabel: string;
}): IngestCollection {
  const { saved } = input;
  return {
    _draftId: input.draftId,
    targetCollectionId: input.targetCollectionId,
    name: saved?.name || input.unnamedLabel,
    kind: saved && saved.kind !== "computed_community" ? saved.kind : "relationship_circle",
    color: saved?.color,
    memberships: input.memberships,
  };
}

/** 只动成员时要补回的元数据：已有的不覆盖，缺的从已保存集合补。 */
export function metadataRepair(
  row: Pick<IngestCollection, "color" | "kind">,
  saved: Pick<CollectionRecord, "kind" | "color"> | undefined,
): Partial<IngestCollection> {
  if (!saved) return {};
  return {
    ...(!row.color && saved.color ? { color: saved.color } : {}),
    ...(!row.kind ? { kind: saved.kind === "computed_community" ? "context" : saved.kind } : {}),
  };
}
