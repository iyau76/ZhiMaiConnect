/** 录音 + 转写：录音在浏览器完成，音频只发给转写接口，不落盘 */

import { findVariant } from "./dialects";
import { confirmCloudTransfer } from "./cloud-consent";
import { fetchWithApiSession } from "./api-session";
import { assertAudio, type ProviderPreset } from "./vision-providers";

export function fileToDataUrl(file: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("音频读取失败"));
    reader.readAsDataURL(file);
  });
}

export interface Recorder {
  stop: () => Promise<Blob>;
  cancel: () => void;
  mime: string;
}

/** 语言 / 方言 id，取值见 src/lib/dialects.ts */
export type SttLang = string;

export async function startRecording(): Promise<Recorder> {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("当前浏览器不支持录音");
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const mime = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "audio/mp4";
  const recorder = new MediaRecorder(stream, { mimeType: mime });
  const chunks: BlobPart[] = [];
  recorder.ondataavailable = (event) => {
    if (event.data.size) chunks.push(event.data);
  };
  recorder.start();

  const cleanup = () => stream.getTracks().forEach((track) => track.stop());

  return {
    mime,
    cancel: () => {
      try {
        recorder.stop();
      } catch {
        /* ignore */
      }
      cleanup();
    },
    stop: () =>
      new Promise<Blob>((resolve) => {
        recorder.onstop = () => {
          cleanup();
          resolve(new Blob(chunks, { type: mime }));
        };
        recorder.stop();
      }),
  };
}

/**
 * 把音频送到当前 OpenAI 兼容接口的 `/audio/transcriptions` 端点。
 * language 传方言 id（见 dialects.ts），方言会转成 ISO 码 + 引导提示。
 */
export async function transcribeAudio(
  audio: Blob | string,
  options: { preset?: ProviderPreset; hint?: string; filename?: string; language?: SttLang } = {},
) {
  const dataUrl = typeof audio === "string" ? audio : await fileToDataUrl(audio);
  const mime = typeof audio === "string" ? undefined : audio.type;
  const preset = options.preset;
  if (!preset) throw new Error("请先选择一套支持语音转写的 OpenAI 兼容接口");
  assertAudio(preset);
  const variant = findVariant(options.language ?? "auto");
  const hint = [variant.prompt, options.hint].filter(Boolean).join(" ").slice(0, 600) || undefined;

  await confirmCloudTransfer(preset, ["音频"]);

  const response = await fetchWithApiSession("/api/transcribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      audio: dataUrl,
      mime,
      filename: options.filename,
      hint,
      language: variant.iso,
      kind: "openai",
      baseUrl: preset.baseUrl,
      apiKey: preset.apiKey,
      model: preset.model,
    }),
  });

  const json = (await response.json()) as { error?: string; text?: string };
  if (!response.ok) throw new Error(json.error ?? `转写失败（${response.status}）`);
  return (json.text ?? "").trim();
}
