import { expect, openApp, seedIntakeDraft, test } from "./fixtures";

test("AI 推断关系会自动展开并显示核验入口", async ({ page }) => {
  await openApp(page, { initialView: "intake" });
  // 空白页面在卸载时会把本机草稿清掉（清理逻辑只看当前内存状态），所以用夹具在每次加载前
  // 写好草稿，走的仍然是「切页返回」那条恢复路径。
  await seedIntakeDraft(page, {
    raw: "王夫人是王熙凤的姑母。",
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
  });

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
