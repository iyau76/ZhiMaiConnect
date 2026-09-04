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
  await expect(editor.getByRole("textbox", { name: /发生了什么/ })).toHaveValue("讨论校园记忆展");
  await editor.getByRole("textbox", { name: /发生了什么/ }).fill("确认校园记忆展拍摄分工");
  await editor.getByRole("button", { name: "保存修改" }).click();

  const events = await readIndexedDbStore<{ id: string; title: string }>(page, "lifeEvents");
  expect(events).toEqual([
    expect.objectContaining({ id: "event-today", title: "确认校园记忆展拍摄分工" }),
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

  await clickVisible(page, page.getByRole("button", { name: /^今天/ }));
  await page.locator('[data-today-item-id="birthday:person-tang"]').click();
  await expect(page.getByRole("heading", { name: "编辑人员资料" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "姓名" })).toHaveValue("唐悦");
});
