import { clickVisible, expect, openApp, readIndexedDbStore, seedIndexedDb, test } from "./fixtures";

const NOW = new Date("2026-09-05T08:00:00+08:00").getTime();

test("今天页从源记录汇总事项，并回到同一事件完成原位编辑", async ({ page }) => {
  await openApp(page, { initialView: "today" });
  await seedIndexedDb(page, {
    persons: [
      {
        id: "person-tang",
        name: "唐悦",
        note: "大学摄影社搭档",
        profile: { birthday: "09-06" },
        descriptors: [],
        thumb: "",
        createdAt: NOW,
      },
    ],
    lifeEvents: [
      {
        id: "event-today",
        date: "2026-09-05",
        timeText: "下午3点",
        place: "书店",
        kind: "meeting",
        title: "讨论校园记忆展",
        personIds: ["person-tang"],
        createdAt: NOW,
      },
    ],
    reminders: [
      {
        id: "reminder-today",
        title: "把拍摄清单发给唐悦",
        due: "2026-09-05",
        personIds: ["person-tang"],
        done: false,
        createdAt: NOW,
      },
    ],
    tasks: [
      {
        id: "task-open",
        title: "补充展览预算",
        priority: "normal",
        status: "doing",
        createdAt: NOW,
      },
    ],
  });
  await page.reload();
  await expect(page.locator('[data-app-hydrated="true"]')).toBeVisible();

  await expect(page.locator('[data-today-item-id="event:event-today"]')).toBeVisible();
  await expect(page.locator('[data-today-item-id="reminder:reminder-today"]')).toBeVisible();
  await expect(page.locator('[data-today-item-id="task:task-open"]')).toBeVisible();
  await expect(page.locator('[data-today-item-id="birthday:person-tang"]')).toBeVisible();

  await page.locator('[data-today-item-id="event:event-today"]').click();
  await expect(page.getByRole("heading", { name: "编辑这件事" })).toBeVisible();
  const editor = page.locator("[data-event-editor]");
  await expect(editor.getByRole("textbox", { name: "具体时间（可选）" })).toHaveValue("下午3点");
  await expect(editor.getByRole("textbox", { name: /发生了什么/ })).toHaveValue("讨论校园记忆展");
  await editor.getByRole("textbox", { name: /发生了什么/ }).fill("确认校园记忆展拍摄分工");
  await editor.getByRole("button", { name: "保存修改" }).click();

  const events = await readIndexedDbStore<{ id: string; title: string }>(page, "lifeEvents");
  expect(events).toEqual([
    expect.objectContaining({
      id: "event-today",
      title: "确认校园记忆展拍摄分工",
      timeText: "下午3点",
      place: "书店",
      kind: "meeting",
    }),
  ]);

  await clickVisible(page, page.getByRole("button", { name: /^今天/ }));
  await expect(page.locator('[data-today-item-id="event:event-today"]')).toContainText(
    "确认校园记忆展拍摄分工",
  );
  await page.locator('[data-today-item-id="reminder:reminder-today"]').click();
  await expect(page.locator('[data-reminder-id="reminder-today"]')).toHaveClass(/ring-2/);

  await clickVisible(page, page.getByRole("button", { name: /^今天/ }));
  await page.locator('[data-today-item-id="task:task-open"]').click();
  await expect(page.locator('[data-task-id="task-open"]')).toHaveClass(/ring-2/);
  await page.getByRole("button", { name: "编辑任务：补充展览预算" }).click();
  const taskEditor = page.getByRole("dialog");
  await taskEditor.getByRole("textbox", { name: "任务标题" }).fill("确认印刷报价");
  await taskEditor.getByRole("textbox", { name: "任务详情" }).fill("向两家印刷店询价");
  await taskEditor.getByLabel("截止日期").fill("2026-09-09");
  await taskEditor.getByLabel("负责人", { exact: true }).fill("唐悦");
  await taskEditor.getByLabel("优先级").selectOption("high");
  await taskEditor.getByRole("checkbox", { name: "唐悦" }).check();
  await taskEditor.getByRole("button", { name: "保存任务" }).click();
  await expect(taskEditor).toBeHidden();
  await page.reload();
  await expect(page.locator('[data-app-hydrated="true"]')).toBeVisible();
  expect(await readIndexedDbStore(page, "tasks")).toEqual([
    expect.objectContaining({
      id: "task-open",
      title: "确认印刷报价",
      detail: "向两家印刷店询价",
      due: "2026-09-09",
      assignee: "唐悦",
      priority: "high",
      status: "doing",
      personIds: ["person-tang"],
    }),
  ]);

  await clickVisible(page, page.getByRole("button", { name: /^今天/ }));
  await page.locator('[data-today-item-id="birthday:person-tang"]').click();
  await expect(page.getByRole("heading", { name: "编辑人员资料" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "姓名" })).toHaveValue("唐悦");
});

test("完成提醒后可把实际结果补记为同一人物的时间线事件", async ({ page }) => {
  await openApp(page, { initialView: "today" });
  await seedIndexedDb(page, {
    persons: [
      {
        id: "person-tang",
        name: "唐悦",
        note: "校园摄影搭档",
        descriptors: [],
        thumb: "",
        createdAt: NOW,
      },
    ],
    reminders: [
      {
        id: "reminder-follow-up",
        title: "把拍摄清单发给唐悦",
        due: "2026-09-05",
        personIds: ["person-tang"],
        done: false,
        createdAt: NOW,
      },
    ],
  });
  await page.reload();
  await page.locator('[data-today-item-id="reminder:reminder-follow-up"]').click();

  await page.getByRole("button", { name: "完成待办：把拍摄清单发给唐悦" }).click();
  const outcome = page.getByRole("textbox", { name: "这件事最后怎么样了" });
  await expect(outcome).toBeVisible();
  await outcome.fill("已经发出拍摄清单\n唐悦说明天确认档期");
  await page.getByRole("button", { name: "保存到时间线" }).click();

  const reminders = await readIndexedDbStore<{
    id: string;
    done: boolean;
    completionEventId?: string;
  }>(page, "reminders");
  expect(reminders).toEqual([
    expect.objectContaining({
      id: "reminder-follow-up",
      done: true,
      completionEventId: expect.any(String),
    }),
  ]);
  const resultEventId = reminders[0].completionEventId!;
  const events = await readIndexedDbStore<{
    id: string;
    title: string;
    detail?: string;
    personIds?: string[];
  }>(page, "lifeEvents");
  expect(events).toEqual([
    expect.objectContaining({
      id: resultEventId,
      title: "已经发出拍摄清单",
      detail: "唐悦说明天确认档期",
      personIds: ["person-tang"],
    }),
  ]);

  await page.getByRole("button", { name: "查看结果" }).click();
  await expect(page.getByRole("heading", { name: "编辑这件事" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: /发生了什么/ })).toHaveValue(
    "已经发出拍摄清单\n唐悦说明天确认档期",
  );
});

test("一句话生成见面简报，源档案变化后保留旧版并生成新版", async ({ page }) => {
  await openApp(page, { initialView: "today" });
  await seedIndexedDb(page, {
    persons: [
      {
        id: "person-tang",
        name: "唐悦",
        note: "大学摄影社搭档",
        profile: {
          relation: "大学同学",
          org: "九月校园记忆展",
          title: "活动摄影师",
          likes: ["胶片摄影"],
          metAt: "大学摄影社",
        },
        descriptors: [],
        thumb: "",
        createdAt: NOW,
      },
    ],
    lifeEvents: [
      {
        id: "event-memory",
        date: "2026-08-20",
        title: "讨论校园记忆展",
        personIds: ["person-tang"],
        createdAt: NOW,
      },
    ],
    reminders: [
      {
        id: "reminder-shoot",
        title: "确认拍摄档期",
        personIds: ["person-tang"],
        done: false,
        createdAt: NOW,
      },
    ],
  });
  await page.reload();
  await expect(page.locator('[data-app-hydrated="true"]')).toBeVisible();

  await page.getByRole("textbox", { name: "输入要见的人" }).fill("明天要见唐悦");
  await page.getByRole("button", { name: "准备简报" }).click();
  await expect(page.getByRole("dialog")).toContainText("为 唐悦 准备第一次见面简报");
  await page.getByRole("button", { name: "生成并保存" }).click();
  await expect(page.getByRole("dialog")).toContainText("见面前看看：唐悦");
  await expect(page.getByRole("dialog")).toContainText("活动摄影师");
  await expect(page.getByRole("dialog")).toContainText("讨论校园记忆展");

  const firstVersions = await readIndexedDbStore<{ id: string; personId: string }>(
    page,
    "meetingBriefs",
  );
  expect(firstVersions).toHaveLength(1);
  const firstId = firstVersions[0].id;

  await page.evaluate(async () => {
    const { facesDb } = await import("/src/lib/face-db.ts");
    const person = (await facesDb.listPersons()).find((item) => item.id === "person-tang");
    if (!person) throw new Error("missing seeded person");
    await facesDb.putPerson({
      ...person,
      profile: { ...person.profile, title: "影像负责人" },
      updatedAt: Date.now(),
    });
  });
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "准备简报" }).click();
  await expect(page.getByRole("dialog")).toContainText("有更新");
  await expect(page.getByRole("dialog")).toContainText("活动摄影师");
  await page.getByRole("button", { name: "生成新版" }).click();
  await expect(page.getByRole("dialog")).toContainText("影像负责人");

  const versions = await readIndexedDbStore<{
    id: string;
    seriesId: string;
    supersedesBriefId?: string;
  }>(page, "meetingBriefs");
  expect(versions).toHaveLength(2);
  expect(versions).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: firstId }),
      expect.objectContaining({ seriesId: firstId, supersedesBriefId: firstId }),
    ]),
  );

  await page.getByLabel("选择简报版本").selectOption(firstId);
  await expect(page.getByRole("dialog")).toContainText("历史版本");
  await expect(page.getByRole("dialog")).toContainText("活动摄影师");
});
