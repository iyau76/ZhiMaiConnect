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

  test("does not leak a manual field between people who share the same name", () => {
    const audit = {
      sourceSummary: "manual",
      extractedAt: 1,
      confirmationStatus: "accepted" as const,
      humanEdited: true,
    };
    const previous: IngestCandidate = {
      people: [
        {
          name: "王晨",
          birthday: "01-01",
          _draftId: "wang-1",
          _fieldGrounding: { birthday: { status: "manual" } },
          _audit: audit,
        },
        { name: "王晨", birthday: "02-02", _draftId: "wang-2" },
      ],
    };
    const result = carryManualState({ people: [{ name: "王晨" }, { name: "王晨" }] }, previous);
    expect(result.people?.filter((person) => person.birthday === "01-01")).toHaveLength(1);
    expect(result.people?.find((person) => person.birthday === "01-01")?._draftId).toBe("wang-1");
  });
});
