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

/** 一个人身上的全部标签：手填的 + 旧数据的「圈子」+ 自动识别出的固定身份 */
export function tagsOf(person: PersonRecord): string[] {
  const list = (person.profile?.tags ?? []).map((tag) => tag.trim()).filter(Boolean);
  const circle = person.profile?.circle?.trim();
  if (circle && !list.includes(circle)) list.unshift(circle);
  return [...new Set([...list, ...autoTagsOf(person)])];
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

/**
 * 会自动识别的「固定身份」标签：这些身份一旦成立基本不变。
 * 「朋友」这类可变身份不自动识别，只有用户自己加才算。
 */
const AUTO_RULES: Array<{ tag: (typeof PRESET_TAGS)[number]; keys: RegExp }> = [
  { tag: "家人", keys: /(爸|父亲|妈|母亲|哥|姐|弟|妹|儿子|女儿|老婆|妻子|老公|丈夫|爷爷|奶奶|外公|外婆|家人)/ },
  { tag: "亲戚", keys: /(舅|姑|姨|叔|伯|婶|表[哥姐弟妹兄]|堂[哥姐弟妹兄]|侄|外甥|亲戚)/ },
  { tag: "大学同学", keys: /(大学(同学|室友|同门)|本科同学|研究生同学|同班同学.*大学)/ },
  { tag: "高中同学", keys: /高中(同学|室友)/ },
  { tag: "初中同学", keys: /初中同学/ },
  { tag: "小学同学", keys: /小学同学/ },
  { tag: "老师", keys: /(老师|导师|教授|班主任|讲师)/ },
  { tag: "同事", keys: /(同事|同一?公司|一个部门|上司|领导|下属|老板)/ },
  { tag: "邻居", keys: /邻居/ },
];

/** 从档案文字里自动识别出的固定身份标签 */
export function autoTagsOf(person: PersonRecord): string[] {
  const p = person.profile ?? {};
  const text = [p.relation, p.circle, p.title, p.org, p.department, person.note]
    .filter(Boolean)
    .join(" ");
  if (!text) return [];
  const hits = AUTO_RULES.filter((rule) => rule.keys.test(text)).map((rule) => t(rule.tag));
  return [...new Set(hits)];
}

/** 展示用：手动标签 + 自动识别标签，都没有就是「未分组」 */
export function displayTagsOf(person: PersonRecord): string[] {
  const list = tagsOf(person);
  return list.length ? list : [t("未分组")];
}
