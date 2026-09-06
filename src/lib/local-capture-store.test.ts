import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  captureText,
  listCaptures,
  removeCapture,
  saveCapture,
  validateCapture,
} from "./local-capture-store";

describe("local capture inbox", () => {
  beforeEach(async () => {
    for (const item of await listCaptures()) await removeCapture(item.id);
  });
  it("keeps independent stable IDs and does not expire yesterday's material", async () => {
    const first = await saveCapture({ title: "合成材料", text: "许星喜欢摄影", files: [] });
    const second = await saveCapture({
      title: "同样的文字也可能是另一次记录",
      text: first.text,
      files: [],
    });
    expect(first.id).not.toBe(second.id);
    expect((await listCaptures()).map((item) => item.id)).toEqual([first.id, second.id]);
    await removeCapture(first.id);
    expect(await listCaptures()).toEqual([second]);
    await removeCapture(first.id);
    expect(await listCaptures()).toEqual([second]);
  });
  it("joins shared text, title and URL without guessing their meaning", () => {
    expect(captureText("活动记录", "活动记录", "https://example.invalid/event")).toBe(
      "活动记录\n\nhttps://example.invalid/event",
    );
  });
  it("validates capacity before persisting input", async () => {
    await expect(saveCapture({ title: "", text: "", files: [] })).rejects.toThrow("没有收到");
    expect(() => validateCapture({ text: "a".repeat(100_001), files: [] })).toThrow("文字过长");
    expect(() =>
      validateCapture({ text: "", files: [{ size: 13 * 1024 * 1024 } as File] }),
    ).toThrow("12 MB");
    expect(await listCaptures()).toEqual([]);
  });
});
