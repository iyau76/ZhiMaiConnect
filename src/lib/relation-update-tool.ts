import { facesDb, type PersonRecord, type RelationRecord } from "./face-db";
import { inferMutual } from "./relation-kind";
import { normalizeRelationSemanticKind } from "./relation-semantics";
import { makeSource } from "./provenance";

export interface RelationUpdateChanges {
  label?: string;
  note?: string;
  basis?: string;
  confidence?: number;
  visibility?: "always" | "auto" | "hidden";
  recommendationPolicy?: "allow" | "avoid" | "block";
}

export interface RelationUpdateProposal {
  id: string;
  tool: "update_relation";
  relationId: string;
  relationLabel: string;
  endpointNames: [string, string];
  reason: string;
  expectedUpdatedAt: number;
  changes: RelationUpdateChanges;
}

function text(value: unknown, max: number) {
  if (typeof value !== "string") return undefined;
  const result = value.trim().slice(0, max);
  return result || undefined;
}

export function createRelationUpdateProposal(
  args: unknown,
  relations: RelationRecord[],
  persons: PersonRecord[],
): RelationUpdateProposal {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("关系修改参数必须是对象");
  }
  const input = args as Record<string, unknown>;
  const relationId = text(input.relationId, 200);
  const relation = relations.find((item) => item.id === relationId);
  if (!relation) throw new Error("没有找到要修改的关系，请先检索并读取关系");
  const raw =
    input.changes && typeof input.changes === "object" && !Array.isArray(input.changes)
      ? (input.changes as Record<string, unknown>)
      : {};
  const changes: RelationUpdateChanges = {
    label: text(raw.label, 300),
    note: text(raw.note, 2_000),
    basis: text(raw.basis, 500),
  };
  if ("confidence" in raw) {
    const confidence = Number(raw.confidence);
    if (Number.isFinite(confidence) && confidence >= 0 && confidence <= 1) {
      changes.confidence = confidence;
    }
  }
  if (raw.visibility === "always" || raw.visibility === "auto" || raw.visibility === "hidden") {
    changes.visibility = raw.visibility;
  }
  if (
    raw.recommendationPolicy === "allow" ||
    raw.recommendationPolicy === "avoid" ||
    raw.recommendationPolicy === "block"
  ) {
    changes.recommendationPolicy = raw.recommendationPolicy;
  }
  for (const key of Object.keys(changes) as Array<keyof RelationUpdateChanges>) {
    if (changes[key] === undefined) delete changes[key];
  }
  if (!Object.keys(changes).length) throw new Error("关系修改提案没有可执行字段");
  const names = new Map(persons.map((person) => [person.id, person.name]));
  const proposal: RelationUpdateProposal = {
    id: crypto.randomUUID(),
    tool: "update_relation",
    relationId: relation.id,
    relationLabel: relation.label,
    endpointNames: [
      names.get(relation.fromId) ?? relation.fromId,
      names.get(relation.toId) ?? relation.toId,
    ],
    reason: text(input.reason, 500) ?? "根据本轮对话更新人物关系",
    expectedUpdatedAt: relation.updatedAt ?? relation.createdAt,
    changes,
  };
  if (!relationUpdateDiff(proposal, relation).length)
    throw new Error("提案与当前关系相同，无需执行");
  return proposal;
}

export function relationUpdateDiff(proposal: RelationUpdateProposal, relation: RelationRecord) {
  const labels: Record<keyof RelationUpdateChanges, string> = {
    label: "关系标签",
    note: "备注",
    basis: "依据",
    confidence: "置信度",
    visibility: "关系图展示",
    recommendationPolicy: "引荐策略",
  };
  return Object.entries(proposal.changes).flatMap(([key, after]) => {
    const before = relation[key as keyof RelationRecord];
    if (String(before ?? "") === String(after ?? "")) return [];
    return [
      {
        field: labels[key as keyof RelationUpdateChanges],
        before: String(before ?? "（空）"),
        after: String(after),
      },
    ];
  });
}

export async function applyRelationUpdateProposal(proposal: RelationUpdateProposal) {
  const current = (await facesDb.listRelations()).find((item) => item.id === proposal.relationId);
  if (!current) throw new Error("关系已不存在，不能执行修改");
  if ((current.updatedAt ?? current.createdAt) !== proposal.expectedUpdatedAt) {
    throw new Error("关系在提案后已发生变化，请重新让 AI 核对后再修改");
  }
  const label = proposal.changes.label ?? current.label;
  const updated: RelationRecord = {
    ...current,
    ...proposal.changes,
    label,
    mutual: proposal.changes.label ? inferMutual(label) : current.mutual,
    semanticKind: proposal.changes.label
      ? normalizeRelationSemanticKind(label)
      : current.semanticKind,
    updatedAt: Date.now(),
    source: makeSource("ai", "AI 助理提议，经用户批准"),
  };
  await facesDb.putRelation(updated);
  return updated;
}
