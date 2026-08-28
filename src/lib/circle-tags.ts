/** 预设的关系标签：这些关系定义清晰，直接用标签分圈子即可（一个人可以有多个标签） */

import type { PersonRecord } from "./face-db";
import { t } from "./i18n";

export const PRESET_TAGS = [
  "家人",
  "亲戚",
  "朋友",
  "同事",
  "小学同学",
  "初中同学",
  "高中同学",
  "大学同学",
  "老师",
  "邻居",
] as const;

export function presetTagLabels(): string[] {
  return PRESET_TAGS.map((tag) => t(tag));
}

/** 一个人身上由用户确认过的标签。圈层由 collections/memberships 单独管理。 */
export function tagsOf(person: PersonRecord): string[] {
  return [...new Set((person.profile?.tags ?? []).map((tag) => tag.trim()).filter(Boolean))];
}

/** 主标签：优先取预设顺序里靠前的那个，用于关系网里的落位 */
export function primaryTagOf(person: PersonRecord): string {
  const list = tagsOf(person);
  if (!list.length) return t("未分组");
  const labels = presetTagLabels();
  for (const label of labels) if (list.includes(label)) return label;
  for (const raw of PRESET_TAGS) if (list.includes(raw)) return t(raw);
  return list[0];
}

/** 展示用：已确认标签；没有就是「未分组」。 */
export function displayTagsOf(person: PersonRecord): string[] {
  const list = tagsOf(person);
  return list.length ? list : [t("未分组")];
}
