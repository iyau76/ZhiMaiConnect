import { createFileRoute } from "@tanstack/react-router";
import { Bell, CalendarDays, Cpu, PenLine, Settings, Users } from "lucide-react";
import { useEffect, useState } from "react";

import { AppearanceControls, LanguageToggle } from "@/components/appearance-controls";
import { CalendarPanel } from "@/components/calendar-panel";
import { IntakePanel } from "@/components/intake-panel";
import { ModelsPanel } from "@/components/models-panel";
import { PageGuide } from "@/components/page-guide";
import { RemindersPanel } from "@/components/reminders-panel";

import { RelationsPanel } from "@/components/relations-panel";
import { Toaster } from "@/components/ui/sonner";
import { WelcomeCover } from "@/components/welcome-cover";

import { t, useLang, initLang } from "@/lib/i18n";
import { initTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { DEFAULT_PRESETS, type ProviderPreset } from "@/lib/vision-providers";

const PRESETS_KEY = "openglass.presets";
const ACTIVE_KEY = "openglass.active";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "知脉 Connect · 个人人脉与人情往来助手" },
      {
        name: "description",
        content:
          "记下身边的人：生日提醒、节日祝福、送礼建议、和谁在哪天做了什么，AI 帮你整理成一张人际关系网，全部存在本机。",
      },
      { property: "og:title", content: "知脉 Connect · 个人人脉与人情往来助手" },
      {
        property: "og:description",
        content:
          "记下身边的人：生日提醒、节日祝福、送礼建议、日历回忆，AI 自动整理关系网，数据只存本机。",
      },

      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

type View = "intake" | "people" | "reminders" | "calendar" | "models" | "settings";

function getNav(): Array<{ id: View; label: string; hint: string; icon: typeof Users }> {
  return [
    { id: "intake", label: t("录入"), hint: t("一段话写下身边的人"), icon: PenLine },
    { id: "people", label: t("人物关系"), hint: t("档案与关系网"), icon: Users },
    { id: "reminders", label: t("提醒"), hint: t("生日、节日与待办"), icon: Bell },
    { id: "calendar", label: t("日历"), hint: t("哪天和谁做了什么"), icon: CalendarDays },
    { id: "models", label: t("AI 助理"), hint: t("模型设置与建议"), icon: Cpu },
    { id: "settings", label: t("设置"), hint: t("主题、无障碍与语言"), icon: Settings },
  ];
}

const HEADINGS: Record<
  View,
  { kicker: string; a: string; b: string; guide: string; points: string[] }
> = {
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
  settings: {
    kicker: "You · Settings",
    a: "调成你顺眼的",
    b: "样子",
    guide: "这一页：外观与无障碍",
    points: [
      "浅色 / 深色主题各有几套，随时切换。",
      "色觉辅助可以避开红绿或蓝黄配色，还能开高对比和大字号。",
    ],
  },
  models: {
    kicker: "Assistant · Setup",
    a: "挑一个顺手的",
    b: "模型",
    guide: "这一页：选模型、问建议",
    points: [
      "自定义接口要填 API Key，否则会返回 401。",
      "可以带上人物和关系数据，直接问 AI 该怎么处理某段关系。",
    ],
  },
};




function Index() {
  const [presets, setPresets] = useState<ProviderPreset[]>(DEFAULT_PRESETS);
  const [activeId, setActiveId] = useState(DEFAULT_PRESETS[0].id);
  const [hydrated, setHydrated] = useState(false);
  const [view, setView] = useState<View>("intake");
  useLang();
  const NAV = getNav();

  useEffect(() => {
    initLang();
    initTheme();
    try {
      const storedPresets = localStorage.getItem(PRESETS_KEY);
      if (storedPresets) {
        const parsed = JSON.parse(storedPresets) as ProviderPreset[];
        if (Array.isArray(parsed) && parsed.length) setPresets(parsed);
      }
      const storedActive = localStorage.getItem(ACTIVE_KEY);
      if (storedActive) setActiveId(storedActive);
    } catch {
      /* 读取失败就用默认值 */
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    localStorage.setItem(PRESETS_KEY, JSON.stringify(presets));
    localStorage.setItem(ACTIVE_KEY, activeId);
  }, [hydrated, presets, activeId]);

  const resolvedActiveId = presets.some((preset) => preset.id === activeId)
    ? activeId
    : presets[0].id;
  const activePreset = presets.find((preset) => preset.id === resolvedActiveId) ?? presets[0];
  const heading = HEADINGS[view];

  return (
    <div className="min-h-screen bg-background text-foreground">
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
                    onClick={() => setView(item.id)}
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
              {t("所有资料只存在本机浏览器，AI 结论仅供参考，需人工复核。")}
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
                  onClick={() => setView(item.id)}
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
                title={heading.guide}
                points={heading.points}
                className="mt-3.5"
              />
            </header>



            {view === "intake" ? (
              <div className="min-w-0 space-y-5">
                <IntakePanel preset={activePreset} />
              </div>
            ) : view === "reminders" ? (
              <RemindersPanel preset={activePreset} />
            ) : view === "settings" ? (
              <div className="max-w-2xl rounded-xl border border-border bg-card p-5">
                <AppearanceControls />
              </div>
            ) : view === "calendar" ? (
              <CalendarPanel preset={activePreset} />
            ) : view === "models" ? (
              <ModelsPanel
                presets={presets}
                onPresetsChange={setPresets}
                activeId={resolvedActiveId}
                onActiveIdChange={setActiveId}
                frame={null}
                onFrameUsed={() => undefined}
              />
            ) : (
              <div className="min-w-0 space-y-5">
                <RelationsPanel preset={activePreset} />
              </div>
            )}
          </main>
        </div>
      </div>
      <Toaster />
      <WelcomeCover />

    </div>
  );
}
