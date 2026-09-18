import { describe, expect, it, vi } from "vitest";
import {
  RELEASES_PAGE_URL,
  checkForAppUpdate,
  compareVersions,
  currentPlatform,
  parseVersion,
  pickAssetForPlatform,
  type ReleaseAsset,
} from "./update-check";

const assets: ReleaseAsset[] = [
  { name: "SHA256SUMS.txt", url: "https://example.invalid/sums", size: 100 },
  {
    name: "ZhiMai-Connect-0.3.2-win-x64-setup.exe",
    url: "https://example.invalid/app.exe",
    size: 200,
  },
  { name: "ZhiMai-Connect-0.3.2-test.apk", url: "https://example.invalid/app.apk", size: 300 },
];

function releasePayload(overrides: Record<string, unknown> = {}) {
  return {
    tag_name: "v0.3.2",
    name: "知脉 Connect 0.3.2",
    body: "修好了关系网布局。",
    published_at: "2026-09-20T00:00:00Z",
    html_url: "https://example.invalid/release",
    prerelease: true,
    draft: false,
    assets: [
      {
        name: "ZhiMai-Connect-0.3.2-win-x64-setup.exe",
        browser_download_url: "https://example.invalid/app.exe",
        size: 200,
      },
      {
        name: "ZhiMai-Connect-0.3.2-test.apk",
        browser_download_url: "https://example.invalid/app.apk",
        size: 300,
      },
    ],
    ...overrides,
  };
}

function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
  } as unknown as Response;
}

describe("版本比较", () => {
  it("解析 v 前缀与预发布后缀", () => {
    expect(parseVersion("v0.3.1")).toEqual({ numbers: [0, 3, 1], label: "" });
    expect(parseVersion("0.3.1-preview.2")).toEqual({ numbers: [0, 3, 1], label: "preview.2" });
    expect(parseVersion("1")).toEqual({ numbers: [1], label: "" });
  });

  it("按数字段比较，预发布小于正式版", () => {
    expect(compareVersions("0.3.1", "0.3.0")).toBe(1);
    expect(compareVersions("v0.3.1", "0.3.1")).toBe(0);
    expect(compareVersions("0.3", "0.3.0")).toBe(0);
    expect(compareVersions("0.3.1-preview.1", "0.3.1")).toBe(-1);
    expect(compareVersions("0.4", "0.3.9")).toBe(1);
  });
});

describe("按平台挑安装包", () => {
  it("Windows 要 exe，Android 要 apk，网页版不挑文件", () => {
    expect(pickAssetForPlatform(assets, "windows")?.name).toContain("setup.exe");
    expect(pickAssetForPlatform(assets, "android")?.name).toContain(".apk");
    expect(pickAssetForPlatform(assets, "web")).toBeNull();
  });

  it("没有对应安装包时返回 null，而不是随便给一个文件", () => {
    expect(pickAssetForPlatform([assets[0]], "windows")).toBeNull();
  });
});

describe("checkForAppUpdate", () => {
  it("发现更高版本时给出安装包与发布信息", async () => {
    const result = await checkForAppUpdate({
      currentVersion: "0.3.1",
      platform: "windows",
      fetchImpl: vi.fn(async () => jsonResponse([releasePayload()])) as unknown as typeof fetch,
    });
    expect(result.status).toBe("update");
    expect(result.release?.tag).toBe("v0.3.2");
    expect(result.release?.version).toBe("0.3.2");
    expect(result.asset?.name).toContain("setup.exe");
  });

  it("已经是最新时不给安装包", async () => {
    const result = await checkForAppUpdate({
      currentVersion: "0.3.2",
      platform: "android",
      fetchImpl: vi.fn(async () => jsonResponse([releasePayload()])) as unknown as typeof fetch,
    });
    expect(result.status).toBe("latest");
    expect(result.release?.tag).toBe("v0.3.2");
  });

  it("跳过草稿，取已发布的最高版本", async () => {
    const result = await checkForAppUpdate({
      currentVersion: "0.3.0",
      platform: "web",
      fetchImpl: vi.fn(async () =>
        jsonResponse([
          releasePayload({ tag_name: "v0.4.0", draft: true }),
          releasePayload({ tag_name: "v0.3.1" }),
        ]),
      ) as unknown as typeof fetch,
    });
    expect(result.status).toBe("update");
    expect(result.release?.tag).toBe("v0.3.1");
    expect(result.asset).toBeNull();
  });

  it("接口报错、网络不通、超时都降级成「查不到」并带原因", async () => {
    const failed = await checkForAppUpdate({
      currentVersion: "0.3.1",
      fetchImpl: vi.fn(async () =>
        jsonResponse({}, { ok: false, status: 403 }),
      ) as unknown as typeof fetch,
    });
    expect(failed.status).toBe("unknown");
    expect(failed.reason).toContain("403");

    const offline = await checkForAppUpdate({
      currentVersion: "0.3.1",
      fetchImpl: vi.fn(async () => {
        throw new Error("network down");
      }) as unknown as typeof fetch,
    });
    expect(offline.status).toBe("unknown");
    expect(offline.reason).toContain("GitHub");

    const empty = await checkForAppUpdate({
      currentVersion: "0.3.1",
      fetchImpl: vi.fn(async () => jsonResponse([])) as unknown as typeof fetch,
    });
    expect(empty.status).toBe("unknown");
    expect(empty.reason).toContain("还没有已发布");
  });

  it("没有已发布版本时给发布页地址兜底", () => {
    expect(RELEASES_PAGE_URL).toContain("github.com/iyau76/ZhiMaiConnect/releases");
  });
});

describe("currentPlatform", () => {
  it("原生壳优先，其次看 UA，默认网页版", () => {
    expect(currentPlatform()).toBe("web");

    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Linux; Android 14)" });
    expect(currentPlatform()).toBe("android");

    vi.stubGlobal("window", { zhimaiNative: { platform: "windows" } });
    expect(currentPlatform()).toBe("windows");

    vi.unstubAllGlobals();
    expect(currentPlatform()).toBe("web");
  });
});
