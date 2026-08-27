// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { beforeEach, describe, expect, it, vi } from "vitest";

const ENGLISH_TITLE = "Zhimai Connect · Relationship Memory & Action Assistant";
const ENGLISH_DESCRIPTION =
  "A local-first, evidence-traceable relationship memory and action assistant.";
const CHINESE_TITLE = "知脉 Connect · 人际关系记忆与行动助手";
const CHINESE_DESCRIPTION = "本地优先、证据可追溯的人际关系记忆与行动助手。";

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  document.documentElement.lang = "";
  document.head.innerHTML = '<meta name="description" content="stale">';
  document.title = "stale";
});

describe("document language metadata", () => {
  it("initLang restores English and synchronizes the document", async () => {
    localStorage.setItem("openglass.lang", "en");
    const { getLang, initLang } = await import("./i18n");

    initLang();

    expect(getLang()).toBe("en");
    expect(document.documentElement).toHaveAttribute("lang", "en");
    expect(document.title).toBe(ENGLISH_TITLE);
    expect(document.querySelector('meta[name="description"]')).toHaveAttribute(
      "content",
      ENGLISH_DESCRIPTION,
    );
  });

  it("setLang keeps the html language, title, and description in sync", async () => {
    const { setLang } = await import("./i18n");

    setLang("en");
    expect(document.documentElement).toHaveAttribute("lang", "en");
    expect(document.title).toBe(ENGLISH_TITLE);
    expect(document.querySelector('meta[name="description"]')).toHaveAttribute(
      "content",
      ENGLISH_DESCRIPTION,
    );

    setLang("zh");
    expect(document.documentElement).toHaveAttribute("lang", "zh-CN");
    expect(document.title).toBe(CHINESE_TITLE);
    expect(document.querySelector('meta[name="description"]')).toHaveAttribute(
      "content",
      CHINESE_DESCRIPTION,
    );
  });
});
