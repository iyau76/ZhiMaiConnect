import { clickVisible, expect, openApp, seedIndexedDb, test } from "./fixtures";

const NOW = new Date("2026-08-29T10:00:00+08:00").getTime();

test("503 后可从中断轮次继续，并保留已完成的档案工具结果", async ({ page }) => {
  await openApp(page);
  await seedIndexedDb(page, {
    persons: [
      {
        id: "resume-person",
        name: "唐悦",
        note: "摄影社搭档",
        profile: { likes: ["人像摄影"], title: "摄影师" },
        descriptors: [],
        thumb: "",
        createdAt: NOW,
      },
    ],
  });
  await page.reload();
  await expect(page.locator('[data-app-hydrated="true"]')).toBeVisible();

  const prompts: string[] = [];
  let chatCalls = 0;
  await page.route("**/api/vision", async (route) => {
    const body = route.request().postDataJSON() as { action?: string; prompt?: string };
    if (body.action !== "chat") {
      await route.fallback();
      return;
    }
    chatCalls += 1;
    prompts.push(body.prompt ?? "");
    if (chatCalls === 1) {
      await route.fulfill({
        status: 200,
        contentType: "text/plain; charset=utf-8",
        body: JSON.stringify({
          type: "tool",
          summary: "先读取唐悦的完整档案",
          tool: "get_profiles",
          args: { personIds: ["resume-person"] },
        }),
      });
      return;
    }
    if (chatCalls <= 4) {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: "模拟上游暂时不可用",
          code: "UPSTREAM_UNAVAILABLE",
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "text/plain; charset=utf-8",
      body: JSON.stringify({
        type: "final",
        summary: "已从中断轮次继续，并复用此前档案结果",
        answer: "唐悦喜欢人像摄影；本次恢复没有重新读取档案。",
        claims: [{ kind: "fact", sourceRef: "person:resume-person", field: "profile.likes" }],
      }),
    });
  });

  await clickVisible(page, page.getByRole("button", { name: /^智能体/ }));
  const assistant = page.getByText("问答智能体", { exact: true }).locator("..").locator("..");
  await assistant.getByRole("textbox").fill("唐悦喜欢什么？请先查档案再回答。");
  await assistant.getByRole("button", { name: "发送问题" }).click();

  await expect(assistant).toContainText("上游模型连续 3 次暂时不可用", { timeout: 30_000 });
  await expect(assistant).toContainText("已保留前 1 轮和 1 条工具结果");
  const resume = assistant.getByRole("button", { name: "从第 2 轮继续" });
  await expect(resume).toBeVisible();
  await resume.click();

  await expect(assistant).toContainText("唐悦喜欢人像摄影", { timeout: 30_000 });
  await expect(resume).toHaveCount(0);
  expect(chatCalls).toBe(5);
  expect(prompts[0]).not.toContain('"tool":"get_profiles"');
  expect(prompts[4]).toContain('"tool":"get_profiles"');
  expect(prompts[4]).toContain("人像摄影");
});
