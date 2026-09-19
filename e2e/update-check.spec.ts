import { expect, openApp, test } from "./fixtures";
import { clickVisible } from "./fixtures";

/**
 * 「检查新版本」以 GitHub Releases 为更新源。
 * 这里把 api.github.com 整体 mock 掉：夹具会拦截一切外部请求并断言没有漏网的域名，
 * 所以用例必须自己注册（后注册的路由优先命中）。
 */
function githubRelease(tag: string, assets: Array<{ name: string; url: string }> = []) {
  return {
    tag_name: tag,
    name: `知脉 Connect ${tag}`,
    body: "修好了关系网布局与文字可读性。",
    published_at: "2026-09-20T00:00:00Z",
    html_url: `https://github.com/iyau76/ZhiMaiConnect/releases/tag/${tag}`,
    prerelease: true,
    draft: false,
    assets: assets.map((asset) => ({
      name: asset.name,
      browser_download_url: asset.url,
      size: 1024,
    })),
  };
}

async function openSettings(page: Parameters<typeof openApp>[0]) {
  await openApp(page);
  await clickVisible(page, page.getByRole("button", { name: /^设置/ }));
  await expect(page.getByTestId("about-controls")).toBeVisible();
}

test("检查新版本：查到更新时给出新版本号", async ({ page }) => {
  await page.route("https://api.github.com/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([githubRelease("v0.3.2")]),
    }),
  );
  await openSettings(page);

  await expect(page.getByTestId("app-version")).toContainText("0.3.1");
  await page.getByRole("button", { name: "检查新版本" }).click();
  await expect(page.getByTestId("update-available")).toContainText("v0.3.2");
  // 网页版没有安装包，要给的是「重开即更新」这句人话，而不是让人去下载 exe
  await expect(page.getByTestId("update-no-asset")).toContainText("网页版");
  await expect(page.getByRole("link", { name: /打开发布页/ })).toHaveAttribute(
    "href",
    /github\.com\/iyau76\/ZhiMaiConnect\/releases/,
  );
});

test("检查新版本：已经最新时明确说清楚", async ({ page }) => {
  await page.route("https://api.github.com/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([githubRelease("v0.3.1")]),
    }),
  );
  await openSettings(page);
  await page.getByRole("button", { name: "检查新版本" }).click();
  await expect(page.getByTestId("update-latest")).toContainText("已是最新版本");
});

test("检查新版本：GitHub 不通时降级提示，仍可手动打开发布页", async ({ page }) => {
  await page.route("https://api.github.com/**", (route) =>
    route.fulfill({ status: 403, contentType: "application/json", body: "{}" }),
  );
  await openSettings(page);
  await page.getByRole("button", { name: "检查新版本" }).click();
  await expect(page.getByTestId("update-unknown")).toContainText("403");
  await expect(page.getByRole("link", { name: /打开发布页/ })).toBeVisible();
});
