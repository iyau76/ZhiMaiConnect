import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chromium, type BrowserContext } from "@playwright/test";

import { clickVisible, expect, openApp, seedIndexedDb, test } from "./fixtures";

const NOW = new Date("2026-08-29T10:00:00+08:00").getTime();
const DATABASE_PERSON_ID = "resume-person-stable-id";
const ARCHIVE_HANDLE_PATTERN = /ref_[0-9a-f]{32}/;

test("503 后可从中断轮次继续，并保留已完成的档案工具结果", async ({ page }) => {
  await openApp(page);
  await seedIndexedDb(page, {
    persons: [
      {
        id: DATABASE_PERSON_ID,
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
  let agentCalls = 0;
  let personRef = "";
  await page.route("**/api/vision", async (route) => {
    const body = route.request().postDataJSON() as { action?: string; prompt?: string };
    if (body.action !== "agent") {
      await route.fallback();
      return;
    }
    agentCalls += 1;
    prompts.push(body.prompt ?? "");
    if (agentCalls === 1) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          reply: JSON.stringify({
            type: "tool",
            summary: "先把唐悦解析为本次运行的档案引用",
            tool: "resolve_record_refs",
            args: { refs: [{ kind: "person", name: "唐悦" }] },
          }),
        }),
      });
      return;
    }
    if (agentCalls === 2) {
      personRef = body.prompt?.match(ARCHIVE_HANDLE_PATTERN)?.[0] ?? "";
      if (!personRef) throw new Error("resolve_record_refs 没有向下一轮提供 opaque handle");
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          reply: JSON.stringify({
            type: "tool",
            summary: "用本次运行的引用读取唐悦档案",
            tool: "get_profiles",
            args: { personRefs: [personRef] },
          }),
        }),
      });
      return;
    }
    if (agentCalls <= 5) {
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
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        reply: JSON.stringify({
          type: "final",
          summary: "已从中断轮次继续，并复用此前档案结果",
          answer: "唐悦喜欢人像摄影；本次恢复没有重新读取档案。",
        }),
      }),
    });
  });

  await clickVisible(page, page.getByRole("button", { name: /^AI 助理/ }));
  const assistant = page.getByText("问一问", { exact: true }).locator("..").locator("..");
  await assistant.getByRole("textbox").fill("唐悦喜欢什么？请先查档案再回答。");
  await assistant.getByRole("button", { name: "发送问题" }).click();

  await expect(assistant).toContainText("上游模型连续 3 次暂时不可用", { timeout: 30_000 });
  await expect(assistant).toContainText("已保留前 2 轮和 2 条工具结果");
  const resume = assistant.getByRole("button", { name: "从第 3 轮继续" });
  await expect(resume).toBeVisible();
  await page.reload();
  await expect(page.locator('[data-app-hydrated="true"]')).toBeVisible();
  await clickVisible(page, page.getByRole("button", { name: /^AI 助理/ }));
  await expect(resume).toBeVisible();
  await expect(assistant).toContainText("已保留前 2 轮和 2 条工具结果");
  await resume.click();

  await expect(assistant).toContainText("唐悦喜欢人像摄影", { timeout: 30_000 });
  await expect(resume).toHaveCount(0);
  await expect(assistant).toContainText("回答完成 · 3 轮 · 2 次工具调用");

  expect(agentCalls).toBe(6);
  expect(personRef).toMatch(ARCHIVE_HANDLE_PATTERN);
  expect(prompts[0]).not.toContain('"tool":"resolve_record_refs"');
  expect(prompts[1]).toContain('"tool":"resolve_record_refs"');
  expect(prompts[1]).toContain(personRef);
  expect(prompts[5]).toContain('"tool":"resolve_record_refs"');
  expect(prompts[5]).toContain('"tool":"get_profiles"');
  expect(prompts[5]).toContain(personRef);
  expect(prompts[5]).toContain("人像摄影");
  expect(prompts.every((prompt) => !prompt.includes(DATABASE_PERSON_ID))).toBe(true);
});

test("离开问一问页面后运行继续，返回时只恢复同一条账本记录", async ({ page }) => {
  await openApp(page);
  let releaseResponse!: () => void;
  const responseGate = new Promise<void>((resolve) => {
    releaseResponse = resolve;
  });
  let agentCalls = 0;
  await page.route("**/api/vision", async (route) => {
    const body = route.request().postDataJSON() as { action?: string };
    if (body.action !== "agent") {
      await route.fallback();
      return;
    }
    agentCalls += 1;
    await responseGate;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        reply: JSON.stringify({
          type: "final",
          summary: "后台分析已经完成",
          answer: "这条回答来自离开页面前启动的同一次运行。",
        }),
      }),
    });
  });

  await clickVisible(page, page.getByRole("button", { name: /^AI 助理/ }));
  const assistant = page.getByText("问一问", { exact: true }).locator("..").locator("..");
  await assistant.getByRole("textbox").fill("离开页面后继续分析这个问题");
  await assistant.getByRole("button", { name: "发送问题" }).click();
  await expect(assistant).toContainText("模型正在分析第 1 轮");

  await clickVisible(page, page.getByRole("button", { name: /^设置/ }));
  await clickVisible(page, page.getByRole("button", { name: /^AI 助理/ }));
  await expect(assistant).toContainText("离开页面后继续分析这个问题");
  await expect(assistant).toContainText("模型正在分析第 1 轮");
  await expect(assistant.getByRole("button", { name: /从第 .* 轮继续/u })).toHaveCount(0);

  releaseResponse();
  await expect(assistant).toContainText("这条回答来自离开页面前启动的同一次运行", {
    timeout: 15_000,
  });
  expect(agentCalls).toBe(1);
});

test("首轮请求中刷新页面，可从预先保存的第 1 轮断点恢复", async ({ page }) => {
  await openApp(page);
  let releaseAbandonedRequest!: () => void;
  const abandonedRequestGate = new Promise<void>((resolve) => {
    releaseAbandonedRequest = resolve;
  });
  let agentCalls = 0;
  await page.route("**/api/vision", async (route) => {
    const body = route.request().postDataJSON() as { action?: string };
    if (body.action !== "agent") {
      await route.fallback();
      return;
    }
    agentCalls += 1;
    if (agentCalls === 1) {
      await abandonedRequestGate;
      await route.abort("aborted").catch(() => undefined);
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        reply: JSON.stringify({
          type: "final",
          summary: "已从首轮断点恢复",
          answer: "刷新前的问题已经从第 1 轮继续完成。",
        }),
      }),
    });
  });

  await clickVisible(page, page.getByRole("button", { name: /^AI 助理/ }));
  const assistant = page.getByText("问一问", { exact: true }).locator("..").locator("..");
  await assistant.getByRole("textbox").fill("请保存这个尚未返回的问题");
  await assistant.getByRole("button", { name: "发送问题" }).click();
  await expect(assistant).toContainText("模型正在分析第 1 轮");

  await page.reload({ waitUntil: "domcontentloaded" });
  releaseAbandonedRequest();
  await expect(page.locator('[data-app-hydrated="true"]')).toBeVisible();
  await clickVisible(page, page.getByRole("button", { name: /^AI 助理/ }));
  const resume = assistant.getByRole("button", { name: "从第 1 轮继续" });
  await expect(assistant).toContainText("请保存这个尚未返回的问题");
  await expect(resume).toBeVisible();
  await resume.click();

  await expect(assistant).toContainText("刷新前的问题已经从第 1 轮继续完成", {
    timeout: 15_000,
  });
  expect(agentCalls).toBe(2);
});

test("关闭浏览器后从同一档案恢复暂停中的运行", async () => {
  test.setTimeout(75_000);
  const profileDirectory = await mkdtemp(join(tmpdir(), "zhimai-agent-resume-"));
  const baseURL = String(test.info().project.use.baseURL);
  const launch = () =>
    chromium.launchPersistentContext(profileDirectory, {
      baseURL,
      channel: process.env.PLAYWRIGHT_CHANNEL ?? "chrome",
      headless: true,
      locale: "zh-CN",
      timezoneId: "Asia/Shanghai",
    });
  const configureModelSession = (context: BrowserContext) =>
    context.addInitScript(() => {
      sessionStorage.setItem(
        "openglass.cloud-transfer-consents",
        JSON.stringify(["builtin-openai:人物关系上下文|文字内容"]),
      );
      sessionStorage.setItem(
        "openglass.session-api-keys",
        JSON.stringify({ "builtin-openai": "playwright-test-key" }),
      );
      localStorage.setItem("openglass.welcomeSeen", "1");
      localStorage.setItem("openglass.lang", "zh");
    });

  let activeContext: BrowserContext | undefined;
  let agentCalls = 0;
  try {
    activeContext = await launch();
    await configureModelSession(activeContext);
    await activeContext.route("**/api/vision", async (route) => {
      const body = route.request().postDataJSON() as { action?: string };
      if (body.action !== "agent") {
        await route.fallback();
        return;
      }
      agentCalls += 1;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "模拟浏览器关闭前的上游中断" }),
      });
    });
    const firstPage = activeContext.pages()[0] ?? (await activeContext.newPage());
    await openApp(firstPage);
    await clickVisible(firstPage, firstPage.getByRole("button", { name: /^AI 助理/ }));
    const firstAssistant = firstPage
      .getByText("问一问", { exact: true })
      .locator("..")
      .locator("..");
    await firstAssistant.getByRole("textbox").fill("浏览器关闭后继续回答这个问题");
    await firstAssistant.getByRole("button", { name: "发送问题" }).click();
    await expect(firstAssistant).toContainText("上游模型连续 3 次暂时不可用", {
      timeout: 30_000,
    });
    await expect(firstAssistant.getByRole("button", { name: "从第 1 轮继续" })).toBeVisible();

    await activeContext.close();
    activeContext = await launch();
    await configureModelSession(activeContext);
    await activeContext.route("**/api/vision", async (route) => {
      const body = route.request().postDataJSON() as { action?: string };
      if (body.action !== "agent") {
        await route.fallback();
        return;
      }
      agentCalls += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          reply: JSON.stringify({
            type: "final",
            summary: "浏览器重启后恢复完成",
            answer: "这条回答复用了关闭浏览器前保存的运行断点。",
          }),
        }),
      });
    });
    const reopenedPage = activeContext.pages()[0] ?? (await activeContext.newPage());
    await openApp(reopenedPage);
    await clickVisible(reopenedPage, reopenedPage.getByRole("button", { name: /^AI 助理/ }));
    const reopenedAssistant = reopenedPage
      .getByText("问一问", { exact: true })
      .locator("..")
      .locator("..");
    await expect(reopenedAssistant).toContainText("浏览器关闭后继续回答这个问题");
    await reopenedAssistant.getByRole("button", { name: "从第 1 轮继续" }).click();
    await expect(reopenedAssistant).toContainText("这条回答复用了关闭浏览器前保存的运行断点", {
      timeout: 15_000,
    });
    expect(agentCalls).toBe(4);
  } finally {
    await activeContext?.close().catch(() => undefined);
    await rm(profileDirectory, { recursive: true, force: true, maxRetries: 3 });
  }
});
