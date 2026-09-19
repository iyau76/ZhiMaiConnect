import { expect, openApp, test } from "./fixtures";

test("AI 推断关系会自动展开并显示核验入口", async ({ page }) => {
  await openApp(page, { initialView: "intake" });
  await page.evaluate(() => {
    localStorage.setItem(
      "zhimai.intake.draft.v1",
      JSON.stringify({
        raw: "王夫人是王熙凤的姑母。",
        supplement: "",
        draft: {
          summary: "AI 推断关系测试",
          people: [
            { name: "王夫人", _draftId: "draft:person:wang-furen" },
            { name: "王熙凤", _draftId: "draft:person:wang-xifeng" },
          ],
          relations: [
            {
              from: "王夫人",
              to: "王熙凤",
              label: "姑母",
              basis: "推断依据：由家族辈分关系推得",
              _draftId: "draft:relation:aunt",
            },
          ],
        },
        attached: [],
        at: Date.now(),
      }),
    );
  });
  await page.reload();

  await expect(page.getByTestId("intake-relation-review-alert")).toBeVisible();
  const relationFold = page
    .locator("[data-review-fold]")
    .filter({ has: page.getByText("新关系", { exact: true }) });
  await expect(relationFold).toHaveAttribute("data-review-attention", "true");
  await expect(relationFold.getByRole("button", { name: "展开或收起：新关系" })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await expect(relationFold.getByText("AI 推断，待核验")).toBeVisible();
});
