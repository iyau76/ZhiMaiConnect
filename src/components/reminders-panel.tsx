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
import { blessingPrompt, upcoming, todayStr, type UpcomingItem } from "@/lib/personal";
import {
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

export function RemindersPanel({
  preset,
  active = true,
  focusReminderId,
  focusRunId,
  focusNonce,
  onOpenEvent,
}: {
  preset: ProviderPreset;
  active?: boolean;
  focusReminderId?: string;
  focusRunId?: string;
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
  const [ask, setAsk] = useState("");
  const [askBusy, setAskBusy] = useState(false);
  const [askAnswer, setAskAnswer] = useState("");
  const [candidates, setCandidates] = useState<CandidateRecommendation[]>([]);
  const [candidateMode, setCandidateMode] = useState<"local" | "agent">("local");
  const [targetChoices, setTargetChoices] = useState<PersonRecord[]>([]);
  const [selectedTargetId, setSelectedTargetId] = useState("");
  const [includeInferredPaths, setIncludeInferredPaths] = useState(false);
  const [recommendationNotice, setRecommendationNotice] = useState("");
  const [aiArchiveMode, setAiArchiveMode] = useState(false);
  const [agentBusy, setAgentBusy] = useState(false);
  const [agentTrace, setAgentTrace] = useState<AgentTraceEvent[]>([]);
  const [latestAgentRun, setLatestAgentRun] = useState<AgentRun | null>(null);
  const [suspendedRecommendation, setSuspendedRecommendation] =
    useState<RecommendationAgentCheckpoint | null>(null);
  const agentAbortRef = useRef<AbortController | null>(null);
  const agentBusyRef = useRef(false);
  const handledReminderFocus = useRef("");
  const runInspectorRef = useRef<HTMLDivElement | null>(null);
  const archiveLoadedRef = useRef(false);
  const hydrationGeneration = useRef(0);
  const recommendationArchiveRef = useRef<{
    persons: PersonRecord[];
    relations: RelationRecord[];
    events: LifeEventRecord[];
  }>({ persons: [], relations: [], events: [] });
  const recommendationResultRef = useRef<PersistedRecommendationResult | null>(null);

  const hydrateRecommendation = useCallback(
    async (archive: {
      persons: PersonRecord[];
      relations: RelationRecord[];
      events: LifeEventRecord[];
    }) => {
      const generation = ++hydrationGeneration.current;
      const runs = await indexedDbAgentRunLedger.listRuns({ threadId: RECOMMENDATION_THREAD_ID });
      const orderedByRecency = [...runs].sort(
        (left, right) => right.ordinal - left.ordinal || right.createdAt - left.createdAt,
      );
      const focusedRun = focusRunId
        ? orderedByRecency.find((candidate) => candidate.id === focusRunId)
        : undefined;
      const ordered = focusedRun
        ? [focusedRun, ...orderedByRecency.filter((candidate) => candidate.id !== focusedRun.id)]
        : orderedByRecency;
      let restored: RecommendationSessionState | undefined;
      let restoredRun = ordered[0];
      for (const run of ordered) {
        if (!run.latestCheckpointId) continue;
        const checkpoint = await indexedDbAgentRunLedger.getCheckpoint(run.latestCheckpointId);
        restored = parseRecommendationSessionState(checkpoint?.state);
        if (restored) {
          restoredRun = run;
          break;
        }
      }
      if (!restored || !restoredRun || generation !== hydrationGeneration.current) return;
      const events = await indexedDbAgentRunLedger.listEvents(restoredRun.id);
      if (generation !== hydrationGeneration.current) return;

      const runningHere =
        restoredRun.status === "running" && activeRecommendationRunIds.has(restoredRun.id);
      const persistedResult = restored.result;
      recommendationResultRef.current = persistedResult;
      const restoredCandidates = restoreRecommendationCandidates(persistedResult, archive.persons);
      const resolution = persistedResult?.targetResolution;
      setAsk(restored.task);
      setAiArchiveMode(restored.aiArchiveMode);
      setIncludeInferredPaths(restored.includeInferredPaths);
      setSelectedTargetId(restored.selectedTargetId);
      setAgentTrace(restored.trace);
      setRecommendationNotice(
        runningHere ? "分析正在后台继续；完成后本页会自动更新。" : restored.notice,
      );
      setAskAnswer(persistedResult?.answer ?? "");
      setCandidates(restoredCandidates);
      setCandidateMode("agent");
      setTargetChoices(
        resolution?.mode === "ambiguous"
          ? resolution.candidatePersonIds.flatMap((id) => {
              const person = archive.persons.find((candidate) => candidate.id === id);
              return person ? [person] : [];
            })
          : [],
      );
      setSuspendedRecommendation(
        !runningHere &&
          (restoredRun.status === "suspended" || restoredRun.status === "running") &&
          restoredRun.resumable
          ? (restored.suspendedRequest?.checkpoint ?? null)
          : null,
      );
      setLatestAgentRun(
        projectAgentRun(events, {
          id: restoredRun.id,
          title: restoredRun.title,
          agentName: restoredRun.agentName,
          model: restoredRun.providerRef.model,
          status: restoredRun.status,
        }),
      );
    },
    [focusRunId],
  );

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
    const archive = { persons: p, relations: rel, events: e };
    recommendationArchiveRef.current = archive;
    if (!archiveLoadedRef.current) {
      archiveLoadedRef.current = true;
      await hydrateRecommendation(archive);
    }
  }, [hydrateRecommendation]);

  useEffect(() => {
    if (active) void load();
  }, [active, load]);

  useEffect(() => {
    const unsubscribe = indexedDbAgentRunLedger.subscribe(() => {
      if (!agentBusyRef.current && archiveLoadedRef.current) {
        void hydrateRecommendation(recommendationArchiveRef.current);
      }
    });
    return unsubscribe;
  }, [hydrateRecommendation]);

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

  const runTargetRecommendation = (targetId: string, includeInferred = includeInferredPaths) => {
    const target = persons.find((person) => person.id === targetId);
    if (!target) return;
    const ranked = rankConnectionPaths({
      task: ask.trim(),
      persons,
      relations,
      events,
      targetId,
      limit: 3,
      includeInferred,
    });
    const targetSide = ranked.length
      ? []
      : rankTargetSideEntries({
          task: ask.trim(),
          persons,
          relations,
          events,
          targetId,
          limit: 3,
          includeInferred,
        });
    setCandidates(ranked.length ? ranked : targetSide);
    setCandidateMode("local");
    setAgentTrace([]);
    setAskAnswer("");
    setSuspendedRecommendation(null);
    setSelectedTargetId(targetId);
    setRecommendationNotice(
      getLang() === "en"
        ? ranked.length
          ? `Target mode: only genuine reachable paths from Me through an intermediary to ${target.name} are shown.`
          : targetSide.length
            ? `No verified path from Me to ${target.name}; these are target-side leads only, not proven contacts.`
            : `No verified path or sufficiently evidenced target-side lead for ${target.name}. Full archive analysis can still inspect the records.`
        : ranked.length
          ? `已验证可达路径：只显示“我 → 中间人 → ${target.name}”的有据路径。`
          : targetSide.length
            ? `未发现本人到 ${target.name} 的已验证路径；以下仅是目标侧潜在入口，不代表你能联系到他们。`
            : `没有发现通往 ${target.name} 的已验证路径，目标侧也缺少足够关系证据。仍可点击“AI 全库分析”继续核对档案。`,
    );
  };

  const findWho = () => {
    if (!ask.trim()) return;
    const mentionedPeople = mentionedArchivePeople(ask.trim(), persons);
    if (mentionedPeople.length) {
      setCandidates([]);
      setTargetChoices(mentionedPeople);
      setSelectedTargetId("");
      setCandidateMode("local");
      setSuspendedRecommendation(null);
      setRecommendationNotice(
        t(
          "本地只召回了问题中出现的人名，不猜测谁是目标。若要查联系路径，请选择目标；也可让 AI 理解完整问题。",
        ),
      );
      return;
    }
    setTargetChoices([]);
    const ranked = rankCandidates(ask.trim(), persons, events).slice(0, 3);
    setCandidates(ranked.map((candidate) => ({ ...candidate, mode: "open" as const })));
    setSelectedTargetId("");
    setRecommendationNotice(t("开放求助模式：按任务匹配、可联系程度和近期互动筛选候选。"));
    setCandidateMode("local");
    setAgentTrace([]);
    setAskAnswer("");
    setSuspendedRecommendation(null);
    if (!ranked.length) toast.error(t("人物库还是空的，请先录入人物资料"));
  };

  const loadOfflineRecommendationDemo = () => {
    const question = "我要组织校园记忆展开幕活动，找谁负责拍照比较合适？";
    const ranked = rankCandidates(question, persons, events).slice(0, 3);
    setAsk(question);
    setCandidates(ranked);
    setCandidateMode("local");
    setTargetChoices([]);
    setSelectedTargetId("");
    setRecommendationNotice(t("开放求助模式：使用合成演示数据进行本地确定性筛选。"));
    setAgentTrace([]);
    setAskAnswer("");
    setSuspendedRecommendation(null);
    if (ranked.length) {
      toast.success(t("已用本地规则生成演示候选；人物与结果均须使用合成演示数据"));
    } else {
      toast.error(t("请先在设置中载入合成演示数据"));
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
      toast.error(error instanceof Error ? error.message : t("AI 请求失败"));
    } finally {
      setAskBusy(false);
    }
  };

  const noticeForRecommendation = (result: RecommendationAgentResult) => {
    const resolution = result.targetResolution;
    if (result.status === "suspended") {
      return `分析已暂停；前 ${result.rounds} 轮与工具结果已经保存在本机。`;
    }
    if (resolution?.mode === "ambiguous") return resolution.question ?? result.answer;
    if (resolution?.mode === "target" && result.candidates.some((candidate) => candidate.path)) {
      return t("目标模式：候选、分数和路径由本地确定性工具锁定，AI 只负责解释与措辞。");
    }
    if (resolution?.mode === "target") {
      return t("未找到本人到目标的已验证路径；AI 已核对档案，当前候选仅是目标侧潜在线索。");
    }
    return t("开放求助模式：AI 已按需读取档案，候选仍需人工复核。");
  };

  const applyRecommendationResult = (
    result: RecommendationAgentResult,
    input: {
      task: string;
      presetId: string;
      includeInferredPaths: boolean;
      selectedTargetId: string;
    },
  ) => {
    const resolution = result.targetResolution;
    const notice = noticeForRecommendation(result);
    setCandidates(result.candidates);
    setCandidateMode("agent");
    setAskAnswer(result.answer);
    setLatestAgentRun({ ...result.run, status: result.status });
    setRecommendationNotice(notice);
    setSuspendedRecommendation(result.checkpoint ?? null);
    if (resolution?.mode === "ambiguous") {
      setTargetChoices(
        resolution.candidatePersonIds.flatMap((id) => {
          const person = persons.find((row) => row.id === id);
          return person ? [person] : [];
        }),
      );
      setSelectedTargetId("");
    } else {
      setTargetChoices([]);
      setSelectedTargetId(resolution?.targetPersonId ?? input.selectedTargetId);
    }
    const state: RecommendationSessionState = {
      version: 1,
      runId: result.run.id,
      task: input.task,
      presetId: input.presetId,
      aiArchiveMode: true,
      includeInferredPaths: input.includeInferredPaths,
      selectedTargetId:
        resolution?.mode === "ambiguous"
          ? ""
          : (resolution?.targetPersonId ?? input.selectedTargetId),
      trace: result.checkpoint?.trace ?? [],
      notice,
      result: persistRecommendationResult(result),
      suspendedRequest: result.checkpoint
        ? { checkpoint: result.checkpoint, presetId: input.presetId }
        : null,
      updatedAt: Date.now(),
    };
    recommendationResultRef.current = state.result;
    return state;
  };

  const runDurableRecommendation = async (resumeFrom?: RecommendationAgentCheckpoint) => {
    const task = resumeFrom?.task ?? ask.trim();
    if (!task || agentBusyRef.current) return;
    const targetPersonId = (resumeFrom?.requestedTargetPersonId ?? selectedTargetId) || undefined;
    const inferred = resumeFrom?.includeInferredPaths ?? includeInferredPaths;
    agentAbortRef.current?.abort();
    const controller = new AbortController();
    agentAbortRef.current = controller;
    agentBusyRef.current = true;
    setAgentBusy(true);
    setSuspendedRecommendation(null);
    const initialTrace = resumeFrom?.trace ?? [];
    let liveTrace = [...initialTrace];
    setAgentTrace(initialTrace);
    if (!resumeFrom) {
      recommendationResultRef.current = null;
      setAskAnswer("");
      setCandidates([]);
      setTargetChoices([]);
    }
    const archive = { persons, relations, events };
    const archiveVersion = recommendationArchiveRevision(archive);
    const budget = resolveSavedAgentBudget("standard");
    let durable: DurableAgentRunRecorder | undefined;
    try {
      durable = await beginDurableAgentRun({
        repository: indexedDbAgentRunLedger,
        threadId: RECOMMENDATION_THREAD_ID,
        agentName: "recommendation",
        entrypoint: "reminders.recommendation",
        title: `这事该拜托谁：${task.slice(0, 40)}`,
        request: {
          task,
          targetSelected: Boolean(targetPersonId),
          includeInferredPaths: inferred,
        },
        providerRef: {
          presetId: preset.id,
          kind: preset.kind,
          model: preset.model,
          configFingerprint: recommendationProviderFingerprint(preset),
        },
        includeArchive: true,
        budget,
        archiveVersion,
        resumeRunId: resumeFrom?.sourceRunId,
        resumeMode: resumeFrom ? "model" : undefined,
        ownerId: browserAgentRunOwnerId(),
        retainEventPayload: new LocalAgentSettingsStore().load().savePrivatePayload,
      });
      const initialCheckpoint =
        resumeFrom ??
        createInitialRecommendationCheckpoint({
          runId: durable.runId,
          task,
          archiveVersion,
          includeInferredPaths: inferred,
          targetPersonId,
          maxRounds: budget.maxRounds,
        });
      const initialState: RecommendationSessionState = {
        version: 1,
        runId: durable.runId,
        task,
        presetId: preset.id,
        aiArchiveMode: true,
        includeInferredPaths: inferred,
        selectedTargetId: targetPersonId ?? "",
        trace: initialTrace,
        notice: resumeFrom
          ? `已恢复前 ${resumeFrom.nextRound - 1} 轮，准备从第 ${resumeFrom.nextRound} 轮继续。`
          : "分析任务已保存在本机；离开页面后仍可回来查看或继续。",
        result: resumeFrom ? recommendationResultRef.current : null,
        suspendedRequest: { checkpoint: initialCheckpoint, presetId: preset.id },
        updatedAt: Date.now(),
      };
      await durable.checkpoint({
        state: initialState,
        checkpointKind: "awaiting_model",
        nextAction: "invoke_model",
        resumable: true,
        dependencyRefs: [{ scope: "archive", version: archiveVersion }],
      });
      activeRecommendationRunIds.add(durable.runId);
      const result = await runRecommendationAgent({
        preset,
        task,
        persons,
        relations,
        events,
        targetPersonId,
        includeInferredPaths: inferred,
        signal: controller.signal,
        archiveVersion,
        budget,
        recorder: durable,
        resumeFrom,
        onCheckpoint: async (checkpoint) => {
          liveTrace = [...checkpoint.trace];
          await durable!.checkpoint({
            state: {
              ...initialState,
              trace: checkpoint.trace,
              notice: `分析进行到第 ${checkpoint.nextRound} 轮；已取得的工具结果均已保存。`,
              suspendedRequest: { checkpoint, presetId: preset.id },
              updatedAt: Date.now(),
            } satisfies RecommendationSessionState,
            checkpointKind: "awaiting_model",
            nextAction: "invoke_model",
            resumable: true,
            dependencyRefs: [{ scope: "archive", version: archiveVersion }],
          });
        },
        onTrace: (event) => {
          liveTrace = [...liveTrace, event];
          setAgentTrace((current) => [...current.slice(-23), event]);
        },
      });
      result.checkpoint = result.checkpoint
        ? { ...result.checkpoint, trace: liveTrace }
        : result.checkpoint;
      const state = applyRecommendationResult(result, {
        task,
        presetId: preset.id,
        includeInferredPaths: inferred,
        selectedTargetId: targetPersonId ?? "",
      });
      state.trace = liveTrace;
      await durable.settle({
        status: result.status,
        state,
        checkpointKind: result.status === "suspended" ? "awaiting_model" : "safe_boundary",
        nextAction: result.status === "suspended" ? "invoke_model" : "finalize",
        resumable: result.status === "suspended",
        dependencyRefs: [{ scope: "archive", version: archiveVersion }],
      });
      if (result.status === "suspended") {
        toast.error(result.answer);
      } else if (result.targetResolution?.mode === "ambiguous") {
        toast.success(t("AI 已理解问题，请选择目标人物后继续"));
      } else {
        toast.success(
          result.disclosureMode === "full"
            ? `AI 已完成全档案分析（${result.rounds} 轮）`
            : `AI 已通过渐进披露完成分析（${result.rounds} 轮）`,
        );
      }
    } catch (error) {
      const aborted = controller.signal.aborted;
      const message = error instanceof Error ? error.message : t("AI 全库分析失败");
      const failedTrace = [...liveTrace, { kind: "error" as const, text: message }];
      if (durable) {
        const failedState: RecommendationSessionState = {
          version: 1,
          runId: durable.runId,
          task,
          presetId: preset.id,
          aiArchiveMode: true,
          includeInferredPaths: inferred,
          selectedTargetId: targetPersonId ?? "",
          trace: failedTrace,
          notice: aborted
            ? "分析已由用户取消。"
            : error instanceof DurableRunResumeError
              ? `${message} 请按当前档案重新发起分析。`
              : message,
          result: aborted ? recommendationResultRef.current : null,
          suspendedRequest: null,
          updatedAt: Date.now(),
        };
        await durable
          .settle({
            status: aborted ? "cancelled" : "failed",
            state: failedState,
            checkpointKind: "safe_boundary",
            nextAction: "finalize",
            resumable: false,
            dependencyRefs: [{ scope: "archive", version: archiveVersion }],
          })
          .catch(() => undefined);
      }
      if (!aborted) {
        setAgentTrace(failedTrace.slice(-24));
        setSuspendedRecommendation(
          error instanceof DurableRunResumeError ? (resumeFrom ?? null) : null,
        );
        toast.error(message);
      }
    } finally {
      if (durable) activeRecommendationRunIds.delete(durable.runId);
      if (agentAbortRef.current === controller) agentAbortRef.current = null;
      agentBusyRef.current = false;
      setAgentBusy(false);
    }
  };

  const analyzeFullArchive = async () => runDurableRecommendation();

  const resumeRecommendation = async () => {
    if (!suspendedRecommendation) return;
    await runDurableRecommendation(suspendedRecommendation);
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

  useEffect(() => {
    if (!focusRunId || latestAgentRun?.id !== focusRunId) return;
    const focusKey = `run:${focusRunId}:${focusNonce ?? 0}`;
    if (handledReminderFocus.current === focusKey) return;
    handledReminderFocus.current = focusKey;
    requestAnimationFrame(() =>
      runInspectorRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }),
    );
  }, [focusNonce, focusRunId, latestAgentRun]);

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
                            void navigator.clipboard.writeText(answer.text);
                            toast.success(t("已复制；系统不会自动发送"));
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

      {/* 这事拜托谁：本地确定性召回，或用户主动授权 AI 按需读取全库 */}
      <section className="rounded-2xl border border-border bg-card/40 p-4 md:p-5">
        <h2 className="flex items-center gap-2 text-sm font-medium">
          <Users className="size-4 text-primary" aria-hidden="true" />
          {t("这事该拜托谁")}
        </h2>
        <Textarea
          value={ask}
          onChange={(event) => {
            agentAbortRef.current?.abort();
            setAsk(event.target.value);
            setCandidates([]);
            setTargetChoices([]);
            setSelectedTargetId("");
            setRecommendationNotice("");
            setAskAnswer("");
            setAgentTrace([]);
            setSuspendedRecommendation(null);
          }}
          rows={3}
          placeholder={t("例如：我想找人帮忙看一下租房合同，谁比较合适？")}
          className="mt-3"
        />
        {targetChoices.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-amber-500/35 bg-amber-500/5 p-3 text-xs">
            <span>{recommendationNotice}</span>
            <select
              value={selectedTargetId}
              onChange={(event) => {
                const id = event.target.value;
                setSelectedTargetId(id);
                if (id) runTargetRecommendation(id);
              }}
              className="h-9 min-w-40 rounded-md border border-border bg-background px-2"
              aria-label={t("选择目标人物")}
            >
              <option value="">{t("请选择目标人物")}</option>
              {targetChoices.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.name}
                </option>
              ))}
            </select>
          </div>
        )}
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
              <span className="block text-xs font-medium">{t("AI 全库分析")}</span>
              <span className="block text-[11px] leading-relaxed text-muted-foreground">
                {t("小档案一次提交；档案较多时由 AI 多轮按需读取人物、关系与事件")}
              </span>
            </span>
          </label>
          <span className="text-[10px] text-muted-foreground">
            {t("不提交照片、人脸特征、联系方式原文；天气与资讯查询不携带人物档案")}
          </span>
        </div>
        <div className="mt-2 flex flex-wrap justify-end gap-2">
          <label className="mr-auto flex items-center gap-2 text-[11px] text-muted-foreground">
            <Switch
              checked={includeInferredPaths}
              onCheckedChange={(checked) => {
                setIncludeInferredPaths(checked);
                setSuspendedRecommendation(null);
                if (selectedTargetId) {
                  window.setTimeout(() => runTargetRecommendation(selectedTargetId, checked), 0);
                }
              }}
              aria-label={t("允许已确认的推导关系参与引荐")}
            />
            {t("允许已确认的推导关系参与引荐")}
          </label>
          <Button variant="ghost" onClick={loadOfflineRecommendationDemo}>
            <Sparkles className="size-4" aria-hidden="true" />
            {t("离线演示问题（合成数据）")}
          </Button>
          <Button variant="outline" onClick={findWho} disabled={!ask.trim() || agentBusy}>
            <Users className="size-4" aria-hidden="true" />
            {t("本地筛选候选")}
          </Button>
          {aiArchiveMode && (
            <Button
              onClick={() =>
                void (suspendedRecommendation ? resumeRecommendation() : analyzeFullArchive())
              }
              disabled={!ask.trim() || agentBusy}
            >
              {agentBusy ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <BrainCircuit className="size-4" aria-hidden="true" />
              )}
              {suspendedRecommendation
                ? `从第 ${suspendedRecommendation.nextRound} 轮继续`
                : t("AI 全库分析")}
            </Button>
          )}
          {candidateMode === "local" && candidates.length > 0 && (
            <Button onClick={() => void explainCandidates()} disabled={askBusy}>
              {askBusy ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <Sparkles className="size-4" aria-hidden="true" />
              )}
              {t("生成比较与话术")}
            </Button>
          )}
        </div>
        {recommendationNotice && targetChoices.length === 0 && (
          <p className="mt-3 rounded-lg border border-border bg-muted/25 px-3 py-2 text-[11px] text-muted-foreground">
            {recommendationNotice}
          </p>
        )}
        {agentTrace.length > 0 && (
          <div className="mt-3">
            <ReasoningDisclosure
              label={t("分析轨迹")}
              current={agentTrace.at(-1)?.text ?? t("正在准备")}
              steps={agentTrace.length}
              running={agentBusy}
              events={agentTrace}
              stepLabel={t("步")}
            />
          </div>
        )}
        {latestAgentRun && !agentBusy && (
          <div ref={runInspectorRef} className="mt-3" data-agent-run-id={latestAgentRun.id}>
            <AgentRunInspector run={latestAgentRun} />
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
                    {candidate.score}{" "}
                    {t(
                      candidate.path
                        ? "路径分"
                        : candidate.mode === "target_side"
                          ? "目标侧相关分"
                          : candidate.mode === "open" && candidateMode === "agent"
                            ? "本地锁定分"
                            : "本地分",
                    )}{" "}
                    · {t(candidate.confidence)} {t("置信度")}
                  </span>
                </div>
                {candidate.path && (
                  <p className="mt-2 rounded-md bg-primary/5 px-2 py-1.5 font-medium text-primary">
                    {candidate.path.direct
                      ? `${t("可直接联系")} ${persons.find((person) => person.id === candidate.path?.targetId)?.name ?? t("目标人物")}`
                      : [
                          t("我"),
                          ...candidate.path.personIds.map(
                            (id) =>
                              persons.find((person) => person.id === id)?.name ?? t("未知人物"),
                          ),
                        ].join(" → ")}
                  </p>
                )}
                {candidate.mode === "target_side" && (
                  <p className="mt-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-2 py-1.5 font-medium text-amber-700 dark:text-amber-300">
                    {t("目标侧潜在入口 · 尚未验证你能联系到此人")}
                  </p>
                )}
                <p className="mt-2 leading-relaxed">
                  {candidate.reasons.join("；") || t("暂无直接匹配理由")}
                </p>
                <div className="mt-2 space-y-1 text-[11px] text-muted-foreground">
                  {candidate.evidence.map((item) => (
                    <p key={item}>
                      {t("依据")}：{item}
                    </p>
                  ))}
                  <p>
                    {t("信息更新")}：{new Date(candidate.updatedAt).toLocaleDateString()}
                  </p>
                  {candidate.risks.map((risk) => (
                    <p key={risk} className="text-amber-700 dark:text-amber-300">
                      {t("风险")}：{risk}
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
                  toast.success(t("已复制，可继续编辑后自行发送"));
                }}
              >
                <Clipboard className="size-3.5" aria-hidden="true" />
                {t("复制")}
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
