/** 把本机的人物库、关系和事务打包成一段紧凑文本，交给模型做办公建议参考 */

import { facesDb, type PersonRecord, type ProjectRecord, type RelationRecord } from "./face-db";

const STATUS_LABEL: Record<ProjectRecord["status"], string> = {
  planned: "待启动",
  active: "进行中",
  blocked: "受阻",
  done: "已完成",
};

const PRIORITY_LABEL: Record<ProjectRecord["priority"], string> = {
  high: "高",
  normal: "中",
  low: "低",
};

function personLine(person: PersonRecord) {
  const p = person.profile ?? {};
  const bits = [p.title, p.department, p.org, p.contact && `联系：${p.contact}`]
    .filter(Boolean)
    .join(" / ");
  const projects = p.projects?.length ? `；负责：${p.projects.join("、")}` : "";
  const tags = p.tags?.length ? `；标签：${p.tags.join("、")}` : "";
  const note = person.note ? `；备注：${person.note.slice(0, 60)}` : "";
  return `- ${person.name}${bits ? `（${bits}）` : ""}${projects}${tags}${note}`;
}

function relationLine(relation: RelationRecord, nameOf: (id: string) => string) {
  const arrow = relation.mutual ? "↔" : "→";
  return `- ${nameOf(relation.fromId)} ${arrow} ${nameOf(relation.toId)}：${relation.label}`;
}

function projectLine(project: ProjectRecord, nameOf: (id: string) => string) {
  const members = (project.memberIds ?? []).map(nameOf).filter(Boolean).join("、");
  return [
    `- ${project.title}`,
    `状态：${STATUS_LABEL[project.status]}`,
    `优先级：${PRIORITY_LABEL[project.priority]}`,
    project.department && `部门：${project.department}`,
    (project.ownerName || (project.ownerId && nameOf(project.ownerId))) &&
      `负责人：${project.ownerName || nameOf(project.ownerId!)}`,
    members && `参与：${members}`,
    project.due && `截止：${project.due}`,
    project.detail && `说明：${project.detail.slice(0, 80)}`,
  ]
    .filter(Boolean)
    .join("｜");
}

export interface AdviceContext {
  text: string;
  persons: number;
  relations: number;
  projects: number;
}

/** 读取本地库并生成上下文（有上限，避免 prompt 过长） */
export async function buildAdviceContext(limit = 60): Promise<AdviceContext> {
  const [persons, relations, projects] = await Promise.all([
    facesDb.listPersons(),
    facesDb.listRelations(),
    facesDb.listProjects(),
  ]);

  const nameById = new Map(persons.map((person) => [person.id, person.name]));
  const nameOf = (id: string) => nameById.get(id) ?? "（已删除）";

  const sections = [
    `【人物档案 ${persons.length} 人】`,
    persons.slice(0, limit).map(personLine).join("\n") || "（暂无）",
    "",
    `【人物关系 ${relations.length} 条】`,
    relations.slice(0, limit).map((relation) => relationLine(relation, nameOf)).join("\n") ||
      "（暂无）",
    "",
    `【事务 ${projects.length} 项】`,
    projects.slice(0, limit).map((project) => projectLine(project, nameOf)).join("\n") || "（暂无）",
  ];

  return {
    text: sections.join("\n"),
    persons: persons.length,
    relations: relations.length,
    projects: projects.length,
  };
}

/** 拼出带资料的提问 */
export function withAdvicePrompt(context: string, question: string) {
  return [
    "你是「知脉 Connect」里的办公参谋。下面是用户本机的人物档案、关系网和事务清单，请据此回答。",
    "回答要具体：点名相关的人、说明理由、给出可执行的下一步；资料里没有的不要编造，可以直接指出缺口。",
    "",
    context,
    "",
    `用户的问题：${question}`,
  ].join("\n");
}
