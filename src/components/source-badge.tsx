import { Bot, Camera, FileUp, Globe, Mic, PenLine, Waves } from "lucide-react";

import { cn } from "@/lib/utils";
import {
  formatSource,
  isInferred,
  sourceLabel,
  type Provenance,
  type SourceKind,
} from "@/lib/provenance";
import { getLang } from "@/lib/i18n";

const ICONS: Record<SourceKind, typeof PenLine> = {
  manual: PenLine,
  ai: Bot,
  camera: Camera,
  audio: Mic,
  voice: Waves,
  import: FileUp,
  web: Globe,
};

interface Props {
  source?: Provenance;
  className?: string;
  /** 显示详细说明（来源备注 + 时间） */
  detailed?: boolean;
}

/** 来源徽章：任何一条信息都要能一眼看出它从哪来 */
export function SourceBadge({ source, className, detailed }: Props) {
  const kind = source?.kind;
  const Icon = kind ? ICONS[kind] : PenLine;
  const inferred = kind ? isInferred(kind) : false;
  const text = source
    ? detailed
      ? formatSource(source)
      : sourceLabel(source.kind)
    : getLang() === "en"
      ? "Source unrecorded"
      : "来源未标注";

  return (
    <span
      title={formatSource(source)}
      className={cn(
        "inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] leading-none",
        source
          ? inferred
            ? "border-primary/40 bg-primary/10 text-primary"
            : "border-border bg-muted/60 text-muted-foreground"
          : "border-dashed border-border text-muted-foreground",
        className,
      )}
    >
      <Icon className="size-3 shrink-0" aria-hidden="true" />
      <span className="truncate">{text}</span>
      {inferred && !detailed && (
        <span className="shrink-0 opacity-70">{getLang() === "en" ? "· inferred" : "· 推断"}</span>
      )}
    </span>
  );
}
