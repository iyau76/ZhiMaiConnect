/**
 * 人物卡模板：除内置的公司管理栏位外，用户可以自己添加栏位
 * （如「负责项目」「分管条线」「入职时间」），全部人物卡共用同一套模板。
 * 值存在 person.profile.extra[字段名] 里，模板只保存字段名和顺序。
 */

const KEY = "zhimai.card-template.v1";

export const BUILTIN_CARD_FIELDS = [
  { key: "title", label: "职位 / 职务" },
  { key: "department", label: "部门 / 科室" },
  { key: "org", label: "单位 / 公司" },
  { key: "reportsTo", label: "汇报对象" },
  { key: "employeeId", label: "工号 / 编号" },
  { key: "contact", label: "联系方式" },
  { key: "address", label: "办公地点" },
  { key: "relation", label: "关系 / 身份" },
] as const;

export type CustomField = { name: string };

export function loadTemplate(): CustomField[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as CustomField[];
    return Array.isArray(parsed) ? parsed.filter((item) => item && item.name) : [];
  } catch {
    return [];
  }
}

export function saveTemplate(fields: CustomField[]) {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(KEY, JSON.stringify(fields));
}

export function addTemplateField(name: string): CustomField[] {
  const clean = name.trim();
  const fields = loadTemplate();
  if (!clean || fields.some((field) => field.name === clean)) return fields;
  const next = [...fields, { name: clean }];
  saveTemplate(next);
  return next;
}

export function removeTemplateField(name: string): CustomField[] {
  const next = loadTemplate().filter((field) => field.name !== name);
  saveTemplate(next);
  return next;
}
