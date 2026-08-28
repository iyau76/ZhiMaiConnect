import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { MemoryAgentRunRecorder } from "./agent-run-log";
import {
  AgentToolPermissionError,
  AgentToolRegistry,
  AgentToolRegistryError,
  AgentToolValidationError,
} from "./agent-tool-registry";

interface TestServices {
  calls: string[];
}

function createRegistry(handler = vi.fn()) {
  const registry = new AgentToolRegistry<TestServices>();
  registry.register({
    name: "search_profiles",
    label: "搜索人物档案",
    description: "按关键词读取匹配的人物档案",
    permission: "private_read",
    input: z
      .object({
        query: z.string().min(1).describe("搜索词"),
        limit: z.number().int().positive().optional(),
      })
      .strict(),
    redact: (payload, phase) =>
      typeof payload === "object" && payload
        ? { ...payload, rawArchive: `[REDACTED_${phase.toUpperCase()}]` }
        : payload,
    handler: async (input, context) => {
      handler(input, context);
      context.services.calls.push(input.query);
      return { names: [input.query], rawArchive: "private archive" };
    },
  });
  registry.register({
    name: "commit_archive",
    label: "提交档案变更",
    description: "将已批准的提案写入档案",
    permission: "write",
    input: z.object({ proposalId: z.string() }).strict(),
    handler: ({ proposalId }) => ({ committed: proposalId }),
  });
  return registry;
}

describe("AgentToolRegistry", () => {
  it("keeps public, private and network capabilities distinct in the model contract", async () => {
    const registry = new AgentToolRegistry<TestServices>();
    const makeTool = (
      name: string,
      permission: "public_read" | "private_read" | "network" | "read",
    ) =>
      registry.register({
        name,
        label: name,
        description: `${name} description`,
        permission,
        input: z.object({}).strict(),
        handler: () => name,
      });
    makeTool("read_clock", "public_read");
    makeTool("read_archive", "private_read");
    makeTool("search_web", "network");
    makeTool("legacy_archive", "read");

    expect(registry.modelDefinitions()).toMatchObject([
      { name: "read_clock", permission: "public_read" },
      { name: "read_archive", permission: "private_read" },
      { name: "search_web", permission: "network" },
      {
        name: "legacy_archive",
        permission: "private_read",
        declaredPermission: "read",
      },
    ]);
    expect(registry.modelGuide()).toContain("search_web [network]");
    expect(registry.modelGuide()).not.toContain("legacy_archive [read]");

    const recorder = new MemoryAgentRunRecorder({ runId: "capabilities" });
    await expect(
      registry.execute(
        "legacy_archive",
        {},
        {
          services: { calls: [] },
          recorder,
          permissions: ["read"],
        },
      ),
    ).resolves.toBe("legacy_archive");
    await expect(
      registry.execute(
        "search_web",
        {},
        {
          services: { calls: [] },
          recorder,
          permissions: ["private_read"],
        },
      ),
    ).rejects.toBeInstanceOf(AgentToolPermissionError);
  });

  it("derives the model guide and permission-filtered tool contract from Zod", () => {
    const registry = createRegistry();

    const definitions = registry.modelDefinitions(["private_read"]);
    expect(definitions).toHaveLength(1);
    expect(definitions[0]).toMatchObject({
      name: "search_profiles",
      permission: "private_read",
      inputSchema: {
        type: "object",
        required: ["query"],
        properties: {
          query: { type: "string", description: "搜索词" },
          limit: { type: "integer" },
        },
      },
    });
    expect(registry.modelGuide(["private_read"])).toContain("search_profiles [private_read]");
    expect(registry.modelGuide(["private_read"])).not.toContain("commit_archive");
  });

  it("redacts a rejected call before it reaches the run log", async () => {
    const handler = vi.fn();
    const registry = createRegistry(handler);
    const recorder = new MemoryAgentRunRecorder({ runId: "registry-run", now: () => 100 });
    const services: TestServices = { calls: [] };

    await expect(
      registry.execute(
        "search_profiles",
        { query: "贾母", rawArchive: "must not be logged" },
        { services, recorder, permissions: ["private_read"] },
      ),
    ).rejects.toBeInstanceOf(AgentToolValidationError);

    expect(handler).not.toHaveBeenCalled();
    expect(JSON.stringify(recorder.events())).not.toContain("must not be logged");
  });

  it("executes valid input and applies domain redaction to results", async () => {
    const handler = vi.fn();
    const registry = createRegistry(handler);
    const recorder = new MemoryAgentRunRecorder({ runId: "registry-run", now: () => 100 });
    const services: TestServices = { calls: [] };

    const output = await registry.execute(
      "search_profiles",
      { query: "贾母", limit: 3 },
      { services, recorder, permissions: ["private_read"] },
    );

    expect(output).toEqual({ names: ["贾母"], rawArchive: "private archive" });
    expect(handler).toHaveBeenCalledOnce();
    expect(services.calls).toEqual(["贾母"]);
    expect(recorder.events().map((event) => event.kind)).toEqual([
      "tool_call",
      "validation",
      "tool_result",
    ]);
    expect(recorder.events().at(-1)?.payload).toMatchObject({
      rawArchive: "[REDACTED_OUTPUT]",
    });
  });

  it("blocks invalid input and missing permission before invoking handlers", async () => {
    const handler = vi.fn();
    const registry = createRegistry(handler);
    const services: TestServices = { calls: [] };

    const invalidRecorder = new MemoryAgentRunRecorder({ runId: "invalid" });
    await expect(
      registry.execute(
        "search_profiles",
        { query: "", limit: 1.5 },
        {
          services,
          recorder: invalidRecorder,
          permissions: ["private_read"],
        },
      ),
    ).rejects.toBeInstanceOf(AgentToolValidationError);

    const deniedRecorder = new MemoryAgentRunRecorder({ runId: "denied" });
    await expect(
      registry.execute(
        "commit_archive",
        { proposalId: "p1" },
        {
          services,
          recorder: deniedRecorder,
          permissions: ["public_read", "proposal"],
        },
      ),
    ).rejects.toBeInstanceOf(AgentToolPermissionError);

    expect(handler).not.toHaveBeenCalled();
    expect(invalidRecorder.events().at(-1)?.status).toBe("failed");
    expect(deniedRecorder.events().at(-1)?.status).toBe("blocked");
  });

  it("rejects duplicate or non-canonical names", () => {
    const registry = createRegistry();
    expect(() =>
      registry.register({
        name: "search_profiles",
        label: "重复",
        description: "重复",
        permission: "private_read",
        input: z.object({}),
        handler: () => null,
      }),
    ).toThrow(AgentToolRegistryError);
    expect(() =>
      registry.register({
        name: "Bad-Tool",
        label: "非法",
        description: "非法",
        permission: "private_read",
        input: z.object({}),
        handler: () => null,
      }),
    ).toThrow(/snake_case/);
  });
});
