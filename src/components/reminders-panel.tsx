/** 个人版：提醒 —— 生日、节日、待办，以及「这事该拜托谁」 */

import {
  BrainCircuit,
  Cake,
  Check,
  Clipboard,
  Clock3,
  Gift,
  Loader2,
  NotebookPen,
  PartyPopper,
  Plus,
  Sparkles,
  Trash2,
  Users,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { SourceBadge } from "@/components/source-badge";
import { AgentRunInspector } from "@/components/agent-run-inspector";
import { ReasoningDisclosure } from "@/components/reasoning-disclosure";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { askText } from "@/lib/ai-text";
import { projectAgentRun, type AgentRun } from "@/lib/agent-run-log";
import { indexedDbAgentRunLedger } from "@/lib/agent-run-ledger";
import { browserAgentRunOwnerId } from "@/lib/agent-run-owner";
import { LocalAgentSettingsStore } from "@/lib/agent-settings";
import {
  beginDurableAgentRun,
  DurableRunResumeError,
  type DurableAgentRunRecorder,
} from "@/lib/durable-agent-run";
import {
  mentionedArchivePeople,
  rankConnectionPaths,
  rankTargetSideEntries,
} from "@/lib/connection-paths";
import {
  facesDb,
  type LifeEventRecord,
  type PersonRecord,
  type RelationRecord,
  type ReminderRecord,
} from "@/lib/face-db";
import { getLang, t } from "@/lib/i18n";
import { buildReminderOutcome } from "@/lib/reminder-outcome";
import { cn } from "@/lib/utils";
import { copyText } from "@/lib/clipboard";
import { blessingPrompt, upcoming, todayStr, type UpcomingItem } from "@/lib/personal";
import {
  DEFAULT_RECOMMENDATION_CANDIDATE_LIMIT,
  RECOMMENDATION_CANDIDATE_LIMIT_OPTIONS,
  normalizeRecommendationCandidateLimit,
  rankCandidates,
  recommendationPrompt,
  staleContacts,
  type CandidateRecommendation,
} from "@/lib/recommendation";
import type { AgentTraceEvent } from "@/lib/agent-trace";
import { resolveSavedAgentBudget } from "@/lib/agent-observability";
import {
  createInitialRecommendationCheckpoint,
  runRecommendationAgent,
  type RecommendationAgentCheckpoint,
  type RecommendationAgentResult,
} from "@/lib/recommendation-agent";
import {
  parseRecommendationSessionState,
  persistRecommendationResult,
  RECOMMENDATION_THREAD_ID,
  recommendationArchiveRevision,
  recommendationProviderFingerprint,
  restoreRecommendationCandidates,
  type PersistedRecommendationResult,
  type RecommendationSessionState,
} from "@/lib/recommendation-session-state";
import type { ProviderPreset } from "@/lib/vision-providers";

const activeRecommendationRunIds = new Set<string>();
const CANDIDATE_LIMIT_STORAGE_KEY = "zhimai:recommendation-candidate-limit";

export function RemindersPanel({
  preset,
  active = true,
  focusReminderId,
  focusNonce,
  onOpenEvent,
}: {
  preset: ProviderPreset;
  active?: boolean;
  focusReminderId?: string;
  focusNonce?: number;
  onOpenEvent?: (eventId: string) => void;
}) {
  const [persons, setPersons] = useState<PersonRecord[]>([]);
  const [reminders, setReminders] = useState<ReminderRecord[]>([]);
  const [events, setEvents] = useState<LifeEventRecord[]>([]);
  const [relations, setRelations] = useState<RelationRecord[]>([]);
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  const [outcomeReminderId, setOutcomeReminderId] = useState("");
  const [outcomeText, setOutcomeText] = useState("");
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [answer, setAnswer] = useState<{ key: string; text: string } | null>(null);
  const handledReminderFocus = useRef("");

  const load = useCallback(async () => {
    const [p, r, e] = await Promise.all([
      facesDb.listPersons(),
      facesDb.listReminders(),
      facesDb.listLifeEvents(),
    ]);
    setPersons(p);
    setReminders(r);
    setEvents(e);
  }, []);

  useEffect(() => {
    if (active) void load();
  }, [active, load]);

  const items = useMemo(() => upcoming(persons, 60), [persons]);
  const stale = useMemo(() => staleContacts(persons, events, 90).slice(0, 6), [persons, events]);

  const suggest = async (item: UpcomingItem) => {
    setBusyKey(item.key);
    setAnswer(null);
    try {
      const text = await askText(preset, blessingPrompt(item));
      setAnswer({ key: item.key, text });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("AI 请求失败"));
    } finally {
      setBusyKey(null);
    }
  };

  const addFrom = async (item: UpcomingItem) => {
    const today = new Date();
    const occurrence = new Date(today.getFullYear(), today.getMonth(), today.getDate() + item.days);
    const record: ReminderRecord = {
      id: crypto.randomUUID(),
      title:
        getLang() === "en"
          ? item.kind === "birthday"
            ? `Send birthday wishes to ${item.person?.name}`
            : `Send greetings for ${t(item.title)}`
          : item.kind === "birthday"
            ? `给 ${item.person?.name} 送生日祝福`
            : `${item.title}问候`,
      due: todayStr(occurrence),
      personIds: item.person ? [item.person.id] : [],
      kind: item.kind,
      done: false,
      createdAt: Date.now(),
    };
    await facesDb.putReminder(record);
    await load();
    toast.success(t("已加入待办，并同步显示在日历"));
  };

  const addManual = async () => {
    if (!title.trim()) return;
    await facesDb.putReminder({
      id: crypto.randomUUID(),
      title: title.trim(),
      due: due || undefined,
      kind: "custom",
      done: false,
      createdAt: Date.now(),
    });
    setTitle("");
    setDue("");
    await load();
  };

  const toggle = async (record: ReminderRecord) => {
    const done = !record.done;
    await facesDb.putReminder({ ...record, done });
    if (done && !record.completionEventId) {
      setOutcomeReminderId(record.id);
      setOutcomeText("");
    } else if (!done && outcomeReminderId === record.id) {
      setOutcomeReminderId("");
      setOutcomeText("");
    }
    await load();
  };

  const saveOutcome = async (record: ReminderRecord) => {
    if (!outcomeText.trim()) return;
    const eventId = record.completionEventId ?? crypto.randomUUID();
    const previous = events.find((event) => event.id === eventId);
    const outcome = buildReminderOutcome(record, outcomeText, { eventId, previous });
    await facesDb.applyArchiveMutationBatch({
      lifeEvents: [outcome.event],
      reminders: [outcome.reminder],
    });
    setOutcomeReminderId("");
    setOutcomeText("");
    await load();
    toast.success(t("结果已记入时间线"));
  };

  const remove = async (id: string) => {
    await facesDb.deleteReminder(id);
    await load();
  };

  const addContactReminder = async (person: PersonRecord) => {
    await facesDb.putReminder({
      id: crypto.randomUUID(),
      title: getLang() === "en" ? `Contact ${person.name}` : `联系 ${person.name}`,
      detail: t("长期未联系提醒，请先确认对方近况再发送消息。"),
      personIds: [person.id],
      kind: "custom",
      done: false,
      createdAt: Date.now(),
    });
    await load();
    toast.success(t("已加入待办"));
  };

  const open = reminders.filter((item) => !item.done);
  const done = reminders.filter((item) => item.done);

  useEffect(() => {
    if (!focusReminderId || !reminders.some((record) => record.id === focusReminderId)) return;
    const focusKey = `reminder:${focusReminderId}:${focusNonce ?? 0}`;
    if (handledReminderFocus.current === focusKey) return;
    handledReminderFocus.current = focusKey;
    requestAnimationFrame(() =>
      document
        .getElementById(`reminder-${focusReminderId}`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" }),
    );
  }, [focusNonce, focusReminderId, reminders]);

  return (
    <div className="min-w-0 space-y-5">
      {/* 即将到来 */}
      <section className="rounded-2xl border border-border bg-card/40 p-4 md:p-5">
        <h2 className="flex items-center gap-2 text-sm font-medium">
          <Cake className="size-4 text-primary" aria-hidden="true" />
          {t("最近 60 天")}
        </h2>
        {items.length === 0 ? (
          <p className="mt-3 text-xs text-muted-foreground">
            {t("还没有生日信息。到「人物关系」给人物填上生日，这里就会自动提醒。")}
          </p>
        ) : (
          <ul className="mt-3 space-y-2">
            {items.map((item) => (
              <li key={item.key} className="rounded-xl border border-border bg-background/60 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="flex items-center gap-2 text-sm">
                    {item.kind === "birthday" ? (
                      <Cake className="size-3.5 text-primary" aria-hidden="true" />
                    ) : (
                      <PartyPopper className="size-3.5 text-primary" aria-hidden="true" />
                    )}
                    {t(item.title)}
                    <span className="text-[11px] text-muted-foreground">
                      {item.md} ·{" "}
                      {item.days === 0 ? t("就是今天") : `${t("还有")} ${item.days} ${t("天")}`}
                    </span>
                  </span>
                  <span className="flex gap-1.5">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void suggest(item)}
                      disabled={busyKey === item.key}
                    >
                      {busyKey === item.key ? (
                        <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                      ) : (
                        <Sparkles className="size-3.5" aria-hidden="true" />
                      )}
                      {t("祝福 / 礼物")}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => void addFrom(item)}>
                      <Plus className="size-3.5" aria-hidden="true" />
                      {t("待办")}
                    </Button>
                  </span>
                </div>
                {answer?.key === item.key && (
                  <div className="mt-3 space-y-2 rounded-lg border border-border bg-card p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-[10px] text-muted-foreground">
                        {item.person
                          ? t("依据人物卡中的关系、喜好、忌口与送礼记录；缺失信息须由模型明确说明")
                          : t("依据本地节日表生成；发送前请自行确认语气与对象")}
                      </span>
                      <span className="flex items-center gap-1.5">
                        {item.person && <SourceBadge source={item.person.source} detailed />}
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            void copyText(answer.text).then((copied) => {
                              if (copied) toast.success(t("已复制；系统不会自动发送"));
                              else toast.error(t("复制失败，请手动选择文本"));
                            });
                          }}
                        >
                          <Clipboard className="size-3.5" aria-hidden="true" />
                          {t("复制")}
                        </Button>
                      </span>
                    </div>
                    <Textarea
                      value={answer.text}
                      onChange={(event) => setAnswer({ ...answer, text: event.target.value })}
                      rows={8}
                      aria-label={t("可编辑的祝福与礼物建议")}
                    />
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* 长期未联系：完全本地计算，不依赖模型 */}
      <section className="rounded-2xl border border-border bg-card/40 p-4 md:p-5">
        <h2 className="flex items-center gap-2 text-sm font-medium">
          <Clock3 className="size-4 text-primary" aria-hidden="true" />
          {t("长期未联系")}
        </h2>
        {stale.length === 0 ? (
          <p className="mt-3 text-xs text-muted-foreground">
            {t("暂无超过 90 天未互动的人物；这里只依据本地共同事件记录计算。")}
          </p>
        ) : (
          <ul className="mt-3 grid gap-2 sm:grid-cols-2">
            {stale.map((item) => (
              <li
                key={item.person.id}
                className="flex items-center justify-between gap-2 rounded-xl border border-border bg-background/60 p-3"
              >
                <span className="min-w-0 text-sm">
                  <span className="block truncate font-medium">{item.person.name}</span>
                  <span className="text-[11px] text-muted-foreground">
                    {item.lastDate ? `${t("上次记录")} ${item.lastDate}` : t("尚无共同事件")} ·{" "}
                    {t("约")} {item.days} {t("天")}
                  </span>
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void addContactReminder(item.person)}
                >
                  <Plus className="size-3.5" aria-hidden="true" />
                  {t("待办")}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* 待办 */}
      <section className="rounded-2xl border border-border bg-card/40 p-4 md:p-5">
        <h2 className="flex items-center gap-2 text-sm font-medium">
          <Gift className="size-4 text-primary" aria-hidden="true" />
          {t("我的待办")}
        </h2>
        <div className="mt-3 flex flex-wrap gap-2">
          <Input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder={t("例如：周末给外婆打个电话")}
            className="min-w-0 flex-1"
          />
          <Input
            type="date"
            value={due}
            min={todayStr()}
            onChange={(event) => setDue(event.target.value)}
            className="w-40"
          />
          <Button onClick={() => void addManual()} disabled={!title.trim()}>
            <Plus className="size-4" aria-hidden="true" />
            {t("添加")}
          </Button>
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground">
          {t("填写日期的待办会同步显示在日历；不填日期时只保留在本页。")}
        </p>

        <ul className="mt-4 space-y-1.5">
          {[...open, ...done].map((record) => (
            <li
              key={record.id}
              id={`reminder-${record.id}`}
              data-reminder-id={record.id}
              className={cn(
                "scroll-mt-6 rounded-lg border border-border bg-background/60 px-3 py-2",
                focusReminderId === record.id && "ring-2 ring-primary/35",
              )}
            >
              <div className="flex items-center justify-between gap-3">
                <button
                  type="button"
                  onClick={() => void toggle(record)}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  aria-label={`${t(record.done ? "恢复待办" : "完成待办")}：${record.title}`}
                >
                  <span
                    className={`flex size-4 shrink-0 items-center justify-center rounded border ${record.done ? "border-primary bg-primary text-primary-foreground" : "border-border"}`}
                  >
                    {record.done && <Check className="size-3" aria-hidden="true" />}
                  </span>
                  <span
                    className={`truncate text-sm ${record.done ? "text-muted-foreground line-through" : ""}`}
                  >
                    {record.title}
                  </span>
                  {record.due && (
                    <span className="text-[11px] text-muted-foreground">{record.due}</span>
                  )}
                </button>
                <div className="flex shrink-0 items-center gap-2">
                  {record.done && !record.completionEventId && (
                    <button
                      type="button"
                      onClick={() => {
                        setOutcomeReminderId(record.id);
                        setOutcomeText("");
                      }}
                      className="text-[11px] text-primary hover:underline"
                    >
                      {t("补记结果")}
                    </button>
                  )}
                  {record.completionEventId && onOpenEvent && (
                    <button
                      type="button"
                      onClick={() => onOpenEvent(record.completionEventId!)}
                      className="flex items-center gap-1 text-[11px] text-primary hover:underline"
                    >
                      <NotebookPen className="size-3" aria-hidden="true" />
                      {t("查看结果")}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => void remove(record.id)}
                    aria-label={t("删除")}
                    className="text-muted-foreground transition-colors hover:text-destructive"
                  >
                    <Trash2 className="size-3.5" aria-hidden="true" />
                  </button>
                </div>
              </div>
              {outcomeReminderId === record.id && (
                <div
                  data-reminder-outcome-editor={record.id}
                  className="mt-3 space-y-2 border-t border-border pt-3"
                >
                  <Textarea
                    value={outcomeText}
                    onChange={(event) => setOutcomeText(event.target.value)}
                    rows={2}
                    aria-label={t("这件事最后怎么样了")}
                    placeholder={t("例如：已经把清单发给唐悦，她说明天确认档期")}
                  />
                  <div className="flex justify-end gap-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setOutcomeReminderId("");
                        setOutcomeText("");
                      }}
                    >
                      {t("稍后再记")}
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => void saveOutcome(record)}
                      disabled={!outcomeText.trim()}
                    >
                      <NotebookPen className="size-3.5" aria-hidden="true" />
                      {t("保存到时间线")}
                    </Button>
                  </div>
                </div>
              )}
            </li>
          ))}
          {reminders.length === 0 && (
            <li className="text-xs text-muted-foreground">
              {t("还没有待办，可以从上面的生日 / 节日一键加入。")}
            </li>
          )}
        </ul>
      </section>
    </div>
  );
}
