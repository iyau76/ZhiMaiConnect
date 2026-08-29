import { expect, openApp, readIndexedDbStore, seedIndexedDb, test } from "./fixtures";

const NOW = new Date("2026-08-29T10:00:00+08:00").getTime();

test("人物档案只保存在当前浏览器上下文，刷新后保留但其它上下文不可见", async ({
  browser,
  page,
}) => {
  await openApp(page);
  await seedIndexedDb(page, {
    persons: [
      {
        id: "private-person",
        name: "仅当前浏览器可见",
        note: "隔离测试",
        profile: {},
        descriptors: [],
        thumb: "",
        createdAt: NOW,
      },
    ],
  });

  await page.reload();
  await expect(page.locator('[data-app-hydrated="true"]')).toBeVisible();
  expect(await readIndexedDbStore<{ id: string }>(page, "persons")).toEqual([
    expect.objectContaining({ id: "private-person" }),
  ]);

  const isolatedContext = await browser.newContext();
  await isolatedContext.addInitScript(() => {
    localStorage.setItem("openglass.welcomeSeen", "1");
    localStorage.setItem("openglass.lang", "zh");
  });
  const isolatedPage = await isolatedContext.newPage();
  const origin = new URL(page.url()).origin;
  await isolatedPage.goto(origin);
  await expect(isolatedPage.locator('[data-app-hydrated="true"]')).toBeVisible();
  expect(await readIndexedDbStore(isolatedPage, "persons")).toEqual([]);
  await isolatedContext.close();
});
