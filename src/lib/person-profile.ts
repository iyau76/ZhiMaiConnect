/**
 * Canonical scalar rules for person profiles.
 *
 * Keep this module independent from IndexedDB and React so every ingestion,
 * edit, migration and restore path applies exactly the same rule.
 */
export function normalizeCloseness(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return undefined;
  return Math.max(1, Math.min(5, Math.round(numeric)));
}

export function isCanonicalCloseness(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 5;
}
