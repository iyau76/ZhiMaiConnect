import {
  applyArchiveMutationPlan,
  createArchiveMutationPlan,
  createDeletePeopleOperations,
  createDeletePersonOperation,
  loadArchiveMutationSnapshot,
  prepareArchiveMutationPlan,
  type ArchiveMutationPlan,
  type ArchiveMutationRepository,
} from "./archive-mutation-plan";
import { facesDb } from "./face-db";

export interface PersonDeletionImpact {
  personName: string;
  factRelationsDeleted: number;
  derivedRelationsRecomputed: number;
  collectionMembershipsRemoved: number;
  recordsDeleted: number;
  recordsDetached: number;
  projectsDeleted: number;
}

export interface PeopleDeletionImpact extends Omit<PersonDeletionImpact, "personName"> {
  personNames: string[];
}

export async function previewPeopleDeletion(
  personIds: string[],
  repository: ArchiveMutationRepository = facesDb,
): Promise<{ plan: ArchiveMutationPlan; impact: PeopleDeletionImpact }> {
  const snapshot = await loadArchiveMutationSnapshot(repository);
  const uniqueIds = [...new Set(personIds)];
  if (!uniqueIds.length) throw new Error("请至少选择一个要删除的人物");
  const persons = uniqueIds.map((personId) => {
    const person = snapshot.persons.find((row) => row.id === personId);
    if (!person) throw new Error(`找不到人物 ${personId}`);
    return person;
  });
  const operations = createDeletePeopleOperations(
    snapshot,
    persons.map((person) => ({
      personId: person.id,
      reason: `用户批量删除人物档案：${person.name}`,
    })),
  );
  const plan = createArchiveMutationPlan({
    title: `批量删除 ${persons.length} 个人物及处理关联记录`,
    reason: "一次性枚举并原子处理共享关系、集合、事件、提醒、任务和事务依赖",
    operations,
  });
  prepareArchiveMutationPlan(plan, snapshot);
  const resolutions = operations.flatMap((operation) => operation.resolutions);
  const uniqueResolutionIds = (kind: (typeof resolutions)[number]["kind"], action?: string) =>
    new Set(
      resolutions
        .filter((row) => row.kind === kind && (!action || row.action === action))
        .map((row) => row.targetId),
    ).size;
  const deletedRelationIds = new Set(
    resolutions.filter((row) => row.kind === "relation_assertion").map((row) => row.targetId),
  );
  const deletingIds = new Set(uniqueIds);
  const deletedRecordIds = new Set(
    resolutions
      .filter(
        (row) =>
          ["life_event", "reminder", "task", "project"].includes(row.kind) &&
          row.action === "delete",
      )
      .map((row) => `${row.kind}:${row.targetId}`),
  );
  const detachedRecordIds = new Set(
    resolutions
      .filter((row) => "action" in row && row.action !== "delete")
      .map((row) => `${row.kind}:${row.targetId}`),
  );
  return {
    plan,
    impact: {
      personNames: persons.map((person) => person.name),
      factRelationsDeleted: deletedRelationIds.size,
      derivedRelationsRecomputed: snapshot.derivedRelations.filter(
        (row) =>
          deletingIds.has(row.fromId) ||
          deletingIds.has(row.toId) ||
          row.supportingRelationIds.some((id) => deletedRelationIds.has(id)),
      ).length,
      collectionMembershipsRemoved: uniqueResolutionIds("collection_membership"),
      recordsDeleted: deletedRecordIds.size,
      recordsDetached: detachedRecordIds.size,
      projectsDeleted: uniqueResolutionIds("project", "delete"),
    },
  };
}

export async function previewPersonDeletion(
  personId: string,
  repository: ArchiveMutationRepository = facesDb,
): Promise<{ plan: ArchiveMutationPlan; impact: PersonDeletionImpact }> {
  const snapshot = await loadArchiveMutationSnapshot(repository);
  const person = snapshot.persons.find((row) => row.id === personId);
  if (!person) throw new Error(`找不到人物 ${personId}`);
  const operation = createDeletePersonOperation(snapshot, {
    personId,
    reason: `用户删除人物档案：${person.name}`,
  });
  const plan = createArchiveMutationPlan({
    title: `删除「${person.name}」及处理关联记录`,
    reason: "删除前完整枚举关系、集合、事件、提醒、任务和事务依赖",
    operations: [operation],
  });
  // Materialise once during preview so UI never presents an unexecutable plan.
  prepareArchiveMutationPlan(plan, snapshot);
  const resolutions = operation.resolutions;
  const deletedRelationIds = new Set(
    resolutions.filter((row) => row.kind === "relation_assertion").map((row) => row.targetId),
  );
  return {
    plan,
    impact: {
      personName: person.name,
      factRelationsDeleted: deletedRelationIds.size,
      derivedRelationsRecomputed: snapshot.derivedRelations.filter(
        (row) =>
          row.fromId === personId ||
          row.toId === personId ||
          row.supportingRelationIds.some((id) => deletedRelationIds.has(id)),
      ).length,
      collectionMembershipsRemoved: resolutions.filter(
        (row) => row.kind === "collection_membership",
      ).length,
      recordsDeleted: resolutions.filter(
        (row) =>
          ["life_event", "reminder", "task", "project"].includes(row.kind) &&
          row.action === "delete",
      ).length,
      recordsDetached: resolutions.filter((row) => "action" in row && row.action === "detach")
        .length,
      projectsDeleted: resolutions.filter(
        (row) => row.kind === "project" && row.action === "delete",
      ).length,
    },
  };
}

export function personDeletionImpactText(impact: PersonDeletionImpact) {
  return [
    `删除人物：${impact.personName}`,
    `删除事实关系：${impact.factRelationsDeleted} 条`,
    `重算可能消失的推导关系：${impact.derivedRelationsRecomputed} 条`,
    `移出集合：${impact.collectionMembershipsRemoved} 处`,
    `删除失去对象的事件/提醒/任务/事务：${impact.recordsDeleted} 条`,
    `保留记录但解除人物关联：${impact.recordsDetached} 条`,
  ].join("\n");
}

export function peopleDeletionImpactText(impact: PeopleDeletionImpact) {
  return [
    `删除人物：${impact.personNames.join("、")}`,
    `删除事实关系：${impact.factRelationsDeleted} 条`,
    `重算可能消失的推导关系：${impact.derivedRelationsRecomputed} 条`,
    `移出集合：${impact.collectionMembershipsRemoved} 处`,
    `删除失去对象的事件/提醒/任务/事务：${impact.recordsDeleted} 条`,
    `保留记录但解除人物关联：${impact.recordsDetached} 条`,
  ].join("\n");
}

export async function applyPersonDeletionPlan(
  plan: ArchiveMutationPlan,
  repository: ArchiveMutationRepository = facesDb,
) {
  return applyArchiveMutationPlan(plan, { repository });
}
