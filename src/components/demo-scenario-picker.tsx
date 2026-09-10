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

import campusArt from "@/assets/art/web/campus.webp";
import familyArt from "@/assets/art/web/family.webp";
import workplaceArt from "@/assets/art/web/workplace.webp";
import smallBusinessArt from "@/assets/art/web/small-business.webp";

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

const SCENARIO_ART: Record<Exclude<DemoScenarioId, "all">, string> = {
  campus: campusArt,
  family: familyArt,
  workplace: workplaceArt,
  small_business: smallBusinessArt,
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
              className="group flex overflow-hidden rounded-xl border border-border bg-background/65 text-left transition-colors hover:border-primary/60 hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-wait disabled:opacity-60 sm:flex-col"
            >
              <img
                src={SCENARIO_ART[scenario.id]}
                alt=""
                width={640}
                height={480}
                loading="lazy"
                decoding="async"
                className="w-24 shrink-0 self-stretch object-cover sm:aspect-[2/1] sm:w-full sm:self-auto"
                data-testid={`scenario-art-${scenario.id}`}
              />
              <span className="block min-w-0 p-3">
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
