import { expect, openApp, test } from "./fixtures";

test("复杂关系测试集可以填入录入框", async ({ page }) => {
  await openApp(page, { initialView: "intake" });

  const picker = page.getByLabel("选择测试材料");
  await expect(picker.locator("option")).toHaveCount(10);
  await picker.selectOption("harry-potter");
  await page.getByRole("button", { name: "填入录入框" }).click();

  await expect(page.getByLabel("录入材料")).toHaveValue(/老汤姆·里德尔/);
  await expect(page.getByLabel("录入材料")).toHaveValue(/小汤姆·马沃罗·里德尔/);
  await expect(page.getByText(/可试问/)).toBeVisible();
});
