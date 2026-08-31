import { clickVisible, expect, openApp, test } from "./fixtures";

for (const width of [390, 768, 1440]) {
  test(`${width}px 下六项核心操作可完成且页面无整体横向溢出`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await openApp(page);

    await page.getByRole("button", { name: "离线演示草稿" }).click();
    await expect(page.getByRole("button", { name: "确认入库" })).toBeVisible();
    await page.getByRole("button", { name: "清除本地录入材料" }).click();
    await expect(page.getByRole("button", { name: "确认入库" })).toHaveCount(0);

    await clickVisible(page, page.getByRole("button", { name: /^设置/ }));
    await page.getByRole("button", { name: "一键载入/重置合成数据" }).click();
    await expect(page.getByText("当前已载入：50 人 · 80 条关系")).toBeVisible();

    await clickVisible(page, page.getByRole("button", { name: /^人物关系/ }));
    await page.getByRole("tab", { name: "关系网" }).click();
    const graph = page.locator("svg").filter({ has: page.locator("#relation-arrow") });
    await graph
      .getByRole("button", { name: /单击聚焦/ })
      .first()
      .click();
    await expect(page.getByRole("button", { name: "打开人物卡" })).toBeVisible();

    await clickVisible(page, page.getByRole("button", { name: /^提醒/ }));
    await page.getByRole("button", { name: "离线演示问题（合成数据）" }).click();
    const recommendation = page.getByRole("heading", { name: "这事该拜托谁" }).locator("..");
    await expect(recommendation.getByRole("textbox")).toHaveValue(
      "我要组织校园记忆展开幕活动，找谁负责拍照比较合适？",
    );
    const candidates = recommendation.locator("ol > li");
    await expect(candidates).toHaveCount(3);
    const candidateList = recommendation.locator("ol");
    await expect(candidateList).toContainText("唐悦");
    await expect(candidateList).toContainText("秦月");
    await expect(candidateList).toContainText("叶青");

    await clickVisible(page, page.getByRole("button", { name: /^日历/ }));
    const eventTitle = `响应式冒烟 ${width}px`;
    await page
      .getByPlaceholder("发生了什么？例如：和小雨吃火锅，聊到她想换工作，答应帮她看简历")
      .fill(eventTitle);
    await page.getByRole("button", { name: "记下来" }).click();
    await expect(page.getByText(eventTitle, { exact: true }).first()).toBeVisible();

    await clickVisible(page, page.getByRole("button", { name: /^AI 助理/ }));
    await expect(page.getByText("模型配置", { exact: true })).toBeVisible();
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
