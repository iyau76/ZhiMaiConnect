import { expect, openApp, readIndexedDbStore, test } from "./fixtures";

test("手工事件可以只精确到月份", async ({ page }) => {
  await openApp(page);
  await page.getByRole("button", { name: /^日历/ }).click();

  const editor = page.locator("[data-event-editor]");
  await editor.getByRole("button", { name: "只记得某月" }).click();
  const month = editor.getByLabel("事件月份");
  await expect(month).toHaveAttribute("type", "month");
  await month.fill("2026-08");
  await editor.locator("textarea").first().fill("只记得月份的事件");
  await editor.getByRole("button", { name: "记下来" }).click();

  const events = await readIndexedDbStore<{
    title: string;
    date: string;
    precision?: string;
  }>(page, "lifeEvents");
  expect(events).toContainEqual(
    expect.objectContaining({
      title: "只记得月份的事件",
      date: "2026-08-01",
      precision: "month",
    }),
  );
});
