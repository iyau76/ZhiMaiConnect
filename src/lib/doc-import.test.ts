import { describe, expect, it } from "vitest";

import { normalizeCsv } from "./doc-import";

describe("CSV import", () => {
  it("preserves quoted commas, escaped quotes and embedded newlines", () => {
    expect(
      normalizeCsv('name,note\n张伟,"合同,法务"\n李梅,"第一行\n第二行"\n王强,"说""好"""'),
    ).toBe('name\tnote\n张伟\t合同,法务\n李梅\t第一行 / 第二行\n王强\t说"好"');
  });
});
