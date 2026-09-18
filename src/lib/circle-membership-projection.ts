/**
 * 圈层成员投影：把档案里的 collection / collection_membership 读成「一个人可以属于多个圈层」的视图模型。
 *
 * 这里是布局与显示的唯一事实入口，不写回档案：
 * - 只有 kind = relationship_circle 的集合才是圈层；context 只做筛选，computed 投影不入图。
 * - source = computed 的成员关系不是用户确认的事实，跳过。
 * - 一个人保留一个节点；交集按成员表直接求，不从包络几何反推。
 * - 不枚举全部子集：只记录真实存在的两两交集。
 *
 * 结果全部按稳定 ID 排序，不依赖 IndexedDB 返回顺序，也不用 localeCompare。
 */

import type { CollectionMembershipRecord, CollectionRecord, PersonRecord } from "./face-db";

export interface CircleMembershipCircle {
  id: string;
  name: string;
  color?: string;
  /** 按稳定 ID 排序的成员 */
  memberIds: string[];
}

export interface CircleMembershipIntersection {
  /** 两个原始圈层 ID，按稳定 ID 排序 */
  circleIds: [string, string];
  memberIds: string[];
}

export interface CircleMembershipProjection {
  /** 按稳定 ID 排序的真实圈层（含空圈层） */
  circles: CircleMembershipCircle[];
  /** 每个人属于哪些圈层；没有圈层的人也在表里，值为空数组 */
  membershipsByPersonId: Map<string, string[]>;
  /** 只列出有共同成员的两两交集 */
  intersections: CircleMembershipIntersection[];
  /** 不属于任何圈层的人，不是自动创建的圈层 */
  unassignedPersonIds: string[];
  /** 被跳过的可疑引用，供上层提示，不静默吞掉 */
  warnings: string[];
}

function compareId(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function buildCircleMembershipProjection(
  persons: Array<Pick<PersonRecord, "id">>,
  collections: CollectionRecord[],
  memberships: CollectionMembershipRecord[],
): CircleMembershipProjection {
  const warnings: string[] = [];
  const personIds: string[] = [];
  const seenPersons = new Set<string>();
  for (const person of persons) {
    if (seenPersons.has(person.id)) {
      warnings.push(`重复的人物 ID：${person.id}`);
      continue;
    }
    seenPersons.add(person.id);
    personIds.push(person.id);
  }
  personIds.sort(compareId);

  const circleById = new Map<string, CircleMembershipCircle>();
  const seenCollections = new Set<string>();
  for (const collection of collections) {
    if (collection.kind !== "relationship_circle") continue;
    if (seenCollections.has(collection.id)) {
      warnings.push(`重复的圈层 ID：${collection.id}`);
      continue;
    }
    seenCollections.add(collection.id);
    circleById.set(collection.id, {
      id: collection.id,
      name: collection.name,
      color: collection.color,
      memberIds: [],
    });
  }

  const membershipsByPersonId = new Map<string, string[]>();
  for (const personId of personIds) membershipsByPersonId.set(personId, []);

  const seenPairs = new Set<string>();
  const sortedMemberships = [...memberships].sort((left, right) => compareId(left.id, right.id));
  for (const membership of sortedMemberships) {
    if (membership.source === "computed") continue;
    const circle = circleById.get(membership.collectionId);
    if (!circle) continue;
    if (!seenPersons.has(membership.personId)) {
      warnings.push(`成员关系指向不存在的人物：${membership.personId}`);
      continue;
    }
    const pairKey = `${membership.collectionId}\u0000${membership.personId}`;
    if (seenPairs.has(pairKey)) continue;
    seenPairs.add(pairKey);
    membershipsByPersonId.get(membership.personId)!.push(membership.collectionId);
  }

  for (const circle of circleById.values()) {
    for (const personId of personIds) {
      if (membershipsByPersonId.get(personId)!.includes(circle.id)) {
        circle.memberIds.push(personId);
      }
    }
  }

  const circles = [...circleById.values()].sort((left, right) => compareId(left.id, right.id));
  const intersectionMemberIds = new Map<string, string[]>();
  for (const personId of personIds) {
    const circleIds = membershipsByPersonId.get(personId)!;
    if (circleIds.length < 2) continue;
    for (let first = 0; first < circleIds.length; first += 1) {
      for (let second = first + 1; second < circleIds.length; second += 1) {
        const pair = [circleIds[first], circleIds[second]].sort(compareId) as [string, string];
        const key = `${pair[0]}\u0000${pair[1]}`;
        const members = intersectionMemberIds.get(key) ?? [];
        members.push(personId);
        intersectionMemberIds.set(key, members);
      }
    }
  }
  const intersections: CircleMembershipIntersection[] = [...intersectionMemberIds.entries()]
    .map(([key, memberIds]) => {
      const [first, second] = key.split("\u0000") as [string, string];
      return {
        circleIds: [first, second] as [string, string],
        memberIds: memberIds.sort(compareId),
      };
    })
    .sort((left, right) =>
      compareId(left.circleIds.join("\u0000"), right.circleIds.join("\u0000")),
    );

  const unassignedPersonIds = personIds.filter(
    (personId) => membershipsByPersonId.get(personId)!.length === 0,
  );

  return { circles, membershipsByPersonId, intersections, unassignedPersonIds, warnings };
}

/** 指定若干圈层的共同成员，直接查成员表，与包络形状无关。 */
export function intersectionMemberIdsOf(
  projection: CircleMembershipProjection,
  circleIds: string[],
): string[] {
  const unique = [...new Set(circleIds)].sort(compareId);
  if (!unique.length) return [];
  const circleById = new Map(projection.circles.map((circle) => [circle.id, circle]));
  const ordered = [...unique].sort(
    (left, right) =>
      (circleById.get(left)?.memberIds.length ?? 0) -
      (circleById.get(right)?.memberIds.length ?? 0),
  );
  let result: string[] | null = null;
  for (const circleId of ordered) {
    const members = new Set(circleById.get(circleId)?.memberIds ?? []);
    if (!members.size) return [];
    result = result ? result.filter((personId) => members.has(personId)) : [...members];
  }
  return (result ?? []).sort(compareId);
}

/** 圈层之间的相似度：共同成员 ÷ 并集成员。只用于布局，不是社会关系评分。 */
export function circleSimilarity(
  projection: CircleMembershipProjection,
  leftId: string,
  rightId: string,
) {
  const shared = intersectionMemberIdsOf(projection, [leftId, rightId]).length;
  if (!shared) return 0;
  const left = projection.circles.find((circle) => circle.id === leftId)?.memberIds.length ?? 0;
  const right = projection.circles.find((circle) => circle.id === rightId)?.memberIds.length ?? 0;
  const union = left + right - shared;
  return union > 0 ? shared / union : 0;
}
