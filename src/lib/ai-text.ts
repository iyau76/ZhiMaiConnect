/** 纯文本 AI 调用与 JSON 解析的公共封装 */

import { askModel } from "./vision-client";
import type { ProviderPreset } from "./vision-providers";

/** 一次性拿到完整回答（非流式使用场景） */
export async function askText(
  preset: ProviderPreset,
  prompt: string,
  onChunk?: (chunk: string) => void,
  signal?: AbortSignal,
) {
  let answer = "";
  await askModel(
    preset,
    prompt,
    null,
    [],
    (chunk) => {
      answer += chunk;
      onChunk?.(chunk);
    },
    signal ?? new AbortController().signal,
  );
  return answer;
}

/** 流式回答，边出边显示 */
export function askStream(
  preset: ProviderPreset,
  prompt: string,
  onChunk: (chunk: string) => void,
  signal?: AbortSignal,
) {
  return askModel(preset, prompt, null, [], onChunk, signal ?? new AbortController().signal);
}

/** 从模型回答里抠出 JSON 对象 */
export function parseLooseJson<T>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  let parseError: SyntaxError | null = null;
  let sawObject = false;

  for (let start = 0; start < body.length; start += 1) {
    if (body[start] !== "{") continue;
    sawObject = true;
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let end = start; end < body.length; end += 1) {
      const char = body[end];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') quoted = true;
      else if (char === "{") depth += 1;
      else if (char === "}") {
        depth -= 1;
        if (depth !== 0) continue;
        try {
          return JSON.parse(body.slice(start, end + 1)) as T;
        } catch (error) {
          if (error instanceof SyntaxError) parseError ??= error;
          break;
        }
      }
    }
  }

  if (parseError) throw parseError;
  if (!sawObject) throw new Error("AI 没有返回可解析的结构化结果");
  throw new SyntaxError("AI 返回的 JSON 对象不完整");
}
