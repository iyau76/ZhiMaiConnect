import { expect, test } from "./fixtures";

for (const { width, theme } of [
  { width: 390, theme: "violet" },
  { width: 390, theme: "midnight" },
  { width: 1440, theme: "violet" },
  { width: 1440, theme: "midnight" },
]) {
  test(`产品插画 ${width}px ${theme}：欢迎、场景选择和空状态`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    await expect(page.locator('[data-app-hydrated="true"]')).toBeVisible();
    await page.evaluate((themeId) => {
      localStorage.setItem("openglass.theme", themeId);
      localStorage.removeItem("openglass.welcomeSeen");
    }, theme);
    await page.reload();
    const welcome = page.getByTestId("welcome-cover");
    await expect(welcome).toBeVisible();
    await expect(welcome.getByTestId("welcome-art").locator("img").first()).toHaveJSProperty(
      "naturalWidth",
      1280,
    );
    const bounds = await welcome.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(900);
    await page.screenshot({ path: testInfo.outputPath("welcome.png") });

    await welcome.getByRole("button", { name: /载入演示库/ }).click();
    await expect(welcome.getByTestId("welcome-art")).toHaveCount(0);
    for (const scenario of ["campus", "family", "workplace", "small_business"]) {
      const image = welcome.getByTestId(`scenario-art-${scenario}`);
      await image.scrollIntoViewIfNeeded();
      await expect(image).toHaveJSProperty("naturalWidth", 640);
    }
    await welcome.evaluate((element) => element.scrollTo(0, 0));
    await page.screenshot({ path: testInfo.outputPath("scenarios.png") });
    await welcome.getByRole("button", { name: "返回选择" }).click();
    await welcome.getByRole("button", { name: /粘贴一段材料/ }).click();
    await expect(welcome).toHaveCount(0);
    const input = page.getByRole("textbox", { name: "录入材料", exact: true });
    await input.scrollIntoViewIfNeeded();
    await expect(page.getByTestId("intake-empty-art")).toHaveJSProperty("naturalWidth", 400);
    await page.screenshot({ path: testInfo.outputPath("intake.png") });
    const before = await input.boundingBox();
    await input.fill("小雨是我的大学同学。");
    await expect(page.getByTestId("intake-empty-art")).toHaveCount(0);
    const after = await input.boundingBox();
    expect(Math.abs(before!.y - after!.y)).toBeLessThan(2);

    await page.goto("/?view=people");
    await expect(page.getByTestId("people-empty-art")).toBeVisible();
    await expect(page.getByTestId("people-empty-art")).toHaveJSProperty("naturalWidth", 400);
    await page.getByTestId("people-empty-art").scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath("people-empty.png") });
    await page.getByPlaceholder("名字", { exact: true }).fill("美术测试人物");
    await page.getByRole("button", { name: "建档", exact: true }).click();
    await expect(page.getByTestId("people-empty-art")).toHaveCount(0);
    await page.getByPlaceholder("搜索名字、备注、标签…").fill("不存在的人");
    await expect(page.getByText("没有匹配的档案", { exact: true })).toBeVisible();
    await expect(page.getByTestId("people-empty-art")).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
  });
}
