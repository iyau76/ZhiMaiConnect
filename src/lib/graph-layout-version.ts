/**
 * 关系网布局版本开关。
 *
 * 原版：按「成员组合」分区 + 环套环布局，已经上线使用。
 * 新版：多重成员包络 + 确定性紧凑布局，仍在验证，默认不启用。
 */

export type GraphLayoutVersion = "legacy" | "compact";

export const GRAPH_LAYOUT_VERSION_STORAGE_KEY = "zhimai:graph-layout-version";
export const DEFAULT_GRAPH_LAYOUT_VERSION: GraphLayoutVersion = "legacy";

type VersionStorage = Pick<Storage, "getItem" | "setItem">;

export function loadGraphLayoutVersion(storage: VersionStorage): GraphLayoutVersion {
  const stored = storage.getItem(GRAPH_LAYOUT_VERSION_STORAGE_KEY);
  return stored === "compact" ? "compact" : DEFAULT_GRAPH_LAYOUT_VERSION;
}

export function saveGraphLayoutVersion(storage: VersionStorage, version: GraphLayoutVersion) {
  storage.setItem(GRAPH_LAYOUT_VERSION_STORAGE_KEY, version);
}
