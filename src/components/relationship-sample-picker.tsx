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
}

export function RelationshipSamplePicker({
  disabled,
  className,
  onSelect,
}: RelationshipSamplePickerProps) {
  const [sampleId, setSampleId] = useState<RelationshipTestSampleId>(
    RELATIONSHIP_TEST_SAMPLES[0].id,
  );
  const sample =
    RELATIONSHIP_TEST_SAMPLES.find((item) => item.id === sampleId) ?? RELATIONSHIP_TEST_SAMPLES[0];

  return (
    <section
      className={cn("rounded-lg border border-border/80 bg-muted/25 p-3", className)}
      aria-label={t("复杂关系测试集")}
    >
      <div className="flex flex-wrap items-end gap-2">
        <label className="min-w-0 flex-1">
          <span className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-foreground">
            <BookOpen className="size-3.5 text-primary" aria-hidden="true" />
            {t("复杂关系测试集")}
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
    </section>
  );
}
