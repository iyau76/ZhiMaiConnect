/** 个人版：生日 / 节日 / 圈子等本地计算逻辑（不联网） */

import solarLunar from "solarlunar";

import type { PersonRecord } from "./face-db";

export const CIRCLES = ["家人", "亲戚", "朋友", "同学", "同事", "邻居", "其它"] as const;

export interface Festival {
  name: string;
  md: string;
  tip: string;
}

const FIXED_FESTIVALS: Festival[] = [
  { name: "元旦", md: "01-01", tip: "新年第一天，适合给长辈和老朋友问候" },
  { name: "情人节", md: "02-14", tip: "伴侣 / 暧昧对象" },
  { name: "妇女节", md: "03-08", tip: "妈妈、女性朋友与同事" },
  { name: "劳动节", md: "05-01", tip: "约朋友出去玩的好时机" },
  { name: "儿童节", md: "06-01", tip: "有小孩的亲友" },
  { name: "教师节", md: "09-10", tip: "老师与曾经带过你的前辈" },
  { name: "国庆节", md: "10-01", tip: "长假，适合约见面" },
  { name: "平安夜", md: "12-24", tip: "朋友、同事小礼物" },
  { name: "圣诞节", md: "12-25", tip: "朋友聚会" },
];

const LUNAR_FESTIVALS = [
  { name: "春节", month: 1, day: 1, lunarLabel: "农历正月初一" },
  { name: "端午节", month: 5, day: 5, lunarLabel: "农历五月初五" },
  { name: "中秋节", month: 8, day: 15, lunarLabel: "农历八月十五" },
] as const;

const FESTIVAL_CACHE = new Map<number, Festival[]>();
const MIN_LUNAR_YEAR = 1900;
const MAX_LUNAR_YEAR = 2100;

export interface LunarDateLabel {
  lunarYear: number;
  lunarMonth: number;
  lunarDay: number;
  isLeap: boolean;
  /** 月初显示月份，其余显示农历日，适合月历小格。 */
  short: string;
  /** 适合 title / 辅助说明的完整农历日期。 */
  full: string;
}

/** 将 YYYY-MM-DD 公历日期精确换算为农历；超出 1900—2100 或日期无效时不猜测。 */
export function lunarDateLabel(date: string): LunarDateLabel | null {
  const match = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const probe = new Date(year, month - 1, day);
  if (
    year < MIN_LUNAR_YEAR ||
    year > MAX_LUNAR_YEAR ||
    probe.getFullYear() !== year ||
    probe.getMonth() !== month - 1 ||
    probe.getDate() !== day
  ) {
    return null;
  }
  const lunar = solarLunar.solar2lunar(year, month, day);
  if (lunar === -1) return null;
  return {
    lunarYear: lunar.lYear,
    lunarMonth: lunar.lMonth,
    lunarDay: lunar.lDay,
    isLeap: lunar.isLeap,
    short: lunar.lDay === 1 ? lunar.monthCn : lunar.dayCn,
    full: `农历${lunar.yearCn}${lunar.monthCn}${lunar.dayCn}`,
  };
}

/**
 * 使用本地历法数据将农历节日换算为公历日期，不依赖设备时区或网络。
 * 当前历法数据覆盖 1900—2100 年；超出范围时不猜测日期。
 */
function lunarFestivalsForYear(year: number): Festival[] {
  if (!Number.isInteger(year) || year < MIN_LUNAR_YEAR || year > MAX_LUNAR_YEAR) return [];
  return LUNAR_FESTIVALS.flatMap((festival) => {
    const solar = solarLunar.lunar2solar(year, festival.month, festival.day, false);
    if (solar === -1 || solar.cYear !== year) return [];
    return [
      {
        name: festival.name,
        md: `${pad(solar.cMonth)}-${pad(solar.cDay)}`,
        tip: `${festival.lunarLabel}，由本地农历历法精确换算`,
      },
    ];
  });
}

export function pad(n: number) {
  return String(n).padStart(2, "0");
}

function nthWeekdayMd(year: number, month: number, weekday: number, nth: number) {
  const first = new Date(year, month - 1, 1).getDay();
  const day = 1 + ((weekday - first + 7) % 7) + (nth - 1) * 7;
  return `${pad(month)}-${pad(day)}`;
}

/** 返回指定年份按规则计算的公历节日和精确换算的农历节日。 */
export function festivalsForYear(year: number): Festival[] {
  const cached = FESTIVAL_CACHE.get(year);
  if (cached) return cached;
  const moving: Festival[] = [
    {
      name: "母亲节",
      md: nthWeekdayMd(year, 5, 0, 2),
      tip: "五月第二个周日，给妈妈打个电话",
    },
    {
      name: "父亲节",
      md: nthWeekdayMd(year, 6, 0, 3),
      tip: "六月第三个周日，给爸爸问候",
    },
    {
      name: "感恩节",
      md: nthWeekdayMd(year, 11, 4, 4),
      tip: "十一月第四个周四，感谢帮过你的人",
    },
  ];
  const festivals = [...FIXED_FESTIVALS, ...moving, ...lunarFestivalsForYear(year)].sort((a, b) =>
    a.md.localeCompare(b.md),
  );
  FESTIVAL_CACHE.set(year, festivals);
  return festivals;
}

/** 当前年份的兼容导出；需要查看其它年份时使用 festivalsForYear。 */
export const FESTIVALS = festivalsForYear(new Date().getFullYear());

export function todayStr(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 从任意生日写法里取出 MM-DD */
export function birthdayMd(raw?: string) {
  if (!raw) return null;
  const full = raw.match(/(?:19|20)\d{2}\s*[-/年.]\s*(\d{1,2})\s*[-/月.]\s*(\d{1,2})/);
  const m = full ?? raw.match(/(\d{1,2})\s*[-/月.]\s*(\d{1,2})/);
  if (!m) return null;
  const month = Number(m[1]);
  const day = Number(m[2]);
  const probe = new Date(2000, month - 1, day);
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    probe.getMonth() !== month - 1 ||
    probe.getDate() !== day
  ) {
    return null;
  }
  return `${pad(month)}-${pad(day)}`;
}

/** 距离下一次 MM-DD 还有几天 */
export function daysUntilMd(md: string, from = new Date()) {
  const [mm, dd] = md.split("-").map(Number);
  const probe = new Date(2000, mm - 1, dd);
  if (!mm || !dd || probe.getMonth() !== mm - 1 || probe.getDate() !== dd) {
    return null;
  }
  const base = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  let next: Date | null = null;
  for (let year = from.getFullYear(); year <= from.getFullYear() + 8; year += 1) {
    const candidate = new Date(year, mm - 1, dd);
    if (candidate.getMonth() !== mm - 1 || candidate.getDate() !== dd || candidate < base) continue;
    next = candidate;
    break;
  }
  if (!next) return null;
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
export function upcoming(
  persons: PersonRecord[],
  windowDays = 60,
  from = new Date(),
): UpcomingItem[] {
  const items: UpcomingItem[] = [];

  for (const person of persons) {
    const md = birthdayMd(person.profile?.birthday);
    if (!md) continue;
    const days = daysUntilMd(md, from);
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

  const seenFestivals = new Set<string>();
  for (const year of [from.getFullYear(), from.getFullYear() + 1]) {
    for (const festival of festivalsForYear(year)) {
      if (seenFestivals.has(festival.name)) continue;
      const [month, day] = festival.md.split("-").map(Number);
      const target = new Date(year, month - 1, day);
      const base = new Date(from.getFullYear(), from.getMonth(), from.getDate());
      const days = Math.round((target.getTime() - base.getTime()) / 86400000);
      if (days < 0 || days > windowDays) continue;
      seenFestivals.add(festival.name);
      items.push({
        key: `f-${festival.name}`,
        kind: "festival",
        title: festival.name,
        md: festival.md,
        days,
        tip: festival.tip,
      });
    }
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
    return `我的朋友「${item.person.name}」快过生日了。已知信息：\n${facts || "（暂无更多信息）"}\n\n请给我：\n1）两条生日祝福（一条轻松、一条正式），每条标注使用了上面哪项依据；\n2）三个具体的礼物建议，逐项说明依据、适合原因和大概预算，不要重复已经送过的礼物；\n3）如果信息太少，明确写出“资料不足”，并指出还缺什么，绝对不要补写未知喜好。\n用中文，简短分点，不要客套开场白。`;
  }
  return `马上是「${item.title}」。${item.tip ?? ""}\n请给我：\n1）三条不同语气的节日问候，可以直接复制发送；\n2）适合在这个节日联系哪一类人（家人 / 朋友 / 同事）以及理由。\n用中文，简短分点，不要客套开场白。`;
}
