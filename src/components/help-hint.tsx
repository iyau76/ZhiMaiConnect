/** 说明性文字默认收进问号，首屏只留操作本身。 */

import { CircleHelp, X } from "lucide-react";
import { useState } from "react";

import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export function HelpHint({
  text,
  label,
  className,
}: {
  text: string;
  label?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <span className={cn("relative inline-flex align-middle", className)}>
      <button
        type="button"
        aria-label={label ?? t("说明")}
        aria-expanded={open}
        className="inline-flex size-5 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground"
        onClick={() => setOpen((value) => !value)}
      >
        <CircleHelp className="size-3.5" aria-hidden="true" />
      </button>
      {open && (
        <span
          role="note"
          className="absolute left-0 top-6 z-30 block w-72 rounded-xl border border-primary/25 bg-card p-3 pr-7 text-left text-[11px] leading-relaxed text-muted-foreground shadow-lg"
        >
          {t(text)}
          <button
            type="button"
            aria-label={t("知道了")}
            className="absolute right-2 top-2 text-muted-foreground transition-colors hover:text-foreground"
            onClick={() => setOpen(false)}
          >
            <X className="size-3" aria-hidden="true" />
          </button>
        </span>
      )}
    </span>
  );
}
