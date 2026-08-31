import { describe, expect, it } from "vitest";

import { assertNotMachineArchiveText, normalizeCsv } from "./doc-import";

describe("CSV import", () => {
  it("preserves quoted commas, escaped quotes and embedded newlines", () => {
    expect(
      normalizeCsv('name,note\n张伟,"合同,法务"\n李梅,"第一行\n第二行"\n王强,"说""好"""'),
    ).toBe('name\tnote\n张伟\t合同,法务\n李梅\t第一行 / 第二行\n王强\t说"好"');
  });
});

describe("machine archive routing", () => {
  it("does not send a valid backup through the AI intake text path", () => {
    const archive = {
      schema: "zhimai-connect/projects@1",
      exportedAt: "2026-08-28T10:00:00.000Z",
      persons: [],
      projects: [],
    };
    expect(() => assertNotMachineArchiveText(JSON.stringify(archive))).toThrow(
      /不能作为 AI 录入材料/,
    );
  });

  it("leaves ordinary JSON source material available to intake", () => {
    expect(() => assertNotMachineArchiveText('{"name":"唐悦"}')).not.toThrow();
  });
});
