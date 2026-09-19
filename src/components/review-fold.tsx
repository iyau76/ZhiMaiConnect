import { ChevronRight } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * 展开状态在页面生命周期内按 stateKey 记忆：草稿核验/持久化会替换草稿对象，
 * 折叠分区随之重挂载；不记忆的话，用户刚展开的分区会被重渲染悄悄合上。
 */
const foldOpenStates = new Map<string, boolean>();

/**
 * 核对页的可折叠分区：标题行常驻（名称 + 数量徽标 + 摘要），内容默认收起。
 * 需要用户决定的事项由调用方通过 defaultOpen 展开；诊断与参考内容默认收起。
 * 触发器带 data-review-fold-trigger，端到端测试用它统一展开。
 */
export function ReviewFold({
  title,
  count,
  summary,
  defaultOpen = false,
  attention = false,
  stateKey,
  className,
  tone = "border",
  children,
}: {
  title: string;
  count?: number;
  summary?: string;
  defaultOpen?: boolean;
  /** Bring this section into view automatically when it needs a user decision. */
  attention?: boolean;
  /** 同一分区在重挂载间保持展开状态的键；缺省用标题。重复实例（如逐人物的详细字段）必须传唯一键。 */
  stateKey?: string;
  className?: string;
  tone?: "border" | "warning";
  children: ReactNode;
}) {
  const memoryKey = stateKey ?? title;
  const [open, setOpen] = useState(() => foldOpenStates.get(memoryKey) ?? defaultOpen);
  useEffect(() => {
    foldOpenStates.set(memoryKey, open);
  }, [memoryKey, open]);
  useEffect(() => {
    if (!attention) return;
    setOpen(true);
    foldOpenStates.set(memoryKey, true);
  }, [attention, memoryKey]);
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className={cn(
        "rounded-xl border",
        tone === "warning" ? "border-amber-500/50 bg-amber-500/5" : "border-border",
        className,
      )}
      data-review-fold
      data-review-attention={attention ? "true" : undefined}
    >
      <CollapsibleTrigger
        data-review-fold-trigger
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-muted/40"
        aria-label={`${t("展开或收起")}：${title}`}
      >
        <ChevronRight
          className="size-3.5 shrink-0 text-muted-foreground transition-transform duration-200 [[data-state=open]>&]:rotate-90"
          aria-hidden="true"
        />
        <span className="text-sm font-medium">{title}</span>
        {count !== undefined && (
          <span className="rounded-full border border-border px-1.5 py-0.5 text-[10px] leading-4 text-muted-foreground">
            {count}
          </span>
        )}
        {summary && (
          <span className="ml-auto hidden max-w-[45%] truncate text-[10px] text-muted-foreground sm:block">
            {summary}
          </span>
        )}
      </CollapsibleTrigger>
      <CollapsibleContent className="border-t border-border/70 px-3 py-3">
        <div className="space-y-2">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}
