import {
  DEFAULT_PRESETS,
  migrateLegacyProviderPresets,
  type ProviderPreset,
} from "./vision-providers";

export const MODEL_PRESETS_KEY = "openglass.presets";
export const ACTIVE_MODEL_PRESET_KEY = "openglass.active";
export const SESSION_API_KEYS_KEY = "openglass.session-api-keys";
export const SAVED_API_KEYS_KEY = "openglass.saved-api-keys";
export const MODEL_PRESETS_VERSION_KEY = "openglass.presets-version";
export const MODEL_PRESETS_VERSION = "3";

type ReadableStorage = Pick<Storage, "getItem">;
type WritableStorage = Pick<Storage, "getItem" | "setItem">;

function readKeyMap(storage: ReadableStorage, key: string): Record<string, string> {
  try {
    const parsed = JSON.parse(storage.getItem(key) ?? "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] =>
          typeof entry[1] === "string" && Boolean(entry[1].trim()),
      ),
    );
  } catch {
    return {};
  }
}

export function presetsWithoutApiKeys(presets: ProviderPreset[]) {
  return presets.map((preset) => ({ ...preset, apiKey: "" }));
}

export function loadSavedModelPresets(storage: ReadableStorage): ProviderPreset[] {
  let parsed: unknown = DEFAULT_PRESETS;
  try {
    const raw = storage.getItem(MODEL_PRESETS_KEY);
    parsed = raw ? (JSON.parse(raw) as unknown) : DEFAULT_PRESETS;
  } catch {
    parsed = DEFAULT_PRESETS;
  }
  const configured = migrateLegacyProviderPresets(parsed);
  const savedKeys = readKeyMap(storage, SAVED_API_KEYS_KEY);
  return configured.map((preset) => ({
    ...preset,
    apiKey: savedKeys[preset.id] ?? preset.apiKey ?? "",
  }));
}

export function applySessionApiKeys(
  presets: ProviderPreset[],
  storage: ReadableStorage,
): ProviderPreset[] {
  const sessionKeys = readKeyMap(storage, SESSION_API_KEYS_KEY);
  return presets.map((preset) => ({
    ...preset,
    apiKey: sessionKeys[preset.id] ?? preset.apiKey,
  }));
}

export function saveSessionApiKeys(storage: WritableStorage, presets: ProviderPreset[]) {
  storage.setItem(
    SESSION_API_KEYS_KEY,
    JSON.stringify(
      Object.fromEntries(
        presets
          .filter((preset) => preset.apiKey.trim())
          .map((preset) => [preset.id, preset.apiKey]),
      ),
    ),
  );
}

/** Persist model settings only after the user presses the explicit save button. */
export function saveModelPresets(storage: WritableStorage, presets: ProviderPreset[]) {
  storage.setItem(MODEL_PRESETS_KEY, JSON.stringify(presetsWithoutApiKeys(presets)));
  storage.setItem(
    SAVED_API_KEYS_KEY,
    JSON.stringify(
      Object.fromEntries(
        presets
          .filter((preset) => preset.apiKey.trim())
          .map((preset) => [preset.id, preset.apiKey]),
      ),
    ),
  );
  storage.setItem(MODEL_PRESETS_VERSION_KEY, MODEL_PRESETS_VERSION);
}

export function hasSavedApiKey(storage: ReadableStorage) {
  if (Object.keys(readKeyMap(storage, SAVED_API_KEYS_KEY)).length > 0) return true;
  try {
    const legacy = JSON.parse(storage.getItem(MODEL_PRESETS_KEY) ?? "[]") as unknown;
    return (
      Array.isArray(legacy) &&
      legacy.some(
        (item) =>
          item &&
          typeof item === "object" &&
          "apiKey" in item &&
          typeof item.apiKey === "string" &&
          Boolean(item.apiKey.trim()),
      )
    );
  } catch {
    return false;
  }
}
