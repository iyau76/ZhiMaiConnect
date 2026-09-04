import { Gauge, History, ShieldAlert, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { AgentRunInspector } from "@/components/agent-run-inspector";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { projectAgentRun, type AgentRun } from "@/lib/agent-run-log";
import { indexedDbAgentRunLedger, type AgentLedgerRunStatus } from "@/lib/agent-run-ledger";
import { LocalAgentRunStore } from "@/lib/agent-run-store";
import type { AgentBudget } from "@/lib/agent-runtime";
import { getLang, t } from "@/lib/i18n";
import {
  LocalAgentSettingsStore,
  resolveAgentSettingsBudget,
  type AgentAuthorizationMode,
  type AgentSettings,
} from "@/lib/agent-settings";

interface AgentControlCenterProps {
  latestRun?: AgentRun | null;
  focusRunId?: string;
}

const FALLBACK_SETTINGS: AgentSettings = {
  version: 2,
  profile: "standard",
  authorizationMode: "standard",
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

interface AgentRunLedgerSummary {
  id: string;
  status: AgentLedgerRunStatus;
  rounds: number;
  eventCount: number;
  updatedAt: number;
}

export function AgentControlCenter({ latestRun, focusRunId }: AgentControlCenterProps) {
  const [settings, setSettings] = useState<AgentSettings>(safeSettings);
  const [budgetSaveStatus, setBudgetSaveStatus] = useState("已保存");
  const [summaries, setSummaries] = useState<AgentRunLedgerSummary[]>([]);
  const [selectedRun, setSelectedRun] = useState<AgentRun | null>(latestRun ?? null);
  const refreshGeneration = useRef(0);
  const budget = resolveAgentSettingsBudget(settings);

  const refreshRuns = useCallback(async () => {
    const generation = ++refreshGeneration.current;
    const runs = await indexedDbAgentRunLedger.listRuns();
    const next = await Promise.all(
      runs.slice(0, 50).map(async (run): Promise<AgentRunLedgerSummary> => {
        const events = await indexedDbAgentRunLedger.listEvents(run.id);
        return {
          id: run.id,
          status: run.status,
          rounds: events.reduce((highest, event) => Math.max(highest, event.round ?? 0), 0),
          eventCount: events.length,
          updatedAt: run.updatedAt,
        };
      }),
    );
    if (generation === refreshGeneration.current) setSummaries(next);
  }, []);

  useEffect(() => {
    void refreshRuns().catch(() => undefined);
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = indexedDbAgentRunLedger.subscribe(() => {
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        void refreshRuns().catch(() => undefined);
      }, 120);
    });
    return () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      unsubscribe();
    };
  }, [refreshRuns]);

  useEffect(() => {
    if (!latestRun) return;
    setSelectedRun(latestRun);
    void refreshRuns().catch(() => undefined);
  }, [latestRun, refreshRuns]);

  const choosePreset = (profile: "quick" | "standard" | "deep") => {
    try {
      const store = new LocalAgentSettingsStore();
      setSettings(store.selectPreset(profile));
      setBudgetSaveStatus("已保存");
      toast.success(
        getLang() === "en"
          ? `Agent budget switched to ${profile}`
          : `Agent 预算已切换为 ${profile}`,
      );
    } catch {
      toast.error("浏览器设置存储不可用；本轮仍可使用默认预算");
    }
  };

  const updateBudgetField = (key: keyof AgentBudget, value: number) => {
    try {
      const next = { ...budget, [key]: value };
      setSettings(new LocalAgentSettingsStore().saveCustomBudget(next));
      setBudgetSaveStatus("已自动保存");
    } catch (error) {
      setBudgetSaveStatus("保存失败");
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

  const chooseAuthorization = (mode: AgentAuthorizationMode) => {
    try {
      setSettings(new LocalAgentSettingsStore().setAuthorizationMode(mode));
      toast.success(mode === "cautious" ? "已切换为逐份签字" : "已切换为汇总签字");
    } catch {
      toast.error("无法保存授权设置");
    }
  };

  const openStoredRun = useCallback(async (id: string) => {
    try {
      const [run, events] = await Promise.all([
        indexedDbAgentRunLedger.getRun(id),
        indexedDbAgentRunLedger.listEvents(id),
      ]);
      if (!run) return;
      setSelectedRun(
        projectAgentRun(events, {
          id: run.id,
          title: run.title,
          agentName: run.agentName,
          model: run.providerRef.model,
          status: run.status,
        }),
      );
    } catch {
      toast.error("无法读取这条运行日志");
    }
  }, []);

  useEffect(() => {
    if (focusRunId) void openStoredRun(focusRunId);
  }, [focusRunId, openStoredRun]);

  const clearLogs = async () => {
    try {
      const runs = await indexedDbAgentRunLedger.listRuns();
      const removable = runs.filter((run) =>
        ["completed", "failed", "cancelled", "budget_exceeded"].includes(run.status),
      );
      await Promise.all(removable.map((run) => indexedDbAgentRunLedger.deleteRun(run.id)));
      new LocalAgentRunStore().clear();
      await refreshRuns();
      if (selectedRun && removable.some((run) => run.id === selectedRun.id)) {
        const latestWasRemoved = latestRun && removable.some((run) => run.id === latestRun.id);
        setSelectedRun(latestWasRemoved ? null : (latestRun ?? null));
      }
      const retained = runs.length - removable.length;
      toast.success(
        retained
          ? `已清除 ${removable.length} 条结束记录；保留 ${retained} 条未完成任务`
          : "已清除持久化 Agent 日志",
      );
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
        value={budget[key]}
        onChange={(event) =>
          updateBudgetField(
            key,
            Math.max(minimum, Math.floor(Number(event.target.value) || minimum)),
          )
        }
        className="h-8 text-xs"
      />
    </label>
  );

  return (
    <details className="rounded-xl border border-border bg-card/45">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 text-sm font-medium">
        <Gauge className="size-4 text-primary" aria-hidden />
        {t("Agent 控制中心")}
        <span className="ml-auto text-[11px] font-normal text-muted-foreground">
          {settings.profile} · {t("最多")} {budget.maxRounds} {t("轮")}
        </span>
      </summary>

      <div className="space-y-4 border-t border-border px-3 py-3">
        <section className="space-y-2" aria-labelledby="agent-authorization-heading">
          <h3 id="agent-authorization-heading" className="text-xs font-semibold">
            {t("档案写入授权")}
          </h3>
          <div className="grid gap-2 sm:grid-cols-3">
            <Button
              type="button"
              variant={settings.authorizationMode === "cautious" ? "default" : "outline"}
              size="sm"
              onClick={() => chooseAuthorization("cautious")}
            >
              {t("谨慎 · 每份签字")}
            </Button>
            <Button
              type="button"
              variant={settings.authorizationMode === "standard" ? "default" : "outline"}
              size="sm"
              onClick={() => chooseAuthorization("standard")}
            >
              {t("标准 · 汇总签字")}
            </Button>
            <Button
              type="button"
              variant={settings.authorizationMode === "full" ? "default" : "outline"}
              size="sm"
              onClick={() => chooseAuthorization("full")}
            >
              {t("全权 · 自动提交")}
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">
            {t(
              "授权只改变签字时机；全权模式会自动提交非删除提案。校验、原子事务、收据和撤销始终生效，删除人物始终单独确认。",
            )}
          </p>
        </section>

        <section className="space-y-2" aria-labelledby="agent-budget-heading">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 id="agent-budget-heading" className="text-xs font-semibold">
              {t("预算上限")}
            </h3>
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-muted-foreground" role="status">
                {t(budgetSaveStatus)}
              </span>
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
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
            {numberField("maxRounds", t("轮次"))}
            {numberField("maxToolCalls", t("工具调用"), 1, 0)}
            {numberField("maxInputTokens", t("输入 token"), 1_000)}
            {numberField("maxOutputTokens", t("输出 token"), 500)}
            {numberField("maxWallTimeMs", t("总时限 ms"), 1_000)}
          </div>
          <p className="text-[11px] text-muted-foreground">
            {t(
              "这里设置的是整次任务的累计上限，不会扩大单轮上下文。修改任一字段会切换为 custom 并立即保存。",
            )}
          </p>
        </section>

        <section
          className="space-y-2 border-t border-border pt-3"
          aria-labelledby="agent-log-heading"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 id="agent-log-heading" className="flex items-center gap-1.5 text-xs font-semibold">
              <History className="size-3.5" aria-hidden />
              {t("本机执行记录（最近 50 次）")}
            </h3>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 text-[11px] text-muted-foreground"
              onClick={() => void clearLogs()}
            >
              <Trash2 className="mr-1 size-3.5" aria-hidden />
              {t("清除日志")}
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
                {t("保存档案正文（敏感）")}
              </span>
              {t(
                "工具结果会作为断点记忆留在本机；启用后，运行详情还会展示已脱敏的提示词与工具输入输出。",
              )}
            </span>
          </label>

          <div className="flex gap-2 overflow-x-auto pb-1">
            {summaries.slice(0, 8).map((summary) => (
              <button
                key={summary.id}
                type="button"
                data-agent-run-summary-id={summary.id}
                className="shrink-0 rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent"
                onClick={() => void openStoredRun(summary.id)}
              >
                {summary.status} · {summary.rounds ?? 0} {t("轮")}
              </button>
            ))}
            {!summaries.length && (
              <span className="text-[11px] text-muted-foreground">{t("还没有持久化运行日志")}</span>
            )}
          </div>
          {selectedRun && <AgentRunInspector run={selectedRun} />}
        </section>
      </div>
    </details>
  );
}
