import { describe, expect, it } from "vitest";

import { MemoryAgentRunRecorder } from "./agent-run-log";
import { AgentRuntime } from "./agent-runtime";
import {
  ARCHIVE_AGENT_TOOL_SCOPES,
  archiveAgentToolRegistry,
  executeArchiveAgentTool,
  type ArchiveAgentData,
} from "./archive-agent-tools";
import type { PersonRecord } from "./face-db";

function person(id: string, name: string, title = ""): PersonRecord {
  return {
    id,
    name,
    note: "",
    descriptors: [],
    thumb: "",
    createdAt: 1,
    profile: { title },
  };
}

const archive: ArchiveAgentData = {
  persons: [person("jia", "贾母"), person("doctor", "林医生", "市中心医院心内科医生")],
  relations: [],
  events: [],
};

describe("archiveAgentToolRegistry", () => {
  it("uses the same concrete tool scope for model guidance and runtime execution", async () => {
    for (const scope of Object.values(ARCHIVE_AGENT_TOOL_SCOPES)) {
      const names = archiveAgentToolRegistry
        .modelDefinitions(scope.permissions, scope.toolNames)
        .map((tool) => tool.name);
      expect(new Set(names)).toEqual(new Set(scope.toolNames));
    }

    const assistantGuide = archiveAgentToolRegistry.modelGuide(
      ARCHIVE_AGENT_TOOL_SCOPES.assistantArchive.permissions,
      {
        compact: true,
        allowedToolNames: ARCHIVE_AGENT_TOOL_SCOPES.assistantArchive.toolNames,
      },
    );
    expect(assistantGuide).toContain("propose_archive_mutations");
    expect(assistantGuide).toContain("migrate_collection_members");
    expect(assistantGuide).toContain("propose_person_deletion");
    expect(assistantGuide).toContain("原子删除计划");
    expect(assistantGuide).not.toContain("stage_person_update");

    const intakeGuide = archiveAgentToolRegistry.modelGuide(
      ARCHIVE_AGENT_TOOL_SCOPES.intakeArchive.permissions,
      { compact: true, allowedToolNames: ARCHIVE_AGENT_TOOL_SCOPES.intakeArchive.toolNames },
    );
    expect(intakeGuide).toContain("stage_person_update");
    expect(intakeGuide).not.toContain("propose_archive_mutations");
    expect(intakeGuide).not.toContain("rank_task_candidates");

    const runtime = new AgentRuntime({
      registry: archiveAgentToolRegistry,
      services: { archive: { persons: [], relations: [], events: [] } },
      permissions: ARCHIVE_AGENT_TOOL_SCOPES.assistantArchive.permissions,
      toolNames: ARCHIVE_AGENT_TOOL_SCOPES.assistantArchive.toolNames,
    });
    const blocked = await runtime.executeTool("stage_person_update", {
      personId: "p1",
      changes: {},
    });
    expect(blocked.status).toBe("failed");
  });

  it("uses the same registry contract for model guidance and runtime validation", async () => {
    const guide = archiveAgentToolRegistry.modelGuide(["private_read"]);
    expect(guide).toContain("search_profiles");
    expect(guide).not.toContain("search_web");

    await expect(
      executeArchiveAgentTool("search_profiles", { query: "贾", unexpected: true }, archive, {
        permissions: ["private_read"],
      }),
    ).rejects.toThrow("Invalid input");
  });

  it("recalls one-character Chinese names and reports complete match counts", async () => {
    const result = (await executeArchiveAgentTool(
      "search_profiles",
      { query: "贾", limit: 1 },
      archive,
      { permissions: ["private_read"] },
    )) as { rows: Array<{ id: string }>; totalMatches: number; exhausted: boolean };
    expect(result).toMatchObject({ totalMatches: 1, exhausted: true });
    expect(result.rows.map((row) => row.id)).toEqual(["jia"]);
  });

  it("marks search results as projections and points field questions to profile details", async () => {
    const result = (await executeArchiveAgentTool(
      "search_profiles",
      { query: "贾", limit: 1 },
      archive,
      { permissions: ["private_read"] },
    )) as {
      projection: string;
      omittedFields: string[];
      omissionMeaning: string;
      detailTool: string;
    };
    expect(result).toMatchObject({
      projection: "profile_index",
      omissionMeaning: "not_loaded",
      detailTool: "get_profiles",
    });
    expect(result.omittedFields).toContain("likes");
  });

  it("does not let private tools run under public-only permission", async () => {
    const runtime = new AgentRuntime({
      registry: archiveAgentToolRegistry,
      services: { archive },
      permissions: ["public_read"],
      recorder: new MemoryAgentRunRecorder(),
    });
    const decision = await runtime.executeTool("get_profiles", { personIds: ["jia"] });
    expect(decision.status).toBe("failed");
  });

  it("keeps verified specialty above socially close but unqualified candidates", async () => {
    const result = (await executeArchiveAgentTool(
      "rank_task_candidates",
      { task: "最近心悸，想找懂心脏问题的人咨询", limit: 2 },
      archive,
      { permissions: ["private_read"] },
    )) as { rows: Array<{ personId: string }> };
    expect(result.rows[0]?.personId).toBe("doctor");
  });
});
