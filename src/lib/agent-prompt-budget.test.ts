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

  it("projects oversized results while retaining locked ranking fields and stable rows", () => {
    const projected = projectToolResultForHistory(
      {
        rankingLocked: true,
        mode: "target_side",
        accessVerified: false,
        rows: Array.from({ length: 50 }, (_, index) => ({
          personId: `person-${index}`,
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

  it("projects every row fairly instead of preserving only an array prefix", () => {
    const projected = projectToolResultForHistory(
      {
        rows: Array.from({ length: 8 }, (_, index) => ({
          id: `person-${index}`,
          name: `人物${index}`,
          title: index % 2 ? "工程师" : "",
          org: "知脉",
          note: "详细资料".repeat(240),
        })),
      },
      3_800,
    ) as { rows: Array<{ id: string; name: string }> };

    expect(projected.rows).toHaveLength(8);
    expect(projected.rows.map((row) => row.id)).toEqual(
      Array.from({ length: 8 }, (_, index) => `person-${index}`),
    );
    expect(projected.rows.every((row) => row.name)).toBe(true);
    expect(JSON.stringify(projected).length).toBeLessThanOrEqual(3_800);
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
