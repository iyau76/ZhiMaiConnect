import { createFileRoute } from "@tanstack/react-router";

const LOVABLE_BASE = "https://ai.gateway.lovable.dev/v1";

type Turn = { role: "user" | "assistant"; text: string; image?: string };

interface Body {
  action?: "chat" | "test" | "audit";
  kind?: "lovable" | "openai";
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  prompt?: string;
  image?: string | null;
  history?: Turn[];
}

function buildMessages(history: Turn[], prompt: string, image?: string | null) {
  const messages: Array<{ role: string; content: unknown }> = [
    {
      role: "system",
      content: [
        "你是「知脉 Connect」的内置 AI 助手。知脉 Connect 是一套本地优先的人物识别与关系网梳理工具，面向政企与组织人脉管理场景。",
        "产品能力包括：",
        "1）多端输入：ESP32-S3 摄像头抓拍、本机摄像头/图片粘贴上传、PDF/Word/截图等文档解析、自由文本录入；",
        "2）人脸识别：浏览器本地运行 BlazeFace 检测 + 128 维人脸特征向量比对，支持合照多张人脸同时识别与批量入库，人脸数据只存在本机 IndexedDB；",
        "3）AI 整理：把一段自然语言、简历或文档自动抽取为人物档案（姓名、部门、职位、负责项目等）与人物之间的关系，并生成可实时编辑的关系草图；",
        "4）关系网可视化：按部门聚类的可拖拽关系图，单向/双向关系箭头，部门可改名、写说明、增删成员；",
        "5）模型可换：可用平台内置模型，也可接入任意 OpenAI 兼容接口，并能审查该模型是否真的支持读图。",
        "回答规则：用简洁中文；被问「你能干什么」时按上面的产品能力介绍自己，不要自称摄像头视觉助手；若用户给了画面或图片，就结合画面回答，可指出画面中的人、可识别的信息，以及可以怎样存入人物库或补充关系。",
      ].join("\n"),
    },
  ];
  for (const turn of history.slice(-8)) {
    messages.push({ role: turn.role, content: turn.text });
  }
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

function resolveTarget(body: Body) {
  if (body.kind === "openai") {
    const base = (body.baseUrl || "").replace(/\/+$/, "");
    if (!base) throw new Error("缺少接口地址（Base URL）");
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (body.apiKey) headers.Authorization = `Bearer ${body.apiKey}`;
    return { url: `${base}/chat/completions`, headers };
  }
  const key = process.env.LOVABLE_API_KEY;
  if (!key) throw new Error("服务端未配置 LOVABLE_API_KEY");
  return {
    url: `${LOVABLE_BASE}/chat/completions`,
    headers: {
      "Content-Type": "application/json",
      "Lovable-API-Key": key,
      "X-Lovable-AIG-SDK": "lovable-fetch",
    } as Record<string, string>,
  };
}

/** 把上游 SSE 转成纯文本流，前端直接按 chunk 追加即可 */
function sseToText(upstream: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = upstream.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const raw of lines) {
            const line = raw.trim();
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === "[DONE]") continue;
            try {
              const json = JSON.parse(payload);
              const delta = json?.choices?.[0]?.delta?.content;
              if (typeof delta === "string" && delta)
                controller.enqueue(encoder.encode(delta));
            } catch {
              /* 忽略无法解析的心跳行 */
            }
          }
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
}

export const Route = createFileRoute("/api/vision")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let body: Body;
        try {
          body = (await request.json()) as Body;
        } catch {
          return Response.json({ error: "请求体不是合法 JSON" }, { status: 400 });
        }

        let target: { url: string; headers: Record<string, string> };
        try {
          target = resolveTarget(body);
        } catch (error) {
          return Response.json({ error: (error as Error).message }, { status: 400 });
        }

        const model = body.model?.trim();
        if (!model) return Response.json({ error: "缺少模型名称" }, { status: 400 });

        const isTest = body.action === "test";
        const isAudit = body.action === "audit";
        const oneShot = isTest || isAudit;
        const prompt = isTest ? "回复两个字：连通" : (body.prompt?.trim() ?? "");
        if (!prompt) return Response.json({ error: "请输入问题" }, { status: 400 });

        const payload = {
          model,
          messages: buildMessages(oneShot ? [] : (body.history ?? []), prompt, isTest ? null : body.image),
          stream: !oneShot,
          ...(model.startsWith("openai/gpt-5.6") ? { reasoning_effort: "none" } : {}),
        };


        let upstream: Response;
        try {
          upstream = await fetch(target.url, {
            method: "POST",
            headers: target.headers,
            body: JSON.stringify(payload),
          });
        } catch (error) {
          return Response.json(
            { error: `无法连接接口地址：${(error as Error).message}` },
            { status: 502 },
          );
        }

        if (!upstream.ok) {
          const text = await upstream.text();
          console.error(`vision upstream ${upstream.status}: ${text}`);
          const message =
            upstream.status === 429
              ? "请求过于频繁，请稍后再试"
              : upstream.status === 402
                ? "AI 额度已用完，请在 Settings → Plans & credits 充值"
                : `接口返回 ${upstream.status}：${text.slice(0, 400)}`;
          return Response.json({ error: message }, { status: upstream.status });
        }

        if (oneShot) {
          const json = (await upstream.json()) as {
            choices?: Array<{ message?: { content?: string } }>;
          };
          return Response.json({ ok: true, reply: json?.choices?.[0]?.message?.content ?? "" });
        }


        if (!upstream.body) return Response.json({ error: "接口没有返回内容" }, { status: 502 });

        return new Response(sseToText(upstream.body), {
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": "no-cache",
          },
        });
      },
    },
  },
});
