import { afterEach, describe, expect, it, vi } from "vitest";

import { clearCloudTransferConsents, confirmCloudTransfer } from "./cloud-consent";
import type { ProviderPreset } from "./vision-providers";

function preset(overrides: Partial<ProviderPreset> = {}): ProviderPreset {
  return {
    id: "provider-1",
    name: "团队模型",
    kind: "openai",
    baseUrl: "https://example.com/v1",
    model: "example-model",
    apiKey: "test-only",
    ...overrides,
  };
}

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("confirmCloudTransfer", () => {
  it("does not ask for consent when all processing stays in local Ollama", () => {
    vi.stubGlobal("window", undefined);
    vi.stubGlobal("sessionStorage", undefined);

    expect(() =>
      confirmCloudTransfer(preset({ kind: "ollama" }), ["文字内容", "人物关系上下文"]),
    ).not.toThrow();
  });

  it("refuses cloud transfer when an interactive browser confirmation is unavailable", () => {
    vi.stubGlobal("window", undefined);

    expect(() => confirmCloudTransfer(preset(), ["文字内容"])).toThrow(
      "云模型调用只能在浏览器中经用户确认后进行",
    );
  });

  it("names the provider and every distinct data type in the confirmation", () => {
    const confirm = vi.fn((_message: string) => true);
    vi.stubGlobal("window", { confirm });
    vi.stubGlobal("sessionStorage", memoryStorage());

    confirmCloudTransfer(preset({ name: "校园私有模型" }), ["图片", "文字内容", "图片"]);

    expect(confirm).toHaveBeenCalledOnce();
    expect(confirm.mock.calls[0][0]).toContain("图片、文字内容");
    expect(confirm.mock.calls[0][0]).toContain("校园私有模型");
    expect(confirm.mock.calls[0][0]).toContain("不会被整库上传");
  });

  it("remembers equivalent consent regardless of data-type order within the session", () => {
    const confirm = vi.fn((_message: string) => true);
    vi.stubGlobal("window", { confirm });
    vi.stubGlobal("sessionStorage", memoryStorage());

    confirmCloudTransfer(preset(), ["图片", "文字内容", "图片"]);
    confirmCloudTransfer(preset(), ["文字内容", "图片"]);

    expect(confirm).toHaveBeenCalledOnce();
  });

  it("asks again when a new data type is sent", () => {
    const confirm = vi.fn((_message: string) => true);
    vi.stubGlobal("window", { confirm });
    vi.stubGlobal("sessionStorage", memoryStorage());

    confirmCloudTransfer(preset(), ["文字内容"]);
    confirmCloudTransfer(preset(), ["文字内容", "人物关系上下文"]);

    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it("does not persist rejected consent", () => {
    const confirm = vi.fn((_message: string) => false);
    vi.stubGlobal("window", { confirm });
    vi.stubGlobal("sessionStorage", memoryStorage());

    expect(() => confirmCloudTransfer(preset(), ["音频"])).toThrow("已取消向云模型发送数据");
    expect(() => confirmCloudTransfer(preset(), ["音频"])).toThrow("已取消向云模型发送数据");
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it("can clear all remembered cloud-transfer consent", () => {
    const confirm = vi.fn((_message: string) => true);
    vi.stubGlobal("window", { confirm });
    vi.stubGlobal("sessionStorage", memoryStorage());

    confirmCloudTransfer(preset(), ["文字内容"]);
    clearCloudTransferConsents();
    confirmCloudTransfer(preset(), ["文字内容"]);

    expect(confirm).toHaveBeenCalledTimes(2);
  });
});
