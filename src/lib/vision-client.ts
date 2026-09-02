import { assertVision, type ChatTurn, type ProviderPreset } from "./vision-providers";
import { confirmCloudTransfer, type CloudDataType } from "./cloud-consent";
import { fetchWithApiSession } from "./api-session";
import { assertVisionPromptFits, fitVisionHistory } from "./ai-request-contract";
import { ModelTransportError } from "./model-transport-resilience";

function stripDataUrl(dataUrl: string) {
  const idx = dataUrl.indexOf(",");
  return idx === -1 ? dataUrl : dataUrl.slice(idx + 1);
}

export interface ModelRequestOptions {
  maxOutputTokens?: number;
  temperature?: number;
  /** Agent 协议使用完整 JSON 响应；普通问答默认继续流式返回。 */
  responseMode?: "stream" | "structured";
}

function ollamaMessages(prompt: string, image: string | null, history: ChatTurn[]) {
  return [
    ...history.slice(-8).map((turn) => ({ role: turn.role, content: turn.text })),
    {
      role: "user" as const,
      content: prompt,
      ...(image ? { images: [stripDataUrl(image)] } : {}),
    },
  ];
}

async function streamOllama(
  preset: ProviderPreset,
  prompt: string,
  image: string | null,
  history: ChatTurn[],
  onChunk: (text: string) => void,
  signal: AbortSignal,
  maxOutputTokens?: number,
  temperature?: number,
) {
  const base = preset.baseUrl.replace(/\/+$/, "");
  const messages = ollamaMessages(prompt, image, history);

  const response = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: preset.model,
      messages,
      stream: true,
      ...(maxOutputTokens || temperature !== undefined
        ? {
            options: {
              ...(maxOutputTokens ? { num_predict: maxOutputTokens } : {}),
              ...(temperature !== undefined ? { temperature } : {}),
            },
          }
        : {}),
    }),
    signal,
  });

  if (!response.ok) {
    throw new ModelTransportError(
      `Ollama 返回 ${response.status}：${(await response.text()).slice(0, 300)}`,
      response.status,
    );
  }
  if (!response.body) throw new Error("Ollama 没有返回内容");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const json = JSON.parse(line);
        const delta = json?.message?.content;
        if (typeof delta === "string" && delta) onChunk(delta);
      } catch {
        /* 跳过不完整的行 */
      }
    }
  }
}

async function completeOllama(
  preset: ProviderPreset,
  prompt: string,
  image: string | null,
  history: ChatTurn[],
  signal: AbortSignal,
  maxOutputTokens?: number,
  temperature?: number,
) {
  const base = preset.baseUrl.replace(/\/+$/, "");
  const response = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: preset.model,
      messages: ollamaMessages(prompt, image, history),
      stream: false,
      format: "json",
      ...(maxOutputTokens || temperature !== undefined
        ? {
            options: {
              ...(maxOutputTokens ? { num_predict: maxOutputTokens } : {}),
              ...(temperature !== undefined ? { temperature } : {}),
            },
          }
        : {}),
    }),
    signal,
  });

  if (!response.ok) {
    throw new ModelTransportError(
      `Ollama 返回 ${response.status}：${(await response.text()).slice(0, 300)}`,
      response.status,
    );
  }

  try {
    const json = (await response.json()) as { message?: { content?: unknown } };
    const reply = json.message?.content;
    if (typeof reply === "string" && reply.trim()) return reply;
  } catch {
    // 统一在下方报告协议错误，不泄露上游正文。
  }
  throw new ModelTransportError(
    "Ollama 没有返回可用的结构化正文",
    502,
    "UPSTREAM_INVALID_RESPONSE",
  );
}

async function serverResponseError(response: Response, clientRequestId: string) {
  let message = `请求失败（${response.status}）`;
  let code: string | undefined;
  let upstreamStatus: number | undefined;
  let providerCode: string | undefined;
  let providerType: string | undefined;
  let upstreamRequestId: string | undefined;
  try {
    const json = (await response.json()) as {
      error?: string;
      code?: string;
      upstreamStatus?: number;
      providerCode?: string;
      providerType?: string;
      upstreamRequestId?: string;
    };
    if (json.error) message = json.error;
    code = json.code;
    upstreamStatus = json.upstreamStatus;
    providerCode = json.providerCode;
    providerType = json.providerType;
    upstreamRequestId = json.upstreamRequestId;
  } catch {
    /* 保留默认信息 */
  }
  const edgeRequestId = response.headers.get("cf-ray") ?? undefined;
  const diagnosticText = [
    `client=${clientRequestId}`,
    edgeRequestId ? `edge=${edgeRequestId}` : "",
    upstreamStatus ? `upstream=${upstreamStatus}` : "",
    providerCode ? `provider=${providerCode}` : "",
    upstreamRequestId ? `upstream-request=${upstreamRequestId}` : "",
  ]
    .filter(Boolean)
    .join("；");
  return new ModelTransportError(`${message}（${diagnosticText}）`, response.status, code, {
    clientRequestId,
    edgeRequestId,
    upstreamRequestId,
    upstreamStatus,
    providerCode,
    providerType,
  });
}

async function requestServer(
  action: "chat" | "agent",
  preset: ProviderPreset,
  prompt: string,
  image: string | null,
  history: ChatTurn[],
  signal: AbortSignal,
  maxOutputTokens?: number,
  temperature?: number,
) {
  const clientRequestId = crypto.randomUUID();
  const response = await fetchWithApiSession("/api/vision", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Zhimai-Client-Request": clientRequestId,
    },
    signal,
    body: JSON.stringify({
      action,
      kind: preset.kind,
      baseUrl: preset.baseUrl,
      apiKey: preset.apiKey,
      model: preset.model,
      prompt,
      image,
      history,
      maxOutputTokens,
      temperature,
    }),
  });
  if (!response.ok) throw await serverResponseError(response, clientRequestId);
  return response;
}

async function streamServer(
  preset: ProviderPreset,
  prompt: string,
  image: string | null,
  history: ChatTurn[],
  onChunk: (text: string) => void,
  signal: AbortSignal,
  maxOutputTokens?: number,
  temperature?: number,
) {
  const response = await requestServer(
    "chat",
    preset,
    prompt,
    image,
    history,
    signal,
    maxOutputTokens,
    temperature,
  );
  if (!response.body) throw new Error("接口没有返回内容");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const isSse = response.headers.get("content-type")?.toLowerCase().includes("text/event-stream");
  let buffer = "";
  let emitted = false;
  const emit = (value: string) => {
    if (!value) return;
    emitted = true;
    onChunk(value);
  };
  const consumeSseLines = (text: string, flush = false) => {
    buffer += text;
    const lines = buffer.split(/\r?\n/);
    buffer = flush ? "" : (lines.pop() ?? "");
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try {
        const payload = JSON.parse(data) as {
          error?: { message?: unknown; code?: unknown };
          choices?: Array<{ delta?: { content?: unknown } }>;
        };
        if (payload.error) {
          throw new ModelTransportError(
            typeof payload.error.message === "string"
              ? payload.error.message
              : "上游 AI 返回流式错误",
            502,
            typeof payload.error.code === "string" ? payload.error.code : "UPSTREAM_STREAM_ERROR",
          );
        }
        const delta = payload.choices?.[0]?.delta?.content;
        if (typeof delta === "string" && delta) emit(delta);
      } catch (error) {
        if (error instanceof ModelTransportError) throw error;
        // SSE comments, heartbeats and provider metadata do not contain answer text.
      }
    }
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      if (isSse) consumeSseLines(text);
      else emit(text);
    }
    const tail = decoder.decode();
    if (isSse) consumeSseLines(tail, true);
    else if (tail) emit(tail);
    if (!emitted) {
      throw new ModelTransportError(
        "上游 AI 未返回可用的流式内容",
        502,
        "UPSTREAM_INVALID_RESPONSE",
      );
    }
  } catch (error) {
    if (signal.aborted) throw error;
    if (error instanceof ModelTransportError) throw error;
    throw new ModelTransportError("上游 AI 流式响应中断", 502, "STREAM_INTERRUPTED");
  }
}

async function completeServer(
  preset: ProviderPreset,
  prompt: string,
  image: string | null,
  history: ChatTurn[],
  signal: AbortSignal,
  maxOutputTokens?: number,
  temperature?: number,
) {
  const response = await requestServer(
    "agent",
    preset,
    prompt,
    image,
    history,
    signal,
    maxOutputTokens,
    temperature,
  );

  try {
    const json = (await response.json()) as { reply?: unknown };
    if (typeof json.reply === "string" && json.reply.trim()) return json.reply;
  } catch {
    // 统一在下方报告协议错误，不泄露上游正文。
  }
  throw new ModelTransportError(
    "上游 AI 没有返回可用的结构化正文",
    502,
    "UPSTREAM_INVALID_RESPONSE",
  );
}

/** 云端兼容接口必须填地址和 Key，否则请求没有明确的接收方。 */
function assertConfigured(preset: ProviderPreset) {
  if (preset.kind === "ollama") return;
  if (!preset.baseUrl.trim()) {
    throw new Error(`「${preset.name}」还没填接口地址，请到「模型」里补上。`);
  }
  if (!preset.apiKey.trim()) {
    throw new Error(`「${preset.name}」还没填 API Key。请到「模型配置」中填写后再试。`);
  }
}

export async function askModel(
  preset: ProviderPreset,
  prompt: string,
  image: string | null,
  history: ChatTurn[],
  onChunk: (text: string) => void,
  signal: AbortSignal,
  options: ModelRequestOptions = {},
) {
  assertConfigured(preset);
  const fittedHistory = fitVisionHistory(history);
  const effectivePrompt = fittedHistory.summary
    ? `${prompt}\n\n对话历史压缩说明：${fittedHistory.summary}`
    : prompt;
  assertVisionPromptFits(effectivePrompt);
  const boundedHistory = fittedHistory.turns;
  // 有图就必须是验证过的多模态模型，避免拿纯文本模型瞎分析
  if (image || boundedHistory.some((turn) => turn.image)) assertVision(preset);
  if (preset.kind === "ollama") {
    if (options.responseMode === "structured") {
      const reply = await completeOllama(
        preset,
        effectivePrompt,
        image,
        boundedHistory,
        signal,
        options.maxOutputTokens,
        options.temperature,
      );
      onChunk(reply);
      return;
    }
    return streamOllama(
      preset,
      effectivePrompt,
      image,
      boundedHistory,
      onChunk,
      signal,
      options.maxOutputTokens,
      options.temperature,
    );
  }
  const dataTypes: CloudDataType[] = ["文字内容"];
  if (/人物档案|人物关系|人脉库|关系网/.test(prompt)) dataTypes.push("人物关系上下文");
  if (image || boundedHistory.some((turn) => turn.image)) dataTypes.push("图片");
  await confirmCloudTransfer(preset, dataTypes);
  if (options.responseMode === "structured") {
    const reply = await completeServer(
      preset,
      effectivePrompt,
      image,
      boundedHistory,
      signal,
      options.maxOutputTokens,
      options.temperature,
    );
    onChunk(reply);
    return;
  }
  return streamServer(
    preset,
    effectivePrompt,
    image,
    boundedHistory,
    onChunk,
    signal,
    options.maxOutputTokens,
    options.temperature,
  );
}

export async function testConnection(preset: ProviderPreset) {
  assertConfigured(preset);
  if (preset.kind === "ollama") {
    const base = preset.baseUrl.replace(/\/+$/, "");
    const response = await fetch(`${base}/api/tags`);
    if (!response.ok) throw new Error(`Ollama 返回 ${response.status}`);
    const json = (await response.json()) as { models?: Array<{ name: string }> };
    const names = (json.models ?? []).map((m) => m.name);
    if (names.length && !names.some((n) => n.split(":")[0] === preset.model.split(":")[0])) {
      throw new Error(`连上了，但没找到模型「${preset.model}」。已安装：${names.join("、")}`);
    }
    return "连接正常";
  }

  const response = await fetchWithApiSession("/api/vision", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "test",
      kind: preset.kind,
      baseUrl: preset.baseUrl,
      apiKey: preset.apiKey,
      model: preset.model,
    }),
  });
  const json = (await response.json()) as { error?: string; reply?: string };
  if (!response.ok) throw new Error(json.error ?? `请求失败（${response.status}）`);
  return `连接正常：${(json.reply ?? "").trim().slice(0, 40)}`;
}

const PROBE_COLORS = [
  { key: "红", css: "#e11d48", alts: ["红", "red", "粉红", "玫红"] },
  { key: "绿", css: "#16a34a", alts: ["绿", "green"] },
  { key: "蓝", css: "#2563eb", alts: ["蓝", "blue"] },
  { key: "黄", css: "#eab308", alts: ["黄", "yellow"] },
];

function makeProbeImage(css: string) {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("浏览器不支持生成测试图");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, 256, 256);
  ctx.fillStyle = css;
  ctx.beginPath();
  ctx.arc(128, 128, 90, 0, Math.PI * 2);
  ctx.fill();
  return canvas.toDataURL("image/png");
}

async function askOnce(preset: ProviderPreset, prompt: string, image: string) {
  assertConfigured(preset);
  if (preset.kind === "ollama") {
    const base = preset.baseUrl.replace(/\/+$/, "");
    const response = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: preset.model,
        stream: false,
        messages: [{ role: "user", content: prompt, images: [stripDataUrl(image)] }],
      }),
    });
    if (!response.ok) throw new Error(`Ollama 返回 ${response.status}`);
    const json = (await response.json()) as { message?: { content?: string } };
    return json.message?.content ?? "";
  }

  const response = await fetchWithApiSession("/api/vision", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "audit",
      kind: preset.kind,
      baseUrl: preset.baseUrl,
      apiKey: preset.apiKey,
      model: preset.model,
      prompt,
      image,
    }),
  });
  const json = (await response.json()) as { error?: string; reply?: string };
  if (!response.ok) throw new Error(json.error ?? `请求失败（${response.status}）`);
  return json.reply ?? "";
}

/**
 * 审查这个模型到底能不能看图：连续两轮发送随机颜色的圆形测试图，
 * 两轮都答对才算通过（瞎猜通过率约 6%）。
 */
export async function auditVision(preset: ProviderPreset) {
  const rounds = [...PROBE_COLORS].sort(() => Math.random() - 0.5).slice(0, 2);
  const replies: string[] = [];
  for (const round of rounds) {
    const reply = await askOnce(
      preset,
      "这张图正中间有一个实心圆。它是什么颜色？只回答一个颜色词，不要解释。",
      makeProbeImage(round.css),
    );
    replies.push(reply.trim());
    const text = reply.toLowerCase();
    if (!round.alts.some((alt) => text.includes(alt.toLowerCase()))) {
      return {
        ok: false as const,
        detail: `第 ${replies.length} 轮答错：图是${round.key}色，模型回答「${reply.trim().slice(0, 30) || "空"}」`,
      };
    }
  }
  return { ok: true as const, detail: `两轮颜色测试全部答对（${replies.join(" / ")}）` };
}

/** 从 ESP32 CameraWebServer 抓一帧，返回 data URL */
export async function captureFrame(host: string) {
  const base = host.replace(/\/+$/, "");
  const response = await fetch(`${base}/capture?_t=${Date.now()}`);
  if (!response.ok) throw new Error(`摄像头返回 ${response.status}`);
  const blob = await response.blob();
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("图片读取失败"));
    reader.readAsDataURL(blob);
  });
}
