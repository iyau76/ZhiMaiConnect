import { createFileRoute } from "@tanstack/react-router";
import {
  Bell,
  CalendarDays,
  ClipboardList,
  Cpu,
  House,
  PenLine,
  Settings,
  Users,
} from "lucide-react";
import { useEffect, useState } from "react";

import { AppearanceControls, LanguageToggle } from "@/components/appearance-controls";
import { AgentControlCenter } from "@/components/agent-control-center";
import { CalendarPanel } from "@/components/calendar-panel";
import { DemoDataControls } from "@/components/demo-data-controls";
import { IntakePanel } from "@/components/intake-panel";
import { ModelsPanel } from "@/components/models-panel";
import { PageGuide } from "@/components/page-guide";
import { PlanBoard } from "@/components/plan-board";
import { PreflightPanel } from "@/components/preflight-panel";
import { RemindersPanel } from "@/components/reminders-panel";
import { TodayPanel } from "@/components/today-panel";

import { RelationsPanel } from "@/components/relations-panel";
import { Toaster } from "@/components/ui/sonner";
import { WelcomeCover } from "@/components/welcome-cover";

import { t, useLang, initLang } from "@/lib/i18n";
import {
  ACTIVE_MODEL_PRESET_KEY,
  applySessionApiKeys,
  loadSavedModelPresets,
  saveModelPresets,
  saveSessionApiKeys,
} from "@/lib/model-preset-storage";
import { initTheme } from "@/lib/theme";
import type { TodayTarget } from "@/lib/today-projection";
import { cn } from "@/lib/utils";
import { DEFAULT_PRESETS, type ProviderPreset } from "@/lib/vision-providers";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "知脉 Connect · 个人人脉与人情往来助手" },
      {
        name: "description",
        content: "本地优先记录人物、事件与关系；云端 AI 仅在确认后接收当前任务所需内容。",
      },
      { property: "og:title", content: "知脉 Connect · 个人人脉与人情往来助手" },
      {
        property: "og:description",
        content: "本地优先、证据可追溯的人际关系记忆与行动助手。",
      },

      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

type View =
  "today" | "intake" | "people" | "reminders" | "calendar" | "plan" | "models" | "settings";

type WorkspaceFocus = TodayTarget & { nonce: number };

const VIEW_SESSION_KEY = "zhimai.workspace.view.v1";
const VIEWS = new Set<View>([
  "today",
  "intake",
  "people",
  "reminders",
  "calendar",
  "plan",
  "models",
  "settings",
]);

function isView(value: string | null): value is View {
  return value !== null && VIEWS.has(value as View);
}

/**
 * These workspaces can own a multi-round browser-side Agent run. Once opened,
 * keep them mounted while the user visits another section so navigation does
 * not erase the conversation or abort an in-flight run.
 */
const RETAINED_AGENT_VIEWS = new Set<View>(["reminders", "plan", "models"]);

function getNav(): Array<{ id: View; label: string; hint: string; icon: typeof Users }> {
  return [
    { id: "today", label: t("今天"), hint: t("现在值得处理的人和事"), icon: House },
    { id: "intake", label: t("录入"), hint: t("一段话写下身边的人"), icon: PenLine },
    { id: "people", label: t("人物关系"), hint: t("档案与关系网"), icon: Users },
    { id: "reminders", label: t("提醒"), hint: t("生日、节日与待办"), icon: Bell },
    { id: "calendar", label: t("日历"), hint: t("哪天和谁做了什么"), icon: CalendarDays },
    { id: "plan", label: t("计划"), hint: t("目标拆解与行动项"), icon: ClipboardList },
    { id: "models", label: t("AI 助理"), hint: t("模型设置与建议"), icon: Cpu },
    { id: "settings", label: t("设置"), hint: t("外观、数据与 Agent"), icon: Settings },
  ];
}

const HEADINGS: Record<
  View,
  { kicker: string; a: string; b: string; guide: string; points: string[] }
> = {
  today: {
    kicker: "Today · Desk",
    a: "今天先看，",
    b: "这些人和事",
    guide: "这一页：从今天开始，把关系真正用起来",
    points: [
      "到期提醒、近期事件和未完成任务会从原记录自动汇总。",
      "点任意一项，就能回到对应的人物卡、事件、提醒或计划。",
      "想起新情况时，随手写一句就能继续补充。",
    ],
  },
  intake: {
    kicker: "Notes · Intake",
    a: "随手写下，",
    b: "自动成册",
    guide: "这一页：把认识的人写下来",
    points: [
      "像发消息一样写：「张伟是我大学同学，喜欢篮球，生日 3 月 12 日」。",
      "也可以直接粘贴截图、聊天记录或简历文件。",
      "点「AI 整理」自动拆成人物卡和关系。",
    ],
  },
  people: {
    kicker: "People · Circles",
    a: "理清每一段",
    b: "关系",
    guide: "这一页：看关系、补资料",
    points: [
      "点圆点改人物卡：生日、圈子、亲密度、喜好、送过什么礼。",
      "双箭头 ⇄ 对等关系（朋友、夫妻），单箭头 → 有方向（父母、师徒）。",
    ],
  },
  reminders: {
    kicker: "Care · Reminders",
    a: "别错过重要的",
    b: "日子",
    guide: "这一页：谁快过生日、该说点什么",
    points: [
      "填了生日的人会自动出现在「最近 60 天」。",
      "点「祝福 / 礼物」，AI 结合喜好和送礼记录给具体建议。",
      "「这事该拜托谁」会从你的人脉里挑合适的人。",
    ],
  },
  calendar: {
    kicker: "Days · Calendar",
    a: "记住和谁的",
    b: "每一天",
    guide: "这一页：一天一条，日子就有迹可循",
    points: [
      "紫点是生日，黄点是节日，灰点是你自己的记录。",
      "点某一天写下和谁做了什么，以后翻回来一目了然。",
    ],
  },
  plan: {
    kicker: "Plan · Action",
    a: "把目标变成",
    b: "下一步行动",
    guide: "这一页：拆解目标、核对草案、推进任务",
    points: [
      "写下一个真实目标，智能体会按需读取相关人物、关系与事件。",
      "生成结果先成为可编辑草案，只有你批准的内容才会进入行动计划。",
      "任务可以继续分配负责人、调整状态和截止日期。",
    ],
  },
  settings: {
    kicker: "You · Settings",
    a: "调成你顺眼的",
    b: "样子",
    guide: "这一页：外观、数据与 Agent 高级设置",
    points: [
      "浅色 / 深色主题各有几套，随时切换。",
      "色觉辅助可以避开红绿或蓝黄配色，还能开高对比和大字号。",
      "Agent 的写入授权、运行预算和本机日志也在这里管理。",
    ],
  },
  models: {
    kicker: "Assistant · Setup",
    a: "挑一个顺手的",
    b: "模型",
    guide: "这一页：选模型、问建议",
    points: [
      "OpenAI / Gemini 兼容接口需要填写 API Key。",
      "可以带上人物和关系数据，直接问 AI 该怎么处理某段关系。",
    ],
  },
};

function Index() {
  const [presets, setPresets] = useState<ProviderPreset[]>(DEFAULT_PRESETS);
  const [activeId, setActiveId] = useState(DEFAULT_PRESETS[0].id);
  const [hydrated, setHydrated] = useState(false);
  const [view, setView] = useState<View>("today");
  const [retainedViews, setRetainedViews] = useState<ReadonlySet<View>>(() => new Set());
  const [workspaceFocus, setWorkspaceFocus] = useState<WorkspaceFocus | null>(null);
  useLang();
  const NAV = getNav();

  useEffect(() => {
    initLang();
    initTheme();
    try {
      const storedView = sessionStorage.getItem(VIEW_SESSION_KEY);
      if (isView(storedView)) setView(storedView);
      const nextPresets = applySessionApiKeys(loadSavedModelPresets(localStorage), sessionStorage);
      setPresets(nextPresets);
      const storedActive = localStorage.getItem(ACTIVE_MODEL_PRESET_KEY);
      setActiveId(
        storedActive && nextPresets.some((preset) => preset.id === storedActive)
          ? storedActive
          : nextPresets[0].id,
      );
    } catch {
      /* 读取失败就用默认值 */
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    sessionStorage.setItem(VIEW_SESSION_KEY, view);
  }, [hydrated, view]);

  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(ACTIVE_MODEL_PRESET_KEY, activeId);
      saveSessionApiKeys(sessionStorage, presets);
    } catch {
      /* 隐私模式或存储空间不足时，仅保留当前内存状态 */
    }
  }, [hydrated, presets, activeId]);

  const persistModelPresets = () => {
    saveModelPresets(localStorage, presets);
    localStorage.setItem(ACTIVE_MODEL_PRESET_KEY, activeId);
  };

  const resolvedActiveId = presets.some((preset) => preset.id === activeId)
    ? activeId
    : presets[0].id;
  const activePreset = presets.find((preset) => preset.id === resolvedActiveId) ?? presets[0];
  const heading = HEADINGS[view];

  const openView = (nextView: View, keepFocus = false) => {
    if (RETAINED_AGENT_VIEWS.has(nextView)) {
      setRetainedViews((current) => {
        if (current.has(nextView)) return current;
        const next = new Set(current);
        next.add(nextView);
        return next;
      });
    }
    if (!keepFocus) setWorkspaceFocus(null);
    setView(nextView);
  };

  const openTodayTarget = (target: TodayTarget) => {
    setWorkspaceFocus({ ...target, nonce: Date.now() });
    openView(target.view, true);
  };

  const renderWorkspace = (workspaceView: View) => {
    if (workspaceView === "today") {
      return <TodayPanel onOpenIntake={() => openView("intake")} onOpenTarget={openTodayTarget} />;
    }
    if (workspaceView === "intake") {
      return (
        <div className="min-w-0 space-y-5">
          <IntakePanel
            preset={activePreset}
            focusRunId={workspaceFocus?.view === "intake" ? workspaceFocus.runId : undefined}
            focusProposalId={
              workspaceFocus?.view === "intake" && workspaceFocus.recordType === "proposal"
                ? workspaceFocus.recordId
                : undefined
            }
            focusNonce={workspaceFocus?.view === "intake" ? workspaceFocus.nonce : undefined}
          />
        </div>
      );
    }
    if (workspaceView === "reminders") {
      return (
        <RemindersPanel
          preset={activePreset}
          active={view === "reminders"}
          focusReminderId={
            workspaceFocus?.view === "reminders" && workspaceFocus.recordType === "reminder"
              ? workspaceFocus.recordId
              : undefined
          }
          focusRunId={
            workspaceFocus?.view === "reminders" &&
            (workspaceFocus.recordType === "run" || workspaceFocus.recordType === "proposal")
              ? workspaceFocus.runId
              : undefined
          }
          focusNonce={workspaceFocus?.view === "reminders" ? workspaceFocus.nonce : undefined}
        />
      );
    }
    if (workspaceView === "settings") {
      return (
        <div className="max-w-5xl space-y-5">
          <div className="space-y-5 rounded-xl border border-border bg-card p-5">
            <AppearanceControls />
            <DemoDataControls />
            <PreflightPanel preset={activePreset} />
          </div>
          <AgentControlCenter
            focusRunId={workspaceFocus?.view === "settings" ? workspaceFocus.runId : undefined}
          />
        </div>
      );
    }
    if (workspaceView === "calendar") {
      return (
        <CalendarPanel
          preset={activePreset}
          focusEventId={
            workspaceFocus?.view === "calendar" && workspaceFocus.recordType === "event"
              ? workspaceFocus.recordId
              : undefined
          }
          focusNonce={workspaceFocus?.view === "calendar" ? workspaceFocus.nonce : undefined}
        />
      );
    }
    if (workspaceView === "plan") {
      return (
        <PlanBoard
          preset={activePreset}
          active={view === "plan"}
          focusTaskId={
            workspaceFocus?.view === "plan" && workspaceFocus.recordType === "task"
              ? workspaceFocus.recordId
              : undefined
          }
          focusProposalId={
            workspaceFocus?.view === "plan" && workspaceFocus.recordType === "proposal"
              ? workspaceFocus.recordId
              : undefined
          }
          focusNonce={workspaceFocus?.view === "plan" ? workspaceFocus.nonce : undefined}
        />
      );
    }
    if (workspaceView === "models") {
      return (
        <ModelsPanel
          presets={presets}
          onPresetsChange={setPresets}
          onSavePresets={persistModelPresets}
          activeId={resolvedActiveId}
          onActiveIdChange={setActiveId}
          frame={null}
          onFrameUsed={() => undefined}
          focusRunId={workspaceFocus?.view === "models" ? workspaceFocus.runId : undefined}
          focusProposalId={
            workspaceFocus?.view === "models" && workspaceFocus.recordType === "proposal"
              ? workspaceFocus.recordId
              : undefined
          }
          focusNonce={workspaceFocus?.view === "models" ? workspaceFocus.nonce : undefined}
        />
      );
    }
    return (
      <div className="min-w-0 space-y-5">
        <RelationsPanel
          preset={activePreset}
          onOpenIntake={() => openView("intake")}
          onOpenEvent={(eventId) =>
            openTodayTarget({ view: "calendar", recordType: "event", recordId: eventId })
          }
          onOpenReminder={(reminderId) =>
            openTodayTarget({
              view: "reminders",
              recordType: "reminder",
              recordId: reminderId,
            })
          }
          focusPersonId={
            workspaceFocus?.view === "people" && workspaceFocus.recordType === "person"
              ? workspaceFocus.recordId
              : undefined
          }
          focusNonce={workspaceFocus?.view === "people" ? workspaceFocus.nonce : undefined}
        />
      </div>
    );
  };

  return (
    <div
      className="min-h-screen bg-background text-foreground"
      data-app-hydrated={hydrated ? "true" : "false"}
    >
      <div className="flex min-h-screen">
        {/* 侧边导航 */}
        <aside className="sticky top-0 hidden h-screen w-[13.5rem] shrink-0 flex-col justify-between border-r border-border bg-sidebar px-5 py-7 md:flex">
          <div>
            <div className="flex items-baseline gap-2">
              <span className="font-display text-2xl leading-none tracking-tight">
                知脉<span className="italic text-primary"> Connect</span>
              </span>
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
              {t("资料整理 · 关系梳理")}
            </p>

            <nav className="mt-9 flex flex-col gap-1">
              {NAV.map((item) => {
                const active = view === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => openView(item.id)}
                    className={cn(
                      "group flex items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors",
                      active
                        ? "bg-sidebar-accent text-sidebar-accent-foreground"
                        : "text-muted-foreground hover:bg-sidebar-accent/50 hover:text-foreground",
                    )}
                  >
                    <item.icon
                      className={cn("size-4 shrink-0", active && "text-primary")}
                      aria-hidden="true"
                    />
                    <span className="min-w-0">
                      <span className="block truncate text-sm">{item.label}</span>
                      <span className="block truncate text-[11px] text-muted-foreground">
                        {item.hint}
                      </span>
                    </span>
                  </button>
                );
              })}
            </nav>
          </div>

          <div className="space-y-4">
            <LanguageToggle />
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              {t(
                "人物档案默认只存在本机；使用云端 AI 时，仅发送当前任务所需内容，提交前请确认。AI 结论需人工复核。",
              )}
            </p>
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          {/* 移动端导航 */}
          <div className="sticky top-0 z-30 flex flex-wrap items-center justify-between gap-2 border-b border-border bg-background/95 px-4 py-3 backdrop-blur md:hidden">
            <div className="flex items-center gap-3">
              <span className="font-display text-xl leading-none">
                知脉<span className="italic text-primary"> Connect</span>
              </span>
              <LanguageToggle />
            </div>
            <div className="flex w-full flex-none overflow-x-auto rounded-lg border border-border p-0.5">
              {NAV.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => openView(item.id)}
                  className={cn(
                    "shrink-0 rounded-md px-3 py-2 text-xs transition-colors",
                    view === item.id ? "bg-accent text-accent-foreground" : "text-muted-foreground",
                  )}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>

          <main className="min-w-0 flex-1 px-4 py-6 md:px-8 md:py-10">
            <header className="mb-7 max-w-3xl">
              <p className="text-[11px] uppercase tracking-[0.28em] text-muted-foreground">
                {heading.kicker}
              </p>
              <h1 className="mt-2 font-display text-4xl leading-[1.05] tracking-tight md:text-5xl">
                {t(heading.a)}
                <span className="italic text-primary">{t(heading.b)}</span>
              </h1>
              <PageGuide
                id={view}
                title={t(heading.guide)}
                points={heading.points.map(t)}
                className="mt-3.5"
              />
            </header>

            {NAV.map((item) => {
              const mounted = item.id === view || retainedViews.has(item.id);
              if (!mounted) return null;
              return (
                <section key={item.id} hidden={item.id !== view} data-workspace-view={item.id}>
                  {renderWorkspace(item.id)}
                </section>
              );
            })}
          </main>
        </div>
      </div>
      <Toaster />
      <WelcomeCover />
    </div>
  );
}
