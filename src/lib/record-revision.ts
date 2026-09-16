/** Canonical record contents, not a wall-clock timestamp. Undefined fields match absent fields. */
export function recordRevision(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(recordRevision).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${recordRevision(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
