/* global window, localStorage, sessionStorage, document */

import { chromium } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const BASE_URL = process.env.ZHIMAI_LIVE_BASE_URL ?? "http://127.0.0.1:8080";
const API_KEY = process.env.DEEPSEEK_API_KEY;
const API_BASE = process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com/v1";
const MODEL = process.env.DEEPSEEK_MODEL ?? "deepseek-chat";
if (!API_KEY) throw new Error("DEEPSEEK_API_KEY is not available to the UI audit process");

const outputDir = path.resolve("test-results/live-ui-audit");
await mkdir(outputDir, { recursive: true });
const report = {
  startedAt: new Date().toISOString(),
  viewport: { width: 1440, height: 900 },
  baseUrl: BASE_URL,
  observations: [],
  screenshots: [],
};

async function seed(page, records) {
  await page.evaluate(async (input) => {
    const { facesDb } = await import("/src/lib/face-db.ts");
    await facesDb.putBatch({
      persons: input.persons ?? [],
      relations: input.relations ?? [],
      lifeEvents: input.lifeEvents ?? [],
      reminders: input.reminders ?? [],
    });
  }, records);
}

async function navigate(page, name) {
  await page
    .getByRole("button", { name: new RegExp(`^${name}`) })
    .first()
    .click();
}

async function screenshot(page, name) {
  const target = path.join(outputDir, name);
  await page.screenshot({ path: target, fullPage: false, animations: "disabled" });
  report.screenshots.push(target);
}

async function metrics(page, locator, label) {
  const result = await locator.evaluate((element, requestedLabel) => {
    const visible = (node) => {
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return (
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        rect.width > 0 &&
        rect.height > 0
      );
    };
    const controls = Array.from(
      element.querySelectorAll("button,input,textarea,select,[role='switch']"),
    )
      .filter(visible)
      .map((node) => {
        const rect = node.getBoundingClientRect();
        return {
          tag: node.tagName.toLowerCase(),
          role: node.getAttribute("role"),
          name:
            node.getAttribute("aria-label") ||
            node.textContent?.replace(/\s+/g, " ").trim().slice(0, 80) ||
            node.getAttribute("placeholder") ||
            "",
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          top: Math.round(rect.top),
        };
      });
    const rect = element.getBoundingClientRect();
    return {
      label: requestedLabel,
      region: {
        top: Math.round(rect.top),
        bottom: Math.round(rect.bottom),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        viewportHeights: Number((rect.height / window.innerHeight).toFixed(2)),
      },
      document: {
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        scrollWidth: document.documentElement.scrollWidth,
        scrollHeight: document.documentElement.scrollHeight,
        horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      },
      controlCount: controls.length,
      buttonCount: controls.filter((item) => item.tag === "button").length,
      smallHitTargets: controls.filter((item) => item.width < 32 || item.height < 32),
      controls,
    };
  }, label);
  report.observations.push(result);
  return result;
}

async function askAssistant(page, text) {
  await navigate(page, "AI 助理");
  const card = page.getByText("问一问", { exact: true }).locator("..").locator("..");
  await card.getByRole("textbox").fill(text);
  await card.getByRole("button", { name: "发送问题" }).click();
  await page.waitForFunction(
    () => {
      const proposal = document.querySelector('[aria-label="待批准的批量档案修改"]');
      const send = document.querySelector('button[aria-label="发送问题"]');
      return Boolean(proposal || (send && !send.disabled));
    },
    null,
    { timeout: 300_000 },
  );
  return card;
}

async function runLongIntake(page, text) {
  await navigate(page, "录入");
  const card = page.getByRole("heading", { name: /随手写，AI 来整理/ }).locator("..");
  await card.getByRole("textbox").fill(text);
  await page.getByRole("button", { name: "AI 整理成档案" }).click();
  const confirm = page.getByRole("button", { name: "确认入库" });
  const error = page.locator('[data-sonner-toast][data-type="error"]').first();
  const outcome = await Promise.race([
    confirm.waitFor({ timeout: 360_000 }).then(() => "draft"),
    error.waitFor({ timeout: 360_000 }).then(() => "error"),
  ]);
  if (outcome === "error") throw new Error((await error.textContent())?.trim() || "长草稿生成失败");
}

const browser = await chromium.launch({
  channel: process.env.PLAYWRIGHT_CHANNEL ?? "chrome",
  headless: true,
});
const context = await browser.newContext({ locale: "zh-CN", viewport: report.viewport });
const page = await context.newPage();
page.on("dialog", (dialog) => dialog.accept());
page.on("pageerror", (error) =>
  report.observations.push({ label: "pageerror", error: String(error) }),
);

try {
  await page.addInitScript(
    ({ apiKey, apiBase, model }) => {
      const preset = {
        id: "live-ui-audit",
        name: "DeepSeek UI Audit",
        kind: "openai",
        baseUrl: apiBase,
        model,
        apiKey: "",
      };
      localStorage.setItem("openglass.welcomeSeen", "1");
      localStorage.setItem("openglass.lang", "zh");
      localStorage.setItem("openglass.presets", JSON.stringify([preset]));
      localStorage.setItem("openglass.active", preset.id);
      sessionStorage.setItem("openglass.session-api-keys", JSON.stringify({ [preset.id]: apiKey }));
    },
    { apiKey: API_KEY, apiBase: API_BASE, model: MODEL },
  );
  await page.goto(BASE_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.locator('[data-app-hydrated="true"]').waitFor({ timeout: 60_000 });
  const now = Date.now();
  await seed(page, {
    persons: [
      {
        id: "tang",
        name: "唐悦",
        note: "摄影师",
        profile: {},
        descriptors: [],
        thumb: "",
        createdAt: now,
      },
      {
        id: "zhou",
        name: "周宁",
        note: "品牌设计师",
        profile: {},
        descriptors: [],
        thumb: "",
        createdAt: now,
      },
    ],
    relations: [
      {
        id: "tang-zhou",
        fromId: "tang",
        toId: "zhou",
        label: "同事",
        basis: "原文：两人曾经共事",
        evidenceMode: "explicit",
        confidence: 0.95,
        confirmationStatus: "confirmed",
        createdAt: now,
      },
    ],
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator('[data-app-hydrated="true"]').waitFor();

  try {
    const assistantCard = await askAssistant(page, "把唐悦和周宁的关系改成前同事");
    const proposal = assistantCard.getByRole("region", { name: "待批准的批量档案修改" });
    await proposal.waitFor({ timeout: 30_000 });
    await proposal.scrollIntoViewIfNeeded();
    await metrics(page, proposal, "AI问一问：待签字提案队列");
    await screenshot(page, "01-assistant-proposal-1440x900.png");
    await proposal.getByRole("button", { name: /签字并原子执行/ }).click();
    await proposal.waitFor({ state: "detached", timeout: 30_000 });
    const receipt = assistantCard.getByText(/变更收据 · \d+ 项/).locator("..");
    await receipt.scrollIntoViewIfNeeded();
    await metrics(page, assistantCard, "AI问一问：签字后收据与输入区");
    await screenshot(page, "02-assistant-receipt-1440x900.png");
  } catch (error) {
    report.observations.push({ label: "AI问一问：未形成待签字提案", error: String(error) });
    await screenshot(page, "01-assistant-no-proposal-1440x900.png");
  }

  const complexInput =
    "贾母是荣国府的老太太，有两个儿子：贾赦和贾政。贾政的正妻王夫人，生了元春和贾宝玉；妾赵姨娘生了探春和贾环。贾敏是贾母的女儿，林黛玉是贾敏的女儿。薛姨妈是王夫人的妹妹。薛宝钗和薛蟠是薛姨妈的孩子。王熙凤是王夫人的内侄女，嫁给了贾琏；贾琏是贾赦的儿子。贾珠是王夫人的大儿子，李纨是贾珠的妻子，贾兰是他们的儿子。宁国府的贾珍是贾敬的儿子，惜春是贾珍的妹妹，贾蓉是贾珍的儿子。尤氏是贾珍的妻子，尤二姐、尤三姐是尤氏继母的女儿。";
  try {
    await runLongIntake(page, complexInput);
    const draftCards = page.locator("[data-draft-kind]");
    const draftCount = await draftCards.count();
    const draftMetrics = await metrics(page, page.locator("main").first(), "录入：复杂长草稿");
    draftMetrics.draftCount = draftCount;
    draftMetrics.acceptButtons = await page.getByRole("button", { name: "接受此项" }).count();
    draftMetrics.hasAcceptAll = await page
      .getByRole("button", { name: /一键接受全部待确认/ })
      .isVisible()
      .catch(() => false);
    await draftCards.first().scrollIntoViewIfNeeded();
    await screenshot(page, "03-intake-long-draft-top-1440x900.png");
    await page.getByRole("button", { name: "确认入库" }).scrollIntoViewIfNeeded();
    await screenshot(page, "04-intake-long-draft-confirm-1440x900.png");
  } catch (error) {
    report.observations.push({ label: "录入：复杂长草稿生成失败", error: String(error) });
    await screenshot(page, "03-intake-long-draft-failure-1440x900.png");
  }

  await navigate(page, "提醒");
  const recommendation = page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "这事该拜托谁", exact: true }) })
    .first();
  await recommendation.scrollIntoViewIfNeeded();
  await metrics(page, recommendation, "这事该拜托谁：初始操作区");
  await screenshot(page, "05-recommendation-controls-1440x900.png");
} catch (error) {
  report.observations.push({ label: "audit-failure", error: String(error) });
} finally {
  await context.close();
  await browser.close();
}

report.finishedAt = new Date().toISOString();
await writeFile(
  path.join(outputDir, "report.json"),
  `${JSON.stringify(report, null, 2)}\n`,
  "utf8",
);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
