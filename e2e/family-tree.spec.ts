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
  const mother = await page.locator('[data-person-id="mother"]').boundingBox();
  const child = await page.locator('[data-person-id="child"]').boundingBox();
  expect(father).not.toBeNull();
  expect(mother).not.toBeNull();
  expect(child).not.toBeNull();
  expect(Math.abs(mother!.y - father!.y)).toBeLessThan(1);
  expect(child!.y).toBeGreaterThan(father!.y);
});

test("有向姑母关系在缺少父母链时仍保持正确辈分", async ({ page }) => {
  await openApp(page);
  await seedIndexedDb(page, {
    persons: [
      {
        id: "wang-furen",
        name: "王夫人",
        note: "",
        descriptors: [],
        thumb: "",
        createdAt: 2,
      },
      {
        id: "wang-xifeng",
        name: "王熙凤",
        note: "",
        descriptors: [],
        thumb: "",
        createdAt: 1,
      },
    ],
    relations: [
      {
        id: "aunt",
        fromId: "wang-furen",
        toId: "wang-xifeng",
        predicate: "uncle_aunt_of",
        label: "姑母",
        createdAt: 1,
      },
    ],
  });

  const people = page.getByRole("button", { name: /^人物/ });
  if (await people.count()) await people.first().click();
  await page.getByRole("tab", { name: "关系网" }).click();
  await page.getByLabel("关系类别筛选").selectOption("family");

  const aunt = await page.locator('[data-person-id="wang-furen"]').boundingBox();
  const niece = await page.locator('[data-person-id="wang-xifeng"]').boundingBox();
  expect(aunt).not.toBeNull();
  expect(niece).not.toBeNull();
  expect(niece!.y).toBeGreaterThan(aunt!.y);
});

test("家族筛选不会拆散配偶和姐妹的同辈锚点", async ({ page }) => {
  await openApp(page);
  await seedIndexedDb(page, {
    persons: [
      { id: "jiamu", name: "贾母", note: "", descriptors: [], thumb: "", createdAt: 7 },
      { id: "jiazheng", name: "贾政", note: "", descriptors: [], thumb: "", createdAt: 6 },
      { id: "wang-furen", name: "王夫人", note: "", descriptors: [], thumb: "", createdAt: 5 },
      { id: "zhao-yiniang", name: "赵姨娘", note: "", descriptors: [], thumb: "", createdAt: 4 },
      { id: "xue-yima", name: "薛姨妈", note: "", descriptors: [], thumb: "", createdAt: 3 },
      { id: "jia-min", name: "贾敏", note: "", descriptors: [], thumb: "", createdAt: 2 },
      { id: "lin-ruhai", name: "林如海", note: "", descriptors: [], thumb: "", createdAt: 1 },
    ],
    relations: [
      {
        id: "jiamu-jiazheng",
        fromId: "jiamu",
        toId: "jiazheng",
        predicate: "parent_of",
        label: "母子",
        createdAt: 7,
      },
      {
        id: "jiamu-jiamin",
        fromId: "jiamu",
        toId: "jia-min",
        predicate: "parent_of",
        label: "母女",
        createdAt: 6,
      },
      {
        id: "jiazheng-wang",
        fromId: "jiazheng",
        toId: "wang-furen",
        predicate: "spouse_of",
        label: "夫妻",
        createdAt: 5,
      },
      {
        id: "jiazheng-zhao",
        fromId: "jiazheng",
        toId: "zhao-yiniang",
        predicate: "spouse_of",
        label: "夫妻",
        createdAt: 4,
      },
      {
        id: "wang-xue",
        fromId: "wang-furen",
        toId: "xue-yima",
        predicate: "sibling_of",
        label: "姐妹",
        createdAt: 3,
      },
      {
        id: "jiamin-lin",
        fromId: "jia-min",
        toId: "lin-ruhai",
        predicate: "spouse_of",
        label: "夫妻",
        createdAt: 2,
      },
    ],
  });

  const people = page.getByRole("button", { name: /^人物/ });
  if (await people.count()) await people.first().click();
  await page.getByRole("tab", { name: "关系网" }).click();
  await page.getByLabel("关系类别筛选").selectOption("family");

  const box = async (id: string) => {
    const result = await page.locator(`[data-person-id="${id}"]`).boundingBox();
    expect(result).not.toBeNull();
    return result!;
  };
  const jiazheng = await box("jiazheng");
  const wangFuren = await box("wang-furen");
  const zhaoYiniang = await box("zhao-yiniang");
  const xueYima = await box("xue-yima");
  const jiaMin = await box("jia-min");
  const linRuhai = await box("lin-ruhai");

  expect(Math.abs(wangFuren.y - jiazheng.y)).toBeLessThan(1);
  expect(Math.abs(zhaoYiniang.y - jiazheng.y)).toBeLessThan(1);
  expect(Math.abs(xueYima.y - wangFuren.y)).toBeLessThan(1);
  expect(Math.abs(linRuhai.y - jiaMin.y)).toBeLessThan(1);
  expect(jiazheng.y).toBeGreaterThan((await box("jiamu")).y);
});
