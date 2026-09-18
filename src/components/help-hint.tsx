/** 说明性文字默认收进问号，首屏只留操作本身。 */

import { CircleHelp, X } from "lucide-react";
import { useState } from "react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * 浮层交给 Radix Popover：它自带视口边界避让、Escape 与外部点击关闭，
 * 关闭后焦点回到触发按钮。不要再改回固定 absolute 定位，手机窄屏会越界。
 */
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
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={label ?? t("说明")}
          aria-expanded={open}
          className={cn(
            "inline-flex size-5 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground",
            className,
          )}
        >
          <CircleHelp className="size-3.5" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="bottom"
        collisionPadding={12}
        className="w-72 max-w-[calc(100vw-1.5rem)] relative p-3 text-left text-[11px] font-normal leading-relaxed text-muted-foreground"
      >
        <button
          type="button"
          aria-label={t("知道了")}
          className="absolute right-2 top-2 text-muted-foreground transition-colors hover:text-foreground"
          onClick={() => setOpen(false)}
        >
          <X className="size-3" aria-hidden="true" />
        </button>
        <p className="pr-5">{t(text)}</p>
      </PopoverContent>
    </Popover>
  );
}
