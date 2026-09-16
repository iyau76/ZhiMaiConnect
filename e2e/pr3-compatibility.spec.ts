import type { Page } from "@playwright/test";
import type { LifeEventRecord } from "../src/lib/face-db";
import { expect, openApp, readIndexedDbStore, seedIndexedDb, test } from "./fixtures";

const legacyEvents: LifeEventRecord[] = [
  { id: "year", date: "2020-01-01", precision: "year", title: "旧年度事件", createdAt: 1 },
  {
    id: "range",
    date: "2026-06-01",
    dateEnd: "2026-08-31",
    precision: "range",
    title: "旧区间事件",
    createdAt: 1,
  },
  {
    id: "relative",
    date: "2021-06-01",
    dateEnd: "2021-08-31",
    precision: "range",
    dateText: "去年夏天",
    title: "旧模糊事件",
    createdAt: 1,
  },
  {
    id: "month",
    date: "2020-03-01",
    precision: "month",
    dateText: "那年开春",
    title: "旧月份事件",
    createdAt: 1,
  },
  { id: "implicit-day", date: "2026-06-03", title: "旧隐式精度事件", createdAt: 1 },
];

async function editEvent(page: Page, event: LifeEventRecord) {
  await openApp(page);
  await seedIndexedDb(page, { lifeEvents: [{ ...event }] });
  await page.getByRole("button", { name: /^日历/ }).click();
  await page.getByRole("button", { name: "时间轴", exact: true }).click();
  await page
    .locator(`[data-event-id="${event.id}"]`)
    .getByRole("button", { name: "编辑事件" })
    .click();
  return page.locator("[data-event-editor]");
}

/** 直接向 IndexedDB 写入修改后的事件，模拟另一个窗口的保存。 */
async function overwriteEventFromOtherWindow(page: Page, event: LifeEventRecord) {
  await page.evaluate(
    async (record) => {
      const relationshipModule = await import("/src/lib/face-db.ts");
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("openglass-faces", relationshipModule.FACE_DB_VERSION);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("lifeEvents", "readwrite");
        tx.objectStore("lifeEvents").put(record);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    },
    event as unknown as never,
  );
}

for (const event of legacyEvents) {
  test(`只改标题完整保留日期字段：${event.id}`, async ({ page }) => {
    const editor = await editEvent(page, event);
    await editor.locator("textarea").first().fill("只改了标题");
    await editor.getByRole("button", { name: /^保存/ }).click();
    await expect(editor.getByRole("button", { name: "记下来" })).toBeVisible();
    const [stored] = await readIndexedDbStore<LifeEventRecord>(page, "lifeEvents");
    expect(stored.id).toBe(event.id);
    expect(stored.title).toBe("只改了标题");
    expect(stored.createdAt).toBe(event.createdAt);
    expect(stored.date).toBe(event.date);
    expect(stored.dateEnd).toBe(event.dateEnd);
    expect(stored.precision).toBe(event.precision);
    expect(stored.dateText).toBe(event.dateText);
  });
}

test("编辑只改时间不截断长标题", async ({ page }) => {
  const longTitle =
    "一段超过六十个字符的合成事件标题，用来验证日历编辑保存不会把原文悄悄裁短，其余字段也应原样保留，标题里还带着日期地点与人物等细节的完整记录。";
  const editor = await editEvent(page, {
    id: "long-title",
    date: "2026-06-03",
    title: longTitle,
    createdAt: 1,
  });
  await editor.getByRole("button", { name: /^保存/ }).click();
  await expect(editor.getByRole("button", { name: "记下来" })).toBeVisible();
  const [stored] = await readIndexedDbStore<LifeEventRecord>(page, "lifeEvents");
  expect(stored.title).toBe(longTitle);
  expect(stored.date).toBe("2026-06-03");
  expect(stored.createdAt).toBe(1);
});

test("同一次双击保存只产生一条记录", async ({ page }) => {
  await openApp(page);
  await page.getByRole("button", { name: /^日历/ }).click();
  const editor = page.locator("[data-event-editor]");
  await editor.locator("textarea").first().fill("双击保存的合成事件");
  await editor.getByRole("button", { name: "记下来" }).click({ clickCount: 2 });
  await expect(editor.getByRole("button", { name: /^保存/ })).toBeHidden();
  const stored = await readIndexedDbStore<LifeEventRecord>(page, "lifeEvents");
  expect(stored).toHaveLength(1);
  expect(stored[0].title).toBe("双击保存的合成事件");
});

test("保存前发现其他窗口已修改时不覆盖", async ({ page }) => {
  const original = {
    id: "conflict",
    date: "2026-06-03",
    title: "原始标题",
    createdAt: 1,
  } satisfies LifeEventRecord;
  const editor = await editEvent(page, original);
  await editor.locator("textarea").first().fill("本窗口迟到的修改");
  await overwriteEventFromOtherWindow(page, {
    ...original,
    title: "另一窗口已保存的标题",
    updatedAt: 12345,
  });
  await editor.getByRole("button", { name: /^保存/ }).click();
  await expect(page.getByText("在其他窗口被修改过")).toBeVisible();
  const [stored] = await readIndexedDbStore<LifeEventRecord>(page, "lifeEvents");
  expect(stored.title).toBe("另一窗口已保存的标题");
  expect(stored.updatedAt).toBe(12345);
});

test("模糊时间入口可以新增去年夏天", async ({ page }) => {
  await openApp(page);
  const lastYear = await page.evaluate(() => new Date().getFullYear() - 1);
  await page.getByRole("button", { name: /^日历/ }).click();
  const editor = page.locator("[data-event-editor]");
  await editor.getByRole("button", { name: "不记得具体哪天" }).click();
  await editor.getByPlaceholder(/大概什么时候/).fill("去年夏天");
  await editor.locator("textarea").first().fill("合成夏日事件");
  await editor.getByRole("button", { name: "记下来" }).click();
  await expect
    .poll(async () =>
      (await readIndexedDbStore<LifeEventRecord>(page, "lifeEvents")).find(
        (event) => event.title === "合成夏日事件",
      ),
    )
    .toMatchObject({
      date: `${lastYear}-06-01`,
      dateEnd: `${lastYear}-08-31`,
      precision: "range",
      dateText: "去年夏天",
    });
});

test("明确把区间改为月份时清除旧结束日期和旧描述", async ({ page }) => {
  const editor = await editEvent(page, legacyEvents[2]);
  await editor.getByRole("button", { name: "只记得某月" }).click();
  await editor.getByLabel("事件月份").fill("2027-04");
  await editor.getByRole("button", { name: /^保存/ }).click();
  await expect(editor.getByRole("button", { name: "记下来" })).toBeVisible();
  const [stored] = await readIndexedDbStore<LifeEventRecord>(page, "lifeEvents");
  expect(stored.date).toBe("2027-04-01");
  expect(stored.precision).toBe("month");
  expect(stored.dateEnd).toBeUndefined();
  expect(stored.dateText).toBeUndefined();
});

async function openFamilyGraph(page: Page) {
  await openApp(page);
  await seedIndexedDb(page, {
    persons: [
      { id: "father", name: "合成父亲", note: "", descriptors: [], thumb: "", createdAt: 4 },
      { id: "spouse", name: "合成配偶", note: "", descriptors: [], thumb: "", createdAt: 3 },
      { id: "daughter", name: "合成女儿", note: "", descriptors: [], thumb: "", createdAt: 2 },
      { id: "cousin", name: "合成表亲", note: "", descriptors: [], thumb: "", createdAt: 1 },
    ],
    relations: [
      {
        id: "father-daughter",
        fromId: "father",
        toId: "daughter",
        predicate: "parent_of",
        label: "父女",
        createdAt: 3,
      },
      {
        id: "daughter-cousin",
        fromId: "daughter",
        toId: "cousin",
        predicate: "cousin_of",
        label: "表亲",
        createdAt: 2,
      },
      {
        id: "parents",
        fromId: "father",
        toId: "spouse",
        predicate: "spouse_of",
        label: "夫妻",
        createdAt: 1,
      },
    ],
  });
  const people = page.getByRole("button", { name: /^人物/ });
  if (await people.count()) await people.first().click();
  await page.getByRole("tab", { name: "关系网" }).click();
  // Include affinal relationships too: the blood-family filter excludes spouses.
  await page.getByLabel("关系类别筛选").selectOption("all");
  await expect(page.locator("[data-relation-graph-frame]")).toHaveAttribute(
    "data-graph-layout",
    "family",
  );
}

test("自动家族树同时显示父女和表亲连线", async ({ page }) => {
  await openFamilyGraph(page);
  await expect(page.locator('[data-relation-id="father-daughter"]')).toHaveCount(1);
  await expect(page.locator('[data-relation-id="daughter-cousin"]')).toHaveCount(1);
  await expect(page.locator('[data-person-id="cousin"]')).toBeVisible();
  await expect(page.locator('[data-relation-id="daughter-cousin"]')).toHaveAttribute(
    "aria-label",
    /⇄/,
  );
});

for (const { personId, edgeId, dx, dy } of [
  { personId: "daughter", edgeId: "father-daughter", dx: 50, dy: 35 },
  { personId: "spouse", edgeId: "parents", dx: 0, dy: 60 },
]) {
  test(`家族树拖动更新人物和连线，切换布局可重置：${personId}`, async ({ page }) => {
    await openFamilyGraph(page);
    const node = page.locator(`[data-person-id="${personId}"]`);
    const circle = node.locator("circle").first();
    await circle.scrollIntoViewIfNeeded();
    const initialY = await circle.getAttribute("cy");
    const edge = page.locator(`[data-relation-id="${edgeId}"] path`).nth(1);
    const initialPath = await edge.getAttribute("d");
    expect(initialY).not.toBeNull();
    expect(initialPath).not.toBeNull();
    const bounds = await circle.boundingBox();
    expect(bounds).not.toBeNull();
    const x = bounds!.x + bounds!.width / 2;
    const y = bounds!.y + bounds!.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + dx, y + dy, { steps: 8 });
    await page.mouse.up();
    await expect
      .poll(async () => Number(await circle.getAttribute("cy")))
      .toBeGreaterThan(Number(initialY));
    await expect(edge).not.toHaveAttribute("d", initialPath!);
    await page.getByLabel("图形布局").selectOption("network");
    await page.getByLabel("图形布局").selectOption("family");
    await expect(circle).toHaveAttribute("cy", initialY!);
  });
}
