import { BookOpen, Plus } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";
import {
  RELATIONSHIP_TEST_SAMPLES,
  type RelationshipTestSample,
  type RelationshipTestSampleId,
} from "@/lib/relationship-test-samples";
import { cn } from "@/lib/utils";

interface RelationshipSamplePickerProps {
  disabled?: boolean;
  className?: string;
  onSelect: (sample: RelationshipTestSample) => void;
  onOpenSettings?: () => void;
}

export function RelationshipSamplePicker({
  disabled,
  className,
  onSelect,
  onOpenSettings,
}: RelationshipSamplePickerProps) {
  const [sampleId, setSampleId] = useState<RelationshipTestSampleId>(
    RELATIONSHIP_TEST_SAMPLES[0].id,
  );
  const sample =
    RELATIONSHIP_TEST_SAMPLES.find((item) => item.id === sampleId) ?? RELATIONSHIP_TEST_SAMPLES[0];

  return (
    <section
      className={cn("rounded-lg border border-border/80 bg-muted/25 p-3", className)}
      aria-label={t("试试这些测试材料")}
    >
      <details>
        <summary className="flex cursor-pointer select-none items-center gap-1.5 text-[11px] font-medium text-foreground">
          <BookOpen className="size-3.5 shrink-0 text-primary" aria-hidden="true" />
          {t("还没想好录入什么？")}
          <span className="text-primary underline underline-offset-2">{t("试试这些")}</span>
        </summary>
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <label className="min-w-0 flex-1">
            <span className="mb-1.5 block text-[11px] text-muted-foreground">
              {t("选择测试材料")}
            </span>
            <select
              value={sampleId}
              onChange={(event) => setSampleId(event.target.value as RelationshipTestSampleId)}
              disabled={disabled}
              className="h-9 w-full rounded-md border border-input bg-background px-2.5 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
              aria-label={t("选择测试材料")}
            >
              {RELATIONSHIP_TEST_SAMPLES.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title} · {item.audience}
                </option>
              ))}
            </select>
          </label>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-9 shrink-0 rounded-full px-3"
            disabled={disabled}
            onClick={() => onSelect(sample)}
          >
            <Plus className="size-3.5" aria-hidden="true" />
            {t("填入录入框")}
          </Button>
        </div>
        <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">
          {sample.featureFocus.join(" · ")}
        </p>
        <p className="mt-1 line-clamp-2 text-[10px] leading-relaxed text-muted-foreground/85">
          {t("可试问")}：{sample.demoPrompts[0]}
        </p>
      </details>
      <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">
        {t("试完想从头再来？可在")}
        <button
          type="button"
          className="mx-0.5 text-primary underline-offset-2 hover:underline"
          onClick={() => {
            if (onOpenSettings) onOpenSettings();
            else window.location.assign("?view=settings");
          }}
        >
          {t("设置")}
        </button>
        {t("中格式化档案，清空全部数据回到初始状态。")}
      </p>
    </section>
  );
}
