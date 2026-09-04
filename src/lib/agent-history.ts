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
        result: {
          omittedBefore: omitted,
          instruction: "更早的结果仍保存在执行账本；优先复用可见结果，确需缺失字段时再调用工具",
        },
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
  "hint",
  "query",
  "targetPersonRef",
  "capability",
  "returnedCount",
  "sourceCount",
  "cursor",
  "total",
  "totalMatches",
  "exhausted",
  "rows",
  "matches",
  "nextCursor",
  "recoverWith",
] as const;

const RAW_ID_FIELD = /^(?:id|.*Ids?)$/u;
const REFERENCE_FIELD = /(?:Ref|Refs|handle|handles)$/u;

function rowFieldRank(key: string, value: unknown) {
  if (key === "sourceRef" || REFERENCE_FIELD.test(key)) return 0;
  if (["name", "label", "title", "type", "status", "entityRole"].includes(key)) return 1;
  if (typeof value === "number" || typeof value === "boolean") return 2;
  if (typeof value === "string" && value.length <= 80) return 3;
  if (Array.isArray(value) && value.length <= 8) return 4;
  if (RAW_ID_FIELD.test(key)) return 6;
  return 5;
}

function projectRowFairly(value: unknown, maxCharacters: number): unknown {
  const full = JSON.stringify(value);
  if (!full || full.length <= maxCharacters) return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return typeof value === "string" ? `${value.slice(0, Math.max(0, maxCharacters - 3))}…` : value;
  }
  const source = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  const omittedFields: string[] = [];
  const omittedItems: Record<string, number> = {};
  const contentLimit = Math.max(40, maxCharacters - 120);
  const keys = Object.keys(source)
    .map((key, index) => ({ key, index, rank: rowFieldRank(key, source[key]) }))
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map(({ key }) => key);
  for (const key of keys) {
    const raw = source[key];
    // Archive stable IDs are local execution details. Opaque *Ref handles are
    // the only identifiers that belong in a model-visible projection.
    if (RAW_ID_FIELD.test(key) && !REFERENCE_FIELD.test(key)) {
      omittedFields.push(key);
      continue;
    }
    let projected: unknown = raw;
    if (typeof raw === "string" && raw.length > 180) projected = `${raw.slice(0, 177)}…`;
    else if (Array.isArray(raw)) {
      if (!raw.length) projected = [];
      else if (raw.every((item) => ["string", "number", "boolean"].includes(typeof item))) {
        projected = raw.slice(0, 8);
        if (raw.length > 8) omittedItems[key] = raw.length - 8;
      } else {
        const items: unknown[] = [];
        for (const item of raw) {
          const remaining = Math.max(
            80,
            contentLimit - JSON.stringify({ ...output, [key]: items }).length,
          );
          const next = projectRowFairly(item, Math.min(remaining, 480));
          if (JSON.stringify({ ...output, [key]: [...items, next] }).length > contentLimit) break;
          items.push(next);
        }
        projected = items;
        if (items.length < raw.length) omittedItems[key] = raw.length - items.length;
      }
    } else if (raw && typeof raw === "object") {
      projected = projectRowFairly(raw, Math.max(80, contentLimit - JSON.stringify(output).length));
    }
    const candidate = { ...output, [key]: projected };
    if (JSON.stringify(candidate).length <= contentLimit) output[key] = projected;
    else omittedFields.push(key);
  }
  const projection = {
    ...(omittedFields.length ? { omittedFields } : {}),
    ...(Object.keys(omittedItems).length ? { omittedItems } : {}),
  };
  if (
    Object.keys(projection).length &&
    JSON.stringify({ ...output, _projection: projection }).length <= maxCharacters
  ) {
    output._projection = projection;
  }
  return output;
}

function numericSourceCount(source: Record<string, unknown>, pageLength: number) {
  if (typeof source.sourceCount === "number") return source.sourceCount;
  if (typeof source.total === "number") return source.total;
  if (typeof source.totalMatches === "number") return source.totalMatches;
  return pageLength;
}

function firstOpaqueRef(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  for (const [key, candidate] of Object.entries(value as Record<string, unknown>)) {
    if (REFERENCE_FIELD.test(key) && typeof candidate === "string") return candidate;
  }
  return undefined;
}

function fits(output: Record<string, unknown>, maxCharacters: number) {
  return JSON.stringify(output).length <= maxCharacters;
}

/**
 * Project a large tool result into a complete JSON value before it enters
 * model history. Rows always form a contiguous prefix, and pagination is
 * recalculated from the rows the model actually receives.
 */
export function projectToolResultForHistory(
  result: unknown,
  maxCharacters = 3_800,
  options: { toolName?: string } = {},
): unknown {
  const full = JSON.stringify(result);
  if (!full || full.length <= maxCharacters) return result;
  if (!result || typeof result !== "object") {
    return {
      _historyProjection: { truncated: true, originalCharacters: full?.length ?? 0 },
      value: String(result).slice(0, Math.max(0, maxCharacters - 120)),
    };
  }

  const source = Array.isArray(result) ? { rows: result } : (result as Record<string, unknown>);
  const primaryArrayKey = Array.isArray(source.rows)
    ? "rows"
    : Array.isArray(source.matches)
      ? "matches"
      : undefined;
  const primaryRows = primaryArrayKey ? (source[primaryArrayKey] as unknown[]) : [];
  const sourceCursor = typeof source.cursor === "number" ? source.cursor : undefined;
  const output: Record<string, unknown> = {
    _historyProjection: { truncated: true, originalCharacters: full.length },
  };

  const keys = [
    ...MODEL_RESULT_PRIORITY.filter((key) => key in source),
    ...Object.keys(source).filter(
      (key) => !(MODEL_RESULT_PRIORITY as readonly string[]).includes(key),
    ),
  ];
  const metadataLimit = primaryArrayKey ? Math.max(80, maxCharacters - 320) : maxCharacters;
  for (const key of keys) {
    if (key === primaryArrayKey || key === "nextCursor" || key === "returnedCount") continue;
    const value = source[key];
    if (Array.isArray(value)) {
      const projected = projectRowFairly(
        value,
        Math.max(80, maxCharacters - JSON.stringify(output).length),
      );
      const candidate = { ...output, [key]: projected };
      if (fits(candidate, metadataLimit)) output[key] = projected;
      continue;
    }
    const projected =
      typeof value === "string" && value.length > 500 ? `${value.slice(0, 497)}…` : value;
    const candidate = { ...output, [key]: projected };
    if (fits(candidate, metadataLimit)) output[key] = projected;
  }

  if (primaryArrayKey) {
    const visibleRows: unknown[] = [];
    output[primaryArrayKey] = visibleRows;
    output.returnedCount = 0;
    output.sourceCount = numericSourceCount(source, primaryRows.length);
    if (sourceCursor !== undefined) output.cursor = sourceCursor;

    for (const row of primaryRows) {
      const remainingRows = Math.max(1, Math.min(primaryRows.length - visibleRows.length, 8));
      const available = Math.max(120, maxCharacters - JSON.stringify(output).length - 180);
      const projected = projectRowFairly(
        row,
        Math.max(120, Math.min(900, Math.floor(available / remainingRows))),
      );
      const nextRows = [...visibleRows, projected];
      const nextCount = nextRows.length;
      const candidate: Record<string, unknown> = {
        ...output,
        [primaryArrayKey]: nextRows,
        returnedCount: nextCount,
      };
      if (sourceCursor !== undefined) candidate.nextCursor = sourceCursor + nextCount;
      if (!fits(candidate, maxCharacters)) break;
      visibleRows.push(projected);
      output.returnedCount = nextCount;
      if (sourceCursor !== undefined) output.nextCursor = sourceCursor + nextCount;
    }

    const rowsWereTruncated = visibleRows.length < primaryRows.length;
    if (!rowsWereTruncated) {
      if ("nextCursor" in source) output.nextCursor = source.nextCursor;
      if ("exhausted" in source) output.exhausted = source.exhausted;
    } else {
      output.exhausted = false;
      output.omittedRowCount = primaryRows.length - visibleRows.length;
      let omittedRefs = primaryRows.slice(visibleRows.length).flatMap((row) => {
        const ref = firstOpaqueRef(row);
        return ref ? [ref] : [];
      });
      let recoverWith = "";
      for (let remaining = visibleRows.length; remaining >= 0; remaining -= 1) {
        recoverWith =
          sourceCursor !== undefined
            ? `再次调用 ${options.toolName ?? "同一工具"}，cursor=${sourceCursor + visibleRows.length}`
            : omittedRefs.length
              ? `再次调用 ${options.toolName ?? "同一工具"}，传入尚未读取的 opaque refs`
              : `缩小 ${options.toolName ?? "同一工具"} 的查询范围后继续读取`;
        if (fits({ ...output, recoverWith }, maxCharacters)) break;
        if (!visibleRows.length) break;
        visibleRows.pop();
        output.returnedCount = visibleRows.length;
        output.omittedRowCount = primaryRows.length - visibleRows.length;
        if (sourceCursor !== undefined) output.nextCursor = sourceCursor + visibleRows.length;
        omittedRefs = primaryRows.slice(visibleRows.length).flatMap((row) => {
          const ref = firstOpaqueRef(row);
          return ref ? [ref] : [];
        });
      }
      if (fits({ ...output, recoverWith }, maxCharacters)) output.recoverWith = recoverWith;
      if (omittedRefs.length) {
        const retained: string[] = [];
        for (const ref of omittedRefs) {
          if (!fits({ ...output, omittedRefs: [...retained, ref] }, maxCharacters)) break;
          retained.push(ref);
        }
        if (retained.length) output.omittedRefs = retained;
      }
    }
  }

  while (!fits(output, maxCharacters) && Array.isArray(output.omittedRefs)) {
    (output.omittedRefs as unknown[]).pop();
  }
  if (!fits(output, maxCharacters)) delete output.recoverWith;
  return output;
}
