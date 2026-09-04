import { defineConfig, devices } from "@playwright/test";

const host = "127.0.0.1";
const port = Number(process.env.PLAYWRIGHT_PORT ?? 4173);
const publicBaseURL = process.env.PLAYWRIGHT_BASE_URL?.trim();
const baseURL = publicBaseURL || `http://${host}:${port}`;

export default defineConfig({
  testDir: "./e2e",
  outputDir: "test-results/playwright",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : 2,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  expect: { timeout: 10_000 },
  timeout: 45_000,
  use: {
    ...devices["Desktop Chrome"],
    baseURL,
    channel: process.env.PLAYWRIGHT_CHANNEL ?? "chrome",
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: publicBaseURL
    ? undefined
    : {
        command: `npm run dev -- --host ${host} --port ${port}`,
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
});
