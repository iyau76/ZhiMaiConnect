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
  "rows",
  "matches",
  "nextCursor",
  "total",
] as const;

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
