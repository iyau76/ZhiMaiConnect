// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveSavedAgentBudget } from "@/lib/agent-observability";
import { AGENT_BUDGET_PRESETS } from "@/lib/agent-runtime";
import { AgentControlCenter } from "./agent-control-center";

vi.mock("@/components/agent-run-inspector", () => ({
  AgentRunInspector: () => null,
}));

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
});

function budgetInput(label: string) {
  return screen.getByLabelText(label) as HTMLInputElement;
}

describe("AgentControlCenter budgets", () => {
  it("uses the same standard default in the control center and every Agent runtime", () => {
    render(<AgentControlCenter />);

    expect(screen.getByText(/standard · 最多 7 轮/)).toBeInTheDocument();
    expect(budgetInput("轮次")).toHaveValue(AGENT_BUDGET_PRESETS.standard.maxRounds);
    expect(resolveSavedAgentBudget("deep")).toEqual(AGENT_BUDGET_PRESETS.standard);
  });

  it("shows and rehydrates every deep preset value after leaving the page", () => {
    const first = render(<AgentControlCenter />);
    fireEvent.click(screen.getByRole("button", { name: "deep" }));

    expect(budgetInput("轮次")).toHaveValue(AGENT_BUDGET_PRESETS.deep.maxRounds);
    expect(budgetInput("工具调用")).toHaveValue(AGENT_BUDGET_PRESETS.deep.maxToolCalls);
    expect(budgetInput("输入 token")).toHaveValue(AGENT_BUDGET_PRESETS.deep.maxInputTokens);
    expect(budgetInput("输出 token")).toHaveValue(AGENT_BUDGET_PRESETS.deep.maxOutputTokens);
    expect(budgetInput("总时限 ms")).toHaveValue(AGENT_BUDGET_PRESETS.deep.maxWallTimeMs);
    expect(resolveSavedAgentBudget()).toEqual(AGENT_BUDGET_PRESETS.deep);

    first.unmount();
    render(<AgentControlCenter />);

    expect(budgetInput("轮次")).toHaveValue(AGENT_BUDGET_PRESETS.deep.maxRounds);
    expect(budgetInput("工具调用")).toHaveValue(AGENT_BUDGET_PRESETS.deep.maxToolCalls);
    expect(budgetInput("输入 token")).toHaveValue(AGENT_BUDGET_PRESETS.deep.maxInputTokens);
    expect(budgetInput("输出 token")).toHaveValue(AGENT_BUDGET_PRESETS.deep.maxOutputTokens);
    expect(budgetInput("总时限 ms")).toHaveValue(AGENT_BUDGET_PRESETS.deep.maxWallTimeMs);
    expect(JSON.parse(localStorage.getItem("zhimai.agent-settings.v2") ?? "null")).toMatchObject({
      profile: "deep",
    });
    expect(resolveSavedAgentBudget()).toEqual(AGENT_BUDGET_PRESETS.deep);
  });

  it("auto-saves a custom field and rehydrates the whole custom budget", () => {
    const first = render(<AgentControlCenter />);
    fireEvent.change(budgetInput("轮次"), { target: { value: "11" } });

    expect(screen.getByRole("status")).toHaveTextContent("已自动保存");
    expect(JSON.parse(localStorage.getItem("zhimai.agent-settings.v2") ?? "null")).toMatchObject({
      profile: "custom",
      customBudget: {
        ...AGENT_BUDGET_PRESETS.standard,
        maxRounds: 11,
      },
    });
    expect(resolveSavedAgentBudget().maxRounds).toBe(11);

    first.unmount();
    render(<AgentControlCenter />);

    expect(budgetInput("轮次")).toHaveValue(11);
    expect(budgetInput("工具调用")).toHaveValue(AGENT_BUDGET_PRESETS.standard.maxToolCalls);
    expect(screen.getByText(/custom · 最多 11 轮/)).toBeInTheDocument();
  });

  it("persists full authorization while keeping it visibly selected", () => {
    const first = render(<AgentControlCenter />);
    fireEvent.click(screen.getByRole("button", { name: "全权 · 自动提交" }));

    expect(JSON.parse(localStorage.getItem("zhimai.agent-settings.v2") ?? "null")).toMatchObject({
      authorizationMode: "full",
    });

    first.unmount();
    render(<AgentControlCenter />);
    expect(screen.getByRole("button", { name: "全权 · 自动提交" })).toHaveClass("bg-primary");
  });
});
