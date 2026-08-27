// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Button } from "./button";

afterEach(cleanup);

describe("Button", () => {
  it("renders an accessible button and forwards click events", () => {
    const onClick = vi.fn();

    render(<Button onClick={onClick}>Save contact</Button>);
    fireEvent.click(screen.getByRole("button", { name: "Save contact" }));

    expect(onClick).toHaveBeenCalledOnce();
  });

  it("exposes the disabled state and blocks click events", () => {
    const onClick = vi.fn();

    render(
      <Button disabled onClick={onClick}>
        Save contact
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Save contact" });

    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });
});
