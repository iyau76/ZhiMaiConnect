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

export function fitVisionHistory<T extends { text: string }>(history: readonly T[]): T[] {
  const candidates = history.slice(-VISION_TEXT_LIMITS.historyTurns).map((turn) => ({
    ...turn,
    text: clipTextHeadTail(turn.text, VISION_TEXT_LIMITS.historyTurnCharacters),
  }));
  const selected: T[] = [];
  let used = 0;
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const turn = candidates[index]!;
    if (used + turn.text.length > VISION_TEXT_LIMITS.historyTotalCharacters) continue;
    selected.unshift(turn);
    used += turn.text.length;
  }
  return selected;
}
