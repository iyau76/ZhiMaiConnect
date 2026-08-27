import { describe, expect, test } from "vitest";

import {
  diffIngestPerson,
  fitPromptMaterial,
  isValidIsoDate,
  isSupportedIntakeFile,
  makeExtractionAudit,
  makeOfflineDemoCandidate,
  normalizeConfidence,
  parseIngestCandidate,
  validateIntakeFiles,
} from "./intake-draft";
import type { PersonRecord } from "./face-db";

describe("intake draft audit", () => {
  test("normalizes model confidence without allowing values outside 0-1", () => {
    expect(normalizeConfidence("0.72")).toBe(0.72);
    expect(normalizeConfidence(9)).toBe(1);
    expect(normalizeConfidence(-1)).toBe(0);
    expect(normalizeConfidence(null)).toBeUndefined();
    expect(normalizeConfidence("")).toBeUndefined();
    expect(normalizeConfidence("unknown")).toBeUndefined();
  });

  test("marks every extracted item pending confirmation", () => {
    expect(makeExtractionAudit("  语音转写  ", 0.8, 123)).toEqual({
      sourceSummary: "语音转写",
      extractedAt: 123,
      confidence: 0.8,
      confirmationStatus: "pending",
    });
  });

  test("provides an explicitly labelled synthetic offline fallback", () => {
    const draft = makeOfflineDemoCandidate(123);
    expect(draft.summary).toContain("合成数据");
    expect(draft.people).toHaveLength(2);
    expect(draft.facts).toHaveLength(1);
    expect(draft.relations).toHaveLength(1);
    expect(draft.events).toHaveLength(1);
    expect(draft.reminders).toHaveLength(1);
    expect(draft.evidence?.[0]?._audit).toMatchObject({
      sourceSummary: expect.stringContaining("离线演示"),
      extractedAt: 123,
      confirmationStatus: "pending",
    });
  });
});

describe("intake update diff", () => {
  test("shows only fields that the candidate would change", () => {
    const current: PersonRecord = {
      id: "p1",
      name: "唐悦",
      note: "旧备注",
      descriptors: [],
      thumb: "",
      createdAt: 1,
      profile: {
        relation: "摄影社同学",
        likes: ["摄影"],
        contact: "demo@example.invalid",
      },
    };
    const changes = diffIngestPerson(
      {
        name: "唐悦",
        note: "愿意协助展览",
        relation: "摄影社搭档",
        likes: ["摄影"],
      },
      current,
    );
    expect(changes.map((item) => item.field)).toEqual(["备注", "关系"]);
    expect(changes[1]).toMatchObject({ before: "摄影社同学", after: "摄影社搭档" });
  });
});

describe("intake runtime schema", () => {
  test("accepts JSON embedded in prose and normalizes null confidence", () => {
    const parsed = parseIngestCandidate(
      'result: {"people":[{"name":"唐悦","confidence":null}],"facts":[],"summary":"演示"}',
    );
    expect(parsed.people?.[0]).toEqual({ name: "唐悦", confidence: undefined });
  });

  test("rejects unknown fields and invalid confidence before a draft is shown", () => {
    expect(() => parseIngestCandidate('{"people":[{"name":"唐悦","invented":true}]}')).toThrow();
    expect(() => parseIngestCandidate('{"people":[{"name":"唐悦","confidence":2}]}')).toThrow();
  });
});

describe("intake prompt budget", () => {
  test("reserves room for instructions and never exceeds the server-safe budget", () => {
    const result = fitPromptMaterial("P".repeat(4_000), "M".repeat(20_000), 11_800, 8_000);
    expect(result.prompt).toHaveLength(11_800);
    expect(result.materialCharacters).toBe(7_800);
    expect(fitPromptMaterial("P".repeat(12_000), "M", 11_800).prompt).toHaveLength(11_800);
  });
});

describe("intake calendar validation", () => {
  test("rejects impossible dates even when their shape is yyyy-mm-dd", () => {
    expect(isValidIsoDate("2028-02-29")).toBe(true);
    expect(isValidIsoDate("2026-02-29")).toBe(false);
    expect(isValidIsoDate("2026-13-01")).toBe(false);
    expect(isValidIsoDate("2026-08-31")).toBe(true);
  });
});

describe("intake file limits", () => {
  test("accepts documented formats and rejects executable files", () => {
    expect(isSupportedIntakeFile({ name: "notes.md", size: 10, type: "text/markdown" })).toBe(true);
    expect(isSupportedIntakeFile({ name: "scan.PNG", size: 10, type: "image/png" })).toBe(true);
    expect(isSupportedIntakeFile({ name: "payload.exe", size: 10 })).toBe(false);
  });

  test("reports count and per-file size violations from the shared import limits", () => {
    const files = Array.from({ length: 5 }, (_, index) => ({
      name: `file-${index}.pdf`,
      size: index === 0 ? 13 * 1024 * 1024 : 3 * 1024 * 1024,
      type: "application/pdf",
    }));
    const errors = validateIntakeFiles(files);
    expect(errors).toHaveLength(2);
    expect(errors.join(" ")).toContain("最多选择 4 个文件");
    expect(errors.join(" ")).toContain("file-0.pdf");
  });
});
