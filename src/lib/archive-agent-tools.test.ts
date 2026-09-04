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

const stableIds = {
  self: "database-person-self-0f6d",
  jia: "database-person-jia-7d27",
  doctor: "database-person-doctor-4059",
  zhangDesign: "database-person-zhang-design-b862",
  zhangSchool: "database-person-zhang-school-c2f8",
  relation: "database-relation-doctor-jia-9e12",
  event: "database-event-consultation-238f",
  collection: "database-collection-family-e619",
  membership: "database-membership-jia-family-d295",
} as const;

function person(
  id: string,
  name: string,
  title = "",
  options: { org?: string; contact?: string; entityRole?: PersonRecord["entityRole"] } = {},
): PersonRecord {
  return {
    id,
    name,
    note: "",
    descriptors: [],
    thumb: "",
    createdAt: 1,
    entityRole: options.entityRole,
    profile: { title, org: options.org, contact: options.contact },
  };
}

const archive: ArchiveAgentData = {
  persons: [
    person(stableIds.self, "我", "", { entityRole: "ego" }),
    person(stableIds.jia, "贾母"),
    person(stableIds.doctor, "林医生", "市中心医院心内科医生", {
      contact: "lin@example.com",
    }),
    person(stableIds.zhangDesign, "张伟", "设计师", { org: "设计院" }),
    person(stableIds.zhangSchool, "张伟", "教师", { org: "学校" }),
  ],
  relations: [
    {
      id: stableIds.relation,
      fromId: stableIds.doctor,
      toId: stableIds.jia,
      label: "家庭医生",
      basis: "长期提供健康咨询",
      confirmationStatus: "confirmed",
      evidenceMode: "explicit",
      createdAt: 1,
    },
  ],
  events: [
    {
      id: stableIds.event,
      title: "健康咨询",
      detail: "讨论体检安排",
      date: "2026-08-20",
      personIds: [stableIds.doctor, stableIds.jia],
      createdAt: 1,
    },
  ],
  collections: [
    {
      id: stableIds.collection,
      name: "家人",
      kind: "relationship_circle",
      createdAt: 1,
      updatedAt: 1,
    },
  ],
  collectionMemberships: [
    {
      id: stableIds.membership,
      collectionId: stableIds.collection,
      personId: stableIds.jia,
      source: "manual",
      createdAt: 1,
    },
  ],
};

function recorder(runId: string) {
  return new MemoryAgentRunRecorder({ runId });
}

async function executeInRun(name: string, input: unknown, runId: string, data = archive) {
  return executeArchiveAgentTool(name, input, data, {
    permissions: ["private_read"],
    recorder: recorder(runId),
  });
}

function expectNoStableIds(value: unknown) {
  const serialized = JSON.stringify(value);
  Object.values(stableIds).forEach((stableId) => expect(serialized).not.toContain(stableId));
}

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
    expect(assistantGuide).not.toContain("propose_archive_mutations");
    expect(assistantGuide).not.toContain("propose_person_deletion");
    expect(assistantGuide).not.toContain("stage_person_update");

    const intakeGuide = archiveAgentToolRegistry.modelGuide(
      ARCHIVE_AGENT_TOOL_SCOPES.intakeArchive.permissions,
      { compact: true, allowedToolNames: ARCHIVE_AGENT_TOOL_SCOPES.intakeArchive.toolNames },
    );
    expect(intakeGuide).not.toContain("stage_person_update");
    expect(intakeGuide).not.toContain("propose_archive_mutations");
    expect(intakeGuide).not.toContain("rank_task_candidates");

    expect(
      archiveAgentToolRegistry.modelDefinitions(["private_read"], ["get_profiles"])[0]?.inputSchema,
    ).toMatchObject({ required: ["personRefs"] });

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

  it("keeps opaque references stable across tools in one run", async () => {
    const runId = "run-stable-handles";
    const search = (await executeInRun("search_profiles", { query: "贾", limit: 1 }, runId)) as {
      rows: Array<{ personRef: string }>;
      totalMatches: number;
      exhausted: boolean;
    };
    const listed = (await executeInRun("list_profiles", { limit: 10 }, runId)) as {
      rows: Array<{ personRef: string; name: string }>;
    };
    const personRef = search.rows[0]?.personRef;

    expect(search).toMatchObject({ totalMatches: 1, exhausted: true });
    expect(personRef).toMatch(/^ref_[0-9a-f]{32}$/);
    expect(listed.rows.find((row) => row.name === "贾母")?.personRef).toBe(personRef);

    const detail = await executeInRun("get_profiles", { personRefs: [personRef] }, runId);
    expect(detail).toMatchObject({ rows: [{ personRef, name: "贾母" }] });
    expectNoStableIds({ search, listed, detail });
  });

  it("lets a resumed run reuse handles and rejects foreign or cross-domain handles", async () => {
    const runId = "run-resumed-handles";
    const resolved = (await executeInRun(
      "resolve_record_refs",
      {
        refs: [
          { kind: "person", name: "林医生" },
          { kind: "event", title: "健康咨询", date: "2026-08-20" },
        ],
      },
      runId,
    )) as { rows: Array<{ candidates: Array<{ handle: string }> }> };
    const personRef = resolved.rows[0]?.candidates[0]?.handle;
    const eventRef = resolved.rows[1]?.candidates[0]?.handle;

    const resumed = await executeInRun("get_profiles", { personRefs: [personRef] }, runId);
    expect(resumed).toMatchObject({ rows: [{ personRef, name: "林医生" }] });

    await expect(
      executeInRun("get_profiles", { personRefs: [personRef] }, "run-foreign-handles"),
    ).rejects.toThrow("当前运行中不存在该引用");
    await expect(executeInRun("get_profiles", { personRefs: [eventRef] }, runId)).rejects.toThrow(
      "引用属于 event，不能作为 person 使用",
    );
  });

  it("isolates ambiguous, missing and resolved semantic references item by item", async () => {
    const result = (await executeInRun(
      "resolve_record_refs",
      {
        refs: [
          { kind: "person", name: "张伟" },
          { kind: "person", name: "不存在" },
          { kind: "person", name: "林医生" },
        ],
      },
      "run-semantic-batch",
    )) as { rows: Array<{ status: string; candidates: Array<{ handle: string; label: string }> }> };

    expect(result.rows.map((row) => row.status)).toEqual(["ambiguous", "missing", "resolved"]);
    expect(result.rows[0]?.candidates).toHaveLength(2);
    expect(result.rows[2]?.candidates[0]).toMatchObject({ label: "林医生" });
    expect(result.rows[2]?.candidates[0]?.handle).toMatch(/^ref_[0-9a-f]{32}$/);
    expectNoStableIds(result);
  });

  it("marks search results as projections and points field questions to profile details", async () => {
    const result = (await executeInRun(
      "search_profiles",
      { query: "贾", limit: 1 },
      "run-projection",
    )) as {
      projection: string;
      returnedFields: string[];
      omittedFields: string[];
      omissionMeaning: string;
      detailTool: string;
    };
    expect(result).toMatchObject({
      projection: "profile_index",
      omissionMeaning: "not_loaded",
      detailTool: "get_profiles",
    });
    expect(result.returnedFields).toContain("personRef");
    expect(result.returnedFields).not.toContain("id");
    expect(result.omittedFields).toContain("likes");
  });

  it("does not let private tools run under public-only permission", async () => {
    const runtime = new AgentRuntime({
      registry: archiveAgentToolRegistry,
      services: { archive },
      permissions: ["public_read"],
      recorder: recorder("run-public-only"),
    });
    const decision = await runtime.executeTool("get_profiles", {
      personRefs: ["ref_00000000000000000000000000000000"],
    });
    expect(decision.status).toBe("failed");
  });

  it("gives every archive Agent scope the same full-library semantic resolution", async () => {
    const tailId = "database-person-tail-stable-id";
    const largeArchive: ArchiveAgentData = {
      persons: [
        ...Array.from({ length: 499 }, (_, index) => person(`person-${index}`, `人物${index}`)),
        {
          ...person(tailId, "周明远"),
          profile: {
            org: "北辰设计院",
            identities: [{ platform: "微信", alias: "老周" }],
          },
        },
      ],
      relations: [],
      events: [],
    };
    const archiveScopes = [
      ARCHIVE_AGENT_TOOL_SCOPES.intakeArchive,
      ARCHIVE_AGENT_TOOL_SCOPES.assistantArchive,
      ARCHIVE_AGENT_TOOL_SCOPES.recommendation,
      ARCHIVE_AGENT_TOOL_SCOPES.planning,
    ];

    for (const [index, scope] of archiveScopes.entries()) {
      expect(scope.toolNames).toContain("resolve_record_refs");
      const runtime = new AgentRuntime({
        registry: archiveAgentToolRegistry,
        services: { archive: largeArchive },
        permissions: scope.permissions,
        toolNames: scope.toolNames,
        recorder: recorder(`run-scope-${index}`),
      });
      const decision = await runtime.executeTool("resolve_record_refs", {
        refs: [{ kind: "person", name: "老周", hints: { org: "北辰设计院" } }],
      });
      expect(decision).toMatchObject({
        status: "ok",
        value: {
          rows: [
            {
              status: "resolved",
              candidates: [{ domain: "person", label: "周明远" }],
            },
          ],
        },
      });
      expect(JSON.stringify(decision)).not.toContain(tailId);
    }
  });

  it("removes database IDs from every model-visible archive and recommendation result", async () => {
    const runId = "run-no-database-ids";
    const resolved = (await executeInRun(
      "resolve_record_refs",
      {
        refs: [
          { kind: "person", name: "林医生" },
          { kind: "person", name: "贾母" },
          { kind: "event", title: "健康咨询" },
          {
            kind: "relation",
            from: { kind: "person", name: "林医生" },
            to: { kind: "person", name: "贾母" },
            label: "家庭医生",
          },
        ],
      },
      runId,
    )) as { rows: Array<{ candidates: Array<{ handle: string }> }> };
    const doctorRef = resolved.rows[0]?.candidates[0]?.handle;
    const targetPersonRef = resolved.rows[1]?.candidates[0]?.handle;
    const eventRef = resolved.rows[2]?.candidates[0]?.handle;
    const relationRef = resolved.rows[3]?.candidates[0]?.handle;

    const outputs = [
      resolved,
      await executeInRun("list_profiles", { limit: 10 }, runId),
      await executeInRun("search_profiles", { query: "医生" }, runId),
      await executeInRun("get_profiles", { personRefs: [doctorRef] }, runId),
      await executeInRun("get_relationships", { personRefs: [doctorRef] }, runId),
      await executeInRun("search_events", { query: "健康咨询" }, runId),
      await executeInRun("search_relations", { query: "家庭医生" }, runId),
      await executeInRun("get_event", { eventRef }, runId),
      await executeInRun("get_relation", { relationRef }, runId),
      await executeInRun("get_events", { personRefs: [doctorRef] }, runId),
      await executeInRun("get_collections", {}, runId),
      await executeInRun(
        "rank_task_candidates",
        { task: "最近心悸，想找懂心脏问题的人咨询", limit: 2 },
        runId,
      ),
      await executeInRun("find_connection_paths", { targetPersonRef, maxHops: 3 }, runId),
      await executeInRun("rank_target_side_entries", { targetPersonRef, limit: 2 }, runId),
    ];

    expectNoStableIds(outputs);
    expect(outputs.at(-3)).toMatchObject({
      rows: expect.arrayContaining([expect.objectContaining({ personName: "林医生" })]),
    });
    expect(outputs.at(-2)).toMatchObject({ targetPersonRef });
    expect(outputs.at(-1)).toMatchObject({ targetPersonRef });
  });

  it("pages profile search, relationships and events through their true tails", async () => {
    const personRows = Array.from({ length: 500 }, (_, index) =>
      person(`db-person-${index}`, `工程师${index}`, "工程师"),
    );
    const relationRows = Array.from({ length: 121 }, (_, index) => ({
      id: `db-relation-${index}`,
      fromId: personRows[0]!.id,
      toId: personRows[(index % 499) + 1]!.id,
      label: `合作关系${index}`,
      confirmationStatus: "confirmed" as const,
      createdAt: index + 1,
    }));
    const eventRows = Array.from({ length: 101 }, (_, index) => ({
      id: `db-event-${index}`,
      title: `项目复盘${index}`,
      detail: "工程师共同参与",
      date: `2026-08-${String((index % 28) + 1).padStart(2, "0")}`,
      personIds: [personRows[0]!.id],
      createdAt: index + 1,
    }));
    const data: ArchiveAgentData = {
      persons: personRows,
      relations: relationRows,
      events: eventRows,
    };
    const runId = "run-page-true-tail";
    const resolved = (await executeInRun(
      "resolve_record_refs",
      { refs: [{ kind: "person", name: "工程师0" }] },
      runId,
      data,
    )) as { rows: Array<{ candidates: Array<{ handle: string }> }> };
    const personRef = resolved.rows[0]!.candidates[0]!.handle;

    const profileTail = (await executeInRun(
      "search_profiles",
      { query: "工程师", cursor: 490, limit: 10 },
      runId,
      data,
    )) as { rows: Array<{ name: string }>; cursor: number; nextCursor: number | null };
    expect(profileTail.rows).toHaveLength(10);
    expect(profileTail.rows.map((row) => row.name)).toEqual(
      personRows
        .map((row) => row.name)
        .sort((left, right) => left.localeCompare(right, "zh-CN"))
        .slice(490),
    );
    expect(profileTail).toMatchObject({ cursor: 490, nextCursor: null, exhausted: true });

    const relationTail = (await executeInRun(
      "get_relationships",
      { personRefs: [personRef], cursor: 120, limit: 10 },
      runId,
      data,
    )) as { rows: Array<{ label: string }>; sourceCount: number; nextCursor: number | null };
    expect(relationTail.rows).toHaveLength(1);
    expect(relationTail.rows[0]?.label).toBe("合作关系120");
    expect(relationTail).toMatchObject({ sourceCount: 121, nextCursor: null, exhausted: true });

    const eventTail = (await executeInRun(
      "get_events",
      { personRefs: [personRef], cursor: 100, limit: 10 },
      runId,
      data,
    )) as { rows: Array<{ eventRef: string }>; sourceCount: number; nextCursor: number | null };
    expect(eventTail.rows).toHaveLength(1);
    expect(eventTail).toMatchObject({ sourceCount: 101, nextCursor: null, exhausted: true });
  });

  it("pages large same-name disambiguation candidate sets without losing opaque handles", async () => {
    const data: ArchiveAgentData = {
      persons: Array.from({ length: 40 }, (_, index) =>
        person(`db-duplicate-${index}`, "王晨", index % 2 ? "教师" : "设计师", {
          org: `机构${index}`,
        }),
      ),
      relations: [],
      events: [],
    };
    const result = (await executeInRun(
      "resolve_record_refs",
      {
        refs: [{ kind: "person", name: "王晨" }],
        candidateCursor: 30,
        candidateLimit: 10,
      },
      "run-candidate-page",
      data,
    )) as {
      rows: Array<{
        candidates: Array<{ handle: string }>;
        candidateCount: number;
        nextCandidateCursor: number | null;
      }>;
    };

    expect(result.rows[0]?.candidates).toHaveLength(10);
    expect(result.rows[0]?.candidateCount).toBe(40);
    expect(result.rows[0]?.nextCandidateCursor).toBeNull();
    expect(result.rows[0]?.candidates.every((candidate) => /^ref_/.test(candidate.handle))).toBe(
      true,
    );
  });

  it("recalculates list pagination after the model-size projection", async () => {
    const data: ArchiveAgentData = {
      persons: Array.from({ length: 500 }, (_, index) => ({
        ...person(`db-person-${index}`, `人物${index}`, "高级产品经理", { org: "北辰集团" }),
        profile: {
          title: "高级产品经理",
          org: "北辰集团",
          tags: Array.from({ length: 12 }, (__, tagIndex) => `标签${index}-${tagIndex}`),
          projects: Array.from(
            { length: 8 },
            (__, projectIndex) => `大型项目${index}-${projectIndex}`,
          ),
        },
      })),
      relations: [],
      events: [],
    };
    const raw = await executeInRun(
      "list_profiles",
      { cursor: 0, limit: 50 },
      "run-projected-page",
      data,
    );
    const projected = archiveAgentToolRegistry.modelResult("list_profiles", raw, 1_200) as {
      rows: Array<{ personRef: string }>;
      returnedCount: number;
      sourceCount: number;
      nextCursor: number;
      exhausted: boolean;
    };

    expect(projected.rows.length).toBeGreaterThan(0);
    expect(projected.rows.length).toBeLessThan(50);
    expect(projected.returnedCount).toBe(projected.rows.length);
    expect(projected.sourceCount).toBe(500);
    expect(projected.nextCursor).toBe(projected.rows.length);
    expect(projected.exhausted).toBe(false);
    expect(JSON.stringify(projected).length).toBeLessThanOrEqual(1_200);
  });

  it("separates the collection index from paged membership rows", async () => {
    const people = Array.from({ length: 75 }, (_, index) =>
      person(`db-member-${index}`, `成员${index}`),
    );
    const collection = {
      id: "db-collection-large",
      name: "项目伙伴",
      kind: "context" as const,
      createdAt: 1,
      updatedAt: 1,
    };
    const data: ArchiveAgentData = {
      persons: people,
      relations: [],
      events: [],
      collections: [collection],
      collectionMemberships: people.map((personRow, index) => ({
        id: `db-membership-${index}`,
        collectionId: collection.id,
        personId: personRow.id,
        source: "manual" as const,
        createdAt: index + 1,
      })),
    };
    const runId = "run-collection-members";
    const index = (await executeInRun("get_collections", {}, runId, data)) as {
      rows: Array<{ collectionRef: string; memberCount: number }>;
    };
    const collectionRef = index.rows[0]!.collectionRef;
    expect(index.rows[0]?.memberCount).toBe(75);

    const memberTail = (await executeInRun(
      "get_collections",
      { collectionRef, cursor: 60, limit: 20 },
      runId,
      data,
    )) as { mode: string; rows: Array<{ personName: string }>; nextCursor: number | null };
    expect(memberTail.mode).toBe("collection_members");
    expect(memberTail.rows).toHaveLength(15);
    expect(memberTail.rows.at(-1)?.personName).toBe("成员74");
    expect(memberTail.nextCursor).toBeNull();
  });
});
