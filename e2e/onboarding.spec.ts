import { expect, readIndexedDbStore, test } from "./fixtures";

test("首次进入可在演示库、粘贴材料和空库之间选择，并载入独立场景包", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator('[data-app-hydrated="true"]')).toBeVisible({ timeout: 30_000 });
  await page.evaluate(() => localStorage.removeItem("openglass.welcomeSeen"));
  await page.reload();
  await expect(page.locator('[data-app-hydrated="true"]')).toBeVisible({ timeout: 30_000 });

  await expect(page.getByRole("button", { name: /载入演示库/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /粘贴一段材料/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /从空库开始/ })).toBeVisible();

  await page.getByRole("button", { name: /载入演示库/ }).click();
  await expect(page.getByRole("button", { name: /校园生活/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /家庭往来/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /职场协作/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /小企业协作/ })).toBeVisible();

  await page.getByRole("button", { name: /家庭往来/ }).click();
  await expect(page.getByRole("heading", { name: /今天先看/ })).toBeVisible();
  await expect
    .poll(async () => (await readIndexedDbStore<{ name: string }>(page, "persons")).length)
    .toBe(10);
  const names = (await readIndexedDbStore<{ name: string }>(page, "persons")).map(
    (person) => person.name,
  );
  expect(names).toContain("苏琴");
  expect(names).not.toContain("唐悦");
  expect(await readIndexedDbStore(page, "relationAssertions")).toHaveLength(12);
});
