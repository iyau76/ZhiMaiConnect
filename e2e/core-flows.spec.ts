import {
  acceptAllDraftItems,
  clickVisible,
  expect,
  openApp,
  readIndexedDbStore,
  seedIndexedDb,
  test,
} from "./fixtures";

const NOW = new Date("2026-08-20T10:00:00+08:00").getTime();

test("录入文字后可复核 AI 草稿、编辑并确认入库", async ({ page, mockNetwork }) => {
  await openApp(page);

  const intake = page.getByRole("heading", { name: /随手写，AI 来整理/ }).locator("..");
  await intake
    .getByRole("textbox")
    .fill(
      "唐悦是我的大学摄影社搭档，生日 3 月 12 日，微信 tangyue_photo，喜欢人像摄影。2026 年 8 月 29 日和唐悦一起讨论校园记忆展。 ",
    );
  await page.getByRole("button", { name: "AI 整理成档案" }).click();

  await expect(page.getByRole("button", { name: "确认入库" })).toBeVisible();
  const intakeTrace = intake.getByRole("status");
  await expect(intakeTrace).toContainText("整理轨迹");
  await expect(intakeTrace).toContainText("整理完成");
  await expect(intakeTrace).toContainText(/\d+ 步/);
  await expect(page.getByText("AI 推断值待核验 · 2")).toBeVisible();
  const warningDetails = page.locator("details").filter({ hasText: "AI 推断值待核验" });
  await expect(warningDetails).not.toHaveAttribute("open", "");
  await warningDetails.locator("summary").click();
  await expect(warningDetails).toHaveAttribute("open", "");
  await expect(warningDetails.getByText(/手冲咖啡/)).toBeVisible();
  const name = page.getByPlaceholder("姓名");
  await expect(name).toHaveValue("唐悦");
  await page.getByRole("combobox", { name: "亲密度", exact: true }).selectOption("4");
  await expect(page.getByText("AI 推断值待核验 · 1")).toBeVisible();

  const batch = page.getByRole("button", { name: /批量接受低风险高置信事件/ });
  await batch.click();
  await expect(page.getByText("待确认 2", { exact: true })).toBeVisible();
  await expect(batch).toHaveCount(0);

  const eventDraft = page.locator('[data-draft-kind="event"]');
  await eventDraft.getByPlaceholder("事件名称").fill("讨论校园记忆展拍摄分工");
  await expect(page.getByText("待确认 3", { exact: true })).toBeVisible();
  await expect(batch).toHaveCount(0);
  await eventDraft.getByRole("button", { name: "接受此项" }).click();

  const personDraft = page.locator('[data-draft-kind="person"]');
  await personDraft.getByRole("button", { name: "接受此项" }).click();
  await name.fill("唐悦（摄影社）");
  await expect(page.getByText("待确认 3", { exact: true })).toBeVisible();
  await personDraft.getByRole("button", { name: "接受此项" }).click();
  await eventDraft.getByRole("button", { name: "接受此项" }).click();

  const reminderDraft = page.locator('[data-draft-kind="reminder"]');
  await expect(reminderDraft.getByPlaceholder("要做什么")).toHaveValue("给唐悦发送拍摄清单");
  await reminderDraft.getByRole("button", { name: "拒绝此项" }).click();
  await expect(page.getByText("待确认 0", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "确认入库" }).click();

  await expect(page.getByRole("button", { name: "确认入库" })).toHaveCount(0);
  const persons = await readIndexedDbStore<{
    id: string;
    name: string;
    source?: { kind: string };
    profile?: {
      contact?: string;
      birthday?: string;
      closeness?: number;
      likes?: string[];
      fieldSources?: Record<string, { kind: string }>;
    };
  }>(page, "persons");
  expect(persons).toHaveLength(1);
  expect(persons[0]).toMatchObject({
    name: "唐悦（摄影社）",
    source: { kind: "manual" },
    profile: {
      contact: "微信 tangyue_photo",
      birthday: "03-12",
      closeness: 4,
      likes: ["人像摄影", "手冲咖啡"],
      fieldSources: {
        name: { kind: "manual" },
        contact: { kind: "manual" },
        birthday: { kind: "manual" },
        closeness: { kind: "manual" },
        likes: { kind: "manual" },
      },
    },
  });
  expect(await readIndexedDbStore(page, "reminders")).toEqual([]);
  const lifeEvents = await readIndexedDbStore<{
    title: string;
    personIds?: string[];
    source?: { kind: string };
  }>(page, "lifeEvents");
  expect(lifeEvents).toEqual([
    expect.objectContaining({
      title: "讨论校园记忆展拍摄分工",
      personIds: [persons[0].id],
      source: expect.objectContaining({ kind: "manual" }),
    }),
  ]);
  await clickVisible(page, page.getByRole("button", { name: /^人物关系/ }));
  await expect(page.getByText("唐悦（摄影社）", { exact: true })).toBeVisible();
  expect(mockNetwork.visionRequests).toHaveLength(1);
  expect(String(mockNetwork.visionRequests[0].prompt)).toContain("唐悦");
});

test("待确认条目是软提醒，直接入库后关系仍保留 pending 状态", async ({ page }) => {
  await openApp(page);
  await page.getByRole("button", { name: "离线演示草稿" }).click();
  await expect(page.getByText(/待确认 \d+/, { exact: true })).toBeVisible();
  await expect(page.getByText(/待确认是软提醒/)).toBeVisible();

  await page.getByRole("button", { name: "确认入库" }).click();
  await expect(page.getByRole("button", { name: "确认入库" })).toHaveCount(0);
  const assertions = await readIndexedDbStore<{ confirmationStatus?: string }>(
    page,
    "relationAssertions",
  );
  expect(assertions.length).toBeGreaterThan(0);
  expect(assertions.every((relation) => relation.confirmationStatus === "pending")).toBe(true);
});

test("批量接受只确认来源对齐关系，名称子串误配保持可见且可单独处理", async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => sessionStorage.removeItem("openglass.cloud-transfer-consents"));
  await page
    .getByRole("heading", { name: /随手写，AI 来整理/ })
    .locator("..")
    .getByRole("textbox")
    .fill("尤二姐是尤氏继母的女儿。");
  await page.getByRole("button", { name: "AI 整理成档案" }).click();
  const cloudConsent = page.getByRole("dialog").filter({ hasText: "发送给云模型" });
  await expect(cloudConsent).toBeVisible();
  await cloudConsent.getByRole("button", { name: "继续" }).click();

  const intakePanel = page.getByTestId("intake-panel");
  const relationCardsBeforeReload = page.locator('[data-draft-kind="relation"]');
  await expect(relationCardsBeforeReload).toHaveCount(2);
  await expect(relationCardsBeforeReload.first()).toContainText("同时包含关系两端");
  await expect(intakePanel).toHaveAttribute("data-intake-draft-persisted", "true");

  const persistedDraft = await page.evaluate(() => {
    const raw = localStorage.getItem("zhimai.intake.draft.v1");
    if (!raw) return null;
    const stash = JSON.parse(raw) as { draft?: { relations?: unknown[] } };
    return stash.draft ?? null;
  });
  expect(persistedDraft).not.toBeNull();
  expect(persistedDraft?.relations?.length ?? 0).toBeGreaterThan(0);

  await page.reload();
  await expect(page.getByTestId("intake-panel")).toHaveAttribute(
    "data-intake-draft-persisted",
    "true",
  );
  await expect(page.getByRole("button", { name: "确认入库" })).toBeVisible();

  const relationCards = page.locator('[data-draft-kind="relation"]');
  await expect(relationCards).toHaveCount(2);
  await expect(relationCards.first()).toContainText("同时包含关系两端");

  await page.getByRole("button", { name: /一键接受已对齐项/ }).click();
  const acceptAllDialog = page.getByTestId("intake-accept-all-dialog");
  await expect(acceptAllDialog).toBeVisible();
  await acceptAllDialog.getByTestId("intake-accept-all-confirm").click();
  await expect(acceptAllDialog).toHaveCount(0);
  await expect(page.getByText("待确认 1", { exact: true })).toBeVisible();
  await expect(relationCards.first().getByRole("button", { name: "接受此项" })).toBeVisible();
  await expect(relationCards.nth(1).getByRole("button", { name: "已接受" })).toBeDisabled();

  await page.getByRole("button", { name: "确认入库" }).click();
  const assertions = await readIndexedDbStore<{
    confirmationStatus?: string;
    evidence?: { basis?: string };
  }>(page, "relationAssertions");
  expect(assertions).toHaveLength(2);
  expect(assertions.filter((item) => item.confirmationStatus === "confirmed")).toHaveLength(1);
  expect(assertions.filter((item) => item.confirmationStatus === "pending")).toHaveLength(1);
});

test("事件草稿按月或年录入时不要求选择具体日期，并能解析原始时间表述", async ({ page }) => {
  await openApp(page);
  await page.getByRole("button", { name: "离线演示草稿" }).click();
  const eventDraft = page.locator('[data-draft-kind="event"]').first();
  const precision = eventDraft.getByRole("combobox", { name: "日期精度" });

  await precision.selectOption("month");
  const month = eventDraft.getByRole("textbox", { name: "事件月份" });
  await expect(month).toHaveAttribute("type", "month");
  await month.fill("2024-07");

  await precision.selectOption("year");
  const year = eventDraft.getByRole("spinbutton", { name: "事件年份" });
  await expect(year).toHaveValue("2024");
  await year.fill("2023");

  const phrase = eventDraft.getByRole("textbox", { name: "原始时间表述" });
  await phrase.fill("去年夏天");
  await phrase.blur();
  await expect(precision).toHaveValue("range");
  await expect(eventDraft.getByRole("textbox", { name: "事件日期" })).toHaveValue(
    `${new Date().getFullYear() - 1}-06-01`,
  );
});

test("人物改名会传播到 Fact、关系、事件和提醒的持久化引用", async ({ page }) => {
  await openApp(page);
  await page.getByRole("button", { name: "离线演示草稿" }).click();
  const personDrafts = page.locator('[data-draft-kind="person"]');
  await personDrafts.nth(1).getByPlaceholder("汇报对象").fill("唐悦");
  await personDrafts.first().getByPlaceholder("姓名").fill("唐悦（摄影社）");
  await acceptAllDraftItems(page);
  await page.getByRole("button", { name: "确认入库" }).click();
  await expect(page.getByRole("button", { name: "确认入库" })).toHaveCount(0);

  const people = await readIndexedDbStore<{
    id: string;
    name: string;
    profile?: {
      extra?: Record<string, string>;
      reportsTo?: string;
      fieldSources?: Record<string, { kind: string }>;
    };
  }>(page, "persons");
  expect(people).toHaveLength(2);
  expect(people.some((person) => person.name === "唐悦")).toBe(false);
  const renamed = people.find((person) => person.name === "唐悦（摄影社）");
  const zhouNing = people.find((person) => person.name === "周宁");
  if (!renamed || !zhouNing) throw new Error("改名后的离线草稿人物未完整入库");
  expect(renamed.profile?.extra?.["档期状态"]).toBe("8 月 28 日前需再次确认");
  expect(renamed.profile?.fieldSources?.["extra:档期状态"]?.kind).toBe("manual");
  expect(zhouNing.profile?.reportsTo).toBe("唐悦（摄影社）");
  expect(zhouNing.profile?.fieldSources?.reportsTo?.kind).toBe("manual");

  const relations = await readIndexedDbStore<{
    fromId: string;
    toId: string;
    source?: { kind: string };
  }>(page, "relations");
  expect(relations).toHaveLength(1);
  expect([relations[0].fromId, relations[0].toId].sort()).toEqual([renamed.id, zhouNing.id].sort());
  expect(relations[0].source?.kind).toBe("manual");

  const events = await readIndexedDbStore<{
    personIds?: string[];
    source?: { kind: string };
  }>(page, "lifeEvents");
  expect(events).toHaveLength(1);
  expect([...(events[0].personIds ?? [])].sort()).toEqual([renamed.id, zhouNing.id].sort());
  expect(events[0].source?.kind).toBe("manual");

  const reminders = await readIndexedDbStore<{
    personIds?: string[];
    source?: { kind: string };
  }>(page, "reminders");
  expect(reminders).toHaveLength(1);
  expect(reminders[0].personIds).toEqual([renamed.id]);
  expect(reminders[0].source?.kind).toBe("manual");

  const evidence = await readIndexedDbStore<{
    linkedPersonIds?: string[];
    source?: { kind: string };
  }>(page, "evidence");
  expect(evidence).toHaveLength(1);
  expect([...(evidence[0].linkedPersonIds ?? [])].sort()).toEqual([renamed.id, zhouNing.id].sort());
  expect(evidence[0].source?.kind).toBe("ai");
});

test("更新已有档案时，姓名变更会按预览实际写入", async ({ page }) => {
  await openApp(page);
  await seedIndexedDb(page, {
    persons: [
      {
        id: "existing-tangyue",
        name: "糖糖",
        note: "历史档案",
        profile: {
          contact: "微信 tangyue_photo",
          identities: [{ platform: "摄影社", alias: "唐悦" }],
        },
        descriptors: [],
        thumb: "",
        createdAt: NOW,
        updatedAt: NOW,
        source: { kind: "manual", label: "E2E seed", at: NOW },
      },
    ],
  });
  await openApp(page);

  await page
    .getByRole("heading", { name: /随手写，AI 来整理/ })
    .locator("..")
    .getByRole("textbox")
    .fill(
      "唐悦是我的大学摄影社搭档，生日 3 月 12 日，微信 tangyue_photo，喜欢人像摄影。2026 年 8 月 29 日和唐悦一起讨论校园记忆展。",
    );
  await page.getByRole("button", { name: "AI 整理成档案" }).click();
  const target = page.getByRole("combobox", { name: "选择新建人物或更新已有档案" });
  await target.selectOption("existing-tangyue");
  await expect(target).toHaveValue("existing-tangyue");
  await acceptAllDraftItems(page);
  await page.getByRole("button", { name: "确认入库" }).click();

  const people = await readIndexedDbStore<{ id: string; name: string; note: string }>(
    page,
    "persons",
  );
  expect(people).toHaveLength(1);
  expect(people[0]).toMatchObject({ id: "existing-tangyue", name: "唐悦", note: "历史档案" });
});

test("补充并重新整理会保留人工字段及其来源", async ({ page, mockNetwork }) => {
  await openApp(page);
  await page
    .getByRole("heading", { name: /随手写，AI 来整理/ })
    .locator("..")
    .getByRole("textbox")
    .fill(
      "唐悦是我的大学摄影社搭档，生日 3 月 12 日，微信 tangyue_photo，喜欢人像摄影。2026 年 8 月 29 日和唐悦一起讨论校园记忆展。",
    );
  await page.getByRole("button", { name: "AI 整理成档案" }).click();

  const person = page.locator('[data-draft-kind="person"]');
  await person.getByRole("combobox", { name: "亲密度", exact: true }).selectOption("4");
  await person.getByPlaceholder("和我的关系").fill("");
  const supplement = page.getByPlaceholder(/补一句就行/);
  await supplement.fill("补充说明：唐悦愿意帮校园记忆展拍摄。 ");
  await page.getByRole("button", { name: "补充并重新整理" }).click();

  await expect(person.getByRole("combobox", { name: "亲密度", exact: true })).toHaveValue("4");
  await expect(person.getByPlaceholder("和我的关系")).toHaveValue("");
  await expect(person.getByText(/亲密度\s*·\s*人工填写/)).toBeVisible();
  expect(mockNetwork.visionRequests).toHaveLength(2);
});

test("人物卡可以手动新建圈层并把未分圈层人物加入其中", async ({ page }) => {
  await openApp(page);
  await seedIndexedDb(page, {
    persons: [
      {
        id: "manual-circle-person",
        name: "小雨",
        note: "待手动整理圈层",
        descriptors: [],
        thumb: "",
        createdAt: NOW,
      },
    ],
  });
  await openApp(page);

  await clickVisible(page, page.getByRole("button", { name: /^人物关系/ }));
  const personCard = page.getByText("小雨", { exact: true }).locator("../..");
  await personCard.getByRole("button", { name: "编辑" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("未分圈层", { exact: true })).toBeVisible();
  await dialog.getByPlaceholder("新圈层名称，如：同学、家人、项目伙伴").fill("同学");
  await dialog.getByRole("button", { name: "新建并加入" }).click();
  await dialog.getByRole("button", { name: "保存", exact: true }).click();

  await expect(dialog).toHaveCount(0);
  const circles = await readIndexedDbStore<{ id: string; name: string; kind: string }>(
    page,
    "collections",
  );
  const memberships = await readIndexedDbStore<{
    collectionId: string;
    personId: string;
    source: string;
  }>(page, "collectionMemberships");
  expect(circles).toEqual([expect.objectContaining({ name: "同学", kind: "relationship_circle" })]);
  expect(memberships).toEqual([
    expect.objectContaining({
      collectionId: circles[0].id,
      personId: "manual-circle-person",
      source: "manual",
    }),
  ]);
});

test("模型配置名称不重复，并可由用户显式保存到当前浏览器", async ({ page }) => {
  await openApp(page);
  await clickVisible(page, page.getByRole("button", { name: /^AI 助理/ }));
  const panel = page.getByTestId("model-config-panel");
  const openaiPreset = panel.locator('[data-provider-preset-id="builtin-openai"]');
  const geminiPreset = panel.locator('[data-provider-preset-id="builtin-gemini"]');

  await expect(openaiPreset).toContainText("OpenAI 兼容接口 · deepseek-chat");
  await expect(geminiPreset).toContainText("Gemini 兼容接口 · gemini-3.7-flash");
  expect(((await openaiPreset.innerText()).match(/OpenAI 兼容接口/gu) ?? []).length).toBe(1);
  expect(((await geminiPreset.innerText()).match(/Gemini 兼容接口/gu) ?? []).length).toBe(1);

  await panel.getByRole("button", { name: "保存模型配置" }).click();
  await expect(page.getByText("模型配置已保存到这个浏览器")).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("openglass.saved-api-keys"))).toContain(
    "playwright-test-key",
  );

  await page.evaluate(() => sessionStorage.removeItem("openglass.session-api-keys"));
  await openApp(page);
  await clickVisible(page, page.getByRole("button", { name: /^AI 助理/ }));
  await expect(
    page.getByTestId("model-config-panel").locator('input[type="password"]'),
  ).toHaveValue("playwright-test-key");
});

test("关系网单击只淡化无关节点，双击开人物卡，并可在图上新建自定义关系", async ({ page }) => {
  await openApp(page);
  await seedIndexedDb(page, {
    persons: [
      {
        id: "person-a",
        name: "陈安",
        note: "律师朋友",
        profile: { title: "律师", circle: "朋友", tags: ["朋友"], closeness: 4 },
        descriptors: [],
        thumb: "",
        createdAt: NOW,
      },
      {
        id: "person-b",
        name: "赵宇",
        note: "前端工程师",
        profile: { title: "前端工程师", circle: "朋友", tags: ["朋友"] },
        descriptors: [],
        thumb: "",
        createdAt: NOW - 1,
      },
      {
        id: "person-c",
        name: "唐悦",
        note: "摄影师",
        profile: { title: "摄影师", circle: "同学", tags: ["同学"] },
        descriptors: [],
        thumb: "",
        createdAt: NOW - 2,
      },
      {
        id: "person-d",
        name: "丁晨",
        note: "赵宇的同事",
        profile: { title: "后端工程师", circle: "同事", tags: ["同事"] },
        descriptors: [],
        thumb: "",
        createdAt: NOW - 3,
      },
    ],
    relations: [
      {
        id: "relation-ab",
        fromId: "person-a",
        toId: "person-b",
        label: "朋友",
        mutual: true,
        sourceId: "evidence-ab",
        confirmationStatus: "confirmed",
        createdAt: NOW,
        updatedAt: NOW,
      },
      {
        id: "relation-ac",
        fromId: "person-a",
        toId: "person-c",
        label: "大学同学",
        mutual: true,
        confirmationStatus: "confirmed",
        createdAt: NOW - 1,
        updatedAt: NOW - 1,
      },
      {
        id: "relation-bd",
        fromId: "person-b",
        toId: "person-d",
        label: "同事",
        mutual: true,
        confirmationStatus: "confirmed",
        createdAt: NOW - 2,
        updatedAt: NOW - 2,
      },
    ],
    evidence: [
      {
        id: "evidence-ab",
        kind: "note",
        title: "合成演示：校友活动记录",
        text: "陈安与赵宇在虚构的校友活动中共同负责签到；此处仅用于自动化测试。",
        origin: "Playwright 合成 fixture",
        linkedPersonIds: ["person-a", "person-b"],
        createdAt: NOW,
      },
    ],
    lifeEvents: [
      {
        id: "event-a",
        date: "2026-08-12",
        title: "一起核对租房合同",
        personIds: ["person-a"],
        kind: "帮忙",
        createdAt: NOW,
      },
    ],
  });

  await clickVisible(page, page.getByRole("button", { name: /^人物关系/ }));
  await page.getByRole("tab", { name: "关系网" }).click();
  const graph = page.locator("svg").filter({ has: page.locator("#relation-arrow") });
  const personA = graph.getByRole("button", { name: /^陈安 ·/ });
  const personB = graph.getByRole("button", { name: /^赵宇 ·/ });
  const personD = graph.getByRole("button", { name: /^丁晨 ·/ });
  await personA.click();

  await expect(graph.getByRole("button", { name: /^陈安 ·/ })).toHaveCount(1);
  await expect(graph.getByRole("button", { name: /^赵宇 ·/ })).toHaveCount(1);
  await expect(graph.getByRole("button", { name: /^唐悦 ·/ })).toHaveCount(1);
  await expect(graph.getByRole("button", { name: /^丁晨 ·/ })).toHaveCount(1);
  await expect(personB).toHaveAttribute("opacity", "1");
  await expect(personD).toHaveAttribute("opacity", "0.25");
  const openProfile = page.getByRole("button", { name: "打开人物卡" });
  await expect(openProfile).toBeVisible();
  const detail = openProfile.locator("../..");
  await expect(detail).toContainText("陈安");
  await expect(detail).toContainText("赵宇");
  await expect(detail).toContainText("唐悦");
  await expect(detail).toContainText("朋友");

  await graph.locator('[data-graph-background="true"]').click({ position: { x: 8, y: 8 } });
  await expect(personD).toHaveAttribute("opacity", "1");
  await expect(openProfile).toHaveCount(0);

  await personA.click();
  await expect(personD).toHaveAttribute("opacity", "0.25");

  await page.getByRole("button", { name: "新建关系" }).click();
  const composer = page.getByRole("region", { name: "新建关系" });
  await expect(composer).toContainText("陈安");
  await personD.click();
  await composer.getByLabel("关系名称").fill("共同创业伙伴");
  await composer.getByRole("button", { name: "确认建立" }).click();
  await expect(composer).toHaveCount(0);
  await expect
    .poll(async () =>
      (await readIndexedDbStore<{ label?: string }>(page, "relations")).some(
        (relation) => relation.label === "共同创业伙伴",
      ),
    )
    .toBe(true);

  await graph.getByRole("button", { name: /查看关系详情：陈安 ⇄ 赵宇/ }).click();
  const relationDetail = page.getByRole("region", { name: "关系详情" });
  await expect(relationDetail).toContainText("陈安 → 赵宇");
  await expect(relationDetail).toContainText("赵宇 → 陈安");
  await expect(relationDetail).toContainText("合成演示：校友活动记录");
  await expect(relationDetail).toContainText("共同负责签到");
  await relationDetail.getByLabel("关系图展示").selectOption("hidden");
  await relationDetail.getByLabel("引荐推荐策略").selectOption("block");
  await expect
    .poll(async () =>
      (
        await readIndexedDbStore<{
          id: string;
          visibility?: string;
          recommendationPolicy?: string;
        }>(page, "relations")
      ).find((relation) => relation.id === "relation-ab"),
    )
    .toMatchObject({ visibility: "hidden", recommendationPolicy: "block" });
  await page.getByLabel("关系网视图").selectOption("all");
  await expect(graph.getByRole("button", { name: /查看关系详情：陈安 ⇄ 赵宇/ })).toBeVisible();

  await personA.dblclick();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByText("姓名", { exact: true }).locator("..").getByRole("textbox"),
  ).toHaveValue("陈安");
  await expect(
    dialog.getByText("职业 / 职位", { exact: true }).locator("..").getByRole("textbox"),
  ).toHaveValue("律师");
});

test("本地候选排序后才请求 AI，并产出可编辑求助话术", async ({ page, mockNetwork }) => {
  await openApp(page);
  await seedIndexedDb(page, {
    persons: [
      {
        id: "person-lawyer",
        name: "陈安",
        note: "可以协助合同审阅",
        profile: {
          title: "律师",
          likes: ["合同审阅", "法律咨询"],
          contact: "chen@example.invalid",
          closeness: 4,
        },
        descriptors: [],
        thumb: "",
        createdAt: NOW,
      },
      {
        id: "person-dev",
        name: "赵宇",
        note: "擅长网站开发",
        profile: {
          title: "前端工程师",
          likes: ["代码", "网站开发"],
          contact: "zhao@example.invalid",
          closeness: 5,
        },
        descriptors: [],
        thumb: "",
        createdAt: NOW - 1,
      },
    ],
    lifeEvents: [
      {
        id: "event-contract",
        date: "2026-08-12",
        title: "一起审阅合同",
        personIds: ["person-lawyer"],
        kind: "帮忙",
        createdAt: NOW,
      },
    ],
  });

  await clickVisible(page, page.getByRole("button", { name: /^提醒/ }));
  const recommendation = page.getByRole("heading", { name: "这事该拜托谁" }).locator("..");
  await expect(recommendation).toBeVisible();
  await recommendation.getByRole("textbox").fill("帮我看一下租房合同中的违约条款");
  await page.getByRole("button", { name: "本地筛选候选" }).click();

  const candidates = page.locator("ol").filter({ hasText: "陈安" });
  await expect(candidates.locator("li").first()).toContainText("陈安");
  expect(mockNetwork.visionRequests).toHaveLength(0);

  await page.getByRole("button", { name: "生成比较与话术" }).click();
  const editable = page.getByRole("textbox", { name: "可编辑的候选比较与求助话术" });
  await expect(editable).toContainText("陈安你好");
  await expect(editable).toContainText("为什么不是赵宇");
  await expect(editable).toContainText("合同审阅经验");
  await editable.fill("陈安你好，方便时帮我看一下合同吗？");
  await expect(editable).toHaveValue("陈安你好，方便时帮我看一下合同吗？");
  expect(mockNetwork.visionRequests).toHaveLength(1);
});

test("目标人物引荐只返回真实可达路径，断开的高亲密度同学不会入选", async ({ page }) => {
  await openApp(page);
  await seedIndexedDb(page, {
    persons: [
      {
        id: "jia-lian",
        name: "贾琏",
        note: "可直接联系",
        profile: { closeness: 5, contact: "synthetic-jialian@example.invalid" },
        descriptors: [],
        thumb: "",
        createdAt: NOW,
      },
      {
        id: "jia-mu",
        name: "贾母",
        note: "目标人物",
        profile: {},
        descriptors: [],
        thumb: "",
        createdAt: NOW - 1,
      },
      {
        id: "classmate-a",
        name: "同学甲",
        note: "与目标无关系记录",
        profile: { closeness: 5, contact: "synthetic-a@example.invalid" },
        descriptors: [],
        thumb: "",
        createdAt: NOW - 2,
      },
      {
        id: "classmate-b",
        name: "同学乙",
        note: "与目标无关系记录",
        profile: { closeness: 5, contact: "synthetic-b@example.invalid" },
        descriptors: [],
        thumb: "",
        createdAt: NOW - 3,
      },
    ],
    relations: [
      {
        id: "jia-family-path",
        fromId: "jia-lian",
        toId: "jia-mu",
        label: "晚辈与长辈",
        basis: "原文：贾琏可以联系贾母",
        evidenceMode: "explicit",
        confidence: 0.95,
        confirmationStatus: "confirmed",
        recommendationPolicy: "allow",
        visibility: "auto",
        createdAt: NOW,
      },
    ],
  });

  await clickVisible(page, page.getByRole("button", { name: /^提醒/ }));
  const recommendation = page.getByRole("heading", { name: "这事该拜托谁" }).locator("..");
  await recommendation.getByRole("textbox").fill("我想找贾母办事，应该通过谁联系？");
  await recommendation.getByRole("button", { name: "本地筛选候选" }).click();
  await expect(recommendation).toContainText("本地只召回了问题中出现的人名，不猜测谁是目标");
  await recommendation.getByRole("combobox", { name: "选择目标人物" }).selectOption("jia-mu");

  await expect(recommendation.getByText(/已验证可达路径/)).toBeVisible();
  await expect(recommendation.locator("ol li")).toHaveCount(1);
  await expect(recommendation.locator("ol li").first()).toContainText("贾琏");
  await expect(recommendation.locator("ol li").first()).toContainText("我 → 贾琏 → 贾母");
  await expect(recommendation.locator("ol")).not.toContainText("同学甲");
  await expect(recommendation.locator("ol")).not.toContainText("同学乙");
});

test("AI 全库分析会渐进读取档案，并用 DSH 式单行轨迹展示过程", async ({ page, mockNetwork }) => {
  await openApp(page);
  await seedIndexedDb(page, {
    persons: [
      {
        id: "person-lawyer-agent",
        name: "陈安",
        note: "可以协助合同审阅",
        profile: {
          title: "律师",
          likes: ["合同审阅", "法律咨询"],
          contact: "private-lawyer@example.invalid",
          closeness: 4,
        },
        descriptors: [],
        thumb: "",
        createdAt: NOW,
      },
      {
        id: "person-dev-agent",
        name: "赵宇",
        note: "擅长网站开发",
        profile: { title: "前端工程师", contact: "private-dev@example.invalid", closeness: 5 },
        descriptors: [],
        thumb: "",
        createdAt: NOW - 1,
      },
    ],
    lifeEvents: [
      {
        id: "event-contract-agent",
        date: "2026-08-12",
        title: "一起审核租房合同",
        personIds: ["person-lawyer-agent"],
        kind: "帮忙",
        createdAt: NOW,
      },
    ],
  });

  await clickVisible(page, page.getByRole("button", { name: /^提醒/ }));
  const recommendation = page.getByRole("heading", { name: "这事该拜托谁" }).locator("..");
  await recommendation.getByRole("textbox").fill("帮我看一下租房合同中的违约条款");
  await recommendation.getByRole("switch", { name: /AI 全库分析/ }).click();
  await recommendation.getByRole("button", { name: "AI 全库分析", exact: true }).click();

  const trace = recommendation.getByRole("status");
  await expect(trace).toContainText("分析完成");
  await expect(trace).toContainText(/\d+ 步/);
  await expect(recommendation.locator("ol li").first()).toContainText("陈安");
  await expect(recommendation.locator("ol li").first()).toContainText(/\d+ 本地锁定分/);
  await expect(
    recommendation.getByRole("textbox", { name: "可编辑的候选比较与求助话术" }),
  ).not.toHaveValue(/赵宇/);

  expect(mockNetwork.visionRequests).toHaveLength(3);
  const prompts = mockNetwork.visionRequests.map((request) => String(request.prompt));
  expect(prompts[0]).toContain("你负责理解一项人际协作任务");
  expect(prompts.slice(1).join("\n")).toContain("已授权访问完整决策档案");
  expect(prompts[2]).toContain('"tool":"search_profiles"');
  expect(prompts.join("\n")).not.toContain("private-lawyer@example.invalid");
});

test("AI 助理问一问会展示流式轨迹并调用受控网页检索工具", async ({ page, mockNetwork }) => {
  await openApp(page);
  await clickVisible(page, page.getByRole("button", { name: /^AI 助理/ }));
  const questionCard = page.getByText("问一问", { exact: true }).locator("..").locator("..");
  await questionCard.getByRole("textbox").fill("Open-Meteo 现在适合做无密钥天气查询吗？");
  await questionCard.getByRole("button", { name: "发送问题" }).click();

  const trace = questionCard.getByRole("status");
  await expect(trace).toContainText("问答轨迹");
  await expect(trace).toContainText("回答完成");
  await expect(questionCard).toContainText("Open-Meteo 提供无需密钥的天气预报接口");

  expect(mockNetwork.webToolRequests).toEqual([{ tool: "search", query: "Open-Meteo 官方文档" }]);
  expect(mockNetwork.visionRequests).toHaveLength(2);
});

test("AI 助理修改人物时必须先批准，批准前人物库保持不变", async ({ page }) => {
  await openApp(page);
  await seedIndexedDb(page, {
    persons: [
      {
        id: "person-update-agent",
        name: "合成测试人物",
        note: "",
        profile: { title: "品牌经理" },
        descriptors: [],
        thumb: "",
        createdAt: NOW,
      },
    ],
  });
  await openApp(page);
  await clickVisible(page, page.getByRole("button", { name: /^AI 助理/ }));
  const questionCard = page.getByText("问一问", { exact: true }).locator("..").locator("..");
  await questionCard.getByRole("textbox").fill("把合成测试人物的职位改成品牌总监");
  await questionCard.getByRole("button", { name: "发送问题" }).click();

  const approval = questionCard.getByRole("region", { name: "待批准的批量档案修改" });
  await expect(approval).toContainText("品牌经理");
  await expect(approval).toContainText("品牌总监");
  let people = await readIndexedDbStore<{ profile?: { title?: string } }>(page, "persons");
  expect(people[0].profile?.title).toBe("品牌经理");

  await approval.getByRole("button", { name: /签字并原子执行/ }).click();
  await expect(approval).toHaveCount(0);
  people = await readIndexedDbStore<{ profile?: { title?: string } }>(page, "persons");
  expect(people[0].profile?.title).toBe("品牌总监");
});

test("AI 助理修改人物关系时同样必须先批准", async ({ page }) => {
  await openApp(page);
  await seedIndexedDb(page, {
    persons: [
      { id: "relation-person-a", name: "甲", note: "", descriptors: [], thumb: "", createdAt: NOW },
      { id: "relation-person-b", name: "乙", note: "", descriptors: [], thumb: "", createdAt: NOW },
    ],
    relations: [
      {
        id: "relation-update-agent",
        fromId: "relation-person-a",
        toId: "relation-person-b",
        label: "同事",
        basis: "原文：甲和乙是同事",
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
  });
  await openApp(page);
  await clickVisible(page, page.getByRole("button", { name: /^AI 助理/ }));
  const questionCard = page.getByText("问一问", { exact: true }).locator("..").locator("..");
  await questionCard.getByRole("textbox").fill("把甲和乙的关系改成前同事");
  await questionCard.getByRole("button", { name: "发送问题" }).click();

  const approval = questionCard.getByRole("region", { name: "待批准的批量档案修改" });
  await expect(approval).toContainText("同事");
  await expect(approval).toContainText("前同事");
  let relations = await readIndexedDbStore<{ label: string }>(page, "relations");
  expect(relations[0].label).toBe("同事");

  await approval.getByRole("button", { name: /签字并原子执行/ }).click();
  await expect(approval).toHaveCount(0);
  relations = await readIndexedDbStore<{ label: string }>(page, "relations");
  expect(relations[0].label).toBe("前同事");
});

test("AI 录入可检索并更新已有事件，确认前不覆盖原记录", async ({ page, mockNetwork }) => {
  await openApp(page);
  await seedIndexedDb(page, {
    lifeEvents: [
      {
        id: "event-update-agent",
        title: "团队聚餐",
        date: "2026-09-01",
        precision: "day",
        createdAt: NOW,
      },
    ],
  });
  await openApp(page);
  const intake = page.getByRole("heading", { name: /随手写，AI 来整理/ }).locator("..");
  await intake.getByRole("textbox").fill("把团队聚餐改到 9 月 2 日");
  await page.getByRole("button", { name: "AI 整理成档案" }).click();

  const eventDraft = page.locator('[data-draft-kind="event"]');
  await expect(eventDraft.getByRole("combobox", { name: "事件写入方式" })).toHaveValue(
    "event-update-agent",
  );
  await expect(eventDraft.getByRole("textbox", { name: "事件日期" })).toHaveValue("2026-09-02");
  let events = await readIndexedDbStore<{ id: string; date: string }>(page, "lifeEvents");
  expect(events).toEqual([
    expect.objectContaining({ id: "event-update-agent", date: "2026-09-01" }),
  ]);

  await eventDraft.getByRole("button", { name: "接受此项" }).click();
  await page.getByRole("button", { name: "确认入库" }).click();
  await expect(page.getByRole("button", { name: "确认入库" })).toHaveCount(0);
  events = await readIndexedDbStore<{ id: string; date: string }>(page, "lifeEvents");
  expect(events).toEqual([
    expect.objectContaining({ id: "event-update-agent", date: "2026-09-02" }),
  ]);
  expect(mockNetwork.visionRequests).toHaveLength(1);
});

test("日历中的既有事件可以原位编辑而不是重复新建", async ({ page }) => {
  await openApp(page);
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
  await seedIndexedDb(page, {
    lifeEvents: [
      {
        id: "event-direct-edit",
        title: "旧事件标题",
        detail: "旧细节",
        date: today,
        precision: "day",
        createdAt: NOW,
      },
    ],
  });
  await openApp(page);
  await clickVisible(page, page.getByRole("button", { name: /^日历/ }));
  const monthCalendar = page.getByText("公历 · 农历").locator("..").locator("..").locator("..");
  await expect(monthCalendar.getByRole("button", { name: /农历/ }).first()).toBeVisible();
  const calendarBox = await monthCalendar.boundingBox();
  expect(calendarBox?.height).toBeLessThan(620);
  await page.getByRole("button", { name: "编辑事件" }).click();
  const editor = page.getByRole("heading", { name: "编辑这件事" }).locator("..").locator("..");
  await editor.getByRole("textbox").last().fill("新事件标题\n新细节");
  await editor.getByRole("button", { name: "保存修改" }).click();

  const events = await readIndexedDbStore<{ id: string; title: string; detail?: string }>(
    page,
    "lifeEvents",
  );
  expect(events).toEqual([
    expect.objectContaining({ id: "event-direct-edit", title: "新事件标题", detail: "新细节" }),
  ]);
});

test("带日期的待办会进入月历和时间轴，并可在日历中完成", async ({ page }) => {
  await openApp(page);
  const due = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
  await seedIndexedDb(page, {
    reminders: [
      {
        id: "reminder-calendar",
        title: "给外婆打电话",
        detail: "确认周末是否回家吃饭",
        due,
        kind: "custom",
        done: false,
        createdAt: NOW,
      },
    ],
  });

  await clickVisible(page, page.getByRole("button", { name: /^日历/ }));
  await expect(page.getByRole("button", { name: new RegExp(`^${due}.*1 个待办`) })).toBeVisible();

  const dayTasks = page.getByRole("region", { name: `${due} 的待办` });
  await expect(dayTasks).toContainText("给外婆打电话");
  await expect(dayTasks).toContainText("确认周末是否回家吃饭");
  await dayTasks.getByRole("button", { name: "完成待办：给外婆打电话" }).click();
  await expect(dayTasks.getByText("给外婆打电话")).toHaveClass(/line-through/);

  const stored = await readIndexedDbStore<{ id: string; done: boolean }>(page, "reminders");
  expect(stored).toEqual([expect.objectContaining({ id: "reminder-calendar", done: true })]);

  await page.getByRole("button", { name: "时间轴" }).click();
  const timeline = page.getByRole("heading", { name: "时间轴" }).locator("..");
  await expect(timeline).toContainText("给外婆打电话");
});

test("资料不足时祝福与礼物建议明确提示缺口且保持可编辑", async ({ page }) => {
  await openApp(page);
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const birthday = `${String(tomorrow.getMonth() + 1).padStart(2, "0")}-${String(
    tomorrow.getDate(),
  ).padStart(2, "0")}`;
  await seedIndexedDb(page, {
    persons: [
      {
        id: "person-missing-profile",
        name: "合成测试人物",
        note: "",
        profile: { birthday },
        descriptors: [],
        thumb: "",
        createdAt: NOW,
      },
    ],
  });

  await clickVisible(page, page.getByRole("button", { name: /^提醒/ }));
  const birthdayItem = page.getByRole("listitem").filter({ hasText: "合成测试人物" });
  await birthdayItem.getByRole("button", { name: "祝福 / 礼物" }).click();
  const editable = page.getByRole("textbox", { name: "可编辑的祝福与礼物建议" });
  await expect(editable).toContainText("资料不足");
  await editable.fill("资料不足：先询问对方近期需要，再决定礼物。");
  await expect(editable).toHaveValue("资料不足：先询问对方近期需要，再决定礼物。");
});
