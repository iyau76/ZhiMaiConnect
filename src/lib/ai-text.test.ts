import { describe, expect, it } from "vitest";

import { parseLooseJson } from "./ai-text";

describe("parseLooseJson", () => {
  it("parses a bare JSON object", () => {
    expect(parseLooseJson<{ name: string; score: number }>('{"name":"林晓","score":0.9}')).toEqual({
      name: "林晓",
      score: 0.9,
    });
  });

  it("extracts an object surrounded by model commentary", () => {
    const response = '分析如下：\n{"precision":"month","date":"2026-08-01"}\n以上是结果。';
    expect(parseLooseJson(response)).toEqual({ precision: "month", date: "2026-08-01" });
  });

  it.each([
    ['```json\n{"people":[{"name":"周宁"}]}\n```', { people: [{ name: "周宁" }] }],
    ['```\n{"ok":true,"nested":{"count":2}}\n```', { ok: true, nested: { count: 2 } }],
  ])("parses a fenced JSON object", (response, expected) => {
    expect(parseLooseJson(response)).toEqual(expected);
  });

  it("preserves braces that appear inside JSON strings", () => {
    expect(parseLooseJson('{"template":"你好，{name}","active":true}')).toEqual({
      template: "你好，{name}",
      active: true,
    });
  });

  it("uses the first complete valid object when commentary contains other braces", () => {
    expect(parseLooseJson('示例 {not-json}，正式结果：{"ok":true}，不要读取 {后文}')).toEqual({
      ok: true,
    });
  });

  it.each(["", "只有自然语言，没有结构化结果", "[1,2,3]"])(
    "throws a domain error when no JSON object is present",
    (response) => {
      expect(() => parseLooseJson(response)).toThrow("AI 没有返回可解析的结构化结果");
    },
  );

  it.each(['{"name":}', "prefix {not-json} suffix"])(
    "surfaces invalid JSON instead of accepting it",
    (response) => {
      expect(() => parseLooseJson(response)).toThrow(SyntaxError);
    },
  );
});
