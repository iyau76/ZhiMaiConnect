import { describe, expect, it, vi } from "vitest";

import {
  createIntakeCommitIntent,
  executeIntakeCommitIntent,
  parseIntakeCommitIntent,
  type IntakeCommitRepository,
} from "./intake-commit-intent";

function intent() {
  return createIntakeCommitIntent({
    decisionId: "intake-decision:run-1",
    proposalRef: "intake-draft:run-1",
    expectedArchiveRevision: 4,
    batch: {
      persons: [
        {
          id: "person-1",
          name: "合成人物",
          note: "",
          descriptors: [],
          thumb: "",
          createdAt: 1,
        },
      ],
    },
    receipt: {
      id: "batch-1",
      committedAt: 1,
      createdPersonIds: ["person-1"],
      createdRelationIds: [],
      createdEvidenceIds: [],
      createdEventIds: [],
      createdReminderIds: [],
      previousPeople: [],
      previousEvents: [],
    },
    summary: {
      createdPeople: 1,
      updatedPeople: 0,
      facts: 0,
      relations: 0,
      createdEvents: 0,
      updatedEvents: 0,
      reminders: 0,
      evidence: 0,
    },
  });
}

describe("intake commit intent", () => {
  it("round-trips one durable exact-write intent", () => {
    const value = intent();
    expect(parseIntakeCommitIntent(value)).toEqual(value);
    expect(parseIntakeCommitIntent({ ...value, expectedArchiveRevision: -1 })).toBeUndefined();
  });

  it("replays the same decision without duplicating its archive batch", async () => {
    const apply = vi
      .fn<IntakeCommitRepository["applyArchiveMutationBatchOnce"]>()
      .mockResolvedValueOnce("applied")
      .mockResolvedValueOnce("already_applied");
    const repository: IntakeCommitRepository = {
      applyArchiveMutationBatchOnce: apply,
      hasAppliedArchiveMutationDecision: vi.fn().mockResolvedValue(true),
    };

    await expect(executeIntakeCommitIntent(intent(), repository)).resolves.toBe("applied");
    await expect(executeIntakeCommitIntent(intent(), repository)).resolves.toBe("already_applied");
    expect(apply.mock.calls[0]?.[1]).toEqual({
      decisionId: "intake-decision:run-1",
      expectedRevision: 4,
    });
  });

  it("recognizes a committed transaction when the caller lost its completion signal", async () => {
    const repository: IntakeCommitRepository = {
      applyArchiveMutationBatchOnce: vi.fn().mockRejectedValue(new Error("connection closed")),
      hasAppliedArchiveMutationDecision: vi.fn().mockResolvedValue(true),
    };

    await expect(executeIntakeCommitIntent(intent(), repository)).resolves.toBe("already_applied");
  });
});
