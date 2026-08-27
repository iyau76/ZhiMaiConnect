// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { LanguageToggle } from "./appearance-controls";
import { setLang } from "../lib/i18n";

beforeEach(() => {
  localStorage.clear();
  setLang("zh");
});

describe("LanguageToggle accessibility", () => {
  it("updates pressed state and accessible names with the active language", () => {
    render(<LanguageToggle />);
    expect(screen.getByRole("button", { name: "切换为中文" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    fireEvent.click(screen.getByRole("button", { name: "切换为英文" }));

    expect(document.documentElement).toHaveAttribute("lang", "en");
    expect(screen.getByRole("button", { name: "Switch to English" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Switch to Chinese" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });
});
