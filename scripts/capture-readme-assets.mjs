import { execFileSync } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = path.join(repositoryRoot, "doc", "assets", "readme");
const videoDir = path.join(outputDir, ".capture");
const baseUrl = process.env.README_CAPTURE_URL ?? "http://127.0.0.1:8091";

await mkdir(videoDir, { recursive: true });

const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL ?? "chrome" });
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  recordVideo: { dir: videoDir, size: { width: 1280, height: 800 } },
});
const page = await context.newPage();
await page.addInitScript(() => {
  globalThis.localStorage.setItem("openglass.welcomeSeen", "1");
  globalThis.localStorage.setItem("openglass.lang", "zh");
  globalThis.localStorage.setItem("openglass.theme", "midnight");
});

const pause = (milliseconds = 900) => page.waitForTimeout(milliseconds);
const dismissGuide = async () => {
  const close = page.getByRole("button", { name: "知道了" });
  if (await close.isVisible()) await close.click();
};
const openNav = async (name) => {
  await page.getByRole("button", { name: new RegExp(`^${name}`) }).click();
  await dismissGuide();
  await pause();
};

await page.goto(baseUrl);
await page.locator('[data-app-hydrated="true"]').waitFor({ state: "visible", timeout: 30_000 });
const capturedVideo = page.video();

await openNav("设置");
await page.getByRole("button", { name: "载入完整 50 人演示库" }).click();
await page.getByText("当前已载入：50 人 · 80 条关系").waitFor({ timeout: 30_000 });

await openNav("今天");
await page.screenshot({ path: path.join(outputDir, "today-workbench.png") });

await openNav("人物关系");
await page.getByRole("tab", { name: "关系网" }).click();
await page.getByRole("button", { name: /^唐悦 ·/ }).waitFor({ state: "visible" });
const relationshipGraph = page.locator("svg").filter({ has: page.locator("#relation-arrow") });
await relationshipGraph.scrollIntoViewIfNeeded();
await pause(1_200);
await page.screenshot({ path: path.join(outputDir, "relationship-map.png") });

await openNav("今天");
await page.getByLabel("输入要见的人").fill("明天要见唐悦");
await page.getByRole("button", { name: "准备简报" }).click();
await page.getByRole("button", { name: "生成并保存" }).click();
await page.getByText("见面前看看：唐悦").waitFor({ state: "visible" });
await pause(1_200);
await page.screenshot({ path: path.join(outputDir, "meeting-brief.png") });

await page.close();
await context.close();
await browser.close();

if (capturedVideo) {
  const videoPath = await capturedVideo.path();
  const gifPath = path.join(outputDir, "three-minute-tour.gif");
  execFileSync(
    "ffmpeg",
    [
      "-y",
      "-i",
      videoPath,
      "-vf",
      "fps=7,scale=880:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5",
      gifPath,
    ],
    { stdio: "inherit" },
  );
  await rm(videoPath, { force: true });
}
