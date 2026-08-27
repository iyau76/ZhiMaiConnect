import { describe, expect, test } from "vitest";

import type { IngestCandidate } from "@/lib/intake-draft";

import { carryManualState } from "./intake-manual-state";

describe("carryManualState", () => {
  test("does not attach an unmatched manual person to a reordered model result", () => {
    const previous: IngestCandidate = {
      people: [
        {
          name: "Alice",
          closeness: 5,
          _draftId: "manual-alice",
          _fieldGrounding: { closeness: { status: "manual" } },
          _audit: {
            sourceSummary: "manual edit",
            extractedAt: 1,
            confirmationStatus: "accepted",
            confidence: 0.99,
            humanEdited: true,
          },
        },
        {
          name: "Bob",
          _draftId: "model-bob",
          _audit: {
            sourceSummary: "model",
            extractedAt: 1,
            confirmationStatus: "pending",
          },
        },
      ],
    };
    const reorderedAndRenamed: IngestCandidate = {
      people: [
        { name: "Bob", title: "Engineer", _draftId: "new-bob" },
        { name: "Alicia", title: "Designer", _draftId: "new-alicia" },
      ],
    };

    const result = carryManualState(reorderedAndRenamed, previous);

    expect(result.people).toHaveLength(3);
    expect(result.people?.[0]).toMatchObject({ name: "Bob", _draftId: "model-bob" });
    expect(result.people?.[1]).toMatchObject({ name: "Alicia", title: "Designer" });
    expect(result.people?.[1]?.closeness).toBeUndefined();
    expect(result.people?.[2]).toMatchObject({
      name: "Alice",
      closeness: 5,
      _draftId: "manual-alice",
      _fieldGrounding: { closeness: { status: "manual" } },
      _audit: {
        confirmationStatus: "pending",
        confidence: undefined,
        humanEdited: true,
      },
    });
  });
});
