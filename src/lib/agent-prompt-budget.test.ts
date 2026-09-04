import { describe, expect, it } from "vitest";

import {
  AGENT_PROMPT_MAX_CHARACTERS,
  fitVisionHistory,
  VISION_TEXT_LIMITS,
} from "./ai-request-contract";
import {
  AgentPromptContractError,
  composeAgentPrompt,
  fitJsonAgentContext,
} from "./agent-prompt-budget";
import { projectToolResultForHistory, serializeToolHistory } from "./agent-history";

describe("shared Agent prompt contract", () => {
  it("allocates context and complete history within the transport limit", () => {
    const history = Array.from({ length: 12 }, (_, index) => ({
      call: { tool: "search_profiles", args: { query: `人物${index}` } },
      result: { rows: [{ id: `p-${index}`, note: "x".repeat(700) }] },
    }));
    const result = composeAgentPrompt({
      render: (context, toolHistory) =>
        `${"R".repeat(3_000)}\n<context>${context}</context>\n<history>${toolHistory}</history>`,
      fitContext: (max) =>
        fitJsonAgentContext({ rows: Array(50).fill({ text: "档".repeat(200) }) }, max),
      toolHistory: history,
      minimumContextCharacters: 500,
      preferredHistoryCharacters: 4_000,
    });

    expect(result.prompt.length).toBeLessThanOrEqual(AGENT_PROMPT_MAX_CHARACTERS);
    expect(() => JSON.parse(result.context)).not.toThrow();
    expect(() => JSON.parse(result.history)).not.toThrow();
    expect(result.prompt).toContain("<context>");
  });

  it("fails loudly when immutable instructions alone exceed the contract", () => {
    expect(() =>
      composeAgentPrompt({
        render: (context, history) =>
          `${"R".repeat(AGENT_PROMPT_MAX_CHARACTERS)}${context}${history}`,
        fitContext: () => "{}",
        toolHistory: [],
      }),
    ).toThrow(AgentPromptContractError);
  });

  it("leaves working context room after a production-sized immutable instruction block", () => {
    const result = composeAgentPrompt({
      render: (context, history) => `${"R".repeat(12_000)}${context}${history}`,
      fitContext: (maximum) => "C".repeat(Math.min(4_000, maximum)),
      toolHistory: [],
      minimumContextCharacters: 2_500,
    });

    expect(result.contextCharacters).toBe(4_000);
    expect(result.prompt.length).toBeLessThanOrEqual(AGENT_PROMPT_MAX_CHARACTERS);
  });

  it("keeps a contiguous newest history suffix and marks omitted earlier calls", () => {
    const history = [
      { call: { index: 0 }, result: { value: "small" } },
      { call: { index: 1 }, result: { value: "x".repeat(1_000) } },
      { call: { index: 2 }, result: { value: "newest" } },
    ];
    const parsed = JSON.parse(serializeToolHistory(history, 260));
    expect(parsed[0].result.omittedBefore).toBe(2);
    expect(parsed.at(-1).call.index).toBe(2);
    expect(parsed.some((entry: { call: { index?: number } }) => entry.call.index === 0)).toBe(
      false,
    );
  });

  it("projects oversized results while retaining locked ranking fields and opaque rows", () => {
    const projected = projectToolResultForHistory(
      {
        rankingLocked: true,
        mode: "target_side",
        accessVerified: false,
        rows: Array.from({ length: 50 }, (_, index) => ({
          personRef: `ref_${String(index).padStart(32, "0")}`,
          score: index,
          evidence: "证据".repeat(100),
        })),
      },
      1_200,
    ) as Record<string, unknown>;
    expect(projected).toMatchObject({
      rankingLocked: true,
      mode: "target_side",
      accessVerified: false,
    });
    expect(Array.isArray(projected.rows)).toBe(true);
    expect(JSON.stringify(projected).length).toBeLessThanOrEqual(1_200);
  });

  it("keeps a small complete page while removing raw ID fields from its projection", () => {
    const projected = projectToolResultForHistory(
      {
        rows: Array.from({ length: 8 }, (_, index) => ({
          id: `person-${index}`,
          personRef: `ref_${String(index).padStart(32, "0")}`,
          name: `人物${index}`,
          title: index % 2 ? "工程师" : "",
          org: "知脉",
          note: "详细资料".repeat(240),
        })),
      },
      3_800,
    ) as { rows: Array<{ id?: string; personRef: string; name: string }> };

    expect(projected.rows).toHaveLength(8);
    expect(projected.rows.map((row) => row.personRef)).toEqual(
      Array.from({ length: 8 }, (_, index) => `ref_${String(index).padStart(32, "0")}`),
    );
    expect(projected.rows.every((row) => row.id === undefined)).toBe(true);
    expect(projected.rows.every((row) => row.name)).toBe(true);
    expect(JSON.stringify(projected).length).toBeLessThanOrEqual(3_800);
  });

  it("recalculates pagination from the contiguous prefix actually shown to the model", () => {
    const projected = projectToolResultForHistory(
      {
        cursor: 100,
        rows: Array.from({ length: 50 }, (_, index) => ({
          personRef: `ref_${String(index).padStart(32, "0")}`,
          name: `人物${index}`,
          note: "详细资料".repeat(250),
        })),
        returnedCount: 50,
        sourceCount: 500,
        nextCursor: 150,
        exhausted: false,
      },
      1_200,
      { toolName: "list_profiles" },
    ) as {
      rows: Array<{ personRef: string }>;
      returnedCount: number;
      sourceCount: number;
      cursor: number;
      nextCursor: number;
      exhausted: boolean;
      recoverWith: string;
    };

    expect(projected.rows.length).toBeGreaterThan(0);
    expect(projected.rows.length).toBeLessThan(50);
    expect(projected.returnedCount).toBe(projected.rows.length);
    expect(projected.sourceCount).toBe(500);
    expect(projected.nextCursor).toBe(100 + projected.rows.length);
    expect(projected.exhausted).toBe(false);
    expect(projected.recoverWith).toContain(`cursor=${projected.nextCursor}`);
    expect(JSON.stringify(projected)).not.toContain('"nextCursor":null');
    expect(JSON.stringify(projected).length).toBeLessThanOrEqual(1_200);
  });

  it("supports matches pages without assuming a rows property", () => {
    const projected = projectToolResultForHistory(
      {
        cursor: 0,
        matches: Array.from({ length: 30 }, (_, index) => ({
          eventRef: `ref_${String(index).padStart(32, "0")}`,
          title: `事件${index}`,
          detail: "共同经历".repeat(200),
        })),
        totalMatches: 90,
        nextCursor: 30,
      },
      900,
      { toolName: "search_events" },
    ) as { matches: unknown[]; returnedCount: number; nextCursor: number };

    expect(projected.matches.length).toBeGreaterThan(0);
    expect(projected.returnedCount).toBe(projected.matches.length);
    expect(projected.nextCursor).toBe(projected.matches.length);
    expect(JSON.stringify(projected).length).toBeLessThanOrEqual(900);
  });

  it("retains nested opaque candidates and declares nested omissions", () => {
    const projected = projectToolResultForHistory(
      {
        cursor: 0,
        rows: [
          {
            status: "ambiguous",
            candidates: Array.from({ length: 20 }, (_, index) => ({
              handle: `ref_${String(index).padStart(32, "0")}`,
              label: `同名人物${index}`,
              evidence: "上下文".repeat(80),
            })),
          },
        ],
        sourceCount: 1,
        nextCursor: null,
      },
      1_000,
      { toolName: "resolve_record_refs" },
    ) as {
      rows: Array<{
        candidates: Array<{ handle: string; label: string }>;
        _projection?: { omittedItems?: { candidates?: number } };
      }>;
    };

    expect(projected.rows[0]?.candidates.length).toBeGreaterThan(0);
    expect(projected.rows[0]?.candidates[0]).toMatchObject({ label: "同名人物0" });
    expect(projected.rows[0]?._projection?.omittedItems?.candidates).toBeGreaterThan(0);
    expect(JSON.stringify(projected).length).toBeLessThanOrEqual(1_000);
  });

  it("keeps projection semantics before large search rows", () => {
    const projected = projectToolResultForHistory(
      {
        projection: "profile_index",
        returnedFields: ["id", "name", "title"],
        omittedFields: ["likes", "dislikes", "gifts", "note"],
        omissionMeaning: "not_loaded",
        detailTool: "get_profiles",
        rows: Array.from({ length: 20 }, (_, index) => ({
          id: `person-${index}`,
          name: `人物${index}`,
          note: "详细资料".repeat(200),
        })),
      },
      1_200,
    ) as Record<string, unknown>;

    expect(projected).toMatchObject({
      projection: "profile_index",
      omissionMeaning: "not_loaded",
      detailTool: "get_profiles",
    });
    expect(projected.omittedFields).toContain("likes");
  });

  it("normalizes complete chat turns before request accounting", () => {
    const history = Array.from({ length: 12 }, (_, index) => ({
      role: index % 2 ? ("assistant" as const) : ("user" as const),
      text: String(index).repeat(8_000),
    }));
    const fitted = fitVisionHistory(history);
    expect(fitted.turns).toHaveLength(VISION_TEXT_LIMITS.historyTurns / 2);
    expect(fitted.omittedTurns).toBe(8);
    expect(fitted.summary).toContain("较早 8 条对话已压缩");
    expect(
      fitted.turns.every((turn) => turn.text.length <= VISION_TEXT_LIMITS.historyTurnCharacters),
    ).toBe(true);
    expect(fitted.turns.reduce((total, turn) => total + turn.text.length, 0)).toBeLessThanOrEqual(
      VISION_TEXT_LIMITS.historyTotalCharacters,
    );
  });
});
