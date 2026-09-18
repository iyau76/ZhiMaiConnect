import { clickVisible, expect, openApp, test } from "./fixtures";

test("从设置载入生活场景后，已打开的人物关系页无需刷新即可看到新数据", async ({ page }) => {
  await openApp(page);

  // 先打开人物关系，让面板进入常驻挂载状态（此时是空库）。
  await clickVisible(page, page.getByRole("button", { name: /^人物关系/ }));
  await clickVisible(page, page.getByRole("button", { name: /^设置/ }));
  await page.getByRole("button", { name: "校园生活" }).click();
  await expect(page.getByText(/已载入 22 位合成人物/)).toBeVisible({ timeout: 30_000 });

  // 回到人物关系：常驻面板应在激活时重新取数，而不是等整页刷新。
  await clickVisible(page, page.getByRole("button", { name: /^人物关系/ }));
  await expect(page.getByText("唐悦").first()).toBeVisible({ timeout: 15_000 });
});

test("世界剧场可以从设置页载入并出现在关系图中", async ({ page }) => {
  await openApp(page);

  await clickVisible(page, page.getByRole("button", { name: /^人物关系/ }));
  await clickVisible(page, page.getByRole("button", { name: /^设置/ }));
  await page.getByRole("button", { name: "红楼梦" }).click();
  await expect(page.getByText(/已载入 35 位合成人物/)).toBeVisible({ timeout: 30_000 });

  await clickVisible(page, page.getByRole("button", { name: /^人物关系/ }));
  await expect(page.getByText("贾宝玉").first()).toBeVisible({ timeout: 15_000 });
});
