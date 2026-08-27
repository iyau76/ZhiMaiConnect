/** AI 整理结果的实时关系网预览：可点点连线、改关系词、加人 */

import { Plus, X } from "lucide-react";
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { t } from "@/lib/i18n";
import { inferMutual } from "@/lib/relation-kind";

export interface GraphPerson {
  name?: string;
  department?: string;
}

export interface GraphRelation {
  from: string;
  to: string;
  label: string;
}

interface Props {
  people: GraphPerson[];
  relations: GraphRelation[];
  onAddPerson: (name: string) => void;
  onAddRelation: (from: string, to: string, label: string) => void;
  onPatchRelation: (index: number, label: string) => void;
  onRemoveRelation: (index: number) => void;
}

const SIZE = 420;
const CENTER = SIZE / 2;

export function DraftGraph({
  people,
  relations,
  onAddPerson,
  onAddRelation,
  onPatchRelation,
  onRemoveRelation,
}: Props) {
  const [linkFrom, setLinkFrom] = useState<string | null>(null);
  const [linkTo, setLinkTo] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [newName, setNewName] = useState("");

  const names = useMemo(() => people.map((p) => (p.name ?? "").trim()).filter(Boolean), [people]);

  const points = useMemo(() => {
    const radius = names.length <= 1 ? 0 : Math.min(CENTER - 56, 60 + names.length * 14);
    const map = new Map<string, { x: number; y: number }>();
    names.forEach((name, i) => {
      const angle = (i / Math.max(names.length, 1)) * Math.PI * 2 - Math.PI / 2;
      map.set(name, { x: CENTER + Math.cos(angle) * radius, y: CENTER + Math.sin(angle) * radius });
    });
    return map;
  }, [names]);

  const clickNode = (name: string) => {
    if (!linkFrom) {
      setLinkFrom(name);
      setLinkTo(null);
      return;
    }
    if (linkFrom === name) {
      setLinkFrom(null);
      setLinkTo(null);
      return;
    }
    setLinkTo(name);
  };

  const confirmLink = () => {
    if (!linkFrom || !linkTo) return;
    onAddRelation(linkFrom, linkTo, label.trim() || t("认识"));
    setLinkFrom(null);
    setLinkTo(null);
    setLabel("");
  };

  return (
    <div className="space-y-3 rounded-xl border border-border bg-background/50 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[11px] text-muted-foreground">
          {t("关系网预览：点两个人可以连线，点连线上的字可以改关系，改上面的表单这里会实时更新。")}
        </p>
      </div>

      {names.length === 0 ? (
        <p className="py-6 text-center text-xs text-muted-foreground">{t("还没有人物")}</p>
      ) : (
        <svg
          viewBox={`0 0 ${SIZE} ${SIZE}`}
          className="w-full"
          role="img"
          aria-label={t("关系网预览")}
        >
          <defs>
            <marker
              id="draft-arrow"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="5"
              markerHeight="5"
              orient="auto-start-reverse"
            >
              <path d="M0,0 L10,5 L0,10 z" className="fill-primary" />
            </marker>
          </defs>

          {relations.map((relation, index) => {
            const from = (relation.from ?? "").trim();
            const to = (relation.to ?? "").trim();
            const a = points.get(from);
            const b = points.get(to);
            if (!a || !b) return null;
            const mutual = inferMutual(relation.label ?? "");

            // 同一对人之间的多条关系分别弯成不同弧度，避免线和文字重合
            const pair = [from, to].sort().join("|");
            const samePair = relations
              .map((r, i) => ({ r, i }))
              .filter(
                ({ r }) => [(r.from ?? "").trim(), (r.to ?? "").trim()].sort().join("|") === pair,
              );
            const total = samePair.length;
            const order = samePair.findIndex(({ i }) => i === index);
            const flip = from === pair.split("|")[0] ? 1 : -1;
            const curve = total <= 1 ? 0 : (order - (total - 1) / 2) * 34 * flip;

            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const len = Math.hypot(dx, dy) || 1;
            const ux = dx / len;
            const uy = dy / len;
            const gap = 13;
            const x1 = a.x + ux * gap;
            const y1 = a.y + uy * gap;
            const x2 = b.x - ux * gap;
            const y2 = b.y - uy * gap;
            const cx = (x1 + x2) / 2 + -uy * curve * 2;
            const cy = (y1 + y2) / 2 + ux * curve * 2;
            const mx = (x1 + x2) / 2 + -uy * curve;
            const my = (y1 + y2) / 2 + ux * curve + (curve === 0 ? -6 : 3);

            return (
              <g key={`${relation.from}-${relation.to}-${index}`}>
                <path
                  d={`M ${x1} ${y1} Q ${cx} ${cy} ${x2} ${y2}`}
                  fill="none"
                  className="stroke-primary/50"
                  strokeWidth={1.4}
                  markerEnd="url(#draft-arrow)"
                  markerStart={mutual ? "url(#draft-arrow)" : undefined}
                />
                <rect
                  x={mx - Math.max((relation.label || t("认识")).length * 5.6 + 8, 20) / 2}
                  y={my - 8}
                  width={Math.max((relation.label || t("认识")).length * 5.6 + 8, 20)}
                  height={15}
                  rx={4}
                  className="fill-background/90"
                />
                <text
                  x={mx}
                  y={my + 3}
                  textAnchor="middle"
                  className="cursor-pointer fill-foreground text-[10px]"
                  onClick={() => {
                    const next = window.prompt(
                      t("改关系词（留空则删除这条关系）"),
                      relation.label ?? "",
                    );
                    if (next === null) return;
                    if (!next.trim()) onRemoveRelation(index);
                    else onPatchRelation(index, next.trim());
                  }}
                >
                  {relation.label || t("认识")}
                </text>
              </g>
            );
          })}

          {names.map((name) => {
            const p = points.get(name);
            if (!p) return null;
            const active = name === linkFrom || name === linkTo;
            return (
              <g key={name} className="cursor-pointer" onClick={() => clickNode(name)}>
                <circle
                  cx={p.x}
                  cy={p.y}
                  r={active ? 13 : 10}
                  className={active ? "fill-primary" : "fill-primary/25 stroke-primary"}
                  strokeWidth={1.2}
                />
                <text
                  x={p.x}
                  y={p.y + 26}
                  textAnchor="middle"
                  className="fill-foreground text-[11px] font-medium"
                >
                  {name}
                </text>
              </g>
            );
          })}
        </svg>
      )}

      {linkFrom && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-primary/40 bg-primary/5 p-2">
          <span className="text-xs">
            {linkFrom} → {linkTo ?? t("再点一个人")}
          </span>
          {linkTo && (
            <>
              <Input
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                onKeyDown={(event) => event.key === "Enter" && confirmLink()}
                className="h-8 w-32 text-xs"
                placeholder={t("关系，如 同事")}
              />
              <Button className="h-8 rounded-full px-3 text-xs" onClick={confirmLink}>
                {t("连上")}
              </Button>
            </>
          )}
          <button
            type="button"
            className="ml-auto text-muted-foreground hover:text-foreground"
            onClick={() => {
              setLinkFrom(null);
              setLinkTo(null);
            }}
          >
            <X className="size-3.5" aria-hidden="true" />
          </button>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={newName}
          onChange={(event) => setNewName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || !newName.trim()) return;
            onAddPerson(newName.trim());
            setNewName("");
          }}
          className="h-8 w-40 text-xs"
          placeholder={t("加个人，输名字回车")}
        />
        <Button
          variant="outline"
          className="h-8 rounded-full px-3 text-xs"
          disabled={!newName.trim()}
          onClick={() => {
            onAddPerson(newName.trim());
            setNewName("");
          }}
        >
          <Plus className="size-3.5" aria-hidden="true" />
          {t("加人物")}
        </Button>
      </div>
    </div>
  );
}
