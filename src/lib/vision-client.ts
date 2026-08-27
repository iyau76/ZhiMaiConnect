import { assertVision, type ChatTurn, type ProviderPreset } from "./vision-providers";
import { confirmCloudTransfer, type CloudDataType } from "./cloud-consent";
import { apiSessionHeaders } from "./api-session";

function stripDataUrl(dataUrl: string) {
  const idx = dataUrl.indexOf(",");
  return idx === -1 ? dataUrl : dataUrl.slice(idx + 1);
}

async function streamOllama(
  preset: ProviderPreset,
  prompt: string,
  image: string | null,
  history: ChatTurn[],
  onChunk: (text: string) => void,
  signal: AbortSignal,
) {
  const base = preset.baseUrl.replace(/\/+$/, "");
  const messages = [
    ...history.slice(-8).map((turn) => ({ role: turn.role, content: turn.text })),
    {
      role: "user",
      content: prompt,
      ...(image ? { images: [stripDataUrl(image)] } : {}),
    },
  ];

  const response = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: preset.model, messages, stream: true }),
    signal,
  });

  if (!response.ok) {
    throw new Error(`Ollama 返回 ${response.status}：${(await response.text()).slice(0, 300)}`);
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

async function streamServer(
  preset: ProviderPreset,
  prompt: string,
  image: string | null,
  history: ChatTurn[],
  onChunk: (text: string) => void,
  signal: AbortSignal,
) {
  const response = await fetch("/api/vision", {
    method: "POST",
    headers: await apiSessionHeaders({ "Content-Type": "application/json" }),
    signal,
    body: JSON.stringify({
      action: "chat",
      kind: preset.kind,
      baseUrl: preset.baseUrl,
      apiKey: preset.apiKey,
      model: preset.model,
      prompt,
      image,
      history,
    }),
  });

  if (!response.ok) {
    let message = `请求失败（${response.status}）`;
    try {
      const json = (await response.json()) as { error?: string };
      if (json.error) message = json.error;
    } catch {
      /* 保留默认信息 */
    }
    throw new Error(message);
  }
  if (!response.body) throw new Error("接口没有返回内容");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    onChunk(decoder.decode(value, { stream: true }));
  }
}

/** 自定义接口必须填 Key，否则会拿到看不懂的 401 */
function assertConfigured(preset: ProviderPreset) {
  if (preset.kind !== "openai") return;
  if (!preset.baseUrl.trim()) {
    throw new Error(`「${preset.name}」还没填接口地址，请到「模型」里补上。`);
  }
  if (!preset.apiKey.trim()) {
    throw new Error(
      `「${preset.name}」还没填 API Key，接口会返回 401。请到「模型」里填入 Key，或切换到内置的 Lovable AI（免配置）。`,
    );
  }
}

export async function askModel(
  preset: ProviderPreset,
  prompt: string,
  image: string | null,
  history: ChatTurn[],
  onChunk: (text: string) => void,
  signal: AbortSignal,
) {
  assertConfigured(preset);
  // 有图就必须是验证过的多模态模型，避免拿纯文本模型瞎分析
  if (image || history.some((turn) => turn.image)) assertVision(preset);
  if (preset.kind === "ollama") {
    return streamOllama(preset, prompt, image, history, onChunk, signal);
  }
  const dataTypes: CloudDataType[] = ["文字内容"];
  if (/人物档案|人物关系|人脉库|关系网/.test(prompt)) dataTypes.push("人物关系上下文");
  if (image || history.some((turn) => turn.image)) dataTypes.push("图片");
  confirmCloudTransfer(preset, dataTypes);
  return streamServer(preset, prompt, image, history, onChunk, signal);
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

  const response = await fetch("/api/vision", {
    method: "POST",
    headers: await apiSessionHeaders({ "Content-Type": "application/json" }),
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

  const response = await fetch("/api/vision", {
    method: "POST",
    headers: await apiSessionHeaders({ "Content-Type": "application/json" }),
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
