/** 纯文本 AI 调用与 JSON 解析的公共封装 */

import { askModel } from "./vision-client";
import type { ProviderPreset } from "./vision-providers";

/** 一次性拿到完整回答（非流式使用场景） */
export async function askText(preset: ProviderPreset, prompt: string) {
  let answer = "";
  await askModel(
    preset,
    prompt,
    null,
    [],
    (chunk) => {
      answer += chunk;
    },
    new AbortController().signal,
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
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("AI 没有返回可解析的结构化结果");
  return JSON.parse(body.slice(start, end + 1)) as T;
}
