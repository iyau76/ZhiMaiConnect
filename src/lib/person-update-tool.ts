import { facesDb, type PersonProfile, type PersonRecord } from "./face-db";
import { makeSource } from "./provenance";

const TEXT_FIELDS = [
  "age",
  "gender",
  "relation",
  "title",
  "department",
  "org",
  "reportsTo",
  "birthday",
  "circle",
  "address",
  "metAt",
] as const;
const LIST_FIELDS = ["projects", "tags", "likes", "dislikes", "gifts"] as const;

type EditableTextField = (typeof TEXT_FIELDS)[number];
type EditableListField = (typeof LIST_FIELDS)[number];

export interface PersonUpdateChanges {
  name?: string;
  note?: string;
  profile?: Partial<Pick<PersonProfile, EditableTextField | EditableListField | "closeness">>;
}

export interface PersonUpdateProposal {
  id: string;
  tool: "update_person";
  personId: string;
  personName: string;
  reason: string;
  expectedUpdatedAt: number;
  changes: PersonUpdateChanges;
}

function text(value: unknown, max: number) {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().slice(0, max);
  return normalized || undefined;
}

function list(value: unknown) {
  if (!Array.isArray(value)) return undefined;
  const normalized = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().slice(0, 120))
    .filter(Boolean)
    .slice(0, 30);
  return normalized.length ? normalized : [];
}

/** Validate an AI tool call and turn it into a non-executing proposal. */
export function createPersonUpdateProposal(
  args: unknown,
  persons: PersonRecord[],
): PersonUpdateProposal {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("人物修改参数必须是对象");
  }
  const input = args as Record<string, unknown>;
  const personId = text(input.personId, 200);
  const person = persons.find((item) => item.id === personId);
  if (!person) throw new Error("没有找到要修改的人物，请先检索档案");

  const rawChanges =
    input.changes && typeof input.changes === "object" && !Array.isArray(input.changes)
      ? (input.changes as Record<string, unknown>)
      : {};
  const rawProfile =
    rawChanges.profile &&
    typeof rawChanges.profile === "object" &&
    !Array.isArray(rawChanges.profile)
      ? (rawChanges.profile as Record<string, unknown>)
      : rawChanges;
  const profile: PersonUpdateChanges["profile"] = {};

  for (const key of TEXT_FIELDS) {
    if (!(key in rawProfile)) continue;
    const value = text(rawProfile[key], 500);
    if (value !== undefined) profile[key] = value;
  }
  for (const key of LIST_FIELDS) {
    if (!(key in rawProfile)) continue;
    const value = list(rawProfile[key]);
    if (value !== undefined) profile[key] = value;
  }
  if ("closeness" in rawProfile) {
    const value = Number(rawProfile.closeness);
    if (Number.isInteger(value) && value >= 1 && value <= 5) profile.closeness = value;
  }

  const changes: PersonUpdateChanges = {
    name: text(rawChanges.name, 200),
    note: text(rawChanges.note, 2_000),
    profile: Object.keys(profile).length ? profile : undefined,
  };
  if (!changes.name && !changes.note && !changes.profile) {
    throw new Error("修改提案没有可执行的受支持字段");
  }
  const proposal: PersonUpdateProposal = {
    id: crypto.randomUUID(),
    tool: "update_person",
    personId: person.id,
    personName: person.name,
    reason: text(input.reason, 500) ?? "根据本轮对话更新人物档案",
    expectedUpdatedAt: person.updatedAt ?? person.createdAt,
    changes,
  };
  if (!personUpdateDiff(proposal, person).length) {
    throw new Error("修改提案与当前档案相同，无需执行");
  }
  return proposal;
}

export function personUpdateDiff(proposal: PersonUpdateProposal, person: PersonRecord) {
  const rows: Array<{ field: string; before: string; after: string }> = [];
  if (proposal.changes.name && proposal.changes.name !== person.name) {
    rows.push({ field: "姓名", before: person.name, after: proposal.changes.name });
  }
  if (proposal.changes.note && proposal.changes.note !== person.note) {
    rows.push({ field: "备注", before: person.note || "（空）", after: proposal.changes.note });
  }
  const labels: Record<string, string> = {
    age: "年龄",
    gender: "性别",
    relation: "关系",
    title: "职位",
    department: "部门",
    org: "单位",
    projects: "负责事项",
    reportsTo: "汇报对象",
    birthday: "生日",
    circle: "圈子",
    closeness: "亲密度",
    likes: "喜欢",
    dislikes: "不喜欢",
    gifts: "送礼记录",
    address: "地点",
    metAt: "相识场景",
    tags: "标签",
  };
  for (const [key, next] of Object.entries(proposal.changes.profile ?? {})) {
    const before = person.profile?.[key as keyof PersonProfile];
    const format = (value: unknown) =>
      Array.isArray(value) ? value.join("、") || "（空）" : String(value ?? "（空）");
    if (format(before) !== format(next)) {
      rows.push({ field: labels[key] ?? key, before: format(before), after: format(next) });
    }
  }
  return rows;
}

/** Execute only after an explicit UI approval. Reject stale proposals. */
export async function applyPersonUpdateProposal(proposal: PersonUpdateProposal) {
  const current = (await facesDb.listPersons()).find((person) => person.id === proposal.personId);
  if (!current) throw new Error("人物档案已不存在，不能执行修改");
  if ((current.updatedAt ?? current.createdAt) !== proposal.expectedUpdatedAt) {
    throw new Error("人物档案在提案后已发生变化，请重新让 AI 核对后再修改");
  }
  const fieldSource = makeSource("ai", "AI 助理提议，经用户批准");
  const profileChanges = proposal.changes.profile ?? {};
  const fieldSources = { ...(current.profile?.fieldSources ?? {}) };
  for (const key of Object.keys(profileChanges)) fieldSources[key] = fieldSource;
  const updated: PersonRecord = {
    ...current,
    ...(proposal.changes.name ? { name: proposal.changes.name } : {}),
    ...(proposal.changes.note ? { note: proposal.changes.note } : {}),
    profile: proposal.changes.profile
      ? { ...current.profile, ...profileChanges, fieldSources }
      : current.profile,
    updatedAt: Date.now(),
  };
  await facesDb.putPerson(updated);
  return updated;
}
