import { expect, openApp, seedIndexedDb, test } from "./fixtures";
import type { Page } from "@playwright/test";

/**
 * 关系网有两条显示链路：原版（组合簇 + 环套环，默认）和新版（多重成员包络 + 紧凑布局，测试中）。
 * 这里只钉住「默认走原版」「切到新版后圈层不再裂成组合簇」「选择会被记住」三件事。
 */
async function openCircleGraph(page: Page) {
  await openApp(page);
  await seedIndexedDb(page, {
    persons: [
      { id: "alice", name: "合成甲", note: "", descriptors: [], thumb: "", createdAt: 3 },
      { id: "bob", name: "合成乙", note: "", descriptors: [], thumb: "", createdAt: 2 },
      { id: "carol", name: "合成丙", note: "", descriptors: [], thumb: "", createdAt: 1 },
    ],
    relations: [{ id: "alice-bob", fromId: "alice", toId: "bob", label: "同事", createdAt: 1 }],
    collections: [
      { id: "c-work", name: "项目组", kind: "relationship_circle", createdAt: 1, updatedAt: 1 },
      { id: "c-school", name: "同学", kind: "relationship_circle", createdAt: 1, updatedAt: 1 },
    ],
    collectionMemberships: [
      {
        id: "c-work:alice",
        collectionId: "c-work",
        personId: "alice",
        source: "manual",
        createdAt: 1,
      },
      { id: "c-work:bob", collectionId: "c-work", personId: "bob", source: "manual", createdAt: 1 },
      {
        id: "c-school:alice",
        collectionId: "c-school",
        personId: "alice",
        source: "manual",
        createdAt: 1,
      },
      {
        id: "c-school:carol",
        collectionId: "c-school",
        personId: "carol",
        source: "manual",
        createdAt: 1,
      },
    ],
  });
  const people = page.getByRole("button", { name: /^人物关系/ });
  for (const candidate of await people.all()) {
    if (await candidate.isVisible()) {
      await candidate.click();
      break;
    }
  }
  await page.getByRole("tab", { name: "关系网" }).click();
  await expect(page.locator("[data-relation-graph-frame]")).toBeVisible();
}

test("关系网默认走原版布局，新版作为测试开关可选", async ({ page }) => {
  await openCircleGraph(page);

  const legacyButton = page.getByRole("button", { name: "原版" });
  const compactButton = page.getByRole("button", { name: "新版（测试）" });
  await expect(legacyButton).toHaveAttribute("aria-pressed", "true");
  await expect(compactButton).toHaveAttribute("aria-pressed", "false");

  // 原版：三个人分属三个「成员组合」簇（{项目组}、{同学}、{项目组+同学}）
  await expect(page.locator("[data-graph-group]")).toHaveCount(3);
  // 圈层图例仍是组合簇的标签（组合名按圈层名排序）
  const legend = page.getByLabel(/圈层图例|拓扑社区图例/);
  await expect(legend.getByText(/同学 \/ 项目组|项目组 \/ 同学/)).toBeVisible();

  await compactButton.click();
  await expect(compactButton).toHaveAttribute("aria-pressed", "true");
  await expect(legacyButton).toHaveAttribute("aria-pressed", "false");
  // 新版：一个人可以有多个圈层，但圈层不再裂成组合簇
  await expect(page.locator("[data-graph-group]")).toHaveCount(2);
  await expect(legend.getByRole("button", { name: "只看圈层：项目组" })).toBeVisible();
  await expect(legend.getByRole("button", { name: "只看圈层：同学" })).toBeVisible();
  // 三个人的节点一个不多一个不少
  await expect(page.locator("[data-person-id]")).toHaveCount(3);

  await page.reload();
  await page.waitForSelector('[data-app-hydrated="true"]', { timeout: 30_000 });
  await openCircleGraphFromNavigation(page);
  await expect(page.getByRole("button", { name: "新版（测试）" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

async function openCircleGraphFromNavigation(page: Page) {
  const people = page.getByRole("button", { name: /^人物关系/ });
  for (const candidate of await people.all()) {
    if (await candidate.isVisible()) {
      await candidate.click();
      break;
    }
  }
  await page.getByRole("tab", { name: "关系网" }).click();
  await expect(page.locator("[data-relation-graph-frame]")).toBeVisible();
}
