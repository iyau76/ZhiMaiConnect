import { BrainCircuit } from "lucide-react";

export function ReasoningDisclosure({
  label,
  current,
  steps,
  running,
  history,
  stepLabel = "步",
}: {
  label: string;
  current: string;
  steps: number;
  running: boolean;
  history?: string[];
  stepLabel?: string;
}) {
  return (
    <div
      data-variant="think"
      data-state={running ? "running" : "complete"}
      className="reasoning-disclosure"
      title={(history?.length ? history : [current]).join(" → ")}
    >
      <div
        data-disclosure-row="true"
        role="status"
        aria-live="polite"
        className="reasoning-disclosure-row"
      >
        <span className="reasoning-state-dot" aria-hidden="true" />
        <BrainCircuit className="relative z-10 size-3.5 shrink-0 text-primary" aria-hidden="true" />
        <span className="relative z-10 shrink-0 text-[10px] font-medium text-primary">{label}</span>
        <span className="relative z-10 min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {current}
        </span>
        <span className="relative z-10 shrink-0 text-[10px] tabular-nums text-muted-foreground">
          {steps} {stepLabel}
        </span>
      </div>
    </div>
  );
}
