export const VISION_TEXT_LIMITS = {
  promptCharacters: 12_000,
  historyTurns: 8,
  historyTurnCharacters: 6_000,
  historyTotalCharacters: 24_000,
} as const;

/**
 * Leave a small transport margin so client-side Agent prompts never sit exactly
 * on the API validation boundary.
 */
export const AGENT_PROMPT_MAX_CHARACTERS = VISION_TEXT_LIMITS.promptCharacters - 200;

export class AiRequestContractError extends Error {
  constructor(
    message: string,
    readonly actualCharacters: number,
    readonly maximumCharacters: number,
  ) {
    super(message);
    this.name = "AiRequestContractError";
  }
}

export function assertVisionPromptFits(prompt: string) {
  if (prompt.length <= VISION_TEXT_LIMITS.promptCharacters) return;
  throw new AiRequestContractError(
    `内部提示词超过请求契约（${prompt.length}/${VISION_TEXT_LIMITS.promptCharacters} 字符）`,
    prompt.length,
    VISION_TEXT_LIMITS.promptCharacters,
  );
}

export function clipTextHeadTail(value: string, maxCharacters: number, headRatio = 0.7) {
  if (maxCharacters <= 0) return "";
  if (value.length <= maxCharacters) return value;
  const marker = "\n…（中间内容已按提示词预算省略）…\n";
  if (maxCharacters <= marker.length) return value.slice(0, maxCharacters);
  const remaining = maxCharacters - marker.length;
  const head = Math.max(0, Math.min(remaining, Math.floor(remaining * headRatio)));
  return `${value.slice(0, head)}${marker}${value.slice(value.length - (remaining - head))}`;
}

export interface FittedVisionHistory<T> {
  turns: T[];
  omittedTurns: number;
  /** Deterministic, bounded context for the model and an explicit UI notice. */
  summary: string;
}

function summarizeOmittedHistory<T extends { text: string; role?: string }>(turns: readonly T[]) {
  if (!turns.length) return "";
  const samples = turns.length <= 4 ? [...turns] : [...turns.slice(0, 2), ...turns.slice(-2)];
  const rows = samples.map((turn) => {
    const role = turn.role === "assistant" ? "助手" : "用户";
    const text = turn.text.replace(/\s+/g, " ").trim();
    return `${role}：${text.slice(0, 80) || "（空消息）"}`;
  });
  return `较早 ${turns.length} 条对话已压缩（不是遗忘）：${rows.join("；")}`.slice(0, 520);
}

/**
 * Fits transport history while reporting every omitted turn. Consumers must
 * pass `summary` to the model and may show `omittedTurns` in the UI.
 */
export function fitVisionHistory<T extends { text: string; role?: string }>(
  history: readonly T[],
): FittedVisionHistory<T> {
  const candidates = history.map((turn) => ({
    ...turn,
    text: clipTextHeadTail(turn.text, VISION_TEXT_LIMITS.historyTurnCharacters),
  }));
  const selected: Array<{ turn: T; index: number }> = [];
  let used = 0;
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    if (selected.length >= VISION_TEXT_LIMITS.historyTurns) break;
    const turn = candidates[index]!;
    if (used + turn.text.length > VISION_TEXT_LIMITS.historyTotalCharacters) continue;
    selected.unshift({ turn, index });
    used += turn.text.length;
  }
  const selectedIndexes = new Set(selected.map((entry) => entry.index));
  const omitted = candidates.filter((_, index) => !selectedIndexes.has(index));
  return {
    turns: selected.map((entry) => entry.turn),
    omittedTurns: omitted.length,
    summary: summarizeOmittedHistory(omitted),
  };
}
