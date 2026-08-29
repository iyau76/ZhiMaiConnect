import { readFile } from "node:fs/promises";

import { clickVisible, expect, openApp, readIndexedDbStore, seedIndexedDb, test } from "./fixtures";

const NOW = new Date("2026-08-29T10:00:00+08:00").getTime();

async function openPeopleArchive(page: Parameters<typeof openApp>[0]) {
  await clickVisible(page, page.getByRole("button", { name: /^人物关系/ }));
  await expect(page.getByRole("heading", { name: "人物档案" })).toBeVisible();
}

async function downloadExport(page: Parameters<typeof openApp>[0], optionName: string) {
  await page.getByRole("button", { name: "导出" }).click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: optionName }).click();
  return downloadPromise;
}

test("人物档案可导出完整 JSON、Markdown 和 Word 文件", async ({ page }) => {
  await openApp(page);
  await seedIndexedDb(page, {
    persons: [
      {
        id: "archive-person",
        name: "导出测试人物",
        note: "用于验证多格式导出",
        profile: { title: "测试工程师", circle: "同事" },
        descriptors: [],
        thumb: "",
        createdAt: NOW,
      },
    ],
    lifeEvents: [
      {
        id: "archive-event",
        title: "导出测试事件",
        date: "2026-08-29",
        personIds: ["archive-person"],
        createdAt: NOW,
      },
    ],
    reminders: [
      {
        id: "archive-reminder",
        title: "导出测试待办",
        due: "2026-08-30",
        personIds: ["archive-person"],
        kind: "custom",
        done: false,
        createdAt: NOW,
      },
    ],
  });
  await openPeopleArchive(page);

  const jsonDownload = await downloadExport(page, "完整备份 (.json)");
  const jsonPath = await jsonDownload.path();
  expect(jsonPath).toBeTruthy();
  const archive = JSON.parse(await readFile(jsonPath!, "utf8")) as {
    schema?: string;
    records?: { persons?: Array<{ name?: string }>; lifeEvents?: unknown[]; reminders?: unknown[] };
  };
  expect(archive.schema).toBe("zhimai-connect/archive@2");
  expect(archive.records?.persons).toEqual([expect.objectContaining({ name: "导出测试人物" })]);
  expect(archive.records?.lifeEvents).toHaveLength(1);
  expect(archive.records?.reminders).toHaveLength(1);

  const markdownDownload = await downloadExport(page, "Markdown (.md)");
  const markdownPath = await markdownDownload.path();
  expect(markdownPath).toBeTruthy();
  expect(await readFile(markdownPath!, "utf8")).toContain("导出测试人物");

  const wordDownload = await downloadExport(page, "Word (.docx)");
  const wordPath = await wordDownload.path();
  expect(wordPath).toBeTruthy();
  const wordBytes = await readFile(wordPath!);
  expect(wordBytes.subarray(0, 2).toString("ascii")).toBe("PK");
  expect(wordBytes.byteLength).toBeGreaterThan(1_000);

  await page.getByRole("button", { name: "导出" }).click();
  const popupPromise = page.waitForEvent("popup");
  await page.getByRole("menuitem", { name: /PDF/ }).click();
  const printPreview = await popupPromise;
  await printPreview.waitForLoadState("domcontentloaded");
  await expect(printPreview.locator("body")).toContainText("导出测试人物");
  await printPreview.close();
});

test("完整备份恢复会替换当前库，损坏文件不会改变已有数据", async ({ page }) => {
  await openApp(page);
  await seedIndexedDb(page, {
    persons: [
      {
        id: "backup-person",
        name: "备份中的人物",
        note: "恢复后应保留",
        profile: {},
        descriptors: [],
        thumb: "",
        createdAt: NOW,
      },
    ],
  });
  await openPeopleArchive(page);

  const backupDownload = await downloadExport(page, "完整备份 (.json)");
  const backupPath = await backupDownload.path();
  expect(backupPath).toBeTruthy();
  const backupBytes = await readFile(backupPath!);

  const restoreInput = page.locator('input[accept="application/json,.json"]');
  await restoreInput.setInputFiles({
    name: "broken.json",
    mimeType: "application/json",
    buffer: Buffer.from('{"schema":'),
  });
  await expect(page.getByLabel("Notifications alt+T")).toContainText(/JSON|解析|格式/);
  expect(await readIndexedDbStore<{ id: string }>(page, "persons")).toEqual([
    expect.objectContaining({ id: "backup-person" }),
  ]);

  await seedIndexedDb(page, {
    persons: [
      {
        id: "post-backup-person",
        name: "备份后新增人物",
        note: "恢复后应消失",
        profile: {},
        descriptors: [],
        thumb: "",
        createdAt: NOW + 1,
      },
    ],
  });
  expect(await readIndexedDbStore(page, "persons")).toHaveLength(2);

  await restoreInput.setInputFiles({
    name: "complete-backup.json",
    mimeType: "application/json",
    buffer: backupBytes,
  });
  await page.waitForLoadState("domcontentloaded");
  await expect(page.locator('[data-app-hydrated="true"]')).toBeVisible();
  await expect
    .poll(async () => readIndexedDbStore<{ id: string }>(page, "persons"))
    .toEqual([expect.objectContaining({ id: "backup-person" })]);
});
