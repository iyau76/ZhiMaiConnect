/**
 * 应用更新检查：以 GitHub Releases 为更新源。
 *
 * 这里只做三件事：读最新发布、比版本号、按运行平台挑安装包。
 * 网络失败一律降级成「查不到」，由界面提示用户手动打开发布页——
 * 检查更新不是底线能力，失败不能拦住用户用应用，也不能假装已经是最新。
 */

export const RELEASE_REPOSITORY = "iyau76/ZhiMaiConnect";
export const RELEASES_API_URL = `https://api.github.com/repos/${RELEASE_REPOSITORY}/releases?per_page=10`;
export const RELEASES_PAGE_URL = `https://github.com/${RELEASE_REPOSITORY}/releases`;

export type ReleasePlatform = "windows" | "android" | "web";

export interface ReleaseAsset {
  name: string;
  url: string;
  size: number;
}

export interface ReleaseInfo {
  /** 原始 tag，如 v0.3.1 */
  tag: string;
  /** 去掉前缀与预发布后缀的版本号，如 0.3.1 */
  version: string;
  name: string;
  notes: string;
  publishedAt: string;
  htmlUrl: string;
  prerelease: boolean;
  assets: ReleaseAsset[];
}

export interface UpdateCheckResult {
  status: "update" | "latest" | "unknown";
  currentVersion: string;
  release?: ReleaseInfo;
  asset?: ReleaseAsset | null;
  /** status = unknown 时的原因，直接展示给用户 */
  reason?: string;
}

/** 解析 `0.3.1`、`v0.3.1`、`0.3.1-preview.2` 这类标签 */
export function parseVersion(input: string) {
  const trimmed = input.trim().replace(/^v/i, "");
  const [main = "", ...rest] = trimmed.split("-");
  const numbers = main.split(".").map((part) => {
    const value = Number.parseInt(part, 10);
    return Number.isFinite(value) ? value : 0;
  });
  return { numbers, label: rest.join("-") };
}

/** 版本比较：a > b 返回正数。预发布版本永远小于同号正式版。 */
export function compareVersions(left: string, right: string) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  const length = Math.max(a.numbers.length, b.numbers.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (a.numbers[index] ?? 0) - (b.numbers[index] ?? 0);
    if (difference !== 0) return difference > 0 ? 1 : -1;
  }
  if (a.label === b.label) return 0;
  if (!a.label) return 1;
  if (!b.label) return -1;
  return a.label > b.label ? 1 : -1;
}

/** 按运行平台挑安装包：Windows 要 exe，Android 要 apk，网页版不需要文件 */
export function pickAssetForPlatform(
  assets: ReleaseAsset[],
  platform: ReleasePlatform,
): ReleaseAsset | null {
  if (platform === "web") return null;
  const suffix = platform === "windows" ? ".exe" : ".apk";
  return assets.find((asset) => asset.name.toLowerCase().endsWith(suffix)) ?? null;
}

function toReleaseInfo(input: unknown): ReleaseInfo | null {
  if (!input || typeof input !== "object") return null;
  const record = input as Record<string, unknown>;
  const tag = typeof record.tag_name === "string" ? record.tag_name : "";
  if (!tag) return null;
  const assets = Array.isArray(record.assets)
    ? record.assets.flatMap((raw) => {
        if (!raw || typeof raw !== "object") return [];
        const asset = raw as Record<string, unknown>;
        const name = typeof asset.name === "string" ? asset.name : "";
        const url =
          typeof asset.browser_download_url === "string" ? asset.browser_download_url : "";
        if (!name || !url) return [];
        return [
          {
            name,
            url,
            size: typeof asset.size === "number" ? asset.size : 0,
          },
        ];
      })
    : [];
  return {
    tag,
    version: parseVersion(tag).numbers.join("."),
    name: typeof record.name === "string" && record.name ? record.name : tag,
    notes: typeof record.body === "string" ? record.body : "",
    publishedAt: typeof record.published_at === "string" ? record.published_at : "",
    htmlUrl: typeof record.html_url === "string" ? record.html_url : RELEASES_PAGE_URL,
    prerelease: record.prerelease === true,
    assets,
  };
}

export interface CheckForAppUpdateOptions {
  currentVersion: string;
  platform?: ReleasePlatform;
  /** 默认用全局 fetch；原生运行时由调用方传入走原生网络栈的实现 */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export async function checkForAppUpdate(
  options: CheckForAppUpdateOptions,
): Promise<UpdateCheckResult> {
  const platform = options.platform ?? "web";
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 8000;
  const controller = typeof AbortController === "undefined" ? null : new AbortController();
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await fetchImpl(RELEASES_API_URL, {
      headers: { Accept: "application/vnd.github+json" },
      signal: controller?.signal,
    });
    if (!response.ok) {
      return {
        status: "unknown",
        currentVersion: options.currentVersion,
        reason: `GitHub 返回 ${response.status}`,
      };
    }
    const payload = (await response.json()) as unknown;
    const releases = Array.isArray(payload)
      ? payload.flatMap((item) => {
          const release = toReleaseInfo(item);
          if (!release) return [];
          const raw = item as Record<string, unknown>;
          return raw.draft === true ? [] : [release];
        })
      : [];
    const latest = releases.sort((left, right) => compareVersions(right.tag, left.tag))[0];
    if (!latest) {
      return {
        status: "unknown",
        currentVersion: options.currentVersion,
        reason: "GitHub 上还没有已发布的版本",
      };
    }
    return {
      status: compareVersions(latest.tag, options.currentVersion) > 0 ? "update" : "latest",
      currentVersion: options.currentVersion,
      release: latest,
      asset: pickAssetForPlatform(latest.assets, platform),
    };
  } catch (error) {
    return {
      status: "unknown",
      currentVersion: options.currentVersion,
      reason:
        (error as Error)?.name === "AbortError" ? "请求超时" : "连不上 GitHub（可能需要代理）",
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 当前运行环境；原生壳会把自己的平台写进 window.zhimaiNative */
export function currentPlatform(): ReleasePlatform {
  const nativePlatform = typeof window === "undefined" ? undefined : window.zhimaiNative?.platform;
  if (nativePlatform === "windows" || nativePlatform === "android") return nativePlatform;
  if (typeof navigator !== "undefined" && /android/i.test(navigator.userAgent)) return "android";
  return "web";
}
