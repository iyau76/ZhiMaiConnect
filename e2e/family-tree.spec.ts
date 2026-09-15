import { expect, openApp, seedIndexedDb, test } from "./fixtures";

test("纯亲属关系自动按家族树展示", async ({ page }) => {
  await openApp(page);
  await seedIndexedDb(page, {
    persons: [
      {
        id: "grandfather",
        name: "祖父",
        note: "",
        descriptors: [],
        thumb: "",
        createdAt: 6,
      },
      {
        id: "grandmother",
        name: "祖母",
        note: "",
        descriptors: [],
        thumb: "",
        createdAt: 5,
      },
      {
        id: "father",
        name: "父亲",
        note: "",
        descriptors: [],
        thumb: "",
        createdAt: 4,
      },
      {
        id: "mother",
        name: "母亲",
        note: "",
        descriptors: [],
        thumb: "",
        createdAt: 3,
      },
      {
        id: "child",
        name: "孩子",
        note: "",
        descriptors: [],
        thumb: "",
        createdAt: 2,
      },
    ],
    relations: [
      {
        id: "grandfather-father",
        fromId: "grandfather",
        toId: "father",
        predicate: "parent_of",
        label: "父子",
        createdAt: 5,
      },
      {
        id: "grandmother-father",
        fromId: "grandmother",
        toId: "father",
        predicate: "parent_of",
        label: "母子",
        createdAt: 4,
      },
      {
        id: "parents",
        fromId: "father",
        toId: "mother",
        predicate: "spouse_of",
        label: "夫妻",
        createdAt: 3,
      },
      {
        id: "parent-child",
        fromId: "father",
        toId: "child",
        predicate: "parent_of",
        label: "父子",
        createdAt: 2,
      },
    ],
  });

  const people = page.getByRole("button", { name: /^人物/ });
  if (await people.count()) await people.first().click();
  await page.getByRole("tab", { name: "关系网" }).click();
  await page.getByLabel("关系类别筛选").selectOption("family");

  await expect(page.locator('[data-relation-graph-frame="true"]')).toHaveAttribute(
    "data-graph-layout",
    "family",
  );
  await expect(page.getByText("家族树按世代排列；配偶同层，子女位于父母下一层。")).toBeVisible();

  const father = await page.locator('[data-person-id="father"]').boundingBox();
  const child = await page.locator('[data-person-id="child"]').boundingBox();
  expect(father).not.toBeNull();
  expect(child).not.toBeNull();
  expect(child!.y).toBeGreaterThan(father!.y);
});
