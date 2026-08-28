import { AGENT_PROMPT_MAX_CHARACTERS, clipTextHeadTail } from "./ai-request-contract";
import { serializeToolHistory } from "./agent-history";

export interface AgentPromptComposition {
  prompt: string;
  context: string;
  history: string;
  maximumCharacters: number;
  contextCharacters: number;
  historyCharacters: number;
}

export interface ComposeAgentPromptOptions {
  /** Render the final prompt. Context and history must be inserted exactly once. */
  render: (context: string, history: string) => string;
  fitContext: (maxCharacters: number) => string;
  toolHistory: Array<{ call: unknown; result: unknown }>;
  preferredHistoryCharacters?: number;
  minimumContextCharacters?: number;
  maxCharacters?: number;
}

export class AgentPromptContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentPromptContractError";
  }
}

/**
 * Compose a prompt without ever slicing JSON archive context or a tool-history
 * entry. The caller owns the semantic context fitter; this function owns the
 * single request budget shared by every Agent.
 */
export function composeAgentPrompt(options: ComposeAgentPromptOptions): AgentPromptComposition {
  const maximumCharacters = options.maxCharacters ?? AGENT_PROMPT_MAX_CHARACTERS;
  const fixedPrompt = options.render("", "");
  if (fixedPrompt.length >= maximumCharacters) {
    throw new AgentPromptContractError(
      `Agent 固定指令已超过提示词预算（${fixedPrompt.length}/${maximumCharacters} 字符）`,
    );
  }

  const variableBudget = maximumCharacters - fixedPrompt.length;
  const minimumContext = Math.min(
    variableBudget,
    Math.max(0, options.minimumContextCharacters ?? 400),
  );
  const preferredHistory = Math.max(2, options.preferredHistoryCharacters ?? 5_000);
  const initialHistoryBudget = Math.max(
    2,
    Math.min(preferredHistory, variableBudget - minimumContext),
  );
  let history = serializeToolHistory(options.toolHistory, initialHistoryBudget) || "[]";
  let contextBudget = Math.max(0, variableBudget - history.length);
  let context = options.fitContext(contextBudget);
  if (context.length > contextBudget) {
    throw new AgentPromptContractError(
      `Agent 上下文适配器违反预算（${context.length}/${contextBudget} 字符）`,
    );
  }

  // Small archives often leave unused context room. Give that room back to
  // complete recent tool entries, then keep the already-valid context intact.
  const spare = variableBudget - context.length - history.length;
  if (spare > 0 && options.toolHistory.length) {
    const expanded = serializeToolHistory(
      options.toolHistory,
      Math.min(preferredHistory, history.length + spare),
    );
    if (expanded && expanded.length <= history.length + spare) history = expanded;
    contextBudget = Math.max(0, variableBudget - history.length);
    if (context.length > contextBudget) context = options.fitContext(contextBudget);
  }

  const prompt = options.render(context, history);
  if (prompt.length > maximumCharacters) {
    throw new AgentPromptContractError(
      `Agent 提示词组合超过预算（${prompt.length}/${maximumCharacters} 字符）`,
    );
  }
  return {
    prompt,
    context,
    history,
    maximumCharacters,
    contextCharacters: context.length,
    historyCharacters: history.length,
  };
}

export function fitPlainAgentContext(value: string, maxCharacters: number) {
  return clipTextHeadTail(value, maxCharacters);
}

/** Keep JSON parseable by adding only complete top-level values/array items. */
export function fitJsonAgentContext(value: unknown, maxCharacters: number) {
  if (maxCharacters < 2) return "";
  const full = JSON.stringify(value);
  if (full && full.length <= maxCharacters) return full;
  if (!value || typeof value !== "object" || Array.isArray(value)) return "{}";

  const source = value as Record<string, unknown>;
  const output: Record<string, unknown> = { _promptBudgetTruncated: true };
  if (JSON.stringify(output).length > maxCharacters) return "{}";
  for (const [key, item] of Object.entries(source)) {
    if (Array.isArray(item)) {
      const selected: unknown[] = [];
      for (const entry of item) {
        const candidate = { ...output, [key]: [...selected, entry] };
        if (JSON.stringify(candidate).length > maxCharacters) break;
        selected.push(entry);
      }
      const candidate = { ...output, [key]: selected };
      if (JSON.stringify(candidate).length <= maxCharacters) output[key] = selected;
      continue;
    }
    const candidate = { ...output, [key]: item };
    if (JSON.stringify(candidate).length <= maxCharacters) output[key] = item;
  }
  return JSON.stringify(output);
}
