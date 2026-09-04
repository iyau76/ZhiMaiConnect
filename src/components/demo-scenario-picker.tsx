import {
  BriefcaseBusiness,
  Database,
  GraduationCap,
  HeartHandshake,
  Loader2,
  Store,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { DEMO_SCENARIOS, loadDemoData, type DemoScenarioId } from "@/lib/demo-data";
import { getLang, t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

type DemoLoadResult = Awaited<ReturnType<typeof loadDemoData>>;

interface DemoScenarioPickerProps {
  className?: string;
  includeComplete?: boolean;
  onLoaded?: (result: DemoLoadResult) => void;
}

const SCENARIO_ICON: Record<Exclude<DemoScenarioId, "all">, LucideIcon> = {
  campus: GraduationCap,
  family: HeartHandshake,
  workplace: BriefcaseBusiness,
  small_business: Store,
};

export function DemoScenarioPicker({
  className,
  includeComplete = true,
  onLoaded,
}: DemoScenarioPickerProps) {
  const [loadingId, setLoadingId] = useState<DemoScenarioId | null>(null);

  const load = async (scenarioId: DemoScenarioId) => {
    setLoadingId(scenarioId);
    try {
      const result = await loadDemoData(scenarioId);
      toast.success(
        getLang() === "en"
          ? `Loaded ${result.people} synthetic people and ${result.relations} relationships`
          : `已载入 ${result.people} 位合成人物、${result.relations} 条关系`,
      );
      onLoaded?.(result);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("载入演示数据失败"));
    } finally {
      setLoadingId(null);
    }
  };

  return (
    <div className={cn("space-y-3", className)}>
      <div className="grid gap-2 sm:grid-cols-2">
        {DEMO_SCENARIOS.map((scenario) => {
          const Icon = SCENARIO_ICON[scenario.id];
          const loading = loadingId === scenario.id;
          return (
            <button
              key={scenario.id}
              type="button"
              disabled={loadingId !== null}
              onClick={() => void load(scenario.id)}
              className="group rounded-xl border border-border bg-background/65 p-3 text-left transition-colors hover:border-primary/60 hover:bg-primary/5 disabled:cursor-wait disabled:opacity-60"
            >
              <span className="flex items-center gap-2 text-sm font-medium">
                {loading ? (
                  <Loader2 className="size-4 animate-spin text-primary" aria-hidden="true" />
                ) : (
                  <Icon className="size-4 text-primary" aria-hidden="true" />
                )}
                {t(scenario.name)}
              </span>
              <span className="mt-1.5 block text-[11px] leading-relaxed text-muted-foreground">
                {t(scenario.description)}
              </span>
              <span className="mt-1 block text-[10px] leading-relaxed text-muted-foreground/80">
                {t(scenario.example)}
              </span>
            </button>
          );
        })}
      </div>

      {includeComplete && (
        <Button
          type="button"
          variant="outline"
          className="w-full"
          disabled={loadingId !== null}
          onClick={() => void load("all")}
        >
          {loadingId === "all" ? (
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          ) : (
            <Database className="size-4" aria-hidden="true" />
          )}
          {t("载入完整 50 人演示库")}
        </Button>
      )}
    </div>
  );
}
