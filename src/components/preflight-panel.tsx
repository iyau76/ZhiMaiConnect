import { CheckCircle2, CircleAlert, ClipboardCheck, Loader2 } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { getDemoDataStatus } from "@/lib/demo-data";
import { facesDb } from "@/lib/face-db";
import { getLang, t } from "@/lib/i18n";
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
    const en = getLang() === "en";
    const next: CheckResult[] = [];
    try {
      const [people, relations, events, reminders, demo] = await Promise.all([
        facesDb.listPersons(),
        facesDb.listRelations(),
        facesDb.listLifeEvents(),
        facesDb.listReminders(),
        getDemoDataStatus(),
      ]);
      next.push({
        name: en ? "Local database" : "本地数据库",
        ok: true,
        detail: en
          ? `${people.length} people, ${relations.length} relationships, ${events.length} events, ${reminders.length} reminders`
          : `${people.length} 人、${relations.length} 条关系、${events.length} 个事件、${reminders.length} 个提醒`,
      });
      next.push({
        name: en ? "Synthetic demo data" : "合成演示数据",
        ok: demo.people === 50 && demo.relations === 80,
        detail:
          demo.people === 50 && demo.relations === 80
            ? en
              ? "50 people / 80 edges; expected scale"
              : "50 人 / 80 边，规模正确"
            : en
              ? `${demo.people} people / ${demo.relations} edges; load the demo data first`
              : `当前 ${demo.people} 人 / ${demo.relations} 边，请先载入`,
      });
    } catch (error) {
      next.push({
        name: en ? "Local database" : "本地数据库",
        ok: false,
        detail:
          error instanceof Error
            ? error.message
            : en
              ? "Could not read IndexedDB"
              : "无法读取 IndexedDB",
      });
    }

    const modelReady =
      Boolean(preset.model.trim()) &&
      (preset.kind === "ollama" || Boolean(preset.baseUrl.trim() && preset.apiKey.trim()));
    next.push({
      name: en ? "Current model setup" : "当前模型配置",
      ok: modelReady,
      detail: modelReady
        ? en
          ? `${preset.name} · ${preset.model} (test connectivity separately on the AI assistant page)`
          : `${preset.name} · ${preset.model}（联网能力请在“AI 助理”页另点测试连接）`
        : en
          ? "The model, endpoint or session key is incomplete; local features remain available."
          : "模型、接口地址或会话密钥不完整；本地功能仍可演示",
    });
    const microphoneReady =
      Reflect.has(navigator, "mediaDevices") && Reflect.has(globalThis, "MediaRecorder");
    next.push({
      name: en ? "Microphone support" : "麦克风能力",
      ok: microphoneReady,
      detail: microphoneReady
        ? en
          ? "Supported by this browser; permission is requested when recording starts."
          : "浏览器支持；实际权限会在开始录音时请求"
        : en
          ? "Recording is unavailable in this browser or context; use text input."
          : "当前浏览器或非安全上下文不支持录音，请使用文字输入",
    });
    next.push({
      name: en ? "File parsing" : "文件解析",
      ok: typeof FileReader !== "undefined",
      detail: en
        ? "Supports TXT / MD / CSV / JSON, PDF, DOCX and common image formats; images are compressed first."
        : "支持 TXT / MD / CSV / JSON、PDF、DOCX 和常见图片；图片会先压缩",
    });
    next.push({
      name: en ? "Key storage" : "密钥存储",
      ok: !persistedKeyRisk(),
      detail: persistedKeyRisk()
        ? en
          ? "A key from an older version remains in localStorage; resave or clear it on the AI assistant page."
          : "发现旧版本遗留的 localStorage 密钥；请在 AI 助理页重新保存或清除"
        : en
          ? "No persisted API key found; cloud model keys stay in the current session only."
          : "未发现持久化 API Key；云模型密钥仅保存在当前会话",
    });
    next.push({
      name: en ? "Language and version" : "语言与版本",
      ok: document.documentElement.lang === "zh-CN" || document.documentElement.lang === "en",
      detail: `v0.1.0 · <html lang="${document.documentElement.lang}">`,
    });
    setResults(next);
    setRunning(false);
  };

  return (
    <section className="space-y-3 border-t border-border pt-5" data-testid="preflight-panel">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-medium">
            <ClipboardCheck className="size-4 text-primary" aria-hidden="true" />
            {t("演示前自检")}
          </h2>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {t("检查本地数据、模型与浏览器能力。")}
          </p>
        </div>
        <Button variant="outline" onClick={() => void run()} disabled={running}>
          {running ? (
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          ) : (
            <ClipboardCheck className="size-4" aria-hidden="true" />
          )}
          {t("运行自检")}
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
