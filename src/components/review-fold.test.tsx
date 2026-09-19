// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ReviewFold } from "./review-fold";

afterEach(cleanup);

describe("ReviewFold", () => {
  it("opens automatically when a relationship needs review", () => {
    const { container } = render(
      <ReviewFold title="新关系" attention>
        <p>AI 推断，待核验</p>
      </ReviewFold>,
    );

    expect(screen.getByRole("button", { name: "展开或收起：新关系" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByText("AI 推断，待核验")).toBeVisible();
    expect(container.querySelector("[data-review-attention=true]")).toBeInTheDocument();
  });

  it("keeps reference-only sections collapsed by default", () => {
    const { container } = render(
      <ReviewFold title="来源材料">
        <p>材料内容</p>
      </ReviewFold>,
    );

    expect(screen.getByRole("button", { name: "展开或收起：来源材料" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.queryByText("材料内容")).not.toBeInTheDocument();
    expect(container.querySelector("[data-review-attention=true]")).not.toBeInTheDocument();
  });
});
