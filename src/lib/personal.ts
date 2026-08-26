/** 个人版：生日 / 节日 / 圈子等本地计算逻辑（不联网） */

import type { PersonRecord } from "./face-db";

export const CIRCLES = ["家人", "亲戚", "朋友", "同学", "同事", "邻居", "其它"] as const;

/** 常见节日（公历部分固定，农历给出近似提醒日期，仅作提醒用途） */
export const FESTIVALS: Array<{ name: string; md: string; tip: string }> = [
  { name: "元旦", md: "01-01", tip: "新年第一天，适合给长辈和老朋友问候" },
  { name: "情人节", md: "02-14", tip: "伴侣 / 暧昧对象" },
  { name: "妇女节", md: "03-08", tip: "妈妈、女性朋友与同事" },
  { name: "劳动节", md: "05-01", tip: "约朋友出去玩的好时机" },
  { name: "母亲节", md: "05-11", tip: "五月第二个周日，给妈妈打个电话" },
  { name: "儿童节", md: "06-01", tip: "有小孩的亲友" },
  { name: "父亲节", md: "06-15", tip: "六月第三个周日，给爸爸问候" },
  { name: "教师节", md: "09-10", tip: "老师与曾经带过你的前辈" },
  { name: "国庆节", md: "10-01", tip: "长假，适合约见面" },
  { name: "感恩节", md: "11-27", tip: "感谢帮过你的人" },
  { name: "平安夜", md: "12-24", tip: "朋友、同事小礼物" },
  { name: "圣诞节", md: "12-25", tip: "朋友聚会" },
];

export function pad(n: number) {
  return String(n).padStart(2, "0");
}

export function todayStr(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 从任意生日写法里取出 MM-DD */
export function birthdayMd(raw?: string) {
  if (!raw) return null;
  const m = raw.match(/(\d{1,2})\s*[-/月.]\s*(\d{1,2})/);
  if (!m) return null;
  return `${pad(Number(m[1]))}-${pad(Number(m[2]))}`;
}

/** 距离下一次 MM-DD 还有几天 */
export function daysUntilMd(md: string, from = new Date()) {
  const [mm, dd] = md.split("-").map(Number);
  if (!mm || !dd) return null;
  const base = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  let next = new Date(from.getFullYear(), mm - 1, dd);
  if (next < base) next = new Date(from.getFullYear() + 1, mm - 1, dd);
  return Math.round((next.getTime() - base.getTime()) / 86400000);
}

export interface UpcomingItem {
  key: string;
  kind: "birthday" | "festival";
  title: string;
  md: string;
  days: number;
  person?: PersonRecord;
  tip?: string;
}

/** 未来 windowDays 天内的生日与节日 */
export function upcoming(persons: PersonRecord[], windowDays = 60): UpcomingItem[] {
  const items: UpcomingItem[] = [];

  for (const person of persons) {
    const md = birthdayMd(person.profile?.birthday);
    if (!md) continue;
    const days = daysUntilMd(md);
    if (days === null || days > windowDays) continue;
    items.push({
      key: `b-${person.id}`,
      kind: "birthday",
      title: `${person.name} 生日`,
      md,
      days,
      person,
    });
  }

  for (const festival of FESTIVALS) {
    const days = daysUntilMd(festival.md);
    if (days === null || days > windowDays) continue;
    items.push({
      key: `f-${festival.name}`,
      kind: "festival",
      title: festival.name,
      md: festival.md,
      days,
      tip: festival.tip,
    });
  }

  return items.sort((a, b) => a.days - b.days);
}

/** 生成一句祝福 / 礼物建议的 prompt */
export function blessingPrompt(item: UpcomingItem) {
  if (item.kind === "birthday" && item.person) {
    const p = item.person.profile ?? {};
    const facts = [
      p.circle ? `关系：${p.circle}` : "",
      p.closeness ? `亲密度：${p.closeness}/5` : "",
      p.likes?.length ? `喜好：${p.likes.join("、")}` : "",
      p.dislikes?.length ? `不喜欢：${p.dislikes.join("、")}` : "",
      p.gifts?.length ? `以前送过：${p.gifts.join("、")}` : "",
      item.person.note ? `备注：${item.person.note}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    return `我的朋友「${item.person.name}」快过生日了。已知信息：\n${facts || "（暂无更多信息）"}\n\n请给我：\n1）两条可以直接发出去的生日祝福（一条轻松、一条正式），不要空话；\n2）三个具体的礼物建议，说明为什么合适、大概预算；\n3）如果信息太少，指出还缺什么。\n用中文，简短分点，不要客套开场白。`;
  }
  return `马上是「${item.title}」。${item.tip ?? ""}\n请给我：\n1）三条不同语气的节日问候，可以直接复制发送；\n2）适合在这个节日联系哪一类人（家人 / 朋友 / 同事）以及理由。\n用中文，简短分点，不要客套开场白。`;
}
