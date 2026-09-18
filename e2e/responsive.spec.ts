import {
  clearToasts,
  clickVisible,
  expect,
  openApp,
  openAskForHelp,
  seedIntakeDraft,
  test,
} from "./fixtures";

for (const width of [390, 768, 1440]) {
  test(`${width}px 下七项核心操作可完成且页面无整体横向溢出`, async ({ page }) => {
    // 七项操作串成一条冒烟链路，窄屏上逐屏点击本来就慢，45 秒默认预算不够。
    test.setTimeout(90_000);
    await page.setViewportSize({ width, height: 900 });
    await openApp(page);

    await seedIntakeDraft(page);
    await expect(page.getByRole("button", { name: "确认入库" })).toBeVisible();
    await page.getByRole("button", { name: "清除本地录入材料" }).click();
    await expect(page.getByRole("button", { name: "确认入库" })).toHaveCount(0);

    if (width < 768) {
      await clearToasts(page);
      await page.getByRole("button", { name: "更多", exact: true }).click();
    }
    await clickVisible(page, page.getByRole("button", { name: /^设置/ }));
    await page.getByRole("button", { name: "载入完整 51 人演示库" }).click();
    await expect(page.getByText("当前已载入：51 人 · 91 条关系")).toBeVisible();

    await clickVisible(page, page.getByRole("button", { name: /^人物关系/ }));
    await page.getByRole("tab", { name: "关系网" }).click();
    const graph = page.locator("svg").filter({ has: page.locator("#relation-arrow") });
    await graph
      .getByRole("button", { name: /单击聚焦/ })
      .first()
      .click();
    await expect(page.getByRole("button", { name: "打开人物卡" })).toBeVisible();

    const recommendation = await openAskForHelp(page);
    await page.getByRole("button", { name: "离线演示问题（合成数据）" }).click();
    await expect(recommendation.getByRole("textbox")).toHaveValue(
      "我要组织校园记忆展开幕活动，找谁负责拍照比较合适？",
    );
    const candidates = recommendation.locator("ol > li");
    await expect(candidates).toHaveCount(3);
    const candidateList = recommendation.locator("ol");
    await expect(candidateList).toContainText("唐悦");
    await expect(candidateList).toContainText("秦月");
    await expect(candidateList).toContainText("叶青");

    if (width < 768) {
      await clearToasts(page);
      await page.getByRole("button", { name: "更多", exact: true }).click();
    }
    await clickVisible(page, page.getByRole("button", { name: /^日历/ }));
    const eventTitle = `响应式冒烟 ${width}px`;
    await page
      .getByPlaceholder("发生了什么？例如：和小雨吃火锅，聊到她想换工作，答应帮她看简历")
      .fill(eventTitle);
    await page.getByRole("button", { name: "记下来" }).click();
    await expect(page.getByText(eventTitle, { exact: true }).first()).toBeVisible();

    if (width < 768) {
      await clearToasts(page);
      await page.getByRole("button", { name: "更多", exact: true }).click();
    }
    await clickVisible(page, page.getByRole("button", { name: /^计划/ }));
    await expect(page.getByTestId("plan-board")).toBeVisible();
    await expect(page.getByPlaceholder("目标，例如：筹备校园记忆展开幕活动")).toBeVisible();

    if (width < 768) {
      await clearToasts(page);
      await page.getByRole("button", { name: "更多", exact: true }).click();
    }
    await clickVisible(page, page.getByRole("button", { name: /^模型配置/ }));
    await expect(page.getByTestId("model-config-panel")).toBeVisible();
    await page.getByRole("button", { name: "测试连接" }).click();
    await expect(page.getByText(/连接正常/)).toBeVisible();

    const overflow = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    expect(overflow.scrollWidth, JSON.stringify(overflow)).toBeLessThanOrEqual(
      overflow.clientWidth + 1,
    );
  });
}
