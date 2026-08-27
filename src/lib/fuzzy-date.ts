/** 模糊时间：记不清具体哪天的往事，可以只记到月、年，或一段时间 */

import type { DatePrecision, LifeEventRecord } from "./face-db";
import { pad } from "./personal";

export const PRECISION_LABEL: Record<DatePrecision, string> = {
  day: "具体某天",
  month: "只记得某月",
  year: "只记得某年",
  range: "一段时间",
};

export function precisionOf(event: LifeEventRecord): DatePrecision {
  return event.precision ?? "day";
}

/** 事件覆盖的起止（含端点），用于判断是否落在某月/某天 */
export function eventSpan(event: LifeEventRecord) {
  const p = precisionOf(event);
  const [y, m] = event.date.split("-").map(Number);
  if (p === "day") return { start: event.date, end: event.date };
  if (p === "month") {
    const last = new Date(y, m, 0).getDate();
    return { start: `${y}-${pad(m)}-01`, end: `${y}-${pad(m)}-${pad(last)}` };
  }
  if (p === "year") return { start: `${y}-01-01`, end: `${y}-12-31` };
  return { start: event.date, end: event.dateEnd ?? event.date };
}

/** 人话时间标签 */
export function formatFuzzy(event: LifeEventRecord) {
  const p = precisionOf(event);
  const [y, m, d] = event.date.split("-").map(Number);
  if (p === "day") return `${y} 年 ${m} 月 ${d} 日`;
  if (p === "month") return `${y} 年 ${m} 月`;
  if (p === "year") return `${y} 年`;
  const end = (event.dateEnd ?? event.date).split("-").map(Number);
  const sameYear = end[0] === y;
  const left = `${y} 年 ${m} 月${d && d !== 1 ? ` ${d} 日` : ""}`;
  const right = `${sameYear ? "" : `${end[0]} 年 `}${end[1]} 月${end[2] && end[2] !== 1 ? ` ${end[2]} 日` : ""}`;
  return `${left} — ${right}`;
}

/** 是否精确到天（精确的在日历上高亮标注，模糊的走时间轴） */
export function isExact(event: LifeEventRecord) {
  return precisionOf(event) === "day";
}

/** 该事件是否与给定月份（yyyy-mm）有交集 */
export function touchesMonth(event: LifeEventRecord, ym: string) {
  const { start, end } = eventSpan(event);
  return start.slice(0, 7) <= ym && end.slice(0, 7) >= ym;
}

/** 时间轴分组标题：年 */
export function yearOf(event: LifeEventRecord) {
  return event.date.slice(0, 4);
}

/** 一条模糊时间的解析结果 */
export type FuzzyParse = { date: string; dateEnd?: string; precision: DatePrecision };

const CN_NUM: Record<string, number> = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
  十一: 11,
  十二: 12,
  冬: 12,
};

const num = (raw: string) => (CN_NUM[raw] !== undefined ? CN_NUM[raw] : Number(raw));

/** 季节 → 起止月 */
const SEASONS: Record<string, [number, number]> = {
  开春: [3, 4],
  春天: [3, 5],
  春: [3, 5],
  夏: [6, 8],
  夏天: [6, 8],
  暑假: [7, 8],
  秋: [9, 11],
  秋天: [9, 11],
  冬天: [12, 2],
  寒假: [1, 2],
  年初: [1, 3],
  上半年: [1, 6],
  年中: [6, 8],
  下半年: [7, 12],
  年底: [11, 12],
  年末: [11, 12],
};

/** 先本地猜一遍常见说法，猜不出来再交给 AI */
export function parseFuzzyLocal(text: string, now = new Date()): FuzzyParse | null {
  const s = text.trim().replace(/\s+/g, "");
  if (!s) return null;
  const thisYear = now.getFullYear();

  /** 相对年份：今年 / 去年 / 前年 / 三年前 */
  let year: number | null = null;
  const explicit = s.match(/((?:19|20)\d{2})\s*年?/);
  if (explicit) year = Number(explicit[1]);
  else if (/今年/.test(s)) year = thisYear;
  else if (/去年|上一?年/.test(s)) year = thisYear - 1;
  else if (/前年/.test(s)) year = thisYear - 2;
  else {
    const ago = s.match(/([一二三四五六七八九十]{1,2}|\d+)\s*年前/);
    if (ago) year = thisYear - num(ago[1]);
  }

  /** 一段时间：2019 到 2021 */
  const span = s.match(/((?:19|20)\d{2})\s*年?\s*(?:到|至|-|—|~)\s*((?:19|20)\d{2})/);
  if (span) {
    return { date: `${span[1]}-01-01`, dateEnd: `${span[2]}-12-31`, precision: "range" };
  }

  /** 月份 */
  const monthMatch = s.match(/([一二三四五六七八九十]{1,2}|\d{1,2})\s*月/);
  if (monthMatch) {
    const m = num(monthMatch[1]);
    if (m >= 1 && m <= 12) {
      const y = year ?? (m > now.getMonth() + 1 ? thisYear - 1 : thisYear);
      return { date: `${y}-${pad(m)}-01`, precision: "month" };
    }
  }

  /** 季节 / 年初年底之类 → 一段时间 */
  for (const [key, [from, to]] of Object.entries(SEASONS)) {
    if (!s.includes(key)) continue;
    const y = year ?? thisYear;
    if (to < from) {
      const last = new Date(y + 1, to, 0).getDate();
      return {
        date: `${y}-${pad(from)}-01`,
        dateEnd: `${y + 1}-${pad(to)}-${pad(last)}`,
        precision: "range",
      };
    }
    const last = new Date(y, to, 0).getDate();
    return {
      date: `${y}-${pad(from)}-01`,
      dateEnd: `${y}-${pad(to)}-${pad(last)}`,
      precision: "range",
    };
  }

  /** 上个月 / 几个月前 */
  if (/上个?月/.test(s)) {
    const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    return { date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-01`, precision: "month" };
  }
  const monthsAgo = s.match(/([一二三四五六七八九十]{1,2}|\d+)\s*个?月前/);
  if (monthsAgo) {
    const d = new Date(now.getFullYear(), now.getMonth() - num(monthsAgo[1]), 1);
    return { date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-01`, precision: "month" };
  }

  if (year) return { date: `${year}-01-01`, precision: "year" };
  return null;
}

/** 交给 AI 去理解「大概什么时候」，返回可入库的时间 */
export function fuzzyPrompt(text: string, now = new Date()) {
  return [
    "把用户描述的模糊时间转成结构化时间，只输出 JSON，不要解释。",
    `今天是 ${now.toISOString().slice(0, 10)}。`,
    'JSON 形如 {"precision":"day|month|year|range","date":"YYYY-MM-DD","dateEnd":"YYYY-MM-DD"}。',
    "precision=year 时 date 用当年 1 月 1 日；month 用当月 1 日；range 时必须给 dateEnd。",
    `用户描述：${text}`,
  ].join("\n");
}

/** 校验 AI 返回的结果 */
export function normalizeFuzzy(raw: Partial<FuzzyParse> | null): FuzzyParse | null {
  const validDate = (value: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [year, month, day] = value.split("-").map(Number);
    return month >= 1 && month <= 12 && day >= 1 && day <= new Date(year, month, 0).getDate();
  };
  if (!raw?.date || !validDate(raw.date)) return null;
  const precision: DatePrecision =
    raw.precision === "day" ||
    raw.precision === "month" ||
    raw.precision === "year" ||
    raw.precision === "range"
      ? raw.precision
      : "year";
  if (raw.dateEnd && !validDate(raw.dateEnd)) return null;
  const dateEnd = raw.dateEnd;
  if (precision === "range" && !dateEnd) return { date: raw.date, precision: "month" };
  if (precision === "range" && dateEnd! < raw.date) return null;
  return { date: raw.date, dateEnd: precision === "range" ? dateEnd : undefined, precision };
}
