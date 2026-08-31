/** Serialize newest complete tool entries without ever cutting through JSON syntax. */
export function serializeToolHistory(
  history: Array<{ call: unknown; result: unknown }>,
  maxCharacters: number,
) {
  if (maxCharacters < 2) return "";
  const selected: Array<{ call: unknown; result: unknown }> = [];
  let used = 2;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = history[index];
    const size = JSON.stringify(entry).length + (selected.length ? 1 : 0);
    if (used + size > maxCharacters) break;
    selected.unshift(entry);
    used += size;
  }
  let omitted = history.length - selected.length;
  if (omitted > 0) {
    for (;;) {
      const marker = {
        call: { type: "history_truncated" },
        result: { omittedBefore: omitted, instruction: "需要时重新调用工具取得完整结果" },
      };
      const candidate = [marker, ...selected];
      const serialized = JSON.stringify(candidate);
      if (serialized.length <= maxCharacters) return serialized;
      if (!selected.length) return "[]";
      selected.shift();
      omitted += 1;
    }
  }
  return JSON.stringify(selected);
}

const MODEL_RESULT_PRIORITY = [
  "rankingLocked",
  "mode",
  "accessVerified",
  "scoreMeaning",
  "safetyNotice",
  "projection",
  "returnedFields",
  "omittedFields",
  "omissionMeaning",
  "detailTool",
  "rows",
  "matches",
  "nextCursor",
  "total",
] as const;

function rowFieldRank(key: string, value: unknown) {
  if (key === "id" || key === "sourceRef" || /Id$/u.test(key)) return 0;
  if (["name", "label", "title", "type", "status", "entityRole"].includes(key)) return 1;
  if (typeof value === "number" || typeof value === "boolean") return 2;
  if (typeof value === "string" && value.length <= 80) return 3;
  if (Array.isArray(value) && value.length <= 8) return 4;
  return 5;
}

function projectRowFairly(value: unknown, maxCharacters: number): unknown {
  const full = JSON.stringify(value);
  if (!full || full.length <= maxCharacters) return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return typeof value === "string" ? `${value.slice(0, Math.max(0, maxCharacters - 3))}…` : value;
  }
  const source = value as Record<string, unknown>;
  const output: Record<string, unknown> = { _rowProjection: true };
  const keys = Object.keys(source)
    .map((key, index) => ({ key, index, rank: rowFieldRank(key, source[key]) }))
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map(({ key }) => key);
  for (const key of keys) {
    const raw = source[key];
    let projected: unknown = raw;
    if (typeof raw === "string" && raw.length > 180) projected = `${raw.slice(0, 177)}…`;
    else if (Array.isArray(raw)) {
      if (!raw.length) projected = [];
      else if (raw.every((item) => ["string", "number", "boolean"].includes(typeof item))) {
        projected = raw.slice(0, 8);
      } else {
        continue;
      }
    } else if (raw && typeof raw === "object") {
      continue;
    }
    const candidate = { ...output, [key]: projected };
    if (JSON.stringify(candidate).length <= maxCharacters) output[key] = projected;
  }
  return output;
}

/**
 * Project a large tool result into a complete JSON value before it enters
 * history. Stable IDs and locally locked ranking fields are retained first.
 */
export function projectToolResultForHistory(result: unknown, maxCharacters = 3_800): unknown {
  const full = JSON.stringify(result);
  if (!full || full.length <= maxCharacters) return result;
  if (!result || typeof result !== "object") {
    return {
      _historyProjection: { truncated: true, originalCharacters: full?.length ?? 0 },
      value: String(result).slice(0, Math.max(0, maxCharacters - 120)),
    };
  }

  const source = Array.isArray(result) ? { rows: result } : (result as Record<string, unknown>);
  const output: Record<string, unknown> = {
    _historyProjection: { truncated: true, originalCharacters: full.length },
  };
  const keys = [
    ...MODEL_RESULT_PRIORITY.filter((key) => key in source),
    ...Object.keys(source).filter(
      (key) => !(MODEL_RESULT_PRIORITY as readonly string[]).includes(key),
    ),
  ];
  for (const key of keys) {
    const value = source[key];
    if (Array.isArray(value)) {
      const emptyCandidate = { ...output, [key]: [] };
      const remaining = maxCharacters - JSON.stringify(emptyCandidate).length - value.length;
      const perRow = value.length ? Math.floor(remaining / value.length) : 0;
      if (value.length > 0 && value.length <= 30 && perRow >= 140) {
        const fairRows = value.map((row) => projectRowFairly(row, perRow));
        const fairCandidate = { ...output, [key]: fairRows };
        if (JSON.stringify(fairCandidate).length <= maxCharacters) {
          output[key] = fairRows;
          continue;
        }
      }
      const rows: unknown[] = [];
      for (const row of value) {
        const candidate = { ...output, [key]: [...rows, row] };
        if (JSON.stringify(candidate).length > maxCharacters) break;
        rows.push(row);
      }
      const candidate = { ...output, [key]: rows };
      if (JSON.stringify(candidate).length <= maxCharacters) output[key] = rows;
      continue;
    }
    const candidate = { ...output, [key]: value };
    if (JSON.stringify(candidate).length <= maxCharacters) output[key] = value;
  }
  return output;
}
