/* global indexedDB, window, localStorage, sessionStorage */
import { _electron as electron, expect } from "@playwright/test";
import { resolve } from "node:path";
import { mkdir, readFile } from "node:fs/promises";
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const output = resolve("test-results/native-verification");
await mkdir(output, { recursive: true });
const profile = resolve(output, "desktop-profile");
const executablePath =
  process.env.ZHIMAI_DESKTOP_EXE || resolve("node_modules/electron/dist/electron.exe");
const args = process.env.ZHIMAI_DESKTOP_EXE ? [] : ["desktop"];
const launch = () =>
  electron.launch({ executablePath, args: [...args, "--user-data-dir=" + profile], env });
let app = await launch();
try {
  const page = await app.firstWindow();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await expect(page.locator('[data-app-hydrated="true"]')).toBeVisible({ timeout: 20000 });
  const welcome = page.getByRole("button", { name: /载入演示库/ });
  if (await welcome.isVisible()) {
    await welcome.click();
    await page.getByRole("button", { name: /家庭往来/ }).click();
  }
  const personCount = () =>
    page.evaluate(
      () =>
        new Promise((resolve, reject) => {
          const request = indexedDB.open("openglass-faces");
          request.onsuccess = () => {
            const db = request.result;
            const query = db.transaction("persons").objectStore("persons").count();
            query.onsuccess = () => {
              db.close();
              resolve(query.result);
            };
            query.onerror = () => reject(query.error);
          };
        }),
    );
  await expect.poll(personCount).toBe(10);
  await page.context().setOffline(true);
  await page.reload();
  await expect(page.locator('[data-app-hydrated="true"]')).toBeVisible();
  expect(await personCount()).toBe(10);
  await page.context().setOffline(false);
  console.log("PASS bundled offline launch + 10 synthetic records");
  await app.evaluate(
    ({ dialog }, file) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
    },
    resolve(output, "sample-backup.json"),
  );
  await page.evaluate(() =>
    window.zhimaiNative.saveFile({
      name: "sample-backup.json",
      mime: "application/json",
      data: btoa('{"synthetic":true}'),
    }),
  );
  expect(JSON.parse(await readFile(resolve(output, "sample-backup.json"), "utf8"))).toEqual({
    synthetic: true,
  });
  await app.evaluate(
    ({ dialog }, file) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
    },
    resolve(output, "sample-print.pdf"),
  );
  await page.evaluate(() =>
    window.zhimaiNative.printHtml({
      name: "合成导出测试",
      html: '<html><meta charset="utf-8"><h1>知脉合成测试</h1></html>',
    }),
  );
  expect((await readFile(resolve(output, "sample-print.pdf"))).subarray(0, 4).toString()).toBe(
    "%PDF",
  );
  console.log("PASS native save + PDF export");
  if (process.env.NATIVE_LIVE_TEST === "1") {
    const config = {
      key: process.env.DEEPSEEK_API_KEY,
      model: process.env.DEEPSEEK_MODEL,
      base: process.env.DEEPSEEK_BASE_URL,
    };
    if (!config.key || !config.model || !config.base) throw new Error("Missing test credentials");
    await page.goto("zhimai://app/?view=models");
    await expect(page.locator('[data-testid="model-config-panel"]')).toBeVisible();
    const panel = page.locator('[data-testid="model-config-panel"]');
    try {
      await panel.locator('input[type="password"]').fill(config.key);
      const fields = panel.locator('input:not([type="password"])');
      await fields.nth(1).fill(config.model);
      await fields.nth(2).fill(config.base);
      await panel.getByRole("button", { name: "测试连接", exact: true }).click();
      await expect(page.getByText(/连接正常/).first()).toBeVisible({ timeout: 60000 });
    } finally {
      await panel.locator('input[type="password"]').fill("");
      await page.evaluate(() => {
        sessionStorage.removeItem("openglass.session-api-keys");
        localStorage.removeItem("openglass.saved-api-keys");
      });
    }
    console.log("PASS real provider via native UI connection test");
  }
  await page.screenshot({ path: resolve(output, "desktop-tested.png") });
  expect(errors).toEqual([]);
  await app.close();
  app = await launch();
  const reopened = await app.firstWindow();
  await expect(reopened.locator('[data-app-hydrated="true"]')).toBeVisible();
  const count = await reopened.evaluate(
    () =>
      new Promise((resolve) => {
        const open = indexedDB.open("openglass-faces");
        open.onsuccess = () => {
          const db = open.result;
          const count = db.transaction("persons").objectStore("persons").count();
          count.onsuccess = () => {
            db.close();
            resolve(count.result);
          };
        };
      }),
  );
  expect(count).toBe(10);
  console.log("PASS process restart persistence");
} finally {
  await app.close();
}
