import type { FuzzyParse } from "./fuzzy-date";

/** One Gregorian validator for local explicit text and model normalization. */
export function calendarDate(year: number, month: number, day: number): string | null {
  if (!Number.isInteger(year) || year < 1 || year > 9999 || month < 1 || month > 12 || day < 1)
    return null;
  const probe = new Date(0);
  probe.setUTCFullYear(year, month, 0);
  if (!Number.isInteger(month) || !Number.isInteger(day) || day > probe.getUTCDate()) return null;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function lastDay(year: number, month: number) {
  const date = new Date(0);
  date.setUTCFullYear(year, month, 0);
  return date.getUTCDate();
}

/** matched + null is an explicit invalid date, not permission to invent an AI replacement. */
export function parseExplicitEventDate(text: string): {
  matched: boolean;
  value: FuzzyParse | null;
} {
  const input = text
    .trim()
    .replace(/\s+/g, "")
    .replace(/^(?:从|自)/, "")
    .replace(/(?:期间|之间)$/, "");
  const day = "\\d{4}[-/.年]\\d{1,2}[-/.月]\\d{1,2}日?";
  const month = "\\d{4}[-/.年]\\d{1,2}月?";
  const year = "\\d{4}年?";
  const separator = "(?:到|至|~|～|—|–|-)";
  const fullDay = (token: string) => {
    const match = /^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/.exec(token);
    return match ? calendarDate(Number(match[1]), Number(match[2]), Number(match[3])) : null;
  };
  const range = (start: string | null, end: string | null) => ({
    matched: true,
    value:
      start && end && start <= end
        ? { date: start, dateEnd: end, precision: "range" as const }
        : null,
  });
  let match = new RegExp(`^(${day})${separator}(${day})$`).exec(input);
  if (match) return range(fullDay(match[1]), fullDay(match[2]));
  match = new RegExp(`^(${day})${separator}(\\d{1,2})[-/.月](\\d{1,2})日?$`).exec(input);
  if (match)
    return range(
      fullDay(match[1]),
      calendarDate(Number(match[1].slice(0, 4)), Number(match[2]), Number(match[3])),
    );
  match = new RegExp(`^(${month})${separator}(${month})$`).exec(input);
  if (match) {
    const parts = (token: string) => token.match(/^(\d{4})[-/.年](\d{1,2})月?$/)!;
    const a = parts(match[1]);
    const b = parts(match[2]);
    return range(calendarDate(+a[1], +a[2], 1), calendarDate(+b[1], +b[2], lastDay(+b[1], +b[2])));
  }
  match = new RegExp(`^(${year})${separator}(${year})$`).exec(input);
  if (match)
    return range(calendarDate(parseInt(match[1]), 1, 1), calendarDate(parseInt(match[2]), 12, 31));
  if (new RegExp(`^${day}$`).test(input))
    return {
      matched: true,
      value: fullDay(input) ? { date: fullDay(input)!, precision: "day" } : null,
    };
  match = /^(\d{4})[-/.年](\d{1,2})月?$/.exec(input);
  if (match) {
    const date = calendarDate(+match[1], +match[2], 1);
    return { matched: true, value: date ? { date, precision: "month" } : null };
  }
  match = /^(\d{4})年?$/.exec(input);
  if (match) {
    const date = calendarDate(+match[1], 1, 1);
    return { matched: true, value: date ? { date, precision: "year" } : null };
  }
  // Never fall back to the first endpoint/year for a malformed explicit interval.
  if (/^\d{4}(?:[-/.年]|$)/.test(input) && /到|至|~|～|—|–/.test(input))
    return { matched: true, value: null };
  const prefix = /^(\d{4})[-/.年](\d{1,2})(?:[-/.月](\d{1,2}))?/.exec(input);
  if (prefix && !calendarDate(+prefix[1], +prefix[2], +(prefix[3] ?? 1)))
    return { matched: true, value: null };
  if (/^\d{4}[-/.][\d./-]*$/.test(input)) return { matched: true, value: null };
  return { matched: false, value: null };
}
