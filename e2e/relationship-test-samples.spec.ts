import { expect, openApp, test } from "./fixtures";

test("测试材料折叠区可以填入录入框", async ({ page }) => {
  await openApp(page, { initialView: "intake" });

  await page.getByText("还没想好录入什么？试试这些").click();
  const picker = page.getByLabel("选择测试材料");
  await expect(picker.locator("option")).toHaveCount(10);
  await picker.selectOption("harry-potter");
  await page.getByRole("button", { name: "填入录入框" }).click();

  await expect(page.getByLabel("录入材料")).toHaveValue(/老汤姆·里德尔/);
  await expect(page.getByLabel("录入材料")).toHaveValue(/小汤姆·马沃罗·里德尔/);
  await expect(page.getByText(/可试问/)).toBeVisible();
});
