/** 人物关系 · 找人办事：问一句「这事该找谁」，本地确定性召回 + 可选 AI 全库分析。 */

import {
  BrainCircuit,
  CircleHelp,
  Clipboard,
  Loader2,
  Pencil,
  Sparkles,
  Users,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { AgentRunInspector } from "@/components/agent-run-inspector";
import { MarkdownView } from "@/components/markdown-view";
import { ReasoningDisclosure } from "@/components/reasoning-disclosure";
import { SourceBadge } from "@/components/source-badge";
import { Button } from "@/components/ui/button";
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
} from "@/lib/face-db";
import { getLang, t } from "@/lib/i18n";
import { copyText } from "@/lib/clipboard";
import {
  DEFAULT_RECOMMENDATION_CANDIDATE_LIMIT,
  RECOMMENDATION_CANDIDATE_LIMIT_OPTIONS,
  normalizeRecommendationCandidateLimit,
  rankCandidates,
  recommendationPrompt,
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
import { cn } from "@/lib/utils";

const activeRecommendationRunIds = new Set<string>();
const CANDIDATE_LIMIT_STORAGE_KEY = "zhimai:recommendation-candidate-limit";

export function AskForHelpPanel({
  preset,
  active = true,
  focusRunId,
  focusNonce,
}: {
  preset: ProviderPreset;
  active?: boolean;
  focusRunId?: string;
  focusNonce?: number;
}) {
  const [persons, setPersons] = useState<PersonRecord[]>([]);
  const [events, setEvents] = useState<LifeEventRecord[]>([]);
  const [relations, setRelations] = useState<RelationRecord[]>([]);

  const [ask, setAsk] = useState("");
  const [askBusy, setAskBusy] = useState(false);
  const [askAnswer, setAskAnswer] = useState("");
  const [answerEditing, setAnswerEditing] = useState(false);
  const [candidates, setCandidates] = useState<CandidateRecommendation[]>([]);
  const [candidateMode, setCandidateMode] = useState<"local" | "agent">("local");
  const [targetChoices, setTargetChoices] = useState<PersonRecord[]>([]);
  const [selectedTargetId, setSelectedTargetId] = useState("");
  const [includeInferredPaths, setIncludeInferredPaths] = useState(true);
  const [includePendingPaths, setIncludePendingPaths] = useState(false);
  const [archiveHelpOpen, setArchiveHelpOpen] = useState(false);
  const [candidateLimit, setCandidateLimit] = useState(() => {
    try {
      return normalizeRecommendationCandidateLimit(
        window.localStorage.getItem(CANDIDATE_LIMIT_STORAGE_KEY),
      );
    } catch {
      return DEFAULT_RECOMMENDATION_CANDIDATE_LIMIT;
    }
  });
  const [recommendationNotice, setRecommendationNotice] = useState("");
  const [aiArchiveMode, setAiArchiveMode] = useState(true);
  const [agentBusy, setAgentBusy] = useState(false);
  const [agentTrace, setAgentTrace] = useState<AgentTraceEvent[]>([]);
  const [latestAgentRun, setLatestAgentRun] = useState<AgentRun | null>(null);
  const [suspendedRecommendation, setSuspendedRecommendation] =
    useState<RecommendationAgentCheckpoint | null>(null);

  const agentAbortRef = useRef<AbortController | null>(null);
  const agentBusyRef = useRef(false);
  const runInspectorRef = useRef<HTMLDivElement | null>(null);
  const archiveLoadedRef = useRef(false);
  const hydrationGeneration = useRef(0);
  const recommendationArchiveRef = useRef<{
    persons: PersonRecord[];
    relations: RelationRecord[];
    events: LifeEventRecord[];
  }>({ persons: [], relations: [], events: [] });
  const recommendationResultRef = useRef<PersistedRecommendationResult | null>(null);
  const handledRunFocus = useRef("");

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
      setIncludePendingPaths(restored.includePendingPaths === true);
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
    const [p, e, rel] = await Promise.all([
      facesDb.listPersons(),
      facesDb.listLifeEvents(),
      facesDb.listRelations(),
    ]);
    setPersons(p);
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

  /**
   * 候选是本地排序的结果；用到待确认关系时补一条可见的风险说明，
   * 不因为「数据没确认」就悄悄少给候选，也不假装这些路径已经核实。
   */
  const markPendingUse = (rows: CandidateRecommendation[]) => {
    const pendingIds = new Set(
      relations
        .filter((relation) => relation.confirmationStatus === "pending")
        .map((row) => row.id),
    );
    if (!pendingIds.size) return rows;
    return rows.map((row) => {
      const usedIds = [...(row.path?.relationIds ?? []), ...(row.targetEntry?.relationIds ?? [])];
      if (!usedIds.some((id) => pendingIds.has(id))) return row;
      return { ...row, risks: [t("这条推荐用到了尚未确认的关系，请先核对再联系。"), ...row.risks] };
    });
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
      limit: candidateLimit,
      includeInferred,
      includePending: includePendingPaths,
    });
    const targetSide = ranked.length
      ? []
      : rankTargetSideEntries({
          task: ask.trim(),
          persons,
          relations,
          events,
          targetId,
          limit: candidateLimit,
          includeInferred,
          includePending: includePendingPaths,
        });
    setCandidates(markPendingUse(ranked.length ? ranked : targetSide));
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
          ? `下面是你能真正联系上的路径：「我 → 中间人 → ${target.name}」。`
          : targetSide.length
            ? `档案里没有你和 ${target.name} 之间的直接路径；下面是 ${target.name} 身边的人，不代表你能联系上他们。`
            : `档案里找不到通往 ${target.name} 的路，${target.name} 身边的关系记录也不够。可以点「AI 全库分析」再核对一遍。`,
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
    const ranked = rankCandidates(ask.trim(), persons, events).slice(0, candidateLimit);
    setCandidates(
      markPendingUse(ranked.map((candidate) => ({ ...candidate, mode: "open" as const }))),
    );
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
    const ranked = rankCandidates(question, persons, events).slice(0, candidateLimit);
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
      return t("顺序和依据都是本地按档案算出来的，AI 只负责把话说明白。");
    }
    if (resolution?.mode === "target") {
      return t("档案里没有你和目标之间的直接路径；下面只是目标身边的人，AI 已经核对过档案。");
    }
    return t("AI 已经按需读过档案；下面这几位还需要你自己核实。");
  };

  const applyRecommendationResult = (
    result: RecommendationAgentResult,
    input: {
      task: string;
      presetId: string;
      includeInferredPaths: boolean;
      includePendingPaths: boolean;
      selectedTargetId: string;
    },
  ) => {
    const resolution = result.targetResolution;
    const notice = noticeForRecommendation(result);
    setCandidates(markPendingUse(result.candidates));
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
      includePendingPaths: input.includePendingPaths,
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
    const pending = resumeFrom?.includePendingPaths ?? includePendingPaths;
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
          includePendingPaths: pending,
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
          includePendingPaths: pending,
          candidateLimit,
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
        includePendingPaths: pending,
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
        includePendingPaths: pending,
        candidateLimit,
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
        includePendingPaths: pending,
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
          includePendingPaths: pending,
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

  useEffect(() => {
    if (!focusRunId || latestAgentRun?.id !== focusRunId) return;
    const focusKey = `run:${focusRunId}:${focusNonce ?? 0}`;
    if (handledRunFocus.current === focusKey) return;
    handledRunFocus.current = focusKey;
    requestAnimationFrame(() =>
      runInspectorRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }),
    );
  }, [focusNonce, focusRunId, latestAgentRun]);

  return (
    <div className="min-w-0 space-y-5">
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
              <span className="flex items-center gap-1.5 text-xs font-medium">
                {t("AI 全库分析")}
                <button
                  type="button"
                  aria-label={t("AI 全库分析是怎么工作的")}
                  aria-expanded={archiveHelpOpen}
                  data-testid="ask-for-help-archive-help"
                  onClick={(event) => {
                    event.preventDefault();
                    setArchiveHelpOpen((value) => !value);
                  }}
                  className="text-muted-foreground transition-colors hover:text-foreground"
                >
                  <CircleHelp className="size-3.5" aria-hidden="true" />
                </button>
              </span>
            </span>
          </label>
          {archiveHelpOpen && (
            <p
              data-testid="ask-for-help-archive-help-text"
              className="w-full rounded-lg border border-primary/25 bg-primary/5 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground"
            >
              {t(
                "档案不多时，一次性把人物、关系与事件交给 AI；档案多时，AI 会分几轮按需读取，不必一次看完。照片、人脸特征和联系方式原文不会提交，天气与资讯类问题也不携带人物档案。",
              )}
            </p>
          )}
        </div>
        <div className="mt-2 flex flex-wrap items-center justify-end gap-3">
          <label className="mr-auto flex items-center gap-2 text-[11px] text-muted-foreground">
            <Switch
              checked={includePendingPaths}
              onCheckedChange={(checked) => {
                setIncludePendingPaths(checked);
                setSuspendedRecommendation(null);
                if (selectedTargetId) {
                  window.setTimeout(() => runTargetRecommendation(selectedTargetId), 0);
                }
              }}
              aria-label={t("允许待确认的关系参与引荐")}
            />
            {t("允许待确认的关系参与引荐")}
          </label>
          <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
            {t("推荐人数上限")}
            <select
              value={candidateLimit}
              onChange={(event) => {
                const next = normalizeRecommendationCandidateLimit(event.target.value);
                setCandidateLimit(next);
                try {
                  window.localStorage.setItem(CANDIDATE_LIMIT_STORAGE_KEY, String(next));
                } catch {
                  // The in-memory choice still applies for this session.
                }
                setSuspendedRecommendation(null);
              }}
              disabled={agentBusy}
              className="h-8 rounded-md border border-border bg-background px-2"
              aria-label={t("推荐人数上限")}
            >
              {RECOMMENDATION_CANDIDATE_LIMIT_OPTIONS.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
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
          // 顺序由数据层锁定（rankCandidates / rankConnectionPaths 等），卡片、正文与话术读同一份数组。
          // 需要改排序时改生成处，不要在这里单独重排，否则正文编号和联系话术会对不上人。
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
                {candidate.mode === "open" && Boolean(candidate.capabilityMatches?.length) && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {candidate.capabilityMatches?.map((match) => (
                      <span
                        key={`${match.slotId}:${match.localRank ?? 1}`}
                        className={cn(
                          "rounded-full border px-2 py-0.5 text-[10px]",
                          match.localRank === 1
                            ? "border-primary/35 bg-primary/10 text-primary"
                            : "border-border bg-muted/35 text-muted-foreground",
                        )}
                      >
                        {match.localRank === 1 ? t("首选") : `${t("备选")} ${match.localRank}`} ·{" "}
                        {match.label}
                      </span>
                    ))}
                  </div>
                )}
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
            <div className="mb-2 flex flex-wrap items-center justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => setAnswerEditing((value) => !value)}>
                <Pencil className="size-3.5" aria-hidden="true" />
                {answerEditing ? t("看排版") : t("改文字")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  void copyText(askAnswer).then((copied) => {
                    if (copied) toast.success(t("已复制，可继续编辑后自行发送"));
                    else toast.error(t("复制失败，请手动选择文本"));
                  });
                }}
              >
                <Clipboard className="size-3.5" aria-hidden="true" />
                {t("复制")}
              </Button>
            </div>
            {answerEditing ? (
              <Textarea
                value={askAnswer}
                onChange={(event) => setAskAnswer(event.target.value)}
                rows={12}
                aria-label={t("可编辑的候选比较与求助话术")}
              />
            ) : (
              <div data-testid="ask-for-help-answer">
                <MarkdownView text={askAnswer} />
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
