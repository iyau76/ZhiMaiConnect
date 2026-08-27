import {
  acceptAllDraftItems,
  clickVisible,
  expect,
  openApp,
  readIndexedDbStore,
  seedIndexedDb,
  snapshotDraftCards,
  test,
} from "./fixtures";

const SENTINEL_AT = new Date("2026-08-19T10:00:00+08:00").getTime();

test("模型失败、切换页面和刷新后，未提交材料仍保留", async ({ page }) => {
  await openApp(page);
  await page.route("**/api/vision", async (route) => {
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "模拟模型不可用", code: "UPSTREAM_UNAVAILABLE" }),
    });
  });

  const material = "这是一段模型失败后也不能丢失的合成演示材料。";
  const intake = page.getByRole("heading", { name: /随手写，AI 来整理/ }).locator("..");
  await intake.getByRole("textbox").fill(material);
  await page.getByRole("button", { name: "AI 整理成档案" }).click();
  await expect(page.getByLabel("Notifications alt+T").getByText("模拟模型不可用")).toBeVisible();
  await expect(page.getByRole("button", { name: "确认入库" })).toHaveCount(0);
  await expect(intake.getByRole("textbox")).toHaveValue(material);

  await clickVisible(page, page.getByRole("button", { name: /^人物关系/ }));
  await expect(page.getByRole("heading", { name: "人物档案" })).toBeVisible();
  await clickVisible(page, page.getByRole("button", { name: /^录入/ }));
  await expect(
    page
      .getByRole("heading", { name: /随手写，AI 来整理/ })
      .locator("..")
      .getByRole("textbox"),
  ).toHaveValue(material);

  await page.reload();
  await expect(
    page
      .getByRole("heading", { name: /随手写，AI 来整理/ })
      .locator("..")
      .getByRole("textbox"),
  ).toHaveValue(material);
});

test("文件解析失败不会覆盖已经在编辑的草稿", async ({ page }) => {
  await openApp(page);
  await page.getByRole("button", { name: "离线演示草稿" }).click();
  const intake = page.getByRole("heading", { name: /随手写，AI 来整理/ }).locator("..");
  const before = await intake.getByRole("textbox").inputValue();
  const beforeDraft = await snapshotDraftCards(page);
  const draftKinds = beforeDraft
    .map((card) => card.kind)
    .filter((kind): kind is string => Boolean(kind));
  expect([...new Set(draftKinds)].sort()).toEqual([
    "event",
    "evidence",
    "fact",
    "person",
    "relation",
    "reminder",
  ]);

  await page.locator('input[type="file"]').setInputFiles({
    name: "broken.docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    buffer: Buffer.from("not-a-valid-docx"),
  });

  await expect(page.getByText(/broken\.docx：/)).toBeVisible();
  await expect(page.getByRole("button", { name: "导入图片 / PDF / Word / 文本" })).toBeEnabled();
  await expect(intake.getByRole("textbox")).toHaveValue(before);
  await expect.poll(() => snapshotDraftCards(page)).toEqual(beforeDraft);
  await expect(page.getByRole("button", { name: "确认入库" })).toBeVisible();
});

test("最近一次合成录入可从界面整批撤销", async ({ page }) => {
  await openApp(page);
  await seedIndexedDb(page, {
    evidence: [
      {
        id: "sentinel-evidence",
        kind: "note",
        title: "非本批次保留证据",
        text: "用于验证撤销只删除最近录入批次。",
        linkedPersonIds: [],
        createdAt: SENTINEL_AT,
        source: { kind: "manual", detail: "Playwright sentinel", at: SENTINEL_AT },
      },
    ],
  });
  await page.getByRole("button", { name: "离线演示草稿" }).click();
  await acceptAllDraftItems(page);
  await page.getByRole("button", { name: "确认入库" }).click();
  const undo = page.getByRole("button", { name: "撤销最近一次录入" });
  await expect(undo).toBeVisible();

  await expect
    .poll(async () => ({
      persons: (await readIndexedDbStore(page, "persons")).length,
      relations: (await readIndexedDbStore(page, "relations")).length,
      evidence: (await readIndexedDbStore(page, "evidence")).length,
      lifeEvents: (await readIndexedDbStore(page, "lifeEvents")).length,
      reminders: (await readIndexedDbStore(page, "reminders")).length,
    }))
    .toEqual({ persons: 2, relations: 1, evidence: 2, lifeEvents: 1, reminders: 1 });
  const evidenceBeforeUndo = await readIndexedDbStore<{ id: string; title: string }>(
    page,
    "evidence",
  );
  expect(evidenceBeforeUndo).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: "sentinel-evidence", title: "非本批次保留证据" }),
      expect.objectContaining({ title: "校园记忆展演示材料（合成）" }),
    ]),
  );
  expect(evidenceBeforeUndo.find((item) => item.id !== "sentinel-evidence")?.id).toBeTruthy();

  await undo.click();
  await expect(undo).toHaveCount(0);

  await expect
    .poll(async () => ({
      persons: (await readIndexedDbStore(page, "persons")).length,
      relations: (await readIndexedDbStore(page, "relations")).length,
      evidence: (await readIndexedDbStore(page, "evidence")).length,
      lifeEvents: (await readIndexedDbStore(page, "lifeEvents")).length,
      reminders: (await readIndexedDbStore(page, "reminders")).length,
    }))
    .toEqual({ persons: 0, relations: 0, evidence: 1, lifeEvents: 0, reminders: 0 });
  expect(await readIndexedDbStore<{ id: string; title: string }>(page, "evidence")).toEqual([
    expect.objectContaining({ id: "sentinel-evidence", title: "非本批次保留证据" }),
  ]);

  await clickVisible(page, page.getByRole("button", { name: /^人物关系/ }));
  await expect(page.getByText("唐悦", { exact: true })).toHaveCount(0);
  await expect(page.getByText("周宁", { exact: true })).toHaveCount(0);
});

test("草稿中人工修改的关系、证据与 Fact 不会被误标为 AI 来源", async ({ page }) => {
  await openApp(page);
  await page.getByRole("button", { name: "离线演示草稿" }).click();

  const relation = page.locator('[data-draft-kind="relation"]');
  await relation.getByPlaceholder("关系").fill("校庆展搭档");
  const evidence = page.locator('[data-draft-kind="evidence"]');
  await evidence.getByPlaceholder("材料标题").fill("人工复核后的合成材料");
  const fact = page.locator('[data-draft-kind="fact"]');
  await fact.getByPlaceholder("材料明确支持的值").fill("人工确认：8 月 28 日前再次确认");

  await acceptAllDraftItems(page);
  await page.getByRole("button", { name: "确认入库" }).click();

  await expect
    .poll(async () => ({
      persons: (await readIndexedDbStore(page, "persons")).length,
      relations: (await readIndexedDbStore(page, "relations")).length,
      evidence: (await readIndexedDbStore(page, "evidence")).length,
      lifeEvents: (await readIndexedDbStore(page, "lifeEvents")).length,
      reminders: (await readIndexedDbStore(page, "reminders")).length,
    }))
    .toEqual({ persons: 2, relations: 1, evidence: 1, lifeEvents: 1, reminders: 1 });

  const relations = await readIndexedDbStore<{
    id: string;
    fromId: string;
    toId: string;
    label: string;
    sourceId?: string;
    source?: { kind: string };
  }>(page, "relations");
  const evidenceRows = await readIndexedDbStore<{
    id: string;
    title: string;
    linkedPersonIds?: string[];
    source?: { kind: string };
  }>(page, "evidence");
  const people = await readIndexedDbStore<{
    id: string;
    name: string;
    source?: { kind: string };
    profile?: {
      extra?: Record<string, string>;
      fieldSources?: Record<string, { kind: string }>;
    };
  }>(page, "persons");
  const tangYue = people.find((person) => person.name === "唐悦");
  const zhouNing = people.find((person) => person.name === "周宁");
  if (!tangYue || !zhouNing) throw new Error("离线草稿人物未完整入库");

  expect(relations).toHaveLength(1);
  expect(relations[0]).toMatchObject({
    label: "校庆展搭档",
    source: expect.objectContaining({ kind: "manual" }),
  });
  expect([relations[0].fromId, relations[0].toId].sort()).toEqual([tangYue.id, zhouNing.id].sort());
  expect(evidenceRows).toHaveLength(1);
  expect(evidenceRows[0]).toMatchObject({
    title: "人工复核后的合成材料",
    source: expect.objectContaining({ kind: "manual" }),
  });
  expect(relations[0].sourceId).toBe(evidenceRows[0].id);
  expect([...(evidenceRows[0].linkedPersonIds ?? [])].sort()).toEqual(
    [tangYue.id, zhouNing.id].sort(),
  );
  expect(tangYue.profile?.extra?.["档期状态"]).toBe("人工确认：8 月 28 日前再次确认");
  expect(tangYue.profile?.fieldSources).toMatchObject({
    "extra:档期状态": { kind: "manual" },
  });
  expect(people.map((person) => person.source?.kind)).toEqual(["ai", "ai"]);
  expect(await readIndexedDbStore<{ source?: { kind: string } }>(page, "lifeEvents")).toEqual([
    expect.objectContaining({ source: expect.objectContaining({ kind: "ai" }) }),
  ]);
  expect(await readIndexedDbStore<{ source?: { kind: string } }>(page, "reminders")).toEqual([
    expect.objectContaining({ source: expect.objectContaining({ kind: "ai" }) }),
  ]);

  await clickVisible(page, page.getByRole("button", { name: /^人物关系/ }));
  await page.getByRole("tab", { name: "关系网" }).click();
  const graph = page.locator("svg").filter({ has: page.locator("#relation-arrow") });
  await graph.getByRole("button", { name: /查看关系详情：唐悦 ⇄ 周宁/ }).click();
  const relationDetail = page.getByRole("region", { name: "关系详情" });
  await expect(relationDetail).toContainText("人工录入");
  await expect(relationDetail).toContainText("草稿中人工编辑");
  await expect(relationDetail).toContainText("人工复核后的合成材料");
  await expect(relationDetail).toContainText("来源：内置离线演示，不对应真实人物");
});

test("语言切换同步 html、标题和关键控件的可访问名称", async ({ page }) => {
  await openApp(page);
  await page.getByRole("button", { name: "切换为英文" }).first().click();

  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page).toHaveTitle("Zhimai Connect · Relationship Memory & Action Assistant");
  await expect(page.getByRole("button", { name: "Switch to English" }).first()).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  await clickVisible(page, page.getByRole("button", { name: /^Calendar/ }));
  await expect(page.getByRole("button", { name: "Previous month" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Next month" })).toBeVisible();
});

test("超过 24 小时的本地录入材料不会恢复", async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => {
    localStorage.setItem(
      "zhimai.intake.draft.v1",
      JSON.stringify({
        raw: "这段过期材料不应恢复",
        supplement: "",
        draft: null,
        attached: [],
        at: Date.now() - 25 * 60 * 60 * 1000,
      }),
    );
  });
  await page.reload();
  await expect(page.locator('[data-app-hydrated="true"]')).toBeVisible();
  const intake = page.getByRole("heading", { name: /随手写，AI 来整理/ }).locator("..");
  await expect(intake.getByRole("textbox")).toHaveValue("");
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("zhimai.intake.draft.v1")))
    .toBeNull();
});

test("50 人 80 关系的合成数据可在关系图内完成交互冒烟", async ({ page }) => {
  await openApp(page);
  await clickVisible(page, page.getByRole("button", { name: /^设置/ }));
  await page.getByRole("button", { name: "一键载入/重置合成数据" }).click();
  await expect(page.getByText("当前已载入：50 人 · 80 条关系")).toBeVisible();

  await clickVisible(page, page.getByRole("button", { name: /^人物关系/ }));
  await page.getByRole("tab", { name: "关系网" }).click();
  const graph = page.locator("svg").filter({ has: page.locator("#relation-arrow") });
  await expect(graph.getByRole("button", { name: /单击聚焦/ })).toHaveCount(50);
  const overviewEdges = graph.getByRole("button", { name: /查看关系详情/ });
  await expect(overviewEdges).not.toHaveCount(80);
  await expect(page.getByText(/当前视图显示 \d+ 条关系，隐藏 \d+ 条/)).toBeVisible();

  await page.getByLabel("关系网视图").selectOption("all");
  await expect(graph.getByRole("button", { name: /查看关系详情/ })).toHaveCount(80);

  await graph.scrollIntoViewIfNeeded();
  const transformBeforeWheel = await graph.locator(":scope > g").getAttribute("transform");
  const scrollBeforeWheel = await page.evaluate(() => window.scrollY);
  const wheelWasPrevented = await graph.evaluate(
    (element) =>
      !element.dispatchEvent(
        new WheelEvent("wheel", { deltaY: -400, bubbles: true, cancelable: true }),
      ),
  );
  expect(wheelWasPrevented).toBe(true);
  await expect
    .poll(() => graph.locator(":scope > g").getAttribute("transform"))
    .not.toBe(transformBeforeWheel);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(scrollBeforeWheel);

  await page.getByRole("button", { name: "全屏查看关系图" }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () => document.fullscreenElement?.getAttribute("data-relation-graph-frame") ?? null,
      ),
    )
    .toBe("true");
  await page.getByRole("button", { name: "退出全屏" }).click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement)).toBeNull();

  await graph
    .getByRole("button", { name: /单击聚焦/ })
    .first()
    .click();
  await expect(page.getByRole("button", { name: "打开人物卡" })).toBeVisible();
});
