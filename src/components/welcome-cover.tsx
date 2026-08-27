/** 首次进入时的封面：品牌 logo + 一句话说明，细节交给每页各自的指引 */

import { X } from "lucide-react";
import { useEffect, useState } from "react";

import logoUrl from "@/assets/logo-mark-384.png";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";

const SEEN_KEY = "openglass.welcomeSeen";

export function WelcomeCover() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    try {
      if (!localStorage.getItem(SEEN_KEY)) setOpen(true);
    } catch {
      /* 隐私模式下读不到就不弹 */
    }
  }, []);

  const close = () => {
    setOpen(false);
    try {
      localStorage.setItem(SEEN_KEY, "1");
    } catch {
      /* 忽略 */
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/90 p-4 backdrop-blur-md">
      <div className="relative w-full max-w-sm rounded-2xl border border-border bg-card p-8 shadow-2xl">
        <button
          type="button"
          onClick={close}
          aria-label={t("关闭")}
          className="absolute right-4 top-4 text-muted-foreground transition-colors hover:text-foreground"
        >
          <X className="size-4" aria-hidden="true" />
        </button>

        <div className="flex flex-col items-center text-center">
          <img
            src={logoUrl}
            alt="知脉 Connect"
            width={192}
            height={192}
            className="mb-5 size-48 opacity-95 transition-opacity duration-500 hover:opacity-100"
          />

          <p className="text-[11px] uppercase tracking-[0.28em] text-muted-foreground">Welcome</p>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
            {t("记住身边的人：生日、喜好、送过什么礼，还有该联系谁。")}
          </p>
          <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
            {t("每一页顶部都有各自的使用说明，跟着走就行。")}
          </p>

          <Button onClick={close} className="mt-6 w-full rounded-full">
            {t("开始使用")}
          </Button>
        </div>
      </div>
    </div>
  );
}
