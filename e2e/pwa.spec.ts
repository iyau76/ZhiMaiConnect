import { test, expect, type Page } from "@playwright/test";

test.skip(
  process.env.PLAYWRIGHT_PWA_TEST !== "1",
  "PWA uses the production build, not the Vite development server",
);

async function installedPage(page: Page) {
  page.on("dialog", (dialog) => dialog.accept());
  page.context().on("page", (next) => next.on("dialog", (dialog) => dialog.accept()));
  await page.addInitScript(() => localStorage.setItem("openglass.welcomeSeen", "1"));
  await page.goto("/?view=settings");
  await expect(page.locator('[data-app-hydrated="true"]')).toBeVisible();
  await expect(page.getByTestId("pwa-ready")).toContainText("离线资源已就绪", { timeout: 60_000 });
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller)
      await new Promise<void>((resolve) =>
        navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), {
          once: true,
        }),
      );
  });
}

test("manifest, offline cold navigation, local edit and non-expiring input", async ({
  page,
  context,
}) => {
  await installedPage(page);
  const manifest = await (await page.request.get("/manifest.webmanifest")).json();
  expect(manifest.display).toBe("standalone");
  expect(manifest.share_target).toMatchObject({ action: "/share-target", method: "POST" });
  for (const icon of manifest.icons) expect((await page.request.get(icon.src)).status()).toBe(200);
  await page.goto("/?view=intake");
  await page
    .getByRole("textbox", { name: "录入材料", exact: true })
    .fill("合成记录：许星喜欢摄影，下周一起讨论活动。");
  await expect
    .poll(() =>
      page.evaluate(
        () => JSON.parse(localStorage.getItem("zhimai.intake.draft.v1") ?? "null")?.raw,
      ),
    )
    .toContain("许星");
  // An old timestamp must no longer erase unsubmitted material.
  await page.evaluate(() => {
    const draft = JSON.parse(localStorage.getItem("zhimai.intake.draft.v1")!);
    draft.at = Date.now() - 7 * 86400_000;
    localStorage.setItem("zhimai.intake.draft.v1", JSON.stringify(draft));
  });
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.clearBrowserCache");
  await context.setOffline(true);
  const next = await context.newPage();
  // Reapply CDP emulation to the newly created target: Chromium initially
  // reports navigator.onLine=true for a new tab even in an offline context.
  await context.setOffline(true);
  await next.goto("/?view=intake");
  await expect(next.getByRole("textbox", { name: "录入材料", exact: true })).toHaveValue(/许星/);
  await context.setOffline(false);
  await context.setOffline(true);
  await expect(next.getByRole("button", { name: "AI 整理成档案", exact: true })).toBeDisabled();
  await next
    .getByRole("textbox", { name: "录入材料", exact: true })
    .fill("离线补记：许星负责摄影。");
  await expect(next.getByText("保留到你手动清除", { exact: false })).toBeVisible();
  await expect
    .poll(() =>
      next.evaluate(
        () => JSON.parse(localStorage.getItem("zhimai.intake.draft.v1") ?? "null")?.raw,
      ),
    )
    .toContain("离线补记");
  await page.close();
  await next.reload();
  await expect(next.getByRole("textbox", { name: "录入材料", exact: true })).toHaveValue(
    "离线补记：许星负责摄影。",
  );
  // Existing local approval + archive path remains usable offline.
  await next.getByRole("button", { name: "离线演示草稿", exact: true }).click();
  await next.getByRole("button", { name: "确认入库", exact: true }).click();
  await expect(next.getByRole("button", { name: "确认入库", exact: true })).toHaveCount(0);
  await next.goto("/?view=people");
  await expect(next.getByText("唐悦", { exact: true }).first()).toBeVisible();
  await context.setOffline(false);
});

test("share POST is local, survives offline reload, and appends once", async ({
  page,
  context,
}) => {
  await installedPage(page);
  await context.setOffline(true);
  await page.evaluate(() => {
    const form = document.createElement("form");
    form.method = "POST";
    form.action = "/share-target";
    form.enctype = "multipart/form-data";
    for (const [name, value] of Object.entries({
      title: "社团活动",
      text: "合成材料：陆遥负责场地。",
    })) {
      const input = document.createElement("input");
      input.name = name;
      input.value = value;
      form.append(input);
    }
    document.body.append(form);
    form.submit();
  });
  await page.waitForURL(/view=intake/);
  const inbox = page.getByRole("region", { name: "待整理材料" });
  await expect(inbox).toContainText("陆遥负责场地");
  await page.reload();
  await inbox.getByRole("button", { name: "放入录入框" }).click();
  await expect(inbox).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "录入材料", exact: true })).toHaveValue(
    /陆遥负责场地/,
  );
  await page.reload();
  const value = await page.getByRole("textbox", { name: "录入材料", exact: true }).inputValue();
  expect(value.split("陆遥负责场地")).toHaveLength(2);
  await expect(inbox).toHaveCount(0);
  await context.setOffline(false);
});

test("mobile navigation and offline files stay local; private requests are not cached", async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installedPage(page);
  const nav = page.getByRole("navigation", { name: "手机导航" });
  await nav.getByRole("button", { name: "录入", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "录入材料", exact: true })).toBeVisible();
  const navBox = (await nav.boundingBox())!;
  for (const name of ["AI 整理成档案", "导入图片 / PDF / Word / 文本", "拍照", "现场录音"]) {
    const box = (await page.getByRole("button", { name, exact: true }).boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.y + box.height).toBeLessThanOrEqual(navBox.y);
  }
  await page.screenshot({ path: "test-results/pwa-mobile-intake.png" });
  await context.setOffline(true);
  await page
    .locator('input[type="file"]')
    .first()
    .setInputFiles({
      name: "合成材料.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("许星负责摄影，陆遥负责场地。", "utf8"),
    });
  const inbox = page.getByRole("region", { name: "待整理材料" });
  await expect(inbox).toContainText("合成材料.txt");
  await page.reload();
  await inbox.getByRole("button", { name: "放入录入框" }).click();
  await expect(page.getByRole("textbox", { name: "录入材料", exact: true })).toHaveValue(
    /许星负责摄影/,
  );
  await nav.getByRole("button", { name: "更多" }).click();
  await nav.getByRole("button", { name: "设置", exact: true }).click();
  await expect(page.getByRole("heading", { name: "安装到手机或电脑" })).toBeVisible();
  await page.screenshot({ path: "test-results/pwa-mobile-settings.png" });
  const width = await page.evaluate(() => ({
    body: document.documentElement.scrollWidth,
    screen: innerWidth,
  }));
  expect(width.body).toBeLessThanOrEqual(width.screen);
  const cached = await page.evaluate(async () => {
    const urls: string[] = [];
    for (const name of await caches.keys())
      for (const request of await (await caches.open(name)).keys()) urls.push(request.url);
    return urls;
  });
  expect(cached.some((url) => url.includes("/api/") || url.includes("/share-target"))).toBe(false);
  const apiFailed = await page.evaluate(() =>
    fetch("/api/status").then(
      () => false,
      () => true,
    ),
  );
  expect(apiFailed).toBe(true);
  await context.setOffline(false);
});

test("an update waits while the current window and draft remain intact", async ({ page }) => {
  await installedPage(page);
  await page.goto("/?view=intake");
  await page
    .getByRole("textbox", { name: "录入材料", exact: true })
    .fill("合成草稿：等我写完再更新。");
  await page.evaluate(async () => {
    await navigator.serviceWorker.register("/sw.js?update-test=1", {
      type: "module",
      scope: "/",
      updateViaCache: "none",
    });
  });
  await expect
    .poll(() =>
      page.evaluate(async () =>
        Boolean((await navigator.serviceWorker.getRegistration())?.waiting),
      ),
    )
    .toBe(true);
  expect(await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL)).not.toContain(
    "update-test",
  );
  await expect(page.getByRole("textbox", { name: "录入材料", exact: true })).toHaveValue(
    "合成草稿：等我写完再更新。",
  );
  await expect(page.getByText(/新版本已下载/)).toBeVisible();
});

test("offline microphone capture stays in the inbox across reload", async ({ page, context }) => {
  await context.grantPermissions(["microphone"]);
  await installedPage(page);
  await page.goto("/?view=intake");
  await context.setOffline(true);
  await page.getByRole("button", { name: "现场录音", exact: true }).click();
  await page.waitForTimeout(1000);
  await page.getByRole("button", { name: /停止录音/ }).click();
  const inbox = page.getByRole("region", { name: "待整理材料" });
  await expect(inbox).toContainText("离线录音");
  await page.reload();
  await expect(inbox).toContainText("recording-");
  await expect(page.getByRole("textbox", { name: "录入材料", exact: true })).toHaveValue("");
  await context.setOffline(false);
});
