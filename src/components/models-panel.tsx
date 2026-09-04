import {
  Check,
  CheckCircle2,
  Eye,
  Loader2,
  Mic,
  Plug,
  Plus,
  Save,
  Send,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { AgentControlCenter } from "@/components/agent-control-center";
import { Button } from "@/components/ui/button";
import { ReasoningDisclosure } from "@/components/reasoning-disclosure";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  assistantArchiveRevision,
  createInitialAssistantCheckpoint,
  runAssistantAgent,
  type AssistantAgentCheckpoint,
  type AssistantAgentResult,
  type AssistantWorkingMemory,
} from "@/lib/assistant-agent";
import { projectAgentRun, type AgentRun } from "@/lib/agent-run-log";
import { browserAgentRunOwnerId } from "@/lib/agent-run-owner";
import { resolveSavedAgentBudget } from "@/lib/agent-observability";
import type { ArchiveCitation } from "@/lib/agent-output-grounding";
import type { ArchiveMutationDiffRow } from "@/lib/archive-mutation-plan";
import {
  ASSISTANT_THREAD_ID,
  assistantProviderFingerprint,
  parseAssistantSessionState,
  type AssistantSessionState,
  type PersistedSuspendedAssistantRequest,
} from "@/lib/assistant-session-state";
import { LocalAgentSettingsStore } from "@/lib/agent-settings";
import {
  indexedDbAgentRunLedger,
  indexedDbMutationArtifactRepository,
} from "@/lib/agent-run-ledger";
import {
  beginDurableAgentRun,
  cancelDurableAgentRun,
  continueDurableAgentRun,
  DurableRunResumeError,
  type DurableAgentRunRecorder,
} from "@/lib/durable-agent-run";
import { facesDb } from "@/lib/face-db";
import { t } from "@/lib/i18n";
import {
  MutationCommitCoordinator,
  type MutationCommitReceipt,
  type MutationProposalEntry,
} from "@/lib/mutation-commit-coordinator";
import type { AgentTraceEvent } from "@/lib/agent-trace";

import { cn } from "@/lib/utils";
import { auditVision, testConnection } from "@/lib/vision-client";
import {
  KIND_LABEL,
  createPreset,
  supportsAudio,
  supportsVision,
  type ChatTurn,
  type ProviderKind,
  type ProviderPreset,
} from "@/lib/vision-providers";

interface Props {
  presets: ProviderPreset[];
  onPresetsChange: (presets: ProviderPreset[]) => void;
  onSavePresets: () => void;
  activeId: string;
  onActiveIdChange: (id: string) => void;
  frame: string | null;
  onFrameUsed: () => void;
}

type AssistantArchive = Pick<
  Parameters<typeof runAssistantAgent>[0],
  "persons" | "relations" | "events" | "collections" | "collectionMemberships"
>;

type SuspendedAssistantRequest = PersistedSuspendedAssistantRequest;

function assistantAdviceWithoutEvidence(answer: string, citations: ArchiveCitation[]) {
  if (!citations.length) return answer;
  const sections = answer.split("\n\n");
  const withoutEvidence = sections
    .filter((section) => !section.startsWith("档案依据（可回查）"))
    .join("\n\n")
    .trim();
  const canonical = citations.map((citation) => `- ${citation.claim}`).join("\n");
  return [canonical, withoutEvidence].filter(Boolean).join("\n\n");
}

function assistantArchiveHasRecords(archive: AssistantArchive) {
  return (
    archive.persons.length +
      archive.relations.length +
      archive.events.length +
      (archive.collections?.length ?? 0) +
      (archive.collectionMemberships?.length ?? 0) >
    0
  );
}

const MUTATION_FIELD_LABELS: Record<string, string> = {
  name: "姓名",
  note: "备注",
  person: "人物档案",
  "profile.tags": "人物标签",
  "collection.name": "圈层名称",
  "collection.kind": "圈层类型",
  "collection.color": "圈层颜色",
  "collection.membership": "圈层成员",
  "relation.label": "关系名称",
  "relation.predicate": "关系类型",
  "relation.qualifiers": "关系限定",
  "relation.direction": "关系方向",
  "relation.note": "关系备注",
  "relation.evidence": "关系依据",
  "relation.validity": "关系有效期",
  "relation.confidence": "关系置信度",
  "relation.confirmationStatus": "关系确认状态",
};

function mutationFieldLabel(field: string) {
  if (MUTATION_FIELD_LABELS[field]) return MUTATION_FIELD_LABELS[field];
  if (field.startsWith("profile.")) return `人物资料 · ${field.slice("profile.".length)}`;
  if (field.startsWith("event.")) return `事件 · ${field.slice("event.".length)}`;
  if (field.startsWith("delete.")) return "删除或解除关联";
  return field;
}

const assistantMutationCoordinator = new MutationCommitCoordinator({
  artifactRepository: indexedDbMutationArtifactRepository,
  scope: "assistant",
  acceptLegacyUnscoped: true,
});

const activeAssistantRunIds = new Set<string>();

export function ModelsPanel({
  presets,
  onPresetsChange,
  onSavePresets,
  activeId,
  onActiveIdChange,
  frame,
  onFrameUsed,
}: Props) {
  const [editId, setEditId] = useState(activeId);
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState("");
  /** 提问时是否附上本机的人物库、关系与事务 */
  const [useData, setUseData] = useState(true);

  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [assistantTrace, setAssistantTrace] = useState<AgentTraceEvent[]>([]);
  const coordinatorRef = useRef(assistantMutationCoordinator);
  const [pendingProposals, setPendingProposals] = useState<MutationProposalEntry[]>(() =>
    assistantMutationCoordinator.pending(),
  );
  const [approvalRows, setApprovalRows] = useState<ArchiveMutationDiffRow[]>([]);
  const [latestReceipt, setLatestReceipt] = useState<MutationCommitReceipt | null>(
    () => assistantMutationCoordinator.committedReceipts().at(-1) ?? null,
  );
  const [latestAgentRun, setLatestAgentRun] = useState<AgentRun | null>(null);
  const [assistantMemory, setAssistantMemory] = useState<AssistantWorkingMemory | null>(null);
  const [suspendedRequest, setSuspendedRequest] = useState<SuspendedAssistantRequest | null>(null);
  const [assistantContextNotice, setAssistantContextNotice] = useState("");
  const [assistantCitations, setAssistantCitations] = useState<ArchiveCitation[]>([]);
  const [citationFeedback, setCitationFeedback] = useState<Record<string, "correct" | "incorrect">>(
    {},
  );
  const [approving, setApproving] = useState(false);
  const hydrationGeneration = useRef(0);
  const [testing, setTesting] = useState(false);
  const [auditing, setAuditing] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let cancelled = false;
    const hydrate = async () => {
      const generation = ++hydrationGeneration.current;
      const coordinator = coordinatorRef.current;
      let queue: MutationProposalEntry[] = [];
      let receipts: MutationCommitReceipt[] = [];
      let rows: ArchiveMutationDiffRow[] = [];
      try {
        const artifacts = await coordinator.hydrate();
        queue = artifacts.proposals;
        receipts = artifacts.receipts;
        if (queue.length) {
          const authorizationMode = new LocalAgentSettingsStore().load().authorizationMode;
          const proposalIds =
            authorizationMode === "cautious" ? [queue[0].id] : queue.map((entry) => entry.id);
          rows = (await coordinator.prepare({ proposalIds })).diff;
        }
      } catch {
        if (!cancelled) toast.error("无法恢复尚未签字的变更提案");
      }

      const runs = await indexedDbAgentRunLedger.listRuns({ threadId: ASSISTANT_THREAD_ID });
      const sessionRuns = [...runs].sort(
        (left, right) => right.ordinal - left.ordinal || right.createdAt - left.createdAt,
      );
      let restored: AssistantSessionState | undefined;
      let restoredRun = sessionRuns[0];
      for (const run of sessionRuns) {
        if (!run.latestCheckpointId) continue;
        const checkpoint = await indexedDbAgentRunLedger.getCheckpoint(run.latestCheckpointId);
        restored = parseAssistantSessionState(checkpoint?.state);
        if (restored) {
          restoredRun = run;
          break;
        }
      }
      const latestRun = restoredRun;
      const events = latestRun ? await indexedDbAgentRunLedger.listEvents(latestRun.id) : [];
      const receipt = restored?.latestReceiptId
        ? await indexedDbMutationArtifactRepository.getReceipt(restored.latestReceiptId)
        : receipts[0];
      if (cancelled || generation !== hydrationGeneration.current) return;
      setPendingProposals(queue);
      setApprovalRows(rows);
      setLatestReceipt(receipt ?? null);
      if (latestRun) {
        setLatestAgentRun(
          projectAgentRun(events, {
            id: latestRun.id,
            title: latestRun.title,
            agentName: latestRun.agentName,
            model: latestRun.providerRef.model,
            status: latestRun.status,
          }),
        );
      }
      if (restored) {
        const stillRunningHere =
          latestRun?.status === "running" && activeAssistantRunIds.has(restored.runId);
        setTurns(restored.turns);
        setUseData(restored.useData);
        setAssistantMemory(restored.workingMemory);
        setSuspendedRequest(stillRunningHere ? null : restored.suspendedRequest);
        setAssistantContextNotice(
          stillRunningHere ? "分析正在后台继续；完成后本页会自动更新。" : restored.contextNotice,
        );
        setAssistantCitations(restored.citations);
        setCitationFeedback(restored.citationFeedback);
      }
    };

    void hydrate().catch(() => {
      if (!cancelled) toast.error("无法恢复上次的本机 Agent 会话");
    });
    const unsubscribe = indexedDbAgentRunLedger.subscribe(() => {
      if (!busyRef.current) void hydrate();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const editing = presets.find((preset) => preset.id === editId) ?? presets[0];

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: "smooth" });
  }, [turns]);

  const patch = (changes: Partial<ProviderPreset>) => {
    onPresetsChange(
      presets.map((preset) => (preset.id === editing.id ? { ...preset, ...changes } : preset)),
    );
  };

  const addPreset = (kind: ProviderKind) => {
    const preset = createPreset(kind);
    onPresetsChange([...presets, preset]);
    setEditId(preset.id);
  };

  const handleSavePresets = () => {
    try {
      onSavePresets();
      toast.success(t("模型配置已保存到这个浏览器"));
    } catch {
      toast.error(t("浏览器无法保存模型配置"));
    }
  };

  const handleTest = async () => {
    setTesting(true);
    try {
      toast.success(await testConnection(editing));
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setTesting(false);
    }
  };

  const handleAudit = async () => {
    if (!editing.model.trim()) {
      toast.error(t("请先填写模型名称"));
      return;
    }
    setAuditing(true);
    try {
      const result = await auditVision(editing);
      patch({ visionVerified: result.ok, visionCheckedAt: Date.now() });
      if (result.ok) toast.success(`${t("这个模型确实能识别图片")}：${result.detail}`);
      else toast.error(`${t("这个模型读不了图片")}：${result.detail}`);
    } catch (error) {
      patch({ visionVerified: false, visionCheckedAt: Date.now() });
      toast.error((error as Error).message);
    } finally {
      setAuditing(false);
    }
  };

  const loadAssistantArchive = async (requested: boolean): Promise<AssistantArchive> => {
    const empty: AssistantArchive = {
      persons: [],
      relations: [],
      events: [],
      collections: [],
      collectionMemberships: [],
    };
    if (!requested) return empty;
    const [persons, relations, events, collections, collectionMemberships] = await Promise.all([
      facesDb.listPersons(),
      facesDb.listRelations(),
      facesDb.listLifeEvents(),
      facesDb.listCollections(),
      facesDb.listCollectionMemberships(),
    ]);
    return { persons, relations, events, collections, collectionMemberships };
  };

  const settleProposalRuns = async (input: {
    proposals: readonly MutationProposalEntry[];
    decision: "approved" | "rejected";
    receipt?: MutationCommitReceipt;
    currentState?: AssistantSessionState;
  }) => {
    const proposalIdsByRun = new Map<string, string[]>();
    input.proposals.forEach((proposal) => {
      if (!proposal.sourceRunId) return;
      const ids = proposalIdsByRun.get(proposal.sourceRunId) ?? [];
      ids.push(proposal.id);
      proposalIdsByRun.set(proposal.sourceRunId, ids);
    });
    if (!proposalIdsByRun.size) return;

    const archive = await loadAssistantArchive(true);
    const archiveVersion = assistantArchiveRevision(archive, assistantArchiveHasRecords(archive));
    const retainEventPayload = new LocalAgentSettingsStore().load().savePrivatePayload;
    const failures: string[] = [];

    for (const [runId, proposalIds] of proposalIdsByRun) {
      try {
        const run = await indexedDbAgentRunLedger.getRun(runId);
        if (!run || run.status !== "awaiting_approval") continue;
        const checkpoint = run.latestCheckpointId
          ? await indexedDbAgentRunLedger.getCheckpoint(run.latestCheckpointId)
          : undefined;
        const restored = parseAssistantSessionState(checkpoint?.state);
        const message =
          input.decision === "approved"
            ? `已签字执行 ${input.receipt?.operationIds.length ?? 0} 项变更并生成可撤销收据。后续提问会从更新后的档案重新读取。`
            : `已拒绝 ${proposalIds.length} 份提案，本机档案没有发生变化。`;
        const state: AssistantSessionState =
          input.currentState?.runId === runId
            ? input.currentState
            : {
                version: 1,
                runId,
                turns: [...(restored?.turns ?? []), { role: "assistant", text: message }],
                useData: restored?.useData ?? run.includeArchive,
                workingMemory:
                  input.decision === "approved" ? null : (restored?.workingMemory ?? null),
                suspendedRequest: null,
                contextNotice:
                  input.decision === "approved"
                    ? "档案已更新，上一版工具记忆已失效；下次会重新读取。"
                    : (restored?.contextNotice ?? ""),
                citations: restored?.citations ?? [],
                citationFeedback: restored?.citationFeedback ?? {},
                latestReceiptId: input.receipt?.id ?? restored?.latestReceiptId,
                updatedAt: Date.now(),
              };
        await continueDurableAgentRun({
          repository: indexedDbAgentRunLedger,
          runId,
          archiveVersion,
          retainEventPayload,
          ownerId: browserAgentRunOwnerId(),
          events: [
            {
              kind: "approval",
              status: input.decision === "approved" ? "succeeded" : "blocked",
              payload: { decision: input.decision, proposalIds, signer: "user" },
            },
            ...(input.decision === "approved" && input.receipt
              ? [
                  {
                    kind: "commit" as const,
                    status: "succeeded" as const,
                    payload: {
                      receiptId: input.receipt.id,
                      operationCount: input.receipt.operationIds.length,
                    },
                  },
                ]
              : []),
          ],
          settle: {
            status: "completed",
            state,
            checkpointKind: "safe_boundary",
            nextAction: "finalize",
            proposalRefs: proposalIds,
            receiptRefs: input.receipt ? [input.receipt.id] : [],
            resumable: false,
            dependencyRefs: [{ scope: "archive", version: archiveVersion }],
          },
        });
        if (input.currentState?.runId === runId) {
          const events = await indexedDbAgentRunLedger.listEvents(runId);
          setLatestAgentRun(
            projectAgentRun(events, {
              id: run.id,
              title: run.title,
              agentName: run.agentName,
              model: run.providerRef.model,
              status: "completed",
            }),
          );
        }
      } catch (error) {
        failures.push((error as Error).message);
      }
    }
    if (failures.length) {
      throw new Error(`有 ${failures.length} 条执行记录未能收口：${failures[0]}`);
    }
  };

  const applyAssistantResult = async (
    result: AssistantAgentResult,
    request: {
      displayTurns: ChatTurn[];
      presetId: string;
      history: ChatTurn[];
      image: string | null;
      includeArchive: boolean;
    },
  ) => {
    const nextTurns = [...request.displayTurns];
    const last = nextTurns[nextTurns.length - 1];
    nextTurns[nextTurns.length - 1] = {
      ...last,
      text: assistantAdviceWithoutEvidence(result.answer, result.citations),
    };
    const notices = [
      result.reusedToolResults > 0 ? `已复用 ${result.reusedToolResults} 条上一轮工具结果。` : "",
      result.historyCompression.omittedTurns > 0
        ? `较早 ${result.historyCompression.omittedTurns} 条对话已压缩为可见摘要。`
        : "",
      result.workingMemory.entries.length > 0
        ? `已保留 ${result.workingMemory.entries.length} 条工具记忆供下轮使用。`
        : "",
    ].filter(Boolean);
    let nextContextNotice = notices.join(" ");
    let nextMemory: AssistantWorkingMemory | null = result.workingMemory;
    let nextSuspendedRequest: SuspendedAssistantRequest | null = result.checkpoint
      ? {
          checkpoint: result.checkpoint,
          presetId: request.presetId,
          history: request.history,
          image: request.image,
          includeArchive: request.includeArchive,
        }
      : null;
    let nextReceipt = latestReceipt;
    let status: "completed" | "suspended" | "awaiting_approval" = result.status;
    const proposalRefs: string[] = [];
    const receiptRefs: string[] = [];
    if (result.pendingApproval) {
      const coordinator = coordinatorRef.current;
      const authorizationMode = new LocalAgentSettingsStore().load().authorizationMode;
      const submitted = await coordinator.submitProposal(result.pendingApproval, {
        authorizationMode,
        sourceRunId: result.run.id,
      });
      proposalRefs.push(submitted.proposal.id);
      if (submitted.status === "committed") {
        nextReceipt = submitted.receipt;
        receiptRefs.push(submitted.receipt.id);
        nextMemory = null;
        nextSuspendedRequest = null;
        nextContextNotice = "档案已更新，上一版工具记忆已失效；下次会重新读取。";
        status = "completed";
      } else {
        status = "awaiting_approval";
      }
      const queue = coordinator.pending();
      let nextRows: ArchiveMutationDiffRow[] = [];
      if (queue.length) {
        const selectedIds =
          authorizationMode === "cautious" ? [queue[0].id] : queue.map((entry) => entry.id);
        nextRows = (await coordinator.prepare({ proposalIds: selectedIds })).diff;
      }
      setApprovalRows(nextRows);
      setPendingProposals(queue);
    }
    setLatestAgentRun({ ...result.run, status });
    setAssistantMemory(nextMemory);
    setAssistantCitations(result.citations);
    setCitationFeedback({});
    setAssistantContextNotice(nextContextNotice);
    setTurns(nextTurns);
    setLatestReceipt(nextReceipt);
    setSuspendedRequest(nextSuspendedRequest);
    const state: AssistantSessionState = {
      version: 1,
      runId: result.run.id,
      turns: nextTurns,
      useData: request.includeArchive,
      workingMemory: nextMemory,
      suspendedRequest: nextSuspendedRequest,
      contextNotice: nextContextNotice,
      citations: result.citations,
      citationFeedback: {},
      latestReceiptId: nextReceipt?.id,
      updatedAt: Date.now(),
    };
    return { state, status, proposalRefs, receiptRefs };
  };

  const runAssistantRequest = async (request: {
    preset: ProviderPreset;
    prompt: string;
    history: ChatTurn[];
    image: string | null;
    includeArchive: boolean;
    displayTurns: ChatTurn[];
    resumeFrom?: AssistantAgentCheckpoint;
    onStarted?: (runId: string) => void;
  }) => {
    const archive = await loadAssistantArchive(request.includeArchive);
    const includeArchive = request.includeArchive && assistantArchiveHasRecords(archive);
    const archiveVersion = assistantArchiveRevision(archive, includeArchive);
    const budget = resolveSavedAgentBudget("standard");
    const retainEventPayload = new LocalAgentSettingsStore().load().savePrivatePayload;
    const runAbort = new AbortController();
    let persistenceFailure: unknown;
    let initialCheckpoint = request.resumeFrom;
    let initialState: AssistantSessionState | undefined;
    const sessionAt = (runId: string, checkpoint: AssistantAgentCheckpoint) =>
      ({
        version: 1,
        runId,
        turns: request.displayTurns,
        useData: includeArchive,
        workingMemory: {
          version: 1,
          archiveVersion,
          entries: checkpoint.toolHistory,
        },
        suspendedRequest: {
          checkpoint,
          presetId: request.preset.id,
          history: request.history,
          image: request.image,
          includeArchive,
        },
        contextNotice: "运行已保存；离开页面后仍可回来查看，刷新后可从当前断点继续。",
        citations: [],
        citationFeedback: {},
        latestReceiptId: latestReceipt?.id,
        updatedAt: Date.now(),
      }) satisfies AssistantSessionState;
    const durable: DurableAgentRunRecorder = await beginDurableAgentRun({
      repository: indexedDbAgentRunLedger,
      threadId: ASSISTANT_THREAD_ID,
      agentName: "assistant",
      entrypoint: "models.ask",
      title: "问一问",
      request: {
        questionCharacters: request.prompt.length,
        historyTurns: request.history.length,
        imageAttached: Boolean(request.image),
      },
      providerRef: {
        presetId: request.preset.id,
        kind: request.preset.kind,
        model: request.preset.model,
        configFingerprint: assistantProviderFingerprint(request.preset),
      },
      includeArchive,
      budget,
      archiveVersion,
      resumeRunId: request.resumeFrom?.sourceRunId,
      resumeMode: request.resumeFrom ? "model" : undefined,
      initialCheckpoint: request.resumeFrom
        ? undefined
        : (runId) => {
            initialCheckpoint = createInitialAssistantCheckpoint({
              question: request.prompt,
              includeArchive,
              archiveVersion,
              maxRounds: budget.maxRounds,
              runId,
              archive,
              workingMemory: assistantMemory,
            });
            initialState = sessionAt(runId, initialCheckpoint);
            return {
              kind: "awaiting_model",
              status: "active",
              nextAction: { kind: "invoke_model" },
              state: initialState,
              observationIds: [],
              dependencyRefs: [{ scope: "archive", version: archiveVersion }],
              budget: {
                rounds: 0,
                toolCalls: 0,
                inputTokens: { total: 0, actual: 0, estimated: 0 },
                outputTokens: { total: 0, actual: 0, estimated: 0 },
              },
            };
          },
      retainEventPayload,
      ownerId: browserAgentRunOwnerId(),
      onPersistenceError: (error) => {
        persistenceFailure ??= error;
        runAbort.abort(error);
      },
    });

    if (!initialCheckpoint) throw new Error("未能建立回答断点");
    const activeInitialState = initialState ?? sessionAt(durable.runId, initialCheckpoint);
    if (request.resumeFrom) {
      await durable.checkpoint({
        state: activeInitialState,
        checkpointKind: "awaiting_model",
        nextAction: "invoke_model",
        resumable: true,
        dependencyRefs: [{ scope: "archive", version: archiveVersion }],
      });
    }
    activeAssistantRunIds.add(durable.runId);
    request.onStarted?.(durable.runId);

    try {
      const result = await runAssistantAgent({
        preset: request.preset,
        question: request.prompt,
        ...archive,
        includeArchive,
        history: request.history,
        image: request.image,
        workingMemory: request.resumeFrom ? null : assistantMemory,
        resumeFrom: request.resumeFrom,
        referenceNamespace: ASSISTANT_THREAD_ID,
        budget,
        recorder: durable,
        signal: runAbort.signal,
        onCheckpoint: async (checkpoint) => {
          const checkpointState: AssistantSessionState = {
            ...activeInitialState,
            workingMemory: {
              version: 1,
              archiveVersion,
              entries: checkpoint.toolHistory,
            },
            suspendedRequest: {
              ...activeInitialState.suspendedRequest!,
              checkpoint,
            },
            updatedAt: Date.now(),
          };
          await durable.checkpoint({
            state: checkpointState,
            checkpointKind: "awaiting_model",
            nextAction: "invoke_model",
            resumable: true,
            dependencyRefs: [{ scope: "archive", version: archiveVersion }],
          });
        },
        onTrace: (event) => setAssistantTrace((prev) => [...prev.slice(-23), event]),
      });
      const applied = await applyAssistantResult(result, {
        displayTurns: request.displayTurns,
        presetId: request.preset.id,
        history: request.history,
        image: request.image,
        includeArchive,
      });
      try {
        await durable.settle({
          status: applied.status,
          state: applied.state,
          checkpointKind:
            applied.status === "suspended"
              ? "awaiting_model"
              : applied.status === "awaiting_approval"
                ? "awaiting_approval"
                : "safe_boundary",
          nextAction:
            applied.status === "suspended"
              ? "invoke_model"
              : applied.status === "awaiting_approval"
                ? "await_approval"
                : "finalize",
          proposalRefs: applied.proposalRefs,
          receiptRefs: applied.receiptRefs,
          resumable: applied.status === "suspended",
          dependencyRefs: [{ scope: "archive", version: archiveVersion }],
        });
      } catch {
        toast.error("回答已经完成，但本机执行记录没有完整保存");
      }
      return;
    } catch (caught) {
      const error = persistenceFailure ?? caught;
      durable.record({
        kind: "finalize",
        status: "failed",
        payload: { reason: request.resumeFrom ? "resume_failed" : "failed" },
      });
      const failedTurns = [...request.displayTurns];
      const last = failedTurns[failedTurns.length - 1];
      failedTurns[failedTurns.length - 1] = {
        ...last,
        text: request.resumeFrom
          ? `继续运行失败，先前工具结果仍保留：${(error as Error).message}`
          : t("请求失败"),
      };
      const state: AssistantSessionState = {
        version: 1,
        runId: durable.runId,
        turns: failedTurns,
        useData: includeArchive,
        workingMemory: assistantMemory,
        suspendedRequest: null,
        contextNotice: request.resumeFrom
          ? "这次断点已经结束；旧工具结果仍在运行记录中，请将问题作为新问题发送。"
          : "",
        citations: assistantCitations,
        citationFeedback,
        latestReceiptId: latestReceipt?.id,
        updatedAt: Date.now(),
      };
      try {
        await durable.settle({
          status: "failed",
          state,
          checkpointKind: "safe_boundary",
          nextAction: "finalize",
          resumable: false,
          dependencyRefs: [{ scope: "archive", version: archiveVersion }],
        });
      } catch {
        // Preserve the original Agent error; it is the actionable failure.
      }
      setTurns(failedTurns);
      throw error;
    } finally {
      activeAssistantRunIds.delete(durable.runId);
    }
  };

  const handleSend = async () => {
    const prompt = input.trim();
    if (!prompt || busyRef.current) return;
    const preset = editing;
    if (!preset.model.trim()) {
      toast.error(t("请先填写模型名称"));
      return;
    }
    const sentFrame = frame;
    const history = turns;
    const displayTurns: ChatTurn[] = [
      ...history,
      { role: "user", text: prompt, image: sentFrame ?? undefined },
      { role: "assistant", text: "" },
    ];
    let started = false;
    busyRef.current = true;
    setBusy(true);
    setAssistantTrace([]);
    try {
      await runAssistantRequest({
        preset,
        prompt,
        history,
        image: sentFrame,
        includeArchive: useData,
        displayTurns,
        onStarted: () => {
          started = true;
          setTurns(displayTurns);
          setSuspendedRequest(null);
          setAssistantCitations([]);
          setCitationFeedback({});
          setInput("");
          if (sentFrame) onFrameUsed();
        },
      });
    } catch (error) {
      toast.error((error as Error).message);
      setAssistantTrace((prev) => [
        ...prev.slice(-23),
        { kind: "error", text: (error as Error).message || t("请求失败") },
      ]);
      if (started) {
        setTurns((prev) => {
          const next = [...prev];
          const last = next[next.length - 1];
          next[next.length - 1] = { ...last, text: t("请求失败") };
          return next;
        });
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const citationKey = (citation: ArchiveCitation) =>
    `${citation.kind}:${citation.sourceRef}:${citation.field ?? ""}:${citation.quote}`;

  const confirmCitation = (citation: ArchiveCitation) => {
    setCitationFeedback((current) => ({ ...current, [citationKey(citation)]: "correct" }));
    toast.success("已标记为核对无误");
  };

  const startCitationCorrection = (citation: ArchiveCitation) => {
    setCitationFeedback((current) => ({ ...current, [citationKey(citation)]: "incorrect" }));
    setInput(
      `档案依据“${citation.claim}”（字段：${citation.field ?? "未指定"}）不正确。请根据我补充的正确内容生成待批准修改提案。正确内容：`,
    );
    requestAnimationFrame(() => inputRef.current?.focus());
    toast.info("已定位对应档案记录；补充正确内容后发送，即进入修改提案流程");
  };

  const resumeAssistant = async () => {
    if (!suspendedRequest || busyRef.current) return;
    const resumeRequest = suspendedRequest;
    const preset = presets.find((candidate) => candidate.id === resumeRequest.presetId);
    if (!preset) {
      toast.error("原模型配置已删除；请重新发送这个问题");
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setSuspendedRequest(null);
    setAssistantTrace([]);
    const displayTurns = [...turns];
    const last = displayTurns[displayTurns.length - 1];
    displayTurns[displayTurns.length - 1] = {
      ...last,
      text: `正在从第 ${resumeRequest.checkpoint.nextRound} 轮继续…`,
    };
    setTurns(displayTurns);
    try {
      await runAssistantRequest({
        preset,
        prompt: resumeRequest.checkpoint.question,
        history: resumeRequest.history,
        image: resumeRequest.image,
        includeArchive: resumeRequest.includeArchive,
        displayTurns,
        resumeFrom: resumeRequest.checkpoint,
      });
    } catch (error) {
      const message = (error as Error).message;
      const storedRun = await indexedDbAgentRunLedger
        .getRun(resumeRequest.checkpoint.sourceRunId)
        .catch(() => undefined);
      let canRetry = Boolean(storedRun?.status === "suspended" && storedRun.resumable);
      const failedTurns = [...displayTurns];
      const lastTurn = failedTurns[failedTurns.length - 1];
      if (error instanceof DurableRunResumeError) {
        canRetry = false;
        failedTurns[failedTurns.length - 1] = {
          ...lastTurn,
          text: `${message} 你可以直接重新发送原问题。`,
        };
        const archive = await loadAssistantArchive(resumeRequest.includeArchive);
        const includeArchive = resumeRequest.includeArchive && assistantArchiveHasRecords(archive);
        const archiveVersion = assistantArchiveRevision(archive, includeArchive);
        const retiredState: AssistantSessionState = {
          version: 1,
          runId: resumeRequest.checkpoint.sourceRunId,
          turns: failedTurns,
          useData: includeArchive,
          workingMemory: null,
          suspendedRequest: null,
          contextNotice: "旧断点已经失效；重新发送时会按当前档案和模型配置执行。",
          citations: assistantCitations,
          citationFeedback,
          latestReceiptId: latestReceipt?.id,
          updatedAt: Date.now(),
        };
        await cancelDurableAgentRun({
          repository: indexedDbAgentRunLedger,
          runId: resumeRequest.checkpoint.sourceRunId,
          archiveVersion,
          state: retiredState,
          reason: error.code.toLowerCase(),
          ownerId: browserAgentRunOwnerId(),
        }).catch(() => undefined);
      } else {
        failedTurns[failedTurns.length - 1] = {
          ...lastTurn,
          text: canRetry
            ? `继续暂时失败，先前工具结果仍保留：${message}`
            : `继续运行已结束：${message} 请将问题重新发送。`,
        };
      }
      setSuspendedRequest(canRetry ? resumeRequest : null);
      toast.error(message);
      setTurns(failedTurns);
      setAssistantTrace((prev) => [
        ...prev.slice(-23),
        { kind: "error", text: message || t("请求失败") },
      ]);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const approveUpdate = async () => {
    if (!pendingProposals.length || !approvalRows.length || approving) return;
    busyRef.current = true;
    setApproving(true);
    try {
      const coordinator = coordinatorRef.current;
      const authorizationMode = new LocalAgentSettingsStore().load().authorizationMode;
      const selectedProposals =
        authorizationMode === "cautious" ? [pendingProposals[0]] : pendingProposals;
      const proposalIds = selectedProposals.map((entry) => entry.id);
      const receipt = await coordinator.commit({
        authorizationMode,
        proposalIds,
        signature: { signer: "user", signedAt: Date.now() },
      });
      const decisionText = `已签字执行 ${receipt.operationIds.length} 项变更并生成可撤销收据。后续提问会从更新后的档案重新读取。`;
      const nextTurns: ChatTurn[] = [...turns, { role: "assistant", text: decisionText }];
      const currentRunId =
        selectedProposals.find((entry) => entry.sourceRunId === latestAgentRun?.id)?.sourceRunId ??
        [...selectedProposals].reverse().find((entry) => entry.sourceRunId)?.sourceRunId ??
        latestAgentRun?.id ??
        "";
      const currentState: AssistantSessionState = {
        version: 1,
        runId: currentRunId,
        turns: nextTurns,
        useData,
        workingMemory: null,
        suspendedRequest: null,
        contextNotice: "档案已更新，上一版工具记忆已失效；下次会重新读取。",
        citations: assistantCitations,
        citationFeedback,
        latestReceiptId: receipt.id,
        updatedAt: Date.now(),
      };
      setLatestReceipt(receipt);
      setAssistantMemory(null);
      setSuspendedRequest(null);
      setAssistantContextNotice(currentState.contextNotice);
      toast.success(t(`已原子执行 ${receipt.operationIds.length} 项档案变更`));
      setTurns(nextTurns);
      const queue = coordinator.pending();
      let nextRows: ArchiveMutationDiffRow[] = [];
      if (queue.length) {
        const nextIds =
          authorizationMode === "cautious" ? [queue[0].id] : queue.map((entry) => entry.id);
        nextRows = (await coordinator.prepare({ proposalIds: nextIds })).diff;
      }
      setApprovalRows(nextRows);
      setPendingProposals(queue);
      try {
        await settleProposalRuns({
          proposals: selectedProposals,
          decision: "approved",
          receipt,
          currentState,
        });
      } catch (error) {
        toast.error(`档案已经更新，但执行记录没有完整收口：${(error as Error).message}`);
      }
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      busyRef.current = false;
      setApproving(false);
    }
  };

  const rejectUpdate = async () => {
    if (!pendingProposals.length || approving) return;
    busyRef.current = true;
    setApproving(true);
    try {
      const coordinator = coordinatorRef.current;
      const authorizationMode = new LocalAgentSettingsStore().load().authorizationMode;
      const rejected = authorizationMode === "cautious" ? [pendingProposals[0]] : pendingProposals;
      coordinator.discard(rejected.map((entry) => entry.id));
      await coordinator.flushPersistence();
      const decisionText = `已拒绝 ${rejected.length} 份提案，本机档案没有发生变化。`;
      const nextTurns: ChatTurn[] = [...turns, { role: "assistant", text: decisionText }];
      const currentRunId =
        rejected.find((entry) => entry.sourceRunId === latestAgentRun?.id)?.sourceRunId ??
        [...rejected].reverse().find((entry) => entry.sourceRunId)?.sourceRunId ??
        latestAgentRun?.id ??
        "";
      const currentState: AssistantSessionState = {
        version: 1,
        runId: currentRunId,
        turns: nextTurns,
        useData,
        workingMemory: assistantMemory,
        suspendedRequest: null,
        contextNotice: assistantContextNotice,
        citations: assistantCitations,
        citationFeedback,
        latestReceiptId: latestReceipt?.id,
        updatedAt: Date.now(),
      };
      setTurns(nextTurns);
      const queue = coordinator.pending();
      let nextRows: ArchiveMutationDiffRow[] = [];
      if (queue.length) {
        const nextIds =
          authorizationMode === "cautious" ? [queue[0].id] : queue.map((entry) => entry.id);
        nextRows = (await coordinator.prepare({ proposalIds: nextIds })).diff;
      }
      setPendingProposals(queue);
      setApprovalRows(nextRows);
      try {
        await settleProposalRuns({
          proposals: rejected,
          decision: "rejected",
          currentState,
        });
      } catch (error) {
        toast.error(`提案已拒绝，但执行记录没有完整收口：${(error as Error).message}`);
      }
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      busyRef.current = false;
      setApproving(false);
    }
  };

  const undoLatestReceipt = async () => {
    if (!latestReceipt || latestReceipt.undoneAt) return;
    busyRef.current = true;
    try {
      const receipt = await coordinatorRef.current.undo(latestReceipt.id);
      setLatestReceipt(receipt);
      setAssistantMemory(null);
      setSuspendedRequest(null);
      setAssistantContextNotice("档案已撤销到上一版本，工具记忆已清空。");
      toast.success("已按收据恢复到提交前的完整档案");
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      busyRef.current = false;
    }
  };

  return (
    <div className="min-w-0 space-y-6">
      {/* 配置编辑 */}
      <div
        className="rounded-2xl border border-border bg-card/40 p-4"
        data-testid="model-config-panel"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm font-medium">{t("模型配置")}</span>
          <div className="flex flex-wrap gap-1.5">
            {(["openai", "gemini", "ollama"] as ProviderKind[]).map((kind) => (
              <Button key={kind} size="sm" variant="outline" onClick={() => addPreset(kind)}>
                <Plus className="size-3.5" aria-hidden="true" />
                {KIND_LABEL[kind].split("（")[0]}
              </Button>
            ))}
          </div>
        </div>

        {/* 配置列表：点一下切换编辑并设为使用中，右侧可直接删除 */}
        <div className="mt-3 space-y-1.5">
          {presets.map((item) => (
            <div
              key={item.id}
              data-provider-preset-id={item.id}
              className={cn(
                "flex items-center gap-2 rounded-lg border px-2.5 py-2 text-sm transition-colors",
                item.id === editing.id
                  ? "border-primary bg-accent/50"
                  : "border-border hover:bg-accent/30",
              )}
            >
              <button
                type="button"
                className="min-w-0 flex-1 truncate text-left"
                onClick={() => {
                  setEditId(item.id);
                  onActiveIdChange(item.id);
                }}
              >
                <span className="truncate font-medium">{item.name || t("未命名")}</span>
                {(item.name.trim() !== KIND_LABEL[item.kind].split("（")[0] || item.model) && (
                  <span className="ml-1.5 text-[11px] text-muted-foreground">
                    {item.name.trim() !== KIND_LABEL[item.kind].split("（")[0]
                      ? KIND_LABEL[item.kind].split("（")[0]
                      : ""}
                    {item.model ? ` · ${item.model}` : ""}
                  </span>
                )}
              </button>
              {item.id === activeId && (
                <span className="shrink-0 rounded-full bg-primary/15 px-2 py-0.5 text-[10px] text-primary">
                  {t("使用中")}
                </span>
              )}
              <Button
                size="icon"
                variant="ghost"
                className="size-7 shrink-0"
                aria-label={t("删除")}
                onClick={() => {
                  if (presets.length <= 1) {
                    toast.error(t("至少保留一套配置"));
                    return;
                  }
                  const rest = presets.filter((preset) => preset.id !== item.id);
                  onPresetsChange(rest);
                  if (editing.id === item.id) setEditId(rest[0].id);
                  if (activeId === item.id) onActiveIdChange(rest[0].id);
                }}
              >
                <Trash2 className="size-3.5" aria-hidden="true" />
              </Button>
            </div>
          ))}
        </div>

        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <div className="space-y-1.5">
            <Label className="text-xs">{t("名称")}</Label>
            <Input value={editing.name} onChange={(e) => patch({ name: e.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">{t("模型")}</Label>
            <Input
              value={editing.model}
              placeholder={
                editing.kind === "ollama"
                  ? "llava / qwen2.5vl"
                  : editing.kind === "gemini"
                    ? "gemini-3.7-flash"
                    : "gpt-4o-mini / deepseek-v4-flash"
              }
              onChange={(e) => patch({ model: e.target.value, visionVerified: false })}
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">{t("接口地址")}</Label>
            <Input
              value={editing.baseUrl}
              placeholder={
                editing.kind === "gemini"
                  ? "https://generativelanguage.googleapis.com/v1beta/openai"
                  : editing.kind === "ollama"
                    ? "http://localhost:11434"
                    : "https://api.deepseek.com/v1"
              }
              onChange={(e) => patch({ baseUrl: e.target.value, visionVerified: false })}
            />
          </div>
          {editing.kind !== "ollama" && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <Label className="text-xs">{t("API Key")}</Label>
                {editing.apiKey && (
                  <button
                    type="button"
                    className="text-[11px] text-destructive underline-offset-2 hover:underline"
                    onClick={() => patch({ apiKey: "" })}
                  >
                    {t("清除密钥")}
                  </button>
                )}
              </div>
              <Input
                type="password"
                value={editing.apiKey}
                autoComplete="off"
                aria-describedby="api-key-storage-note"
                onChange={(e) => patch({ apiKey: e.target.value })}
              />
              <p id="api-key-storage-note" className="text-[11px] text-muted-foreground">
                {t("未保存的密钥只在当前会话使用；点击“保存模型配置”后会保存在这个浏览器。")}
              </p>
            </div>
          )}
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={handleSavePresets}>
            <Save className="size-3.5" aria-hidden="true" />
            {t("保存模型配置")}
          </Button>
          <Button size="sm" variant="outline" onClick={handleTest} disabled={testing}>
            {testing ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <Plug className="size-3.5" aria-hidden="true" />
            )}
            {t("测试连接")}
          </Button>
          <Button size="sm" variant="outline" onClick={handleAudit} disabled={auditing}>
            {auditing ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <Eye className="size-3.5" aria-hidden="true" />
            )}
            {t("审查看图能力")}
          </Button>
          {editing.kind === "openai" && (
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={Boolean(editing.audioCapable)}
                onChange={(e) => patch({ audioCapable: e.target.checked })}
              />
              {t("支持语音转写")}
            </label>
          )}
        </div>

        <div className="mt-3 space-y-1.5 text-[11px]">
          <p
            className={cn(
              "flex items-center gap-1.5",
              supportsVision(editing) ? "text-primary" : "text-destructive",
            )}
          >
            {supportsVision(editing) ? (
              <CheckCircle2 className="size-3.5" aria-hidden="true" />
            ) : (
              <TriangleAlert className="size-3.5" aria-hidden="true" />
            )}
            {supportsVision(editing)
              ? t("看图能力已验证，可用于图片分析")
              : t("未验证看图能力，图片任务会被拦截")}
          </p>
          <p
            className={cn(
              "flex items-center gap-1.5",
              supportsAudio(editing) ? "text-primary" : "text-muted-foreground",
            )}
          >
            <Mic className="size-3.5" aria-hidden="true" />
            {supportsAudio(editing) ? t("可用于语音转写") : t("不支持语音转写，录音任务会被拦截")}
          </p>
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
          {t("当前选中的配置用于文字整理和图片任务；录音需使用支持语音转写的 OpenAI 兼容接口。")}
          {editing.visionCheckedAt
            ? ` ${t("上次审查")}：${new Date(editing.visionCheckedAt).toLocaleString()}`
            : ""}
        </p>
      </div>

      <AgentControlCenter latestRun={latestAgentRun} />

      {/* 问一问：可带上本机资料做人际建议 */}
      <div className="rounded-2xl border border-border bg-card/40 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm font-medium">{t("问一问")}</span>
          <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <input
              type="checkbox"
              checked={useData}
              onChange={(event) => setUseData(event.target.checked)}
              className="size-3.5 accent-[hsl(var(--primary))]"
            />
            {t("带上我的人物库")}
          </label>
        </div>

        {frame && (
          <img
            src={frame}
            alt={t("待提问的画面")}
            className="mt-3 max-h-40 rounded-lg border border-border object-contain"
          />
        )}

        <div ref={logRef} className="mt-3 max-h-72 space-y-2 overflow-y-auto">
          {turns.map((turn, index) => (
            <div
              key={index}
              className={cn(
                "rounded-lg px-3 py-2 text-sm whitespace-pre-wrap",
                turn.role === "user" ? "bg-accent/60" : "bg-muted/50",
              )}
            >
              {turn.text || "…"}
            </div>
          ))}
        </div>

        {assistantContextNotice && (
          <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground" role="status">
            {assistantContextNotice}
          </p>
        )}

        {assistantCitations.length > 0 && (
          <section
            className="mt-3 space-y-2 rounded-xl border border-primary/30 bg-primary/5 p-3"
            aria-label="可核验档案依据"
          >
            <p className="text-xs font-semibold">档案依据（本地生成，可逐条核对）</p>
            {assistantCitations.map((citation) => {
              const feedback = citationFeedback[citationKey(citation)];
              return (
                <article
                  key={citationKey(citation)}
                  className="rounded-lg border border-border bg-background/70 p-2.5 text-xs"
                >
                  <p className="font-medium text-foreground">{citation.claim}</p>
                  <p className="mt-1 break-all text-[11px] text-muted-foreground">
                    {citation.sourceRef} · 原记录：“{citation.quote}”
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant={feedback === "correct" ? "default" : "outline"}
                      className="h-7 text-[11px]"
                      onClick={() => confirmCitation(citation)}
                    >
                      <Check className="size-3.5" aria-hidden="true" />
                      {feedback === "correct" ? "已确认" : "正确"}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant={feedback === "incorrect" ? "destructive" : "outline"}
                      className="h-7 text-[11px]"
                      onClick={() => startCitationCorrection(citation)}
                    >
                      <X className="size-3.5" aria-hidden="true" />
                      不正确，发起更正
                    </Button>
                  </div>
                </article>
              );
            })}
          </section>
        )}

        {suspendedRequest && (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-500/50 bg-amber-500/10 p-3 text-xs">
            <span>
              上游服务暂时不可用；前 {suspendedRequest.checkpoint.nextRound - 1}{" "}
              轮与工具结果已保留。
            </span>
            <Button type="button" size="sm" onClick={() => void resumeAssistant()} disabled={busy}>
              {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : null}
              从第 {suspendedRequest.checkpoint.nextRound} 轮继续
            </Button>
          </div>
        )}

        {assistantTrace.length > 0 && (
          <div className="mt-2">
            <ReasoningDisclosure
              label={t("问答轨迹")}
              current={assistantTrace.at(-1)?.text ?? t("正在准备回答")}
              steps={assistantTrace.length}
              running={busy}
              events={assistantTrace}
              stepLabel={t("步")}
            />
          </div>
        )}

        {pendingProposals.length > 0 && (
          <div
            className="mt-3 rounded-xl border border-amber-500/60 bg-amber-500/10 p-3"
            role="region"
            aria-label={t("待批准的批量档案修改")}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-medium">
                  {t("待签字的档案提案队列")} · {pendingProposals.length} 份
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {pendingProposals.map((entry) => entry.plan.title).join("；")}
                </p>
              </div>
              <span className="shrink-0 rounded-full border border-amber-500/50 px-2 py-0.5 text-[10px] text-amber-600 dark:text-amber-300">
                {t("尚未写入")}
              </span>
            </div>
            <dl className="mt-3 space-y-2 text-xs">
              {approvalRows.length === 0 && (
                <div className="rounded-lg bg-background/60 p-2.5 text-muted-foreground">
                  {t("正在生成可核对的变更差异…")}
                </div>
              )}
              {approvalRows.map((row) => (
                <div
                  key={`${row.operationId}:${row.targetId}:${row.field}`}
                  className="min-w-0 rounded-lg bg-background/60 p-2.5"
                >
                  <dt className="flex min-w-0 flex-wrap items-center gap-1.5">
                    <span className="break-words font-semibold text-foreground">
                      {row.targetLabel}
                    </span>
                    <span className="rounded-full border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
                      {mutationFieldLabel(row.field)}
                    </span>
                  </dt>
                  <div className="mt-2 grid min-w-0 gap-2 sm:grid-cols-2">
                    <dd className="min-w-0 rounded-md border border-border/70 px-2 py-1.5 text-muted-foreground">
                      <span className="mb-0.5 block text-[10px] no-underline">{t("变更前")}</span>
                      <span className="block whitespace-pre-wrap break-words line-through">
                        {row.before}
                      </span>
                    </dd>
                    <dd
                      className={cn(
                        "min-w-0 rounded-md border border-border/70 px-2 py-1.5",
                        row.destructive ? "text-destructive" : "text-foreground",
                      )}
                    >
                      <span className="mb-0.5 block text-[10px] text-muted-foreground">
                        {t("变更后")}
                      </span>
                      <span className="block whitespace-pre-wrap break-words">{row.after}</span>
                    </dd>
                  </div>
                </div>
              ))}
            </dl>
            <p className="mt-2 text-[11px] text-muted-foreground">
              {t("批准前不会写入本机档案；数据若已被其他操作修改，本提案会自动失效。")}
            </p>
            <div className="mt-3 flex justify-end gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => void rejectUpdate()}
                disabled={approving}
              >
                <X className="size-3.5" aria-hidden="true" />
                {t("拒绝")}
              </Button>
              <Button
                size="sm"
                onClick={() => void approveUpdate()}
                disabled={approving || approvalRows.length === 0}
              >
                {approving ? (
                  <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <Check className="size-3.5" aria-hidden="true" />
                )}
                {t(
                  `签字并原子执行（${pendingProposals.reduce((sum, entry) => sum + entry.plan.operations.length, 0)} 项）`,
                )}
              </Button>
            </div>
          </div>
        )}

        {latestReceipt && (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-emerald-500/40 bg-emerald-500/5 p-3 text-xs">
            <span>
              变更收据 · {latestReceipt.operationIds.length} 项 ·
              {new Date(latestReceipt.committedAt).toLocaleTimeString()}
            </span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={Boolean(latestReceipt.undoneAt)}
              onClick={() => void undoLatestReceipt()}
            >
              {latestReceipt.undoneAt ? "已撤销" : "整批撤销"}
            </Button>
          </div>
        )}

        <div className="mt-3 flex gap-2">
          <Textarea
            ref={inputRef}
            value={input}
            rows={2}
            placeholder={t("问点什么，比如：这周该联系谁？")}
            onChange={(e) => setInput(e.target.value)}
          />
          <Button onClick={handleSend} disabled={busy} aria-label={t("发送问题")}>
            {busy ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <Send className="size-4" aria-hidden="true" />
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
