// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentRunInspector } from "./agent-run-inspector";
import {
  MemoryAgentRunRecorder,
  projectAgentRun,
  redactAgentPayload,
  type AgentRun,
} from "@/lib/agent-run-log";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const SAMPLE_RUN: AgentRun = {
  id: "run-audit-001",
  title: "整理人物档案",
  agentName: "录入 Agent",
  model: "deepseek-chat",
  status: "completed",
  rounds: 3,
  tokenUsage: { input: 2_400, output: 1_200, total: 3_600 },
  durationMs: 18_400,
  steps: [
    {
      id: "search",
      round: 1,
      kind: "tool",
      status: "completed",
      title: "检索已有档案",
      toolName: "search_profiles",
      durationMs: 230,
      input: { query: "唐悦", apiKey: "sk-secret-value" },
      output: { matches: [{ id: "person-1", name: "唐悦" }] },
    },
    {
      id: "validate",
      round: 2,
      kind: "validation",
      status: "completed",
      title: "校验增量提案",
      output: { ok: true },
    },
    {
      id: "proposal",
      round: 2,
      kind: "proposal",
      status: "completed",
      title: "人物与关系修改提案",
      input: { changes: [{ type: "relation", label: "前同事" }] },
    },
    {
      id: "approval",
      round: 3,
      kind: "approval",
      status: "completed",
      title: "用户批准",
      output: { approved: true, authorization: "Bearer hidden-token" },
    },
  ],
};

describe("AgentRunInspector", () => {
  it("renders an accessible summary and a bounded, round-based details dialog", () => {
    render(<AgentRunInspector run={SAMPLE_RUN} />);

    const trigger = screen.getByRole("button", {
      name: /运行详情：完成 · 3 轮 · 1 个工具 · 3\.6k token · 18\.4s/,
    });
    expect(trigger).toHaveTextContent("完成");
    expect(trigger).toHaveTextContent("3 轮 · 1 个工具 · 3.6k token · 18.4s");
    expect(trigger.tagName).toBe("BUTTON");
    expect(trigger).not.toHaveAttribute("tabindex", "-1");

    trigger.focus();
    expect(trigger).toHaveFocus();
    fireEvent.click(trigger);

    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAccessibleName("整理人物档案");
    expect(dialog).toHaveClass("max-h-[calc(100vh-2rem)]", "w-[calc(100vw-2rem)]");
    expect(within(dialog).getByText("第 1 轮")).toBeVisible();
    expect(within(dialog).getByText("第 2 轮")).toBeVisible();
    expect(within(dialog).getByText("第 3 轮")).toBeVisible();
    expect(within(dialog).getByText("search_profiles")).toBeVisible();
    expect(within(dialog).getByText("验证")).toBeVisible();
    expect(within(dialog).getByText("提案")).toBeVisible();
    expect(within(dialog).getByText("批准")).toBeVisible();

    const payloads = dialog.querySelectorAll("details");
    expect(payloads.length).toBeGreaterThan(0);
    payloads.forEach((details) => expect(details).not.toHaveAttribute("open"));

    fireEvent.click(within(payloads[0] as HTMLElement).getByText("参数与结果"));
    expect(payloads[0]).toHaveAttribute("open");
    expect(within(payloads[0] as HTMLElement).getByText(/\[REDACTED\]/)).toBeVisible();
  });

  it("copies only a sanitized JSON representation", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render(<AgentRunInspector run={SAMPLE_RUN} redactKeys={["name"]} />);

    fireEvent.click(screen.getByRole("button", { name: /运行详情/ }));
    fireEvent.click(screen.getByRole("button", { name: "复制运行 JSON" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
    const copied = writeText.mock.calls[0][0] as string;
    expect(copied).toContain('"apiKey": "[REDACTED]"');
    expect(copied).toContain('"authorization": "[REDACTED]"');
    expect(copied).toContain('"name": "[REDACTED]"');
    expect(copied).not.toContain("sk-secret-value");
    expect(copied).not.toContain("hidden-token");
    expect(screen.getAllByText("已复制").length).toBeGreaterThan(0);
  });

  it("bounds hostile payloads without throwing", () => {
    const circular: Record<string, unknown> = {
      token: "secret-token",
      note: "Authorization: Bearer abc.def.ghi",
      huge: "x".repeat(9_000),
    };
    circular.self = circular;

    const sanitized = redactAgentPayload(circular) as Record<string, unknown>;
    expect(sanitized.token).toBe("[REDACTED]");
    expect(sanitized.note).toBe("Authorization: Bearer [REDACTED]");
    expect(sanitized.self).toBe("[CIRCULAR]");
    expect(String(sanitized.huge)).toContain("[TRUNCATED]");
  });

  it("does not present missing provider usage as an actual zero-token run", () => {
    render(
      <AgentRunInspector
        run={{
          id: "run-without-usage",
          status: "running",
          steps: [],
        }}
      />,
    );

    const trigger = screen.getByRole("button", { name: /运行详情/ });
    expect(trigger).toHaveTextContent("token 未知");
    expect(trigger).not.toHaveTextContent("0 token");
  });

  it("marks a mixed actual and estimated token total as approximate", () => {
    render(
      <AgentRunInspector
        run={{
          id: "run-mixed-usage",
          status: "completed",
          tokenUsage: { total: 1_500 },
          estimatedTokens: 500,
          steps: [],
        }}
      />,
    );

    expect(screen.getByRole("button", { name: /运行详情/ })).toHaveTextContent("≈1.5k token");
  });

  it("renders one tool action when the runtime ledger contains a call and its result", () => {
    const recorder = new MemoryAgentRunRecorder({ runId: "run-projected" });
    recorder.record({
      kind: "tool_call",
      status: "started",
      round: 1,
      toolName: "search_profiles",
      invocationId: "invocation-1",
      at: 1_000,
      payload: { query: "唐悦" },
      usage: { input: { value: 300, source: "actual" } },
    });
    recorder.record({
      kind: "validation",
      status: "succeeded",
      round: 1,
      toolName: "search_profiles",
      invocationId: "invocation-1",
      at: 1_050,
      payload: { valid: true },
    });
    recorder.record({
      kind: "tool_result",
      status: "succeeded",
      round: 1,
      toolName: "search_profiles",
      invocationId: "invocation-1",
      at: 1_200,
      durationMs: 200,
      payload: { matches: 1 },
      usage: { output: { value: 100, source: "estimated" } },
    });
    const run = projectAgentRun(recorder.events(), {
      id: recorder.runId,
      title: "投影运行",
    });

    expect(run.steps.filter((step) => step.kind === "tool")).toHaveLength(1);
    expect(run.steps.find((step) => step.kind === "tool")).toMatchObject({
      input: { query: "唐悦" },
      output: { matches: 1 },
      durationMs: 200,
    });
    expect(run.tokenUsage?.provenance).toBe("mixed");

    render(<AgentRunInspector run={run} />);
    const trigger = screen.getByRole("button", { name: /运行详情/ });
    expect(trigger).toHaveTextContent("1 个工具");
    expect(trigger).toHaveTextContent("≈400 token");
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog");
    const toolRows = dialog.querySelectorAll('[data-agent-step="tool"]');
    expect(toolRows).toHaveLength(1);
    expect(within(toolRows[0] as HTMLElement).getByText("search_profiles")).toBeVisible();
    fireEvent.click(within(toolRows[0] as HTMLElement).getByText("参数与结果"));
    expect(within(toolRows[0] as HTMLElement).getByText(/"query": "唐悦"/)).toBeVisible();
    expect(within(toolRows[0] as HTMLElement).getByText(/"matches": 1/)).toBeVisible();
  });
});
