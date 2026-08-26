/** 每页各自的轻量指引：每次进这一页都会出现，关掉后可以用「怎么用」再打开 */

import { HelpCircle, X } from "lucide-react";
import { useState } from "react";

import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export function PageGuide({
  id,
  title,
  points,
  className,
}: {
  id: string;
  title: string;
  points: string[];
  className?: string;
}) {
  const [open, setOpen] = useState(true);

  const close = () => setOpen(false);

  void id;


  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          "inline-flex items-center gap-1.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground",
          className,
        )}
      >
        <HelpCircle className="size-3.5" aria-hidden="true" />
        {t("怎么用")}
      </button>
    );
  }

  return (
    <div className={cn("relative rounded-xl border border-primary/25 bg-primary/5 p-3 pr-9", className)}>
      <button
        type="button"
        onClick={close}
        aria-label={t("知道了")}
        className="absolute right-2.5 top-2.5 text-muted-foreground transition-colors hover:text-foreground"
      >
        <X className="size-3.5" aria-hidden="true" />
      </button>
      <p className="text-[12px] font-medium">{t(title)}</p>
      <ul className="mt-1.5 space-y-1">
        {points.map((point) => (
          <li key={point} className="flex gap-1.5 text-[11px] leading-relaxed text-muted-foreground">
            <span className="text-primary">·</span>
            <span>{t(point)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
