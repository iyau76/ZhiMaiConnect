import { expect, test as base, type Page, type Route } from "@playwright/test";

export interface MockNetworkState {
  blockedExternalUrls: string[];
  unhandledApiUrls: string[];
  transcriptionRequests: unknown[];
  visionRequests: Array<Record<string, unknown>>;
}

const intakeDraft = {
  people: [
    {
      name: "唐悦",
      relation: "大学摄影社搭档",
      contact: "微信 tangyue_photo",
      birthday: "03-12",
      closeness: 5,
      likes: ["人像摄影", "手冲咖啡"],
      confidence: 0.94,
    },
  ],
  relations: [],
  events: [
    {
      title: "讨论校园记忆展",
      date: "2026-08-29",
      precision: "day",
      people: ["唐悦"],
      confidence: 0.9,
    },
  ],
  reminders: [
    {
      title: "给唐悦发送拍摄清单",
      due: "2026-08-28",
      people: ["唐悦"],
      kind: "custom",
      confidence: 0.91,
    },
  ],
  evidence: [],
  summary: "识别出一位大学同学、一项共同活动和一个待办；写入前仍可编辑。",
};

function visionReply(body: Record<string, unknown>) {
  if (body.action === "test") return "连接正常";
  const prompt = typeof body.prompt === "string" ? body.prompt : "";
  if (prompt.includes("结构化 JSON") || prompt.includes("structured JSON")) {
    return JSON.stringify(intakeDraft);
  }
  if (prompt.includes("以下候选及排序由本地确定性规则产生")) {
    return "首选陈安：人物档案明确记录了合同审阅经验。为什么不是赵宇：赵宇更擅长网站开发，缺少合同证据。\n\n可编辑话术：陈安你好，方便时能否帮我看一下租房合同中的违约条款？不用着急，我会先隐去无关个人信息。";
  }
  if (prompt.includes("明确写出“资料不足”")) {
    return "资料不足：目前只知道生日日期，缺少喜好、忌口和既往送礼记录。\n\n祝福：生日快乐，愿你新的一岁顺心。\n\n礼物建议：先询问近期需要，再决定礼物，不补写未知喜好。";
  }
  return "这是由 Playwright 本地 mock 返回的可编辑建议。";
}

async function handleRoute(route: Route, state: MockNetworkState) {
  const request = route.request();
  const url = new URL(request.url());

  if (url.pathname === "/api/status") {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "Cache-Control": "no-store" },
      body: JSON.stringify({
        ok: true,
        sessionToken: "playwright-session-token",
        lovableConfigured: true,
        customProxyHostsConfigured: false,
      }),
    });
    return;
  }

  if (url.pathname === "/api/vision") {
    const body = (request.postDataJSON() ?? {}) as Record<string, unknown>;
    state.visionRequests.push(body);
    await route.fulfill({
      status: 200,
      contentType: body.action === "test" ? "application/json" : "text/plain; charset=utf-8",
      headers: { "Cache-Control": "no-store" },
      body:
        body.action === "test" ? JSON.stringify({ reply: visionReply(body) }) : visionReply(body),
    });
    return;
  }

  if (url.pathname === "/api/transcribe") {
    state.transcriptionRequests.push(request.postDataJSON());
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "Cache-Control": "no-store" },
      body: JSON.stringify({ text: "唐悦是我的大学摄影社搭档。" }),
    });
    return;
  }

  if (url.pathname.startsWith("/api/")) {
    state.unhandledApiUrls.push(url.href);
    await route.fulfill({
      status: 501,
      contentType: "application/json",
      body: JSON.stringify({ error: "Unhandled Playwright API mock" }),
    });
    return;
  }

  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
    state.blockedExternalUrls.push(url.href);
    await route.abort("blockedbyclient");
    return;
  }

  await route.continue();
}

export const test = base.extend<{ mockNetwork: MockNetworkState }>({
  mockNetwork: [
    async ({ page }, fixtureUse) => {
      const state: MockNetworkState = {
        blockedExternalUrls: [],
        unhandledApiUrls: [],
        transcriptionRequests: [],
        visionRequests: [],
      };
      await page.route("**/*", (route) => handleRoute(route, state));
      await page.addInitScript(() => {
        if (!sessionStorage.getItem("zhimai.playwright.initialized")) {
          localStorage.clear();
          sessionStorage.clear();
          sessionStorage.setItem("zhimai.playwright.initialized", "1");
          localStorage.setItem("openglass.welcomeSeen", "1");
          localStorage.setItem("openglass.lang", "zh");
        }
      });
      page.on("dialog", (dialog) => dialog.accept());
      await fixtureUse(state);
      expect(state.unhandledApiUrls).toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

export async function openApp(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "AI 整理成档案" })).toBeVisible();
  // The 50/80 graph smoke test can briefly saturate the dev server when two
  // workers start together, so wait for actual hydration instead of treating
  // SSR visibility as interactivity.
  await expect(page.locator('[data-app-hydrated="true"]')).toBeVisible({ timeout: 30_000 });
  const start = page.getByRole("button", { name: "开始使用" });
  if (await start.isVisible()) await start.click();
}

export async function clickVisible(page: Page, locator: ReturnType<Page["getByRole"]>) {
  for (const candidate of await locator.all()) {
    if (await candidate.isVisible()) {
      await candidate.click();
      return;
    }
  }
  throw new Error(`没有找到可见元素：${await locator.allTextContents()}`);
}

export async function acceptAllDraftItems(page: Page) {
  const batch = page.getByRole("button", { name: /批量接受低风险高置信事件/ });
  if (await batch.isVisible()) {
    await batch.click();
    await expect(batch).toHaveCount(0);
  }
  const pending = page.getByRole("button", { name: "接受此项" });
  const initialCount = await pending.count();
  for (let index = initialCount; index > 0; index -= 1) {
    await pending.first().click();
    await expect(pending).toHaveCount(index - 1);
  }
}

export interface DraftCardSnapshot {
  kind: string | null;
  index: string | null;
  audit: {
    text: string;
    acceptDisabled: boolean | null;
  };
  controls: Array<{
    tag: string;
    type: string | null;
    name: string | null;
    placeholder: string | null;
    ariaLabel: string | null;
    value: string;
    checked: boolean | null;
    disabled: boolean;
  }>;
}

/** Capture every editable value and the review line for every top-level intake item. */
export async function snapshotDraftCards(page: Page): Promise<DraftCardSnapshot[]> {
  return page.locator("[data-draft-kind]").evaluateAll((cards) =>
    cards.map((card) => {
      const auditLine = card.firstElementChild;
      const acceptButton = Array.from(auditLine?.querySelectorAll("button") ?? []).find((button) =>
        ["接受此项", "已接受", "Accept item", "Accepted"].includes(
          button.textContent?.trim() ?? "",
        ),
      );
      const controls = Array.from(
        card.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
          "input, textarea, select",
        ),
      );

      return {
        kind: card.getAttribute("data-draft-kind"),
        index: card.getAttribute("data-draft-index"),
        audit: {
          text: auditLine?.textContent?.replace(/\s+/g, " ").trim() ?? "",
          acceptDisabled: acceptButton instanceof HTMLButtonElement ? acceptButton.disabled : null,
        },
        controls: controls.map((control) => ({
          tag: control.tagName.toLowerCase(),
          type: control instanceof HTMLInputElement ? control.type : null,
          name: control.getAttribute("name"),
          placeholder: control.getAttribute("placeholder"),
          ariaLabel: control.getAttribute("aria-label"),
          value: control.value,
          checked:
            control instanceof HTMLInputElement && ["checkbox", "radio"].includes(control.type)
              ? control.checked
              : null,
          disabled: control.disabled,
        })),
      };
    }),
  );
}

interface SeedRecord {
  id: string;
  [key: string]: unknown;
}

export interface IndexedDbSeed {
  persons?: SeedRecord[];
  relations?: SeedRecord[];
  evidence?: SeedRecord[];
  lifeEvents?: SeedRecord[];
  reminders?: SeedRecord[];
}

export async function seedIndexedDb(page: Page, seed: IndexedDbSeed) {
  await page.evaluate(async (records) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("openglass-faces", 8);
      request.onupgradeneeded = () => {
        const target = request.result;
        const stores = [
          "persons",
          "sightings",
          "relations",
          "evidence",
          "voiceprints",
          "caseEvents",
          "tasks",
          "projects",
          "lifeEvents",
          "reminders",
        ];
        stores.forEach((store) => {
          if (!target.objectStoreNames.contains(store)) {
            target.createObjectStore(store, { keyPath: "id" });
          }
        });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const entries = Object.entries(records).filter(([, rows]) => rows?.length) as Array<
      [string, SeedRecord[]]
    >;
    if (!entries.length) return;
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(
        entries.map(([store]) => store),
        "readwrite",
      );
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
      entries.forEach(([store, rows]) => {
        rows.forEach((row) => transaction.objectStore(store).put(row));
      });
    });
  }, seed);
}

export async function readIndexedDbStore<T = SeedRecord>(page: Page, store: string) {
  return page.evaluate(async (storeName) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("openglass-faces", 8);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    if (!db.objectStoreNames.contains(storeName)) return [];
    return new Promise<T[]>((resolve, reject) => {
      const request = db.transaction(storeName, "readonly").objectStore(storeName).getAll();
      request.onsuccess = () => resolve(request.result as T[]);
      request.onerror = () => reject(request.error);
    });
  }, store);
}
