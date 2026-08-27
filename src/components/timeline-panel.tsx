import { CalendarPlus, FileText, Loader2, Mic, Package, Trash2, Waves } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { SourceBadge } from "@/components/source-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  facesDb,
  type CaseEventRecord,
  type EvidenceRecord,
  type PersonRecord,
  type VoiceprintRecord,
} from "@/lib/face-db";
import { t } from "@/lib/i18n";
import { makeSource } from "@/lib/provenance";

type ItemKind = "audio" | "note" | "exhibit" | "voice";

interface TimelineItem {
  id: string;
  at: number;
  kind: ItemKind;
  title: string;
  detail?: string;
  personIds: string[];
  source?: ReturnType<typeof makeSource>;
}

const ICONS: Record<ItemKind, typeof FileText> = {
  audio: Mic,
  note: FileText,
  exhibit: Package,
  voice: Waves,
};

const KIND_LABEL: Record<ItemKind, string> = {
  audio: "录音转写",
  note: "笔录",
  exhibit: "物证",
  voice: "声纹样本",
};

function evidenceKind(record: EvidenceRecord): ItemKind {
  if (record.kind === "audio") return "audio";
  if (record.kind === "exhibit") return "exhibit";
  return "note";
}

/** 本地时间转 datetime-local 输入值 */
function toLocalInput(ms: number) {
  const d = new Date(ms - new Date().getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
}

export function TimelinePanel() {
  const [people, setPeople] = useState<PersonRecord[]>([]);
  const [items, setItems] = useState<TimelineItem[]>([]);
  const [events, setEvents] = useState<CaseEventRecord[]>([]);
  const [personFilter, setPersonFilter] = useState("");
  const [kindFilter, setKindFilter] = useState<ItemKind | "">("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  // 新增案件事件表单
  const [evAt, setEvAt] = useState(() => toLocalInput(Date.now()));
  const [evTitle, setEvTitle] = useState("");
  const [evDetail, setEvDetail] = useState("");
  const [evPlace, setEvPlace] = useState("");
  const [evCertainty, setEvCertainty] = useState<"fact" | "inferred">("fact");
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    const [evidence, voiceprints, persons, caseEvents] = await Promise.all([
      facesDb.listEvidence(),
      facesDb.listVoiceprints(),
      facesDb.listPersons(),
      facesDb.listCaseEvents(),
    ]);
    setPeople(persons);
    setEvents(caseEvents);

    const merged: TimelineItem[] = [
      ...evidence.map((row: EvidenceRecord) => ({
        id: `e-${row.id}`,
        at: row.createdAt,
        kind: evidenceKind(row),
        title: row.title,
        detail: row.text.slice(0, 200),
        personIds: row.linkedPersonIds ?? [],
        source: row.source,
      })),
      ...voiceprints.map((row: VoiceprintRecord) => ({
        id: `v-${row.id}`,
        at: row.createdAt,
        kind: "voice" as const,
        title: row.name,
        detail: `${Math.round(row.durationMs / 1000)}s`,
        personIds: row.personId ? [row.personId] : [],
        source: row.source,
      })),
    ].sort((a, b) => b.at - a.at);

    setItems(merged);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const filtered = useMemo(() => {
    const fromTs = from ? new Date(from).getTime() : null;
    const toTs = to ? new Date(to).getTime() + 86_400_000 : null;
    return items.filter((item) => {
      if (personFilter && !item.personIds.includes(personFilter)) return false;
      if (kindFilter && item.kind !== kindFilter) return false;
      if (fromTs && item.at < fromTs) return false;
      if (toTs && item.at > toTs) return false;
      return true;
    });
  }, [items, personFilter, kindFilter, from, to]);

  const groups = useMemo(() => {
    const map = new Map<string, TimelineItem[]>();
    for (const item of filtered) {
      const day = new Date(item.at).toLocaleDateString();
      const list = map.get(day) ?? [];
      list.push(item);
      map.set(day, list);
    }
    return [...map.entries()];
  }, [filtered]);

  const addEvent = async () => {
    if (!evTitle.trim()) {
      toast.error(t("先写一句这条事件是什么"));
      return;
    }
    setSaving(true);
    try {
      await facesDb.putCaseEvent({
        id: crypto.randomUUID(),
        at: new Date(evAt).getTime(),
        title: evTitle.trim(),
        detail: evDetail.trim() || undefined,
        place: evPlace.trim() || undefined,
        certainty: evCertainty,
        createdAt: Date.now(),
        source: makeSource("manual", t("手工补录")),
      });
      setEvTitle("");
      setEvDetail("");
      setEvPlace("");
      await refresh();
      toast.success(t("已加入案件时间线"));
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="flex min-w-0 flex-col gap-5 rounded-2xl border border-border bg-card/60 p-5">
      <header className="flex items-center justify-between gap-3">
        <h2 className="flex items-baseline gap-2.5">
          <span className="font-display text-xl leading-none tracking-tight">{t("时间线")}</span>
          <span className="text-[10px] uppercase tracking-[0.24em] text-muted-foreground">
            Timeline
          </span>
        </h2>
      </header>

      <Tabs defaultValue="case">
        <TabsList>
          <TabsTrigger value="case">{t("案件时间线")}</TabsTrigger>
          <TabsTrigger value="work">{t("办案时间线")}</TabsTrigger>
        </TabsList>

        {/* 案子本身发生了什么 */}
        <TabsContent value="case" className="space-y-4 pt-4">
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {t(
              "案件时间线记录案子里发生过的事：几点谁在哪、监控拍到什么、法医推断的时间区间。和录入材料的先后无关，需要手工或从材料里补。",
            )}
          </p>

          <div className="space-y-2 rounded-xl border border-dashed border-border p-3">
            <div className="flex flex-wrap gap-2">
              <Input
                type="datetime-local"
                value={evAt}
                onChange={(event) => setEvAt(event.target.value)}
                className="h-8 w-auto text-xs"
              />
              <Input
                value={evTitle}
                onChange={(event) => setEvTitle(event.target.value)}
                placeholder={t("事件，例：监控拍到妻子回小区")}
                className="h-8 min-w-[14rem] flex-1 text-xs"
              />
              <Input
                value={evPlace}
                onChange={(event) => setEvPlace(event.target.value)}
                placeholder={t("地点")}
                className="h-8 w-32 text-xs"
              />
              <select
                value={evCertainty}
                onChange={(event) => setEvCertainty(event.target.value as "fact" | "inferred")}
                className="h-8 rounded-md border border-border bg-background px-2 text-xs"
              >
                <option value="fact">{t("事实")}</option>
                <option value="inferred">{t("推测")}</option>
              </select>
            </div>
            <Textarea
              value={evDetail}
              onChange={(event) => setEvDetail(event.target.value)}
              rows={2}
              className="text-xs"
              placeholder={t("补充说明、依据的材料等（可留空）")}
            />
            <Button
              size="sm"
              className="rounded-full px-4"
              disabled={saving}
              onClick={() => void addEvent()}
            >
              {saving ? (
                <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <CalendarPlus className="size-3.5" aria-hidden="true" />
              )}
              {t("加入案件时间线")}
            </Button>
          </div>

          {events.length === 0 ? (
            <p className="py-10 text-center text-xs text-muted-foreground">
              {t("案件时间线还是空的，先补一条事件")}
            </p>
          ) : (
            <ol className="relative space-y-3 border-l border-border pl-5">
              {events.map((event) => (
                <li key={event.id} className="relative">
                  <span className="absolute -left-[1.65rem] top-2 flex size-5 items-center justify-center rounded-full border border-border bg-background">
                    <span className="size-1.5 rounded-full bg-primary" />
                  </span>
                  <div className="flex items-start gap-3 rounded-xl border border-border p-3">
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-baseline gap-2">
                        <span className="text-[11px] tabular-nums text-muted-foreground">
                          {new Date(event.at).toLocaleString()}
                        </span>
                        <span className="truncate text-sm font-medium">{event.title}</span>
                        {event.certainty === "inferred" && (
                          <span className="rounded-full border border-primary/50 px-2 py-0.5 text-[10px] text-primary">
                            {t("推测")}
                          </span>
                        )}
                        {event.place && (
                          <span className="text-[10px] text-muted-foreground">{event.place}</span>
                        )}
                      </p>
                      {event.detail && (
                        <p className="mt-1 whitespace-pre-wrap text-[11px] leading-relaxed text-muted-foreground">
                          {event.detail}
                        </p>
                      )}
                      <div className="mt-1.5">
                        <SourceBadge source={event.source} detailed />
                      </div>
                    </div>
                    <button
                      type="button"
                      className="shrink-0 text-muted-foreground transition-colors hover:text-destructive"
                      onClick={async () => {
                        await facesDb.deleteCaseEvent(event.id);
                        await refresh();
                      }}
                    >
                      <Trash2 className="size-3.5" aria-hidden="true" />
                    </button>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </TabsContent>

        {/* 办案过程：材料是什么时候进来的 */}
        <TabsContent value="work" className="space-y-4 pt-4">
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={personFilter}
              onChange={(event) => setPersonFilter(event.target.value)}
              className="h-8 rounded-full border border-border bg-background px-3 text-[11px] outline-none"
            >
              <option value="">{t("全部人物")}</option>
              {people.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.name}
                </option>
              ))}
            </select>
            {(Object.keys(KIND_LABEL) as ItemKind[]).map((kind) => (
              <Button
                key={kind}
                type="button"
                size="sm"
                variant={kindFilter === kind ? "default" : "outline"}
                className="h-7 rounded-full px-3 text-[11px]"
                onClick={() => setKindFilter(kindFilter === kind ? "" : kind)}
              >
                {t(KIND_LABEL[kind])}
              </Button>
            ))}
            <Input
              type="date"
              value={from}
              onChange={(event) => setFrom(event.target.value)}
              className="h-8 w-auto text-[11px]"
            />
            <Input
              type="date"
              value={to}
              onChange={(event) => setTo(event.target.value)}
              className="h-8 w-auto text-[11px]"
            />
            <span className="text-[11px] text-muted-foreground">
              {filtered.length} / {items.length}
            </span>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 px-3 text-[11px]"
              onClick={() => void refresh()}
            >
              {t("刷新")}
            </Button>
          </div>

          {groups.length === 0 ? (
            <p className="py-12 text-center text-xs text-muted-foreground">
              {t("这个条件下还没有记录")}
            </p>
          ) : (
            <div className="space-y-6">
              {groups.map(([day, list]) => (
                <div key={day}>
                  <p className="mb-2 text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
                    {day}
                  </p>
                  <ol className="relative space-y-3 border-l border-border pl-5">
                    {list.map((item) => {
                      const Icon = ICONS[item.kind];
                      return (
                        <li key={item.id} className="relative">
                          <span className="absolute -left-[1.65rem] top-2 flex size-5 items-center justify-center rounded-full border border-border bg-background">
                            <Icon className="size-3 text-primary" aria-hidden="true" />
                          </span>
                          <div className="flex gap-3 rounded-xl border border-border p-3">
                            <div className="min-w-0 flex-1">
                              <p className="flex flex-wrap items-baseline gap-2">
                                <span className="truncate text-sm font-medium">{item.title}</span>
                                <span className="text-[10px] text-muted-foreground">
                                  {new Date(item.at).toLocaleTimeString()} ·{" "}
                                  {t(KIND_LABEL[item.kind])}
                                </span>
                              </p>
                              {item.detail && (
                                <p className="mt-0.5 line-clamp-2 whitespace-pre-wrap text-[11px] leading-relaxed text-muted-foreground">
                                  {item.detail}
                                </p>
                              )}
                              <div className="mt-1.5 flex flex-wrap gap-1">
                                <SourceBadge source={item.source} detailed />
                                {item.personIds
                                  .map((id) => people.find((person) => person.id === id))
                                  .filter((person): person is PersonRecord => Boolean(person))
                                  .map((person) => (
                                    <span
                                      key={person.id}
                                      className="rounded-full border border-border px-2 py-0.5 text-[10px] text-muted-foreground"
                                    >
                                      {person.name}
                                    </span>
                                  ))}
                              </div>
                            </div>
                          </div>
                        </li>
                      );
                    })}
                  </ol>
                </div>
              ))}
            </div>
          )}

          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {t(
              "办案时间线按材料进入系统的时间排列，用来回溯资料是怎么来的，每条都标注了信息来源。",
            )}
          </p>
        </TabsContent>
      </Tabs>
    </section>
  );
}
