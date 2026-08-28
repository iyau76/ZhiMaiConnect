import { Gauge, History, ShieldAlert, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { AgentRunInspector } from "@/components/agent-run-inspector";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { AgentRun } from "@/lib/agent-run-log";
import { LocalAgentRunStore, type StoredAgentRunSummary } from "@/lib/agent-run-store";
import { AGENT_BUDGET_PRESETS, type AgentBudget } from "@/lib/agent-runtime";
import { LocalAgentSettingsStore, type AgentSettings } from "@/lib/agent-settings";

interface AgentControlCenterProps {
  latestRun?: AgentRun | null;
}

const FALLBACK_SETTINGS: AgentSettings = {
  version: 1,
  profile: "standard",
  savePrivatePayload: false,
  updatedAt: 0,
};

function safeSettings() {
  try {
    return new LocalAgentSettingsStore().load();
  } catch {
    return FALLBACK_SETTINGS;
  }
}

function safeRunSummaries() {
  try {
    return new LocalAgentRunStore().list();
  } catch {
    return [];
  }
}

export function AgentControlCenter({ latestRun }: AgentControlCenterProps) {
  const [settings, setSettings] = useState<AgentSettings>(safeSettings);
  const initialBudget = useMemo(
    () =>
      settings.profile === "custom" && settings.customBudget
        ? settings.customBudget
        : { ...AGENT_BUDGET_PRESETS.standard },
    // The initial form is deliberately not reset when a preset button is clicked.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const [custom, setCustom] = useState<AgentBudget>(initialBudget);
  const [summaries, setSummaries] = useState<StoredAgentRunSummary[]>(safeRunSummaries);
  const [selectedRun, setSelectedRun] = useState<AgentRun | null>(latestRun ?? null);

  useEffect(() => {
    if (!latestRun) return;
    setSelectedRun(latestRun);
    setSummaries(safeRunSummaries());
  }, [latestRun]);

  const choosePreset = (profile: "quick" | "standard" | "deep") => {
    try {
      const store = new LocalAgentSettingsStore();
      setSettings(store.selectPreset(profile));
      setCustom({ ...AGENT_BUDGET_PRESETS[profile] });
      toast.success(`Agent 预算已切换为 ${profile}`);
    } catch {
      toast.error("浏览器设置存储不可用；本轮仍可使用默认预算");
    }
  };

  const saveCustom = () => {
    try {
      setSettings(new LocalAgentSettingsStore().saveCustomBudget(custom));
      toast.success("自定义 Agent 预算已保存");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "预算格式无效");
    }
  };

  const togglePrivatePayload = (enabled: boolean) => {
    try {
      setSettings(new LocalAgentSettingsStore().setSavePrivatePayload(enabled));
    } catch {
      toast.error("无法保存日志隐私设置");
    }
  };

  const openStoredRun = (id: string) => {
    try {
      const entry = new LocalAgentRunStore().get(id);
      if (entry) setSelectedRun(entry.run);
    } catch {
      toast.error("无法读取这条运行日志");
    }
  };

  const clearLogs = () => {
    try {
      new LocalAgentRunStore().clear();
      setSummaries([]);
      if (selectedRun?.id !== latestRun?.id) setSelectedRun(latestRun ?? null);
      toast.success("已清除持久化 Agent 日志");
    } catch {
      toast.error("无法清除 Agent 日志");
    }
  };

  const numberField = (key: keyof AgentBudget, label: string, step = 1, minimum = 1) => (
    <label className="grid gap-1 text-[11px] text-muted-foreground">
      <span>{label}</span>
      <Input
        type="number"
        min={minimum}
        step={step}
        value={custom[key]}
        onChange={(event) =>
          setCustom((previous) => ({
            ...previous,
            [key]: Math.max(minimum, Math.floor(Number(event.target.value) || minimum)),
          }))
        }
        className="h-8 text-xs"
      />
    </label>
  );

  return (
    <details className="rounded-xl border border-border bg-card/45">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 text-sm font-medium">
        <Gauge className="size-4 text-primary" aria-hidden />
        Agent 运行预算与日志
        <span className="ml-auto text-[11px] font-normal text-muted-foreground">
          {settings.profile} · 最多{" "}
          {settings.profile === "custom"
            ? custom.maxRounds
            : AGENT_BUDGET_PRESETS[settings.profile].maxRounds}{" "}
          轮
        </span>
      </summary>

      <div className="space-y-4 border-t border-border px-3 py-3">
        <section className="space-y-2" aria-labelledby="agent-budget-heading">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 id="agent-budget-heading" className="text-xs font-semibold">
              预算上限
            </h3>
            <div className="flex gap-1">
              {(["quick", "standard", "deep"] as const).map((profile) => (
                <Button
                  key={profile}
                  type="button"
                  variant={settings.profile === profile ? "default" : "outline"}
                  size="sm"
                  className="h-7 px-2 text-[11px]"
                  onClick={() => choosePreset(profile)}
                >
                  {profile}
                </Button>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
            {numberField("maxRounds", "轮次")}
            {numberField("maxToolCalls", "工具调用", 1, 0)}
            {numberField("maxInputTokens", "输入 token", 1_000)}
            {numberField("maxOutputTokens", "输出 token", 500)}
            {numberField("maxWallTimeMs", "总时限 ms", 1_000)}
          </div>
          <Button type="button" variant="outline" size="sm" className="h-8" onClick={saveCustom}>
            保存为自定义预算
          </Button>
        </section>

        <section
          className="space-y-2 border-t border-border pt-3"
          aria-labelledby="agent-log-heading"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 id="agent-log-heading" className="flex items-center gap-1.5 text-xs font-semibold">
              <History className="size-3.5" aria-hidden />
              最近运行（最多 50 次 / 30 天）
            </h3>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 text-[11px] text-muted-foreground"
              onClick={clearLogs}
            >
              <Trash2 className="mr-1 size-3.5" aria-hidden />
              清除日志
            </Button>
          </div>

          <label className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-2 text-[11px] leading-relaxed">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={settings.savePrivatePayload}
              onChange={(event) => togglePrivatePayload(event.target.checked)}
            />
            <span>
              <span className="flex items-center gap-1 font-medium text-amber-700 dark:text-amber-300">
                <ShieldAlert className="size-3.5" aria-hidden />
                保存档案正文（敏感）
              </span>
              默认只保存轮次、工具名、耗时和 token；启用后才保存已脱敏的提示词与工具输入输出。
            </span>
          </label>

          <div className="flex gap-2 overflow-x-auto pb-1">
            {summaries.slice(0, 8).map((summary) => (
              <button
                key={summary.id}
                type="button"
                className="shrink-0 rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent"
                onClick={() => openStoredRun(summary.id)}
              >
                {summary.status} · {summary.rounds ?? 0} 轮
              </button>
            ))}
            {!summaries.length && (
              <span className="text-[11px] text-muted-foreground">还没有持久化运行日志</span>
            )}
          </div>
          {selectedRun && <AgentRunInspector run={selectedRun} />}
        </section>
      </div>
    </details>
  );
}
