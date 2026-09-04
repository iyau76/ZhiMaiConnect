/** 个人版：日历 —— 记得住的写到天，记不清的记到月/年或一段时间，都在时间轴上排好 */

import {
  BellRing,
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  ListTree,
  Pencil,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { PhotoNotes } from "@/components/photo-notes";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  facesDb,
  type DatePrecision,
  type LifeEventRecord,
  type PersonRecord,
  type PhotoNote,
  type ReminderRecord,
} from "@/lib/face-db";
import { askText, parseLooseJson } from "@/lib/ai-text";
import {
  eventSpan,
  formatFuzzy,
  fuzzyPrompt,
  isExact,
  normalizeFuzzy,
  parseFuzzyLocal,
  precisionOf,
  touchesMonth,
  type FuzzyParse,
} from "@/lib/fuzzy-date";
import { getLang, t } from "@/lib/i18n";
import { birthdayMd, festivalsForYear, lunarDateLabel, pad, todayStr } from "@/lib/personal";
import { cn } from "@/lib/utils";
import type { ProviderPreset } from "@/lib/vision-providers";

const WEEK = ["一", "二", "三", "四", "五", "六", "日"];
const PRECISIONS: DatePrecision[] = ["day", "month"];
const PRECISION_TABS: Record<string, string> = {
  day: "记得具体哪天",
  month: "不记得具体哪天",
};

export function CalendarPanel({
  preset,
  focusEventId,
  focusNonce,
}: {
  preset?: ProviderPreset;
  focusEventId?: string;
  focusNonce?: number;
}) {
  const now = new Date();
  const [view, setView] = useState<"month" | "timeline">("month");
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth()); // 0-based
  const [selected, setSelected] = useState(todayStr());
  const [persons, setPersons] = useState<PersonRecord[]>([]);
  const [events, setEvents] = useState<LifeEventRecord[]>([]);
  const [reminders, setReminders] = useState<ReminderRecord[]>([]);

  // 表单
  const [precision, setPrecision] = useState<DatePrecision>("day");
  /** 不记得具体哪天时，用户随手写的一句时间描述 */
  const [fuzzyText, setFuzzyText] = useState("");
  const [fuzzyHint, setFuzzyHint] = useState("");
  const [title, setTitle] = useState("");

  const [withIds, setWithIds] = useState<string[]>([]);
  const [personQuery, setPersonQuery] = useState("");
  const [photos, setPhotos] = useState<PhotoNote[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const handledFocus = useRef("");
  const editorRef = useRef<HTMLElement | null>(null);

  const load = useCallback(async () => {
    const [p, e, r] = await Promise.all([
      facesDb.listPersons(),
      facesDb.listLifeEvents(),
      facesDb.listReminders(),
    ]);
    setPersons(p);
    setEvents(e);
    setReminders(r);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const ym = `${year}-${pad(month + 1)}`;

  const cells = useMemo(() => {
    const first = new Date(year, month, 1);
    const offset = (first.getDay() + 6) % 7; // 周一开头
    const days = new Date(year, month + 1, 0).getDate();
    const list: Array<string | null> = Array.from({ length: offset }, () => null);
    for (let d = 1; d <= days; d += 1) list.push(`${year}-${pad(month + 1)}-${pad(d)}`);
    return list;
  }, [year, month]);

  const lunarByDate = useMemo(
    () =>
      new Map(
        cells
          .filter((date): date is string => Boolean(date))
          .map((date) => [date, lunarDateLabel(date)] as const),
      ),
    [cells],
  );

  /** 精确到天的事件，落到具体格子 */
  const byDate = useMemo(() => {
    const map = new Map<string, LifeEventRecord[]>();
    for (const event of events) {
      if (!isExact(event)) continue;
      const arr = map.get(event.date) ?? [];
      arr.push(event);
      map.set(event.date, arr);
    }
    return map;
  }, [events]);

  /** 有明确截止日的待办直接落到月历；无日期待办仍只留在提醒页。 */
  const remindersByDate = useMemo(() => {
    const map = new Map<string, ReminderRecord[]>();
    for (const reminder of reminders) {
      if (!reminder.due) continue;
      const rows = map.get(reminder.due) ?? [];
      rows.push(reminder);
      map.set(reminder.due, rows);
    }
    return map;
  }, [reminders]);

  /** 覆盖当前月份、但记不清具体哪天的事件 */
  const fuzzyThisMonth = useMemo(
    () => events.filter((event) => !isExact(event) && touchesMonth(event, ym)),
    [events, ym],
  );

  /** 一段时间型事件在本月哪些天里（浅色底纹） */
  const spanDays = useMemo(() => {
    const set = new Set<string>();
    for (const event of events) {
      if (precisionOf(event) !== "range") continue;
      const { start, end } = eventSpan(event);
      for (const date of cells) {
        if (date && date >= start && date <= end) set.add(date);
      }
    }
    return set;
  }, [events, cells]);

  const timeline = useMemo(() => {
    type TimelineItem =
      | { kind: "event"; date: string; record: LifeEventRecord }
      | { kind: "reminder"; date: string; record: ReminderRecord };
    const sorted: TimelineItem[] = [
      ...events.map((record): TimelineItem => ({ kind: "event", date: record.date, record })),
      ...reminders.flatMap((record): TimelineItem[] =>
        record.due ? [{ kind: "reminder", date: record.due, record }] : [],
      ),
    ].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    const groups = new Map<string, TimelineItem[]>();
    for (const item of sorted) {
      const key = item.date.slice(0, 4);
      const arr = groups.get(key) ?? [];
      arr.push(item);
      groups.set(key, arr);
    }
    return [...groups.entries()];
  }, [events, reminders]);

  const marksFor = (date: string) => {
    const md = date.slice(5);
    const birthdays = persons.filter((person) => birthdayMd(person.profile?.birthday) === md);
    const festival = festivalsForYear(Number(date.slice(0, 4))).find((item) => item.md === md);
    return { birthdays, festival };
  };

  const shift = (delta: number) => {
    const next = new Date(year, month + delta, 1);
    setYear(next.getFullYear());
    setMonth(next.getMonth());
  };

  const [saving, setSaving] = useState(false);

  const resetForm = () => {
    setEditingId(null);
    setTitle("");
    setWithIds([]);
    setPersonQuery("");
    setPhotos([]);
    setFuzzyText("");
    setFuzzyHint("");
  };

  const edit = useCallback((event: LifeEventRecord) => {
    setEditingId(event.id);
    setPrecision(precisionOf(event) === "day" ? "day" : "month");
    setSelected(event.date);
    setYear(Number(event.date.slice(0, 4)));
    setMonth(Number(event.date.slice(5, 7)) - 1);
    setFuzzyText(precisionOf(event) === "day" ? "" : formatFuzzy(event));
    setFuzzyHint("");
    setTitle([event.title, event.detail].filter(Boolean).join("\n"));
    setWithIds(event.personIds ?? []);
    setPhotos(event.photos ?? []);
  }, []);

  useEffect(() => {
    if (!focusEventId) return;
    const focusKey = `${focusEventId}:${focusNonce ?? 0}`;
    if (handledFocus.current === focusKey) return;
    const event = events.find((record) => record.id === focusEventId);
    if (!event) return;
    handledFocus.current = focusKey;
    edit(event);
    setView(isExact(event) ? "month" : "timeline");
    requestAnimationFrame(() =>
      editorRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }),
    );
  }, [edit, events, focusEventId, focusNonce]);

  const add = async () => {
    if (!title.trim() || saving) return;
    const previous = editingId ? events.find((event) => event.id === editingId) : undefined;
    let date = selected;
    let dateEnd: string | undefined;
    let stored: DatePrecision = precision;

    if (precision !== "day") {
      const text = fuzzyText.trim();
      if (!text) {
        setFuzzyHint("先写一句大概的时间，比如「去年夏天」。");
        return;
      }
      setSaving(true);
      let parsed =
        previous && text === formatFuzzy(previous)
          ? {
              date: previous.date,
              dateEnd: previous.dateEnd,
              precision: precisionOf(previous),
            }
          : parseFuzzyLocal(text);
      if (!parsed && preset) {
        // 本地猜不出来的说法交给 AI 理解
        try {
          setFuzzyHint("正在整理时间…");
          parsed = normalizeFuzzy(
            parseLooseJson<Partial<FuzzyParse>>(await askText(preset, fuzzyPrompt(text))),
          );
        } catch {
          parsed = null;
        }
      }
      setSaving(false);
      if (!parsed) {
        setFuzzyHint("这个时间没看懂，换个说法试试，比如「2019 年秋天」。");
        return;
      }
      date = parsed.date;
      dateEnd = parsed.dateEnd;
      stored = parsed.precision;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      toast.error(t("请先选择有效日期"));
      return;
    }
    const [dateYear, dateMonth, dateDay] = date.split("-").map(Number);
    const dateProbe = new Date(dateYear, dateMonth - 1, dateDay);
    if (
      dateYear < 1900 ||
      dateProbe.getFullYear() !== dateYear ||
      dateProbe.getMonth() !== dateMonth - 1 ||
      dateProbe.getDate() !== dateDay
    ) {
      toast.error(t("请先选择有效日期"));
      return;
    }

    // 一栏输入：第一行当标题，剩下的当细节
    const raw = title.trim().replace(/\r/g, "");
    const [head, ...rest] = raw.split("\n");
    const body = rest.join("\n").trim();

    await facesDb.putLifeEvent({
      id: previous?.id ?? crypto.randomUUID(),
      date,
      dateEnd,
      precision: stored,
      dateText: stored === "day" ? undefined : fuzzyText.trim(),
      title: (head || raw).slice(0, 60),
      detail: body || undefined,
      personIds: withIds,
      photos: photos.length ? photos : undefined,
      createdAt: previous?.createdAt ?? Date.now(),
      updatedAt: previous ? Date.now() : undefined,
      source: previous?.source,
    });
    resetForm();
    await load();
  };

  const remove = async (id: string) => {
    await facesDb.deleteLifeEvent(id);
    await load();
  };

  const names = (ids?: string[]) =>
    (ids ?? [])
      .map((id) => persons.find((person) => person.id === id)?.name ?? t("已删除"))
      .join("、");

  const personOptions = useMemo(() => {
    const selectedIds = new Set(withIds);
    const query = personQuery.trim().toLocaleLowerCase();
    const selectedPeople = persons.filter((person) => selectedIds.has(person.id));
    const matches = persons.filter((person) => {
      if (selectedIds.has(person.id)) return false;
      if (!query) return true;
      const profile = person.profile;
      return [
        person.name,
        person.note,
        profile?.relation,
        profile?.org,
        profile?.department,
        profile?.title,
        ...(profile?.tags ?? []),
        ...(profile?.identities?.map((identity) => identity.alias) ?? []),
      ]
        .filter(Boolean)
        .join(" ")
        .toLocaleLowerCase()
        .includes(query);
    });
    return [...selectedPeople, ...matches].slice(0, Math.max(30, selectedPeople.length));
  }, [personQuery, persons, withIds]);

  const dayEvents = byDate.get(selected) ?? [];
  const dayReminders = remindersByDate.get(selected) ?? [];
  const dayMarks = marksFor(selected);

  const toggleReminder = async (reminder: ReminderRecord) => {
    await facesDb.putReminder({ ...reminder, done: !reminder.done });
    await load();
  };

  const renderReminder = (reminder: ReminderRecord, showDate = false) => (
    <li
      key={`reminder-${reminder.id}`}
      className={cn(
        "flex items-start justify-between gap-3 rounded-lg border px-3 py-2",
        reminder.done
          ? "border-border bg-muted/30 text-muted-foreground"
          : "border-rose-500/35 bg-rose-500/5",
      )}
    >
      <div className="min-w-0">
        {showDate && <p className="text-[11px] font-medium text-rose-600">{reminder.due}</p>}
        <p className={cn("text-sm", reminder.done && "line-through")}>{reminder.title}</p>
        {reminder.detail && <p className="text-xs text-muted-foreground">{reminder.detail}</p>}
        {reminder.personIds && reminder.personIds.length > 0 && (
          <p className="mt-1 text-[11px] text-muted-foreground">
            {t("相关人物")}：{names(reminder.personIds)}
          </p>
        )}
      </div>
      <button
        type="button"
        onClick={() => void toggleReminder(reminder)}
        className={cn(
          "flex size-7 shrink-0 items-center justify-center rounded-full border transition-colors",
          reminder.done
            ? "border-primary bg-primary text-primary-foreground"
            : "border-border bg-background hover:border-primary hover:text-primary",
        )}
        aria-label={`${t(reminder.done ? "恢复待办" : "完成待办")}：${reminder.title}`}
        title={t(reminder.done ? "标记为未完成" : "标记为已完成")}
      >
        {reminder.done ? (
          <Check className="size-3.5" aria-hidden="true" />
        ) : (
          <BellRing className="size-3.5" aria-hidden="true" />
        )}
      </button>
    </li>
  );

  const renderEvent = (event: LifeEventRecord, showDate = false) => (
    <li
      key={event.id}
      data-event-id={event.id}
      className={cn(
        "flex items-start justify-between gap-3 rounded-lg border bg-background/60 px-3 py-2",
        isExact(event) ? "border-primary/40" : "border-dashed border-border",
        editingId === event.id && "ring-2 ring-primary/35",
      )}
    >
      <div className="min-w-0">
        {showDate && (
          <p
            className={cn(
              "text-[11px]",
              isExact(event) ? "font-medium text-primary" : "text-muted-foreground",
            )}
          >
            {formatFuzzy(event)}
            {!isExact(event) && ` · ${t("大概")}`}
          </p>
        )}
        <p className="text-sm">{event.title}</p>
        {event.detail && <p className="text-xs text-muted-foreground">{event.detail}</p>}
        {event.photos && event.photos.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {event.photos.map((photo) => (
              <img
                key={photo.id}
                src={photo.dataUrl}
                alt={photo.caption || event.title}
                title={photo.caption}
                className="size-12 rounded-md border border-border object-cover"
              />
            ))}
          </div>
        )}
        {event.personIds && event.personIds.length > 0 && (
          <p className="mt-1 text-[11px] text-muted-foreground">
            {t("和")}：{names(event.personIds)}
          </p>
        )}
      </div>
      <div className="flex shrink-0 gap-1">
        <button
          type="button"
          onClick={() => edit(event)}
          aria-label={t("编辑事件")}
          className="text-muted-foreground transition-colors hover:text-primary"
        >
          <Pencil className="size-3.5" aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={() => void remove(event.id)}
          aria-label={t("删除")}
          className="text-muted-foreground transition-colors hover:text-destructive"
        >
          <Trash2 className="size-3.5" aria-hidden="true" />
        </button>
      </div>
    </li>
  );

  return (
    <div className="min-w-0 space-y-5">
      <div className="flex gap-1.5">
        <Button
          size="sm"
          variant={view === "month" ? "default" : "outline"}
          onClick={() => setView("month")}
        >
          <CalendarDays className="size-4" aria-hidden="true" />
          {t("月历")}
        </Button>
        <Button
          size="sm"
          variant={view === "timeline" ? "default" : "outline"}
          onClick={() => setView("timeline")}
        >
          <ListTree className="size-4" aria-hidden="true" />
          {t("时间轴")}
        </Button>
      </div>

      {view === "month" ? (
        <section className="rounded-2xl border border-border bg-card/40 p-3 md:p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <h2 className="font-display text-base tracking-tight md:text-lg">
                {getLang() === "en" ? `${year}-${pad(month + 1)}` : `${year} 年 ${month + 1} 月`}
              </h2>
              <span className="rounded-full border border-border px-2 py-0.5 text-[10px] text-muted-foreground">
                {t("公历 · 农历")}
              </span>
            </div>
            <div className="flex gap-1.5">
              <Button
                size="icon"
                variant="outline"
                onClick={() => shift(-1)}
                aria-label={t("上个月")}
              >
                <ChevronLeft className="size-4" aria-hidden="true" />
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  const today = new Date();
                  setYear(today.getFullYear());
                  setMonth(today.getMonth());
                  setSelected(todayStr(today));
                }}
              >
                {t("今天")}
              </Button>
              <Button
                size="icon"
                variant="outline"
                onClick={() => shift(1)}
                aria-label={t("下个月")}
              >
                <ChevronRight className="size-4" aria-hidden="true" />
              </Button>
            </div>
          </div>

          <div className="mt-3 grid grid-cols-7 gap-1 text-center text-[10px] text-muted-foreground">
            {WEEK.map((day) => (
              <span key={day}>{t(`星期${day}`)}</span>
            ))}
          </div>
          <div className="mt-1 grid grid-cols-7 gap-1">
            {cells.map((date, index) => {
              if (!date) return <span key={`empty-${index}`} />;
              const { birthdays, festival } = marksFor(date);
              const has = (byDate.get(date)?.length ?? 0) > 0;
              const dateReminders = remindersByDate.get(date) ?? [];
              const hasOpenReminder = dateReminders.some((reminder) => !reminder.done);
              const hasDoneReminder = dateReminders.length > 0 && !hasOpenReminder;
              const inSpan = spanDays.has(date);
              const isToday = date === todayStr();
              const lunar = lunarByDate.get(date);
              const reminderLabel = dateReminders.length
                ? `${dateReminders.length} ${t("个待办")}${hasOpenReminder ? "" : t("，均已完成")}`
                : "";
              return (
                <button
                  key={date}
                  type="button"
                  onClick={() => setSelected(date)}
                  title={[date, lunar?.full, festival?.name, reminderLabel]
                    .filter(Boolean)
                    .join(" · ")}
                  aria-label={[date, lunar?.full, festival?.name, reminderLabel]
                    .filter(Boolean)
                    .join("，")}
                  className={cn(
                    "relative flex h-14 flex-col items-start justify-start rounded-md border p-1.5 text-xs transition-colors sm:h-16 md:h-[4.5rem] md:rounded-lg md:p-2",
                    selected === date
                      ? "border-primary bg-primary/10 text-foreground"
                      : "border-border/60 hover:bg-accent/50",
                    inSpan && selected !== date && "bg-primary/5",
                    isToday && selected !== date && "border-primary/50",
                    has && selected !== date && "font-semibold",
                  )}
                >
                  <span className="font-medium leading-none">{Number(date.slice(8))}</span>
                  <span className="mt-1 max-w-full truncate text-[9px] leading-none text-muted-foreground md:text-[10px]">
                    {lunar?.short ?? ""}
                  </span>
                  <span className="absolute bottom-1.5 left-1.5 flex gap-0.5 md:bottom-2 md:left-2">
                    {birthdays.length > 0 && <i className="size-1.5 rounded-full bg-primary" />}
                    {festival && <i className="size-1.5 rounded-full bg-amber-400" />}
                    {has && <i className="size-1.5 rounded-full bg-foreground" />}
                    {hasOpenReminder && <i className="size-1.5 rounded-full bg-rose-500" />}
                    {hasDoneReminder && <i className="size-1.5 rounded-full bg-emerald-500" />}
                  </span>
                </button>
              );
            })}
          </div>
          <p className="mt-3 text-[11px] text-muted-foreground">
            <i className="mr-1 inline-block size-1.5 rounded-full bg-primary align-middle" />
            {t("生日")}
            <i className="ml-3 mr-1 inline-block size-1.5 rounded-full bg-amber-400 align-middle" />
            {t("节日")}
            <i className="ml-3 mr-1 inline-block size-1.5 rounded-full bg-foreground align-middle" />
            {t("记清了的事")}
            <i className="ml-3 mr-1 inline-block size-1.5 rounded-full bg-rose-500 align-middle" />
            {t("未完成待办")}
            <i className="ml-3 mr-1 inline-block size-1.5 rounded-full bg-emerald-500 align-middle" />
            {t("已完成待办")}
            <span className="ml-3 inline-block rounded bg-primary/10 px-1 align-middle">
              {t("底色")}
            </span>{" "}
            {t("一段时间里的事")}
          </p>

          {fuzzyThisMonth.length > 0 && (
            <div className="mt-4 border-t border-border pt-3">
              <p className="text-xs text-muted-foreground">{t("这个月前后，记不清具体哪天的：")}</p>
              <ul className="mt-2 space-y-1.5">
                {fuzzyThisMonth.map((event) => renderEvent(event, true))}
              </ul>
            </div>
          )}
        </section>
      ) : (
        <section className="rounded-2xl border border-border bg-card/40 p-4 md:p-5">
          <h2 className="font-display text-lg tracking-tight">{t("时间轴")}</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("事件和有截止日期的待办按年份倒序；模糊日期事件使用虚线显示。")}
          </p>
          <div className="mt-4 space-y-5">
            {timeline.map(([y, list]) => (
              <div key={y}>
                <h3 className="text-sm font-medium text-primary">
                  {getLang() === "en" ? y : `${y} 年`}
                </h3>
                <ul className="mt-2 space-y-1.5 border-l border-border pl-3">
                  {list.map((item) =>
                    item.kind === "event"
                      ? renderEvent(item.record, true)
                      : renderReminder(item.record, true),
                  )}
                </ul>
              </div>
            ))}
            {timeline.length === 0 && (
              <p className="text-xs text-muted-foreground">
                {t("还没有事件或带日期的待办，先在下面写一条。")}
              </p>
            )}
          </div>
        </section>
      )}

      <section
        ref={editorRef}
        data-event-editor
        className="scroll-mt-6 rounded-2xl border border-border bg-card/40 p-4 md:p-5"
      >
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-medium">{t(editingId ? "编辑这件事" : "记一件事")}</h3>
          {editingId && (
            <Button size="sm" variant="ghost" onClick={resetForm}>
              <X className="size-3.5" aria-hidden="true" />
              {t("取消编辑")}
            </Button>
          )}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          {t(
            "记不清哪天没关系，选「不记得具体哪天」，随手写句「去年夏天」，AI 会自己放到时间轴上。",
          )}
        </p>

        <div className="mt-3 flex flex-wrap gap-1.5">
          {PRECISIONS.map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => setPrecision(item)}
              className={cn(
                "rounded-full border px-3 py-1 text-[11px] transition-colors",
                precision === item
                  ? "border-primary bg-primary/10 text-foreground"
                  : "border-border text-muted-foreground hover:bg-accent/50",
              )}
            >
              {t(PRECISION_TABS[item])}
            </button>
          ))}
        </div>

        <div className="mt-3">
          {precision === "day" ? (
            <Input
              type="date"
              value={selected}
              onChange={(event) => setSelected(event.target.value)}
            />
          ) : (
            <div className="space-y-1.5">
              <Input
                value={fuzzyText}
                onChange={(event) => setFuzzyText(event.target.value)}
                placeholder={t("大概什么时候？例如：去年夏天、2019年前后、三年前秋天")}
              />
              <p className="text-[11px] text-muted-foreground">
                {fuzzyHint ? t(fuzzyHint) : t("随手写个大概，保存时自动整理成时间轴上的位置。")}
              </p>
            </div>
          )}
        </div>

        {precision === "day" && (dayMarks.birthdays.length > 0 || dayMarks.festival) && (
          <p className="mt-2 text-xs text-primary">
            {dayMarks.birthdays.map((person) => `${person.name} ${t("生日")}`).join("、")}
            {dayMarks.birthdays.length > 0 && dayMarks.festival ? " · " : ""}
            {dayMarks.festival ? t(dayMarks.festival.name) : ""}
          </p>
        )}

        {precision === "day" && (
          <div className="mt-3 space-y-3">
            {dayReminders.length > 0 && (
              <section
                className="rounded-xl border border-rose-500/25 bg-rose-500/5 p-3"
                role="region"
                aria-label={`${selected} ${t("的待办")}`}
              >
                <h4 className="flex items-center gap-1.5 text-xs font-medium">
                  <BellRing className="size-3.5 text-rose-500" aria-hidden="true" />
                  {t("当天待办")} · {dayReminders.filter((reminder) => !reminder.done).length}{" "}
                  {t("项未完成")}
                </h4>
                <ul className="mt-2 space-y-1.5">
                  {dayReminders.map((reminder) => renderReminder(reminder))}
                </ul>
              </section>
            )}
            <ul className="space-y-1.5">
              {dayEvents.map((event) => renderEvent(event))}
              {dayEvents.length === 0 && dayReminders.length === 0 && (
                <li className="text-xs text-muted-foreground">{t("这天还没有记录，写一条吧。")}</li>
              )}
            </ul>
          </div>
        )}

        <div className="mt-4 space-y-2 border-t border-border pt-4">
          <Textarea
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            rows={3}
            placeholder={t("发生了什么？例如：和小雨吃火锅，聊到她想换工作，答应帮她看简历")}
          />

          <PhotoNotes photos={photos} onChange={setPhotos} />
          {persons.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Input
                  value={personQuery}
                  onChange={(event) => setPersonQuery(event.target.value)}
                  aria-label={t("搜索参与人物")}
                  placeholder={t("搜索参与人物")}
                  className="h-8 max-w-xs text-xs"
                />
                {withIds.length > 0 && (
                  <span className="text-[11px] text-muted-foreground">
                    {t("已选")} {withIds.length} {t("人")}
                  </span>
                )}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {personOptions.map((person) => {
                  const on = withIds.includes(person.id);
                  return (
                    <button
                      key={person.id}
                      type="button"
                      aria-pressed={on}
                      onClick={() =>
                        setWithIds((prev) =>
                          on ? prev.filter((id) => id !== person.id) : [...prev, person.id],
                        )
                      }
                      className={cn(
                        "rounded-full border px-2.5 py-1 text-[11px] transition-colors",
                        on
                          ? "border-primary bg-primary/10 text-foreground"
                          : "border-border text-muted-foreground",
                      )}
                    >
                      {person.name}
                    </button>
                  );
                })}
                {personOptions.length === 0 && (
                  <span className="text-[11px] text-muted-foreground">
                    {t("没有找到匹配的人物")}
                  </span>
                )}
              </div>
            </div>
          )}
          <div className="flex justify-end">
            <Button onClick={() => void add()} disabled={!title.trim() || saving}>
              <Plus className="size-4" aria-hidden="true" />
              {saving ? t("整理中…") : editingId ? t("保存修改") : t("记下来")}
            </Button>
          </div>
        </div>
      </section>
    </div>
  );
}
