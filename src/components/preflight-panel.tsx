import { CheckCircle2, CircleAlert, ClipboardCheck, Loader2 } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { getDemoDataStatus } from "@/lib/demo-data";
import { facesDb } from "@/lib/face-db";
import { cn } from "@/lib/utils";
import type { ProviderPreset } from "@/lib/vision-providers";

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

function persistedKeyRisk() {
  try {
    const presets = JSON.parse(localStorage.getItem("openglass.presets") ?? "[]") as unknown;
    if (!Array.isArray(presets)) return false;
    return presets.some(
      (item) =>
        item &&
        typeof item === "object" &&
        "apiKey" in item &&
        typeof item.apiKey === "string" &&
        Boolean(item.apiKey),
    );
  } catch {
    return false;
  }
}

export function PreflightPanel({ preset }: { preset: ProviderPreset }) {
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<CheckResult[]>([]);

  const run = async () => {
    setRunning(true);
    const next: CheckResult[] = [];
    let lovableConfigured: boolean | null = null;
    try {
      const response = await fetch("/api/status", { headers: { Accept: "application/json" } });
      const status = (await response.json()) as { lovableConfigured?: boolean };
      lovableConfigured = response.ok && status.lovableConfigured === true;
    } catch {
      lovableConfigured = null;
    }
    try {
      const [people, relations, events, reminders, demo] = await Promise.all([
        facesDb.listPersons(),
        facesDb.listRelations(),
        facesDb.listLifeEvents(),
        facesDb.listReminders(),
        getDemoDataStatus(),
      ]);
      next.push({
        name: "本地数据库",
        ok: true,
        detail: `${people.length} 人、${relations.length} 条关系、${events.length} 个事件、${reminders.length} 个提醒`,
      });
      next.push({
        name: "合成演示数据",
        ok: demo.people === 50 && demo.relations === 80,
        detail:
          demo.people === 50 && demo.relations === 80
            ? "50 人 / 80 边，规模正确"
            : `当前 ${demo.people} 人 / ${demo.relations} 边，请先载入`,
      });
    } catch (error) {
      next.push({
        name: "本地数据库",
        ok: false,
        detail: error instanceof Error ? error.message : "无法读取 IndexedDB",
      });
    }

    const modelReady =
      Boolean(preset.model.trim()) &&
      (preset.kind === "lovable"
        ? lovableConfigured === true
        : preset.kind !== "openai" || Boolean(preset.baseUrl.trim() && preset.apiKey.trim()));
    next.push({
      name: "当前模型配置",
      ok: modelReady,
      detail: modelReady
        ? `${preset.name} · ${preset.model}（联网能力请在“AI 助理”页另点测试连接）`
        : preset.kind === "lovable" && lovableConfigured === false
          ? "服务端缺少 LOVABLE_API_KEY；请改用本地 Ollama/自定义接口，基础功能仍可演示"
          : lovableConfigured === null && preset.kind === "lovable"
            ? "无法读取服务端配置状态；请在“AI 助理”页测试连接"
            : "模型、接口地址或会话密钥不完整；本地功能仍可演示",
    });
    const microphoneReady =
      Reflect.has(navigator, "mediaDevices") && Reflect.has(globalThis, "MediaRecorder");
    next.push({
      name: "麦克风能力",
      ok: microphoneReady,
      detail: microphoneReady
        ? "浏览器支持；实际权限会在开始录音时请求"
        : "当前浏览器或非安全上下文不支持录音，请使用文字输入",
    });
    next.push({
      name: "文件解析",
      ok: typeof FileReader !== "undefined",
      detail: "支持 TXT / MD / CSV / JSON、PDF、DOCX 和常见图片；图片会先压缩",
    });
    next.push({
      name: "密钥存储",
      ok: !persistedKeyRisk(),
      detail: persistedKeyRisk()
        ? "发现旧版本遗留的 localStorage 密钥；请在 AI 助理页重新保存或清除"
        : "未发现持久化 API Key；自定义密钥仅保存在当前会话",
    });
    next.push({
      name: "语言与版本",
      ok: document.documentElement.lang === "zh-CN" || document.documentElement.lang === "en",
      detail: `v0.1.0 · <html lang="${document.documentElement.lang}">`,
    });
    setResults(next);
    setRunning(false);
  };

  return (
    <section className="space-y-3 border-t border-border pt-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-medium">
            <ClipboardCheck className="size-4 text-primary" aria-hidden="true" />
            演示前自检
          </h2>
          <p className="mt-1 text-[11px] text-muted-foreground">
            只做本地只读检查，不发送人物资料，也不会主动申请麦克风权限。
          </p>
        </div>
        <Button variant="outline" onClick={() => void run()} disabled={running}>
          {running ? (
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          ) : (
            <ClipboardCheck className="size-4" aria-hidden="true" />
          )}
          运行自检
        </Button>
      </div>
      {results.length > 0 && (
        <ul className="grid gap-2 sm:grid-cols-2">
          {results.map((result) => (
            <li
              key={result.name}
              className="rounded-lg border border-border bg-background/50 p-2.5"
            >
              <p className="flex items-center gap-1.5 text-xs font-medium">
                {result.ok ? (
                  <CheckCircle2 className="size-3.5 text-primary" aria-hidden="true" />
                ) : (
                  <CircleAlert className="size-3.5 text-amber-600" aria-hidden="true" />
                )}
                <span className={cn(!result.ok && "text-amber-700 dark:text-amber-300")}>
                  {result.name}
                </span>
              </p>
              <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                {result.detail}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
