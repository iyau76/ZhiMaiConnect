import { describe, expect, it } from "vitest";
import {
  DEFAULT_GRAPH_LAYOUT_VERSION,
  GRAPH_LAYOUT_VERSION_STORAGE_KEY,
  loadGraphLayoutVersion,
  saveGraphLayoutVersion,
} from "./graph-layout-version";

function memoryStorage(initial?: string) {
  const values = new Map<string, string>();
  if (initial !== undefined) values.set(GRAPH_LAYOUT_VERSION_STORAGE_KEY, initial);
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    value: () => values.get(GRAPH_LAYOUT_VERSION_STORAGE_KEY),
  };
}

describe("关系网布局版本开关", () => {
  it("默认走原版", () => {
    expect(loadGraphLayoutVersion(memoryStorage())).toBe("legacy");
    expect(DEFAULT_GRAPH_LAYOUT_VERSION).toBe("legacy");
  });

  it("选过新版以后记住选择", () => {
    const storage = memoryStorage();
    saveGraphLayoutVersion(storage, "compact");
    expect(storage.value()).toBe("compact");
    expect(loadGraphLayoutVersion(storage)).toBe("compact");
    saveGraphLayoutVersion(storage, "legacy");
    expect(loadGraphLayoutVersion(storage)).toBe("legacy");
  });

  it("存储里的脏值回落到原版", () => {
    expect(loadGraphLayoutVersion(memoryStorage("preview"))).toBe("legacy");
  });
});
