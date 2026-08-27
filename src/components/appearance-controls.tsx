import { Check, Contrast, Eye, Languages, Palette, Type } from "lucide-react";

import { getLang, setLang, t, useLang } from "@/lib/i18n";
import { A11Y_MODES, THEMES, useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";

/** 语言切换（顶部常驻） */
export function LanguageToggle() {
  useLang();
  return (
    <div className="inline-flex rounded-full border border-border p-0.5">
      {(["zh", "en"] as const).map((code) => (
        <button
          key={code}
          type="button"
          onClick={() => setLang(code)}
          aria-label={
            getLang() === "zh"
              ? code === "zh"
                ? "切换为中文"
                : "切换为英文"
              : code === "zh"
                ? "Switch to Chinese"
                : "Switch to English"
          }
          aria-pressed={getLang() === code}
          className={cn(
            "rounded-full px-2.5 py-1 text-[11px] transition-colors",
            getLang() === code
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {code === "zh" ? "中文" : "EN"}
        </button>
      ))}
    </div>
  );
}

/** 用户设置里的外观面板：主题、深色、色觉辅助、字号、语言 */
export function AppearanceControls() {
  const { theme, setTheme, a11y, setA11y, bigText, setBigText } = useTheme();
  const lang = useLang();
  const label = (item: { zh: string; en: string }) => (lang === "zh" ? item.zh : item.en);

  const light = THEMES.filter((item) => !item.dark);
  const dark = THEMES.filter((item) => item.dark);

  const swatches = (list: typeof light | typeof dark) => (
    <div className="flex flex-wrap gap-2">
      {list.map((item) => (
        <button
          key={item.id}
          type="button"
          onClick={() => setTheme(item.id)}
          className={cn(
            "flex items-center gap-2 rounded-full border border-border py-1 pl-1 pr-3 text-xs transition-colors hover:bg-accent/60",
            theme === item.id && "border-primary bg-accent text-accent-foreground",
          )}
        >
          <span className="relative size-6 overflow-hidden rounded-full border border-border">
            <span
              className="absolute inset-0"
              style={{
                background: `linear-gradient(135deg, ${item.swatch[0]} 0 50%, ${item.swatch[1]} 50% 100%)`,
              }}
            />
            {theme === item.id && (
              <Check className="relative m-auto size-3 text-primary-foreground mix-blend-difference" />
            )}
          </span>
          {label(item)}
        </button>
      ))}
    </div>
  );

  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <p className="flex items-center gap-1.5 text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
          <Palette className="size-3" aria-hidden="true" />
          {t("浅色主题")}
        </p>
        {swatches(light)}
      </section>

      <section className="space-y-2">
        <p className="flex items-center gap-1.5 text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
          <Contrast className="size-3" aria-hidden="true" />
          {t("深色主题")}
        </p>
        {swatches(dark)}
      </section>

      <section className="space-y-2">
        <p className="flex items-center gap-1.5 text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
          <Eye className="size-3" aria-hidden="true" />
          {t("色觉辅助 / 对比度")}
        </p>
        <div className="grid gap-2 sm:grid-cols-2">
          {A11Y_MODES.map((mode) => (
            <button
              key={mode.id}
              type="button"
              onClick={() => setA11y(mode.id)}
              className={cn(
                "rounded-lg border border-border px-3 py-2 text-left transition-colors hover:bg-accent/50",
                a11y === mode.id && "border-primary bg-accent text-accent-foreground",
              )}
            >
              <span className="block text-sm">{label(mode)}</span>
              <span className="block text-[11px] text-muted-foreground">{label(mode.desc)}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="space-y-2">
        <p className="flex items-center gap-1.5 text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
          <Type className="size-3" aria-hidden="true" />
          {t("字号")}
        </p>
        <button
          type="button"
          onClick={() => setBigText(!bigText)}
          className={cn(
            "rounded-full border border-border px-3 py-1.5 text-xs transition-colors hover:bg-accent/60",
            bigText && "border-primary bg-accent text-accent-foreground",
          )}
        >
          {bigText ? t("大字号：已开启") : t("大字号：已关闭")}
        </button>
      </section>

      <section className="space-y-2">
        <p className="flex items-center gap-1.5 text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
          <Languages className="size-3" aria-hidden="true" />
          {t("语言")}
        </p>
        <LanguageToggle />
      </section>
    </div>
  );
}
