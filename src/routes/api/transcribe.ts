import { createFileRoute } from "@tanstack/react-router";

const LOVABLE_BASE = "https://ai.gateway.lovable.dev/v1";
const DEFAULT_MODEL = "openai/gpt-4o-mini-transcribe";

interface Body {
  /** data URL 或纯 base64 */
  audio?: string;
  mime?: string;
  filename?: string;
  /** "lovable"（默认，走 Lovable AI）或 "openai"（自定义 OpenAI 兼容接口，如自建 Whisper） */
  kind?: "lovable" | "openai";
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  /** 提示语，帮助模型识别人名/术语 */
  hint?: string;
  /** ISO-639-1 语言码，不传则自动检测（方言统一用 zh + hint 引导） */
  language?: string;
}

function decodeBase64(input: string) {
  const raw = input.includes(",") ? input.slice(input.indexOf(",") + 1) : input;
  const binary = atob(raw);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export const Route = createFileRoute("/api/transcribe")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let body: Body;
        try {
          body = (await request.json()) as Body;
        } catch {
          return Response.json({ error: "请求体不是合法 JSON" }, { status: 400 });
        }

        if (!body.audio) return Response.json({ error: "缺少音频数据" }, { status: 400 });

        let url: string;
        const headers: Record<string, string> = {};
        let model = body.model?.trim() || DEFAULT_MODEL;

        if (body.kind === "openai") {
          const base = (body.baseUrl || "").replace(/\/+$/, "");
          if (!base) return Response.json({ error: "缺少接口地址（Base URL）" }, { status: 400 });
          url = `${base}/audio/transcriptions`;
          if (body.apiKey) headers.Authorization = `Bearer ${body.apiKey}`;
          if (!body.model?.trim()) model = "whisper-1";
        } else {
          const key = process.env.LOVABLE_API_KEY;
          if (!key) return Response.json({ error: "服务端未配置 LOVABLE_API_KEY" }, { status: 400 });
          url = `${LOVABLE_BASE}/audio/transcriptions`;
          headers["Lovable-API-Key"] = key;
          headers["X-Lovable-AIG-SDK"] = "lovable-fetch";
        }

        let bytes: Uint8Array;
        try {
          bytes = decodeBase64(body.audio);
        } catch {
          return Response.json({ error: "音频数据无法解码" }, { status: 400 });
        }

        const mime = body.mime || "audio/webm";
        const form = new FormData();
        form.append("file", new Blob([bytes as unknown as BlobPart], { type: mime }), body.filename || "audio.webm");
        form.append("model", model);
        if (body.hint) form.append("prompt", body.hint);
        if (body.language && body.language !== "auto") form.append("language", body.language);

        let upstream: Response;
        try {
          upstream = await fetch(url, { method: "POST", headers, body: form });
        } catch (error) {
          return Response.json(
            { error: `无法连接转写接口：${(error as Error).message}` },
            { status: 502 },
          );
        }

        if (!upstream.ok) {
          const text = await upstream.text();
          console.error(`transcribe upstream ${upstream.status}: ${text}`);
          const message =
            upstream.status === 429
              ? "请求过于频繁，请稍后再试"
              : upstream.status === 402
                ? "AI 额度已用完，请在 Settings → Plans & credits 充值"
                : `转写接口返回 ${upstream.status}：${text.slice(0, 400)}`;
          return Response.json({ error: message }, { status: upstream.status });
        }

        const json = (await upstream.json()) as { text?: string };
        return Response.json({ ok: true, text: json.text ?? "" });
      },
    },
  },
});

