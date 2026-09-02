// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ReasoningDisclosure } from "./reasoning-disclosure";

afterEach(cleanup);

describe("ReasoningDisclosure", () => {
  it("expands structured public Agent events by stage", () => {
    const { container } = render(
      <ReasoningDisclosure
        label="分析轨迹"
        current="回答完成"
        steps={6}
        running={false}
        events={[
          { kind: "status", text: "准备人物索引" },
          { kind: "model", text: "需要核对人物关系" },
          { kind: "tool", text: "人物索引已返回" },
          { kind: "check", text: "关系引用校验通过" },
          { kind: "done", text: "回答完成" },
          { kind: "error", text: "一条外部查询不可用" },
        ]}
      />,
    );

    const trigger = screen.getByRole("button", { name: /分析轨迹 · 6 步/ });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("人物索引已返回")).not.toBeInTheDocument();

    fireEvent.click(trigger);

    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("人物索引已返回")).toBeVisible();
    expect(screen.getByText("关系引用校验通过")).toBeVisible();
    expect(screen.getByText("工具轨迹 1")).toBeVisible();
    expect(container.querySelectorAll("[data-trace-kind]")).toHaveLength(6);
    expect(container.querySelector('[data-trace-kind="model"]')).toHaveTextContent("模型摘要");
    expect(container.querySelector('[data-trace-kind="error"]')).toHaveTextContent("错误");
  });

  it("keeps the former string history compatible", () => {
    const { container } = render(
      <ReasoningDisclosure
        label="整理轨迹"
        current="旧记录二"
        steps={2}
        running
        history={["旧记录一", "旧记录二"]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /整理轨迹 · 2 步/ }));

    expect(screen.getByText("旧记录一")).toBeVisible();
    expect(container.querySelectorAll('[data-trace-kind="status"]')).toHaveLength(2);
  });
});
