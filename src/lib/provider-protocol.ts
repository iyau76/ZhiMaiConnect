import { SafeApiError } from "./api-error";

export interface VisionProtocolInput {
  action: "chat" | "agent" | "test" | "audit";
  model: string;
  baseUrl: string;
  history: Array<{ role: "user" | "assistant"; text: string }>;
  prompt?: string;
  image?: string | null;
  maxOutputTokens?: number;
  temperature?: number;
}

export function buildTranscriptionForm(
  audio: Uint8Array,
  options: { model?: string; mime?: string; filename?: string; hint?: string; language?: string },
) {
  const form = new FormData();
  form.append(
    "file",
    new Blob([audio as unknown as BlobPart], { type: options.mime || "audio/webm" }),
    options.filename || "audio.webm",
  );
  form.append("model", options.model || "whisper-1");
  if (options.hint) form.append("prompt", options.hint);
  if (options.language && options.language !== "auto") form.append("language", options.language);
  return form;
}

const SYSTEM_PROMPT = [
  "你是「知脉 Connect」的内置助手：一个本地优先、证据可追溯的人际关系记忆与行动助手。",
  "你帮助用户整理其主动提供的人物档案、关系、互动记录、重要日期和行动事项，并生成可核对、可编辑的建议或草稿。",
  "事实规则：只依据本次对话中明确提供的文字、图片和资料回答；不得编造人物、关系、经历、联系方式或已完成的动作。资料不足时明确说“不确定”并指出需要补充什么。",
  "证据规则：涉及具体人物或关系时，尽量标明信息来源、发生或记录时间和置信度；严格区分已知事实、合理推断和行动建议。没有来源或时间时，不得虚构引用，应明确标注缺失。",
  "隐私规则：产品的档案默认保存在用户浏览器本地；只有用户主动调用云模型时，本次请求中选定的内容才会发送给相应服务商。不要声称所有处理都在本地完成。",
  "外部行动规则：你只能生成消息、提醒或沟通方案的草稿，不得声称已经发送、发布、联系或修改任何外部系统。",
  "平台边界：不得宣称能够读取、搜索或接入个人微信、QQ、小红书等封闭平台，也不得假装看到了用户未提供的聊天记录或账号数据。",
  "图片规则：只描述图片中可直接观察或读取的信息；不要凭外貌猜测身份、关系、健康、民族、政治倾向等敏感属性。若要关联到已有档案，必须让用户确认。",
  "表达规则：默认使用简洁、自然的中文；给出建议时说明依据、风险和下一步，始终让用户保留最终决定权。",
].join("\n");

type Message = { role: "system" | "user" | "assistant"; content: unknown };

function buildMessages(
  history: VisionProtocolInput["history"],
  prompt: string,
  image?: string | null,
) {
  const messages: Message[] = [{ role: "system", content: SYSTEM_PROMPT }];
  for (const turn of history) messages.push({ role: turn.role, content: turn.text });
  if (image) {
    messages.push({
      role: "user",
      content: [
        { type: "text", text: prompt },
        { type: "image_url", image_url: { url: image } },
      ],
    });
  } else {
    messages.push({ role: "user", content: prompt });
  }
  return messages;
}

export function buildVisionPayload(body: VisionProtocolInput) {
  const oneShot = body.action !== "chat";
  const privateOneShot = body.action === "test" || body.action === "audit";
  const prompt = body.action === "test" ? "回复两个字：连通" : (body.prompt ?? "");
  const targetHostname = new URL(body.baseUrl).hostname;
  const officialDeepSeekAgent =
    body.action === "agent" &&
    targetHostname === "api.deepseek.com" &&
    /^deepseek-v4-(?:flash(?:-vision-exp)?|pro)$/i.test(body.model);
  const officialGeminiAgent =
    body.action === "agent" &&
    targetHostname === "generativelanguage.googleapis.com" &&
    /^gemini-/i.test(body.model);
  const payload = {
    model: body.model,
    messages: buildMessages(
      privateOneShot ? [] : body.history,
      prompt,
      body.action === "test" ? null : body.image,
    ),
    stream: !oneShot,
    ...(body.maxOutputTokens
      ? /(?:^|\/)(?:gpt-5|o[134])(?:[.-]|$)/i.test(body.model)
        ? { max_completion_tokens: body.maxOutputTokens }
        : { max_tokens: body.maxOutputTokens }
      : {}),
    ...(body.temperature !== undefined && !/(?:^|\/)(?:gpt-5|o[134])(?:[.-]|$)/i.test(body.model)
      ? { temperature: body.temperature }
      : {}),
    ...(body.model.startsWith("openai/gpt-5.6") ? { reasoning_effort: "none" } : {}),
    ...(officialDeepSeekAgent
      ? {
          thinking: { type: "disabled" },
          response_format: { type: "json_object" },
        }
      : officialGeminiAgent
        ? { response_format: { type: "json_object" } }
        : {}),
  };

  return payload;
}

export function parseVisionReply(raw: string) {
  let reply = "";
  try {
    const payload = JSON.parse(raw) as {
      choices?: Array<{
        finish_reason?: unknown;
        message?: { content?: unknown; reasoning_content?: unknown };
      }>;
    };
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content === "string") reply = content;
    if (!reply) {
      const choice = payload.choices?.[0];
      const reasoning = choice?.message?.reasoning_content;
      if (choice?.finish_reason === "length" && typeof reasoning === "string" && reasoning) {
        throw new SafeApiError(
          422,
          "MODEL_OUTPUT_TRUNCATED",
          "模型把输出预算耗在思考阶段，尚未生成可用正文",
        );
      }
      throw new SafeApiError(502, "UPSTREAM_INVALID_RESPONSE", "上游 AI 没有返回可用正文");
    }
  } catch (error) {
    if (error instanceof SafeApiError) throw error;
    throw new SafeApiError(502, "UPSTREAM_INVALID_RESPONSE", "上游 AI 返回了无效响应");
  }
  return reply;
}
