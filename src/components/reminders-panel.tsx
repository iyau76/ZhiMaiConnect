/** 个人版：提醒 —— 生日、节日、待办，以及「这事该拜托谁」 */

import {
  BrainCircuit,
  Cake,
  Check,
  Clipboard,
  Clock3,
  Gift,
  Loader2,
  PartyPopper,
  Plus,
  Sparkles,
  Trash2,
  Users,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { SourceBadge } from "@/components/source-badge";
import { ReasoningDisclosure } from "@/components/reasoning-disclosure";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { askText } from "@/lib/ai-text";
import {
  facesDb,
  type LifeEventRecord,
  type PersonRecord,
  type RelationRecord,
  type ReminderRecord,
} from "@/lib/face-db";
import { t } from "@/lib/i18n";
import { blessingPrompt, upcoming, todayStr, type UpcomingItem } from "@/lib/personal";
import {
  rankCandidates,
  recommendationPrompt,
  staleContacts,
  type CandidateRecommendation,
} from "@/lib/recommendation";
import { runRecommendationAgent, type AgentTraceEvent } from "@/lib/recommendation-agent";
import type { ProviderPreset } from "@/lib/vision-providers";

export function RemindersPanel({ preset }: { preset: ProviderPreset }) {
  const [persons, setPersons] = useState<PersonRecord[]>([]);
  const [reminders, setReminders] = useState<ReminderRecord[]>([]);
  const [events, setEvents] = useState<LifeEventRecord[]>([]);
  const [relations, setRelations] = useState<RelationRecord[]>([]);
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [answer, setAnswer] = useState<{ key: string; text: string } | null>(null);
  const [ask, setAsk] = useState("");
  const [askBusy, setAskBusy] = useState(false);
  const [askAnswer, setAskAnswer] = useState("");
  const [candidates, setCandidates] = useState<CandidateRecommendation[]>([]);
  const [candidateMode, setCandidateMode] = useState<"local" | "agent">("local");
  const [aiArchiveMode, setAiArchiveMode] = useState(false);
  const [agentBusy, setAgentBusy] = useState(false);
  const [agentTrace, setAgentTrace] = useState<AgentTraceEvent[]>([]);
  const agentAbortRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    const [p, r, e, rel] = await Promise.all([
      facesDb.listPersons(),
      facesDb.listReminders(),
      facesDb.listLifeEvents(),
      facesDb.listRelations(),
    ]);
    setPersons(p);
    setReminders(r);
    setEvents(e);
    setRelations(rel);
  }, []);

  useEffect(() => {
    void load();
    return () => agentAbortRef.current?.abort();
  }, [load]);

  const items = useMemo(() => upcoming(persons, 60), [persons]);
  const stale = useMemo(() => staleContacts(persons, events, 90).slice(0, 6), [persons, events]);

  const suggest = async (item: UpcomingItem) => {
    setBusyKey(item.key);
    setAnswer(null);
    try {
      const text = await askText(preset, blessingPrompt(item));
      setAnswer({ key: item.key, text });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "AI 请求失败");
    } finally {
      setBusyKey(null);
    }
  };

  const addFrom = async (item: UpcomingItem) => {
    const record: ReminderRecord = {
      id: crypto.randomUUID(),
      title: item.kind === "birthday" ? `给 ${item.person?.name} 送生日祝福` : `${item.title}问候`,
      due: undefined,
      personIds: item.person ? [item.person.id] : [],
      kind: item.kind,
      done: false,
      createdAt: Date.now(),
    };
    await facesDb.putReminder(record);
    await load();
    toast.success("已加入待办");
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
    await facesDb.putReminder({ ...record, done: !record.done });
    await load();
  };

  const remove = async (id: string) => {
    await facesDb.deleteReminder(id);
    await load();
  };

  const addContactReminder = async (person: PersonRecord) => {
    await facesDb.putReminder({
      id: crypto.randomUUID(),
      title: `联系 ${person.name}`,
      detail: "长期未联系提醒，请先确认对方近况再发送消息。",
      personIds: [person.id],
      kind: "custom",
      done: false,
      createdAt: Date.now(),
    });
    await load();
    toast.success("已加入待办");
  };

  const findWho = () => {
    if (!ask.trim()) return;
    const ranked = rankCandidates(ask.trim(), persons, events).slice(0, 3);
    setCandidates(ranked);
    setCandidateMode("local");
    setAgentTrace([]);
    setAskAnswer("");
    if (!ranked.length) toast.error("人物库还是空的，请先录入人物资料");
  };

  const loadOfflineRecommendationDemo = () => {
    const question = "我要组织校园记忆展开幕活动，找谁负责拍照比较合适？";
    const ranked = rankCandidates(question, persons, events).slice(0, 3);
    setAsk(question);
    setCandidates(ranked);
    setCandidateMode("local");
    setAgentTrace([]);
    setAskAnswer("");
    if (ranked.length) {
      toast.success("已用本地规则生成演示候选；人物与结果均须使用合成演示数据");
    } else {
      toast.error("请先在设置中载入合成演示数据");
    }
  };

  const explainCandidates = async () => {
    if (!ask.trim() || !candidates.length) return;
    setAskBusy(true);
    setAskAnswer("");
    try {
      const text = await askText(preset, recommendationPrompt(ask.trim(), candidates));
      setAskAnswer(text);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "AI 请求失败");
    } finally {
      setAskBusy(false);
    }
  };

  const analyzeFullArchive = async () => {
    if (!ask.trim() || agentBusy) return;
    agentAbortRef.current?.abort();
    const controller = new AbortController();
    agentAbortRef.current = controller;
    setAgentBusy(true);
    setAskAnswer("");
    setCandidates([]);
    setAgentTrace([]);
    try {
      const result = await runRecommendationAgent({
        preset,
        task: ask.trim(),
        persons,
        relations,
        events,
        signal: controller.signal,
        onTrace: (event) => setAgentTrace((current) => [...current.slice(-19), event]),
      });
      setCandidates(result.candidates);
      setCandidateMode("agent");
      setAskAnswer(result.answer);
      toast.success(
        result.disclosureMode === "full"
          ? `AI 已完成全档案分析（${result.rounds} 轮）`
          : `AI 已通过渐进披露完成分析（${result.rounds} 轮）`,
      );
    } catch (error) {
      if (!controller.signal.aborted) {
        toast.error(error instanceof Error ? error.message : "AI 全库分析失败");
      }
    } finally {
      if (agentAbortRef.current === controller) agentAbortRef.current = null;
      setAgentBusy(false);
    }
  };

  const open = reminders.filter((item) => !item.done);
  const done = reminders.filter((item) => item.done);

  return (
    <div className="min-w-0 space-y-5">
      {/* 即将到来 */}
      <section className="rounded-2xl border border-border bg-card/40 p-4 md:p-5">
        <h2 className="flex items-center gap-2 text-sm font-medium">
          <Cake className="size-4 text-primary" aria-hidden="true" />
          最近 60 天
        </h2>
        {items.length === 0 ? (
          <p className="mt-3 text-xs text-muted-foreground">
            还没有生日信息。到「人物关系」给人物填上生日，这里就会自动提醒。
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
                    {item.title}
                    <span className="text-[11px] text-muted-foreground">
                      {item.md} · {item.days === 0 ? "就是今天" : `还有 ${item.days} 天`}
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
                      祝福 / 礼物
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => void addFrom(item)}>
                      <Plus className="size-3.5" aria-hidden="true" />
                      待办
                    </Button>
                  </span>
                </div>
                {answer?.key === item.key && (
                  <div className="mt-3 space-y-2 rounded-lg border border-border bg-card p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-[10px] text-muted-foreground">
                        {item.person
                          ? "依据人物卡中的关系、喜好、忌口与送礼记录；缺失信息须由模型明确说明"
                          : "依据本地节日表生成；发送前请自行确认语气与对象"}
                      </span>
                      <span className="flex items-center gap-1.5">
                        {item.person && <SourceBadge source={item.person.source} detailed />}
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            void navigator.clipboard.writeText(answer.text);
                            toast.success("已复制；系统不会自动发送");
                          }}
                        >
                          <Clipboard className="size-3.5" aria-hidden="true" />
                          复制
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
          长期未联系
        </h2>
        {stale.length === 0 ? (
          <p className="mt-3 text-xs text-muted-foreground">
            暂无超过 90 天未互动的人物；这里只依据本地共同事件记录计算。
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
                    {item.lastDate ? `上次记录 ${item.lastDate}` : "尚无共同事件"} · 约 {item.days}{" "}
                    天
                  </span>
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void addContactReminder(item.person)}
                >
                  <Plus className="size-3.5" aria-hidden="true" />
                  待办
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
          我的待办
        </h2>
        <div className="mt-3 flex flex-wrap gap-2">
          <Input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="例如：周末给外婆打个电话"
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
            添加
          </Button>
        </div>

        <ul className="mt-4 space-y-1.5">
          {[...open, ...done].map((record) => (
            <li
              key={record.id}
              className="flex items-center justify-between gap-3 rounded-lg border border-border bg-background/60 px-3 py-2"
            >
              <button
                type="button"
                onClick={() => void toggle(record)}
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
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
              <button
                type="button"
                onClick={() => void remove(record.id)}
                aria-label={t("删除")}
                className="text-muted-foreground transition-colors hover:text-destructive"
              >
                <Trash2 className="size-3.5" aria-hidden="true" />
              </button>
            </li>
          ))}
          {reminders.length === 0 && (
            <li className="text-xs text-muted-foreground">
              还没有待办，可以从上面的生日 / 节日一键加入。
            </li>
          )}
        </ul>
      </section>

      {/* 这事拜托谁：本地确定性召回，或用户主动授权 AI 按需读取全库 */}
      <section className="rounded-2xl border border-border bg-card/40 p-4 md:p-5">
        <h2 className="flex items-center gap-2 text-sm font-medium">
          <Users className="size-4 text-primary" aria-hidden="true" />
          这事该拜托谁
        </h2>
        <Textarea
          value={ask}
          onChange={(event) => {
            agentAbortRef.current?.abort();
            setAsk(event.target.value);
            setCandidates([]);
            setAskAnswer("");
            setAgentTrace([]);
          }}
          rows={3}
          placeholder="例如：我想找人帮忙看一下租房合同，谁比较合适？"
          className="mt-3"
        />
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-background/45 px-3 py-2.5">
          <label
            htmlFor="ai-archive-mode"
            className="flex min-w-0 cursor-pointer items-center gap-3"
          >
            <Switch
              id="ai-archive-mode"
              checked={aiArchiveMode}
              onCheckedChange={setAiArchiveMode}
              disabled={agentBusy}
            />
            <span className="min-w-0">
              <span className="block text-xs font-medium">AI 全库分析</span>
              <span className="block text-[11px] leading-relaxed text-muted-foreground">
                小档案一次提交；档案较多时由 AI 多轮按需读取人物、关系与事件
              </span>
            </span>
          </label>
          <span className="text-[10px] text-muted-foreground">
            不提交照片、人脸特征、联系方式原文；天气与资讯查询不携带人物档案
          </span>
        </div>
        <div className="mt-2 flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={loadOfflineRecommendationDemo}>
            <Sparkles className="size-4" aria-hidden="true" />
            离线演示问题（合成数据）
          </Button>
          <Button variant="outline" onClick={findWho} disabled={!ask.trim() || agentBusy}>
            <Users className="size-4" aria-hidden="true" />
            本地筛选候选
          </Button>
          {aiArchiveMode && (
            <Button onClick={() => void analyzeFullArchive()} disabled={!ask.trim() || agentBusy}>
              {agentBusy ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <BrainCircuit className="size-4" aria-hidden="true" />
              )}
              AI 全库分析
            </Button>
          )}
          {candidateMode === "local" && candidates.length > 0 && (
            <Button onClick={() => void explainCandidates()} disabled={askBusy}>
              {askBusy ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <Sparkles className="size-4" aria-hidden="true" />
              )}
              生成比较与话术
            </Button>
          )}
        </div>
        {agentTrace.length > 0 && (
          <div className="mt-3">
            <ReasoningDisclosure
              label={t("分析轨迹")}
              current={agentTrace.at(-1)?.text ?? t("正在准备")}
              steps={agentTrace.length}
              running={agentBusy}
              history={agentTrace.map((event) => event.text)}
              stepLabel={t("步")}
            />
          </div>
        )}
        {candidates.length > 0 && (
          <ol className="mt-3 grid gap-2 lg:grid-cols-3">
            {candidates.map((candidate, index) => (
              <li
                key={candidate.person.id}
                className="rounded-xl border border-border bg-background/60 p-3 text-xs"
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="font-medium">
                    {index + 1}. {candidate.person.name}
                  </span>
                  <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] text-primary">
                    {candidate.score} {candidateMode === "agent" ? "AI建议分" : "本地分"} ·{" "}
                    {candidate.confidence}置信度
                  </span>
                </div>
                <p className="mt-2 leading-relaxed">
                  {candidate.reasons.join("；") || "暂无直接匹配理由"}
                </p>
                <div className="mt-2 space-y-1 text-[11px] text-muted-foreground">
                  {candidate.evidence.map((item) => (
                    <p key={item}>依据：{item}</p>
                  ))}
                  <p>信息更新：{new Date(candidate.updatedAt).toLocaleDateString()}</p>
                  {candidate.risks.map((risk) => (
                    <p key={risk} className="text-amber-700 dark:text-amber-300">
                      风险：{risk}
                    </p>
                  ))}
                </div>
                <SourceBadge source={candidate.source} className="mt-2" detailed />
              </li>
            ))}
          </ol>
        )}
        {askAnswer && (
          <div className="mt-3 rounded-lg border border-border bg-background/60 p-3">
            <div className="mb-2 flex justify-end">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  void navigator.clipboard.writeText(askAnswer);
                  toast.success("已复制，可继续编辑后自行发送");
                }}
              >
                <Clipboard className="size-3.5" aria-hidden="true" />
                复制
              </Button>
            </div>
            <Textarea
              value={askAnswer}
              onChange={(event) => setAskAnswer(event.target.value)}
              rows={10}
              aria-label={t("可编辑的候选比较与求助话术")}
            />
          </div>
        )}
      </section>
    </div>
  );
}
