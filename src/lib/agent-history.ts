/** Serialize newest complete tool entries without ever cutting through JSON syntax. */
export function serializeToolHistory(
  history: Array<{ call: unknown; result: unknown }>,
  maxCharacters: number,
) {
  const selected: Array<{ call: unknown; result: unknown }> = [];
  let used = 2;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = history[index];
    const size = JSON.stringify(entry).length + (selected.length ? 1 : 0);
    if (used + size > maxCharacters) continue;
    selected.unshift(entry);
    used += size;
  }
  if (!selected.length && history.length) {
    return JSON.stringify([
      { call: { type: "history_truncated" }, result: { omitted: history.length } },
    ]);
  }
  return JSON.stringify(selected);
}
