import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  readArchiveSnapshot: vi.fn(),
}));

vi.mock("./face-db", () => ({ facesDb: db }));

import { buildMachineArchive } from "./export-data";

describe("buildMachineArchive", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.readArchiveSnapshot.mockResolvedValue({
      persons: [],
      relationAssertions: [],
      derivedRelations: [],
      relationEvidenceLinks: [],
      relationViewPreferences: [],
      referralPolicies: [],
      collections: [],
      collectionMemberships: [],
      evidence: [],
      caseEvents: [],
      tasks: [],
      projects: [],
      lifeEvents: [],
      reminders: [],
    });
  });

  it("reads every durable current-model store rather than exporting the mixed relation view", async () => {
    const archive = await buildMachineArchive();

    expect(archive.schema).toBe("zhimai-connect/archive@2");
    expect(archive.records).toEqual({
      persons: [],
      relationAssertions: [],
      relationEvidenceLinks: [],
      relationViewPreferences: [],
      referralPolicies: [],
      collections: [],
      collectionMemberships: [],
      evidence: [],
      caseEvents: [],
      tasks: [],
      projects: [],
      lifeEvents: [],
      reminders: [],
    });
    expect(db.readArchiveSnapshot).toHaveBeenCalledOnce();
    expect(db).not.toHaveProperty("listRelations");
  });
});
