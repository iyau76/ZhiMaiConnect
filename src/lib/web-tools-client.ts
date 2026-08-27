import { apiSessionHeaders } from "./api-session";

export type WebToolRequest =
  | { tool: "weather"; location: string }
  | { tool: "news"; query: string }
  | { tool: "search"; query: string };

export async function callWebTool(request: WebToolRequest, signal?: AbortSignal) {
  const response = await fetch("/api/web-tools", {
    method: "POST",
    headers: await apiSessionHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(request),
    signal,
  });
  const body = (await response.json()) as { error?: unknown; result?: unknown };
  if (!response.ok) {
    throw new Error(
      typeof body.error === "string" ? body.error : `联网工具请求失败（${response.status}）`,
    );
  }
  return body.result;
}
