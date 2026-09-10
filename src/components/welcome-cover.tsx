/** 首次进入时只做一次选择：看演示、带材料开始，或从空库开始。 */

import { ArrowLeft, Database, FileInput, NotebookPen } from "lucide-react";
import { useEffect, useState } from "react";

import logoUrl from "@/assets/logo-mark-384.png";
import welcomeArt from "@/assets/art/web/welcome.webp";
import { DemoScenarioPicker } from "@/components/demo-scenario-picker";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { t } from "@/lib/i18n";

const SEEN_KEY = "openglass.welcomeSeen";

interface WelcomeCoverProps {
  onPasteMaterial: () => void;
  onDemoLoaded: () => void;
}

export function WelcomeCover({ onPasteMaterial, onDemoLoaded }: WelcomeCoverProps) {
  const [open, setOpen] = useState(false);
  const [choosingDemo, setChoosingDemo] = useState(false);

  useEffect(() => {
    try {
      if (!localStorage.getItem(SEEN_KEY)) setOpen(true);
    } catch {
      /* 隐私模式下读不到就不弹 */
    }
  }, []);

  const close = (next?: () => void) => {
    setOpen(false);
    try {
      localStorage.setItem(SEEN_KEY, "1");
    } catch {
      /* 忽略 */
    }
    next?.();
  };

  if (!open) return null;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent
        data-testid="welcome-cover"
        className="max-h-[90dvh] w-[calc(100%-2rem)] max-w-3xl gap-0 overflow-y-auto rounded-2xl bg-card p-0 sm:rounded-2xl [&>button]:grid [&>button]:size-8 [&>button]:place-items-center [&>button]:rounded-full [&>button]:bg-card [&>button]:opacity-100"
      >
        {!choosingDemo && (
          <div className="relative overflow-hidden bg-[#fbf7f2]" data-testid="welcome-art">
            <img
              src={welcomeArt}
              alt=""
              width={1280}
              height={720}
              fetchPriority="high"
              className="h-36 w-full object-cover object-right sm:h-60"
            />
            <div className="absolute bottom-4 left-5 flex items-center gap-2 rounded-full bg-[#fbf7f2]/95 px-3 py-1.5 text-sm font-medium text-slate-800 sm:bottom-auto sm:top-6">
              <img src={logoUrl} alt="" width={32} height={32} className="size-8" />
              知脉 Connect
            </div>
          </div>
        )}
        <div className="flex flex-col items-center p-5 text-center sm:p-7">
          <DialogTitle className="text-xl leading-snug">{t("先从你手边的生活开始")}</DialogTitle>
          <DialogDescription className="mt-2 max-w-lg text-sm leading-relaxed">
            {t("记下一个人或一件事，知脉会把关系、事件和下一步放回同一张工作台。")}
          </DialogDescription>

          {choosingDemo ? (
            <div className="mt-6 w-full text-left">
              <button
                type="button"
                className="mb-3 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                onClick={() => setChoosingDemo(false)}
              >
                <ArrowLeft className="size-3.5" aria-hidden="true" />
                {t("返回选择")}
              </button>
              <p className="mb-3 text-sm font-medium">{t("选一套虚构资料直接体验")}</p>
              <DemoScenarioPicker onLoaded={() => close(onDemoLoaded)} />
            </div>
          ) : (
            <div className="mt-6 grid w-full gap-3 sm:grid-cols-3">
              <button
                type="button"
                className="rounded-xl border border-primary/40 bg-primary/5 p-4 text-left transition-colors hover:bg-primary/10"
                onClick={() => setChoosingDemo(true)}
              >
                <Database className="size-5 text-primary" aria-hidden="true" />
                <span className="mt-3 block text-sm font-semibold">{t("载入演示库")}</span>
                <span className="mt-1 block text-[11px] leading-relaxed text-muted-foreground">
                  {t("用虚构人物走一遍完整流程")}
                </span>
              </button>
              <button
                type="button"
                className="rounded-xl border border-border bg-background/60 p-4 text-left transition-colors hover:border-primary/50"
                onClick={() => close(onPasteMaterial)}
              >
                <FileInput className="size-5 text-primary" aria-hidden="true" />
                <span className="mt-3 block text-sm font-semibold">{t("粘贴一段材料")}</span>
                <span className="mt-1 block text-[11px] leading-relaxed text-muted-foreground">
                  {t("从聊天摘录或个人印象开始")}
                </span>
              </button>
              <button
                type="button"
                className="rounded-xl border border-border bg-background/60 p-4 text-left transition-colors hover:border-primary/50"
                onClick={() => close()}
              >
                <NotebookPen className="size-5 text-primary" aria-hidden="true" />
                <span className="mt-3 block text-sm font-semibold">{t("从空库开始")}</span>
                <span className="mt-1 block text-[11px] leading-relaxed text-muted-foreground">
                  {t("保留一张干净的个人工作台")}
                </span>
              </button>
            </div>
          )}

          {!choosingDemo && (
            <Button variant="ghost" onClick={() => close()} className="mt-4 rounded-full">
              {t("稍后再说")}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
