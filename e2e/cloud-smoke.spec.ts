import { acceptAllDraftItems, clickVisible, expect, openApp, test } from "./fixtures";

test.describe("Cloudflare 公开版本", () => {
  test.skip(!process.env.PLAYWRIGHT_BASE_URL, "仅在 PLAYWRIGHT_BASE_URL 指向公开部署时运行");

  test("五条主流程使用同一公开构建完成冒烟", async ({ page }) => {
    test.setTimeout(90_000);
    await openApp(page);

    const intake = page.getByRole("heading", { name: /随手写，AI 来整理/ }).locator("..");
    await intake
      .getByRole("textbox")
      .fill(
        "唐悦是我的大学摄影社搭档，生日 3 月 12 日，微信 tangyue_photo，喜欢人像摄影。2026 年 8 月 29 日和唐悦一起讨论校园记忆展。",
      );
    await page.getByRole("button", { name: "AI 整理成档案" }).click();
    await expect(intake.getByRole("status")).toContainText("整理完成");
    await acceptAllDraftItems(page);
    await page.getByRole("button", { name: "确认入库" }).click();
    await clickVisible(page, page.getByRole("button", { name: /^人物关系/ }));
    await expect(page.getByText("唐悦", { exact: true }).first()).toBeVisible();
    await clickVisible(page, page.getByRole("button", { name: /^录入/ }));
    await page.getByRole("button", { name: "撤销最近一次录入" }).click();

    await clickVisible(page, page.getByRole("button", { name: /^设置/ }));
    await page.getByRole("button", { name: /载入.*(?:50 人|合成数据)/ }).click();
    await expect(page.getByText("当前已载入：50 人 · 80 条关系")).toBeVisible();

    await clickVisible(page, page.getByRole("button", { name: /^录入/ }));
    await intake.getByRole("textbox").fill("请整理当前人物库的全部圈层");
    await page.getByRole("button", { name: "AI 整理成档案" }).click();
    await expect(intake.getByRole("status")).toContainText("整理完成", { timeout: 30_000 });
    const approveCollections = page.getByRole("button", { name: "批准圈层变更" });
    await expect(approveCollections).toBeVisible();
    await approveCollections.click();
    await expect(approveCollections).toHaveCount(0);
    await clickVisible(page, page.getByRole("button", { name: /^人物关系/ }));
    await page.getByRole("tab", { name: "关系网" }).click();
    await expect(page.getByText("校园伙伴", { exact: true }).first()).toBeVisible();

    await clickVisible(page, page.getByRole("button", { name: /^提醒/ }));
    const recommendation = page.getByRole("heading", { name: "这事该拜托谁" }).locator("..");
    await recommendation.getByRole("textbox").fill("帮我看一下租房合同中的违约条款");
    await recommendation.getByRole("button", { name: "本地筛选候选" }).click();
    await expect(recommendation.locator("ol li").first()).toContainText("本地分");
    await recommendation.getByRole("button", { name: "生成比较与话术" }).click();
    await expect(
      recommendation.getByRole("textbox", { name: "可编辑的候选比较与求助话术" }),
    ).not.toHaveValue("");

    await clickVisible(page, page.getByRole("button", { name: /^AI 助理/ }));
    const assistant = page.getByText("问一问", { exact: true }).locator("..").locator("..");
    await assistant.getByRole("textbox").fill("Open-Meteo 现在适合做无密钥天气查询吗？");
    await assistant.getByRole("button", { name: "发送问题" }).click();
    await expect(assistant).toContainText("Open-Meteo 提供无需密钥的天气预报接口");

    await assistant.getByRole("textbox").fill("把唐悦的职位改成影像顾问");
    await assistant.getByRole("button", { name: "发送问题" }).click();
    const approval = assistant.getByRole("region", { name: "待批准的批量档案修改" });
    await expect(approval).toContainText("影像顾问");
    await approval.getByRole("button", { name: /签字并原子执行/ }).click();
    await expect(assistant).toContainText("变更收据 · 1 项");
    await assistant.getByRole("button", { name: "整批撤销" }).click();
    await expect(assistant.getByRole("button", { name: "已撤销" })).toBeVisible();
  });
});
