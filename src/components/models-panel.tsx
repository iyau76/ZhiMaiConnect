import {
  Check,
  CheckCircle2,
  Eye,
  Loader2,
  Mic,
  Plug,
  Plus,
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  runAssistantAgent,
  type AssistantAgentCheckpoint,
  type AssistantAgentResult,
  type AssistantWorkingMemory,
} from "@/lib/assistant-agent";
import type { AgentRun } from "@/lib/agent-run-log";
import type { ArchiveCitation } from "@/lib/agent-output-grounding";
import type { ArchiveMutationDiffRow } from "@/lib/archive-mutation-plan";
import { LocalAgentSettingsStore } from "@/lib/agent-settings";
import { facesDb } from "@/lib/face-db";
import { t } from "@/lib/i18n";
import {
  MutationCommitCoordinator,
  type MutationCommitReceipt,
  type MutationProposalEntry,
} from "@/lib/mutation-commit-coordinator";
import type { AgentTraceEvent } from "@/lib/recommendation-agent";

import { cn } from "@/lib/utils";
import { auditVision, testConnection } from "@/lib/vision-client";
import {
  KIND_LABEL,
  LOVABLE_MODELS,
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
  activeId: string;
  onActiveIdChange: (id: string) => void;
  frame: string | null;
  onFrameUsed: () => void;
}

type AssistantArchive = Pick<
  Parameters<typeof runAssistantAgent>[0],
  "persons" | "relations" | "events" | "collections" | "collectionMemberships"
>;

interface SuspendedAssistantRequest {
  checkpoint: AssistantAgentCheckpoint;
  preset: ProviderPreset;
  history: ChatTurn[];
  image: string | null;
  includeArchive: boolean;
}

function assistantAdviceWithoutEvidence(answer: string, citations: ArchiveCitation[]) {
  if (!citations.length) return answer;
  const sections = answer.split("\n\n");
  const withoutEvidence = sections
    .filter((section) => !section.startsWith("档案依据（可回查）"))
    .join("\n\n")
    .trim();
  return withoutEvidence || "已找到以下可核验档案依据。";
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

// The panel is conditionally mounted by the workspace navigation. Keep the
// in-flight proposal queue and receipts at module scope so a page switch does
// not silently discard a user's unsigned Agent work.
const assistantMutationCoordinator = new MutationCommitCoordinator();

export function ModelsPanel({
  presets,
  onPresetsChange,
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
  const [testing, setTesting] = useState(false);
  const [auditing, setAuditing] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const coordinator = coordinatorRef.current;
    const queue = coordinator.pending();
    if (!queue.length) return;
    let cancelled = false;
    const authorizationMode = new LocalAgentSettingsStore().load().authorizationMode;
    const proposalIds =
      authorizationMode === "cautious" ? [queue[0].id] : queue.map((entry) => entry.id);
    void coordinator.prepare({ proposalIds }).then((prepared) => {
      if (!cancelled) setApprovalRows(prepared.diff);
    });
    return () => {
      cancelled = true;
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
    try {
      const [persons, relations, events, collections, collectionMemberships] = await Promise.all([
        facesDb.listPersons(),
        facesDb.listRelations(),
        facesDb.listLifeEvents(),
        facesDb.listCollections(),
        facesDb.listCollectionMemberships(),
      ]);
      return { persons, relations, events, collections, collectionMemberships };
    } catch {
      toast.error(t("读不到本机资料，这次按普通提问发送"));
      return empty;
    }
  };

  const applyAssistantResult = async (result: AssistantAgentResult) => {
    setLatestAgentRun(result.run);
    setAssistantMemory(result.workingMemory);
    setAssistantCitations(result.citations);
    setCitationFeedback({});
    const notices = [
      result.reusedToolResults > 0 ? `已复用 ${result.reusedToolResults} 条上一轮工具结果。` : "",
      result.historyCompression.omittedTurns > 0
        ? `较早 ${result.historyCompression.omittedTurns} 条对话已压缩为可见摘要。`
        : "",
      result.workingMemory.entries.length > 0
        ? `已保留 ${result.workingMemory.entries.length} 条工具记忆供下轮使用。`
        : "",
    ].filter(Boolean);
    setAssistantContextNotice(notices.join(" "));
    setTurns((prev) => {
      const next = [...prev];
      const last = next[next.length - 1];
      next[next.length - 1] = {
        ...last,
        text: assistantAdviceWithoutEvidence(result.answer, result.citations),
      };
      return next;
    });
    if (result.pendingApproval) {
      const coordinator = coordinatorRef.current;
      const authorizationMode = new LocalAgentSettingsStore().load().authorizationMode;
      const submitted = await coordinator.submitProposal(result.pendingApproval, {
        authorizationMode,
        sourceRunId: result.run.id,
      });
      if (submitted.status === "committed") {
        setLatestReceipt(submitted.receipt);
        setAssistantMemory(null);
        setSuspendedRequest(null);
        setAssistantContextNotice("档案已更新，上一版工具记忆已失效；下次会重新读取。");
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
  };

  const runAssistantRequest = async (request: {
    preset: ProviderPreset;
    prompt: string;
    history: ChatTurn[];
    image: string | null;
    includeArchive: boolean;
    resumeFrom?: AssistantAgentCheckpoint;
  }) => {
    const archive = await loadAssistantArchive(request.includeArchive);
    const includeArchive = request.includeArchive && archive.persons.length > 0;
    const result = await runAssistantAgent({
      preset: request.preset,
      question: request.prompt,
      ...archive,
      includeArchive,
      history: request.history,
      image: request.image,
      workingMemory: request.resumeFrom ? null : assistantMemory,
      resumeFrom: request.resumeFrom,
      onTrace: (event) => setAssistantTrace((prev) => [...prev.slice(-23), event]),
    });
    await applyAssistantResult(result);
    setSuspendedRequest(
      result.checkpoint
        ? {
            checkpoint: result.checkpoint,
            preset: request.preset,
            history: request.history,
            image: request.image,
            includeArchive,
          }
        : null,
    );
  };

  const handleSend = async () => {
    const prompt = input.trim();
    if (!prompt || busy) return;
    const preset = editing;
    if (!preset.model.trim()) {
      toast.error(t("请先填写模型名称"));
      return;
    }
    const sentFrame = frame;
    const history = turns;
    setTurns([
      ...history,
      { role: "user", text: prompt, image: sentFrame ?? undefined },
      { role: "assistant", text: "" },
    ]);
    setSuspendedRequest(null);
    setAssistantCitations([]);
    setCitationFeedback({});
    setInput("");
    if (sentFrame) onFrameUsed();
    setBusy(true);
    setAssistantTrace([]);
    try {
      await runAssistantRequest({
        preset,
        prompt,
        history,
        image: sentFrame,
        includeArchive: useData,
      });
    } catch (error) {
      toast.error((error as Error).message);
      setAssistantTrace((prev) => [
        ...prev.slice(-23),
        { kind: "done", text: (error as Error).message || t("请求失败") },
      ]);
      setTurns((prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
        next[next.length - 1] = { ...last, text: t("请求失败") };
        return next;
      });
    } finally {
      setBusy(false);
    }
  };

  const citationKey = (citation: ArchiveCitation) => `${citation.sourceRef}:${citation.quote}`;

  const confirmCitation = (citation: ArchiveCitation) => {
    setCitationFeedback((current) => ({ ...current, [citationKey(citation)]: "correct" }));
    toast.success("已标记为核对无误");
  };

  const startCitationCorrection = (citation: ArchiveCitation) => {
    setCitationFeedback((current) => ({ ...current, [citationKey(citation)]: "incorrect" }));
    setInput(
      `档案事实 ${citation.sourceRef}“${citation.quote}”不正确。请先读取该稳定 ID，并根据我补充的正确内容生成待批准修改提案。正确内容：`,
    );
    requestAnimationFrame(() => inputRef.current?.focus());
    toast.info("已定位对应档案记录；补充正确内容后发送，即进入修改提案流程");
  };

  const resumeAssistant = async () => {
    if (!suspendedRequest || busy) return;
    setBusy(true);
    setAssistantTrace([]);
    setTurns((prev) => {
      const next = [...prev];
      const last = next[next.length - 1];
      next[next.length - 1] = {
        ...last,
        text: `正在从第 ${suspendedRequest.checkpoint.nextRound} 轮继续…`,
      };
      return next;
    });
    try {
      await runAssistantRequest({
        preset: suspendedRequest.preset,
        prompt: suspendedRequest.checkpoint.question,
        history: suspendedRequest.history,
        image: suspendedRequest.image,
        includeArchive: suspendedRequest.includeArchive,
        resumeFrom: suspendedRequest.checkpoint,
      });
    } catch (error) {
      toast.error((error as Error).message);
      setAssistantTrace((prev) => [
        ...prev.slice(-23),
        { kind: "done", text: (error as Error).message || t("请求失败") },
      ]);
    } finally {
      setBusy(false);
    }
  };

  const approveUpdate = async () => {
    if (!pendingProposals.length || !approvalRows.length || approving) return;
    setApproving(true);
    try {
      const coordinator = coordinatorRef.current;
      const authorizationMode = new LocalAgentSettingsStore().load().authorizationMode;
      const proposalIds =
        authorizationMode === "cautious"
          ? [pendingProposals[0].id]
          : pendingProposals.map((entry) => entry.id);
      const receipt = await coordinator.commit({
        authorizationMode,
        proposalIds,
        signature: { signer: "user", signedAt: Date.now() },
      });
      setLatestReceipt(receipt);
      setAssistantMemory(null);
      setSuspendedRequest(null);
      setAssistantContextNotice("档案已更新，上一版工具记忆已失效；下次会重新读取。");
      toast.success(t(`已原子执行 ${receipt.operationIds.length} 项档案变更`));
      setTurns((prev) => [
        ...prev,
        {
          role: "assistant",
          text: `已签字执行 ${receipt.operationIds.length} 项变更并生成可撤销收据。后续提问会从更新后的档案重新读取。`,
        },
      ]);
      const queue = coordinator.pending();
      let nextRows: ArchiveMutationDiffRow[] = [];
      if (queue.length) {
        const nextIds =
          authorizationMode === "cautious" ? [queue[0].id] : queue.map((entry) => entry.id);
        nextRows = (await coordinator.prepare({ proposalIds: nextIds })).diff;
      }
      setApprovalRows(nextRows);
      setPendingProposals(queue);
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setApproving(false);
    }
  };

  const rejectUpdate = () => {
    if (!pendingProposals.length) return;
    const authorizationMode = new LocalAgentSettingsStore().load().authorizationMode;
    const rejected = authorizationMode === "cautious" ? [pendingProposals[0]] : pendingProposals;
    coordinatorRef.current.discard(rejected.map((entry) => entry.id));
    setPendingProposals(coordinatorRef.current.pending());
    setApprovalRows([]);
    setTurns((prev) => [
      ...prev,
      { role: "assistant", text: `已拒绝 ${rejected.length} 份提案，本机档案没有发生变化。` },
    ]);
  };

  const undoLatestReceipt = async () => {
    if (!latestReceipt || latestReceipt.undoneAt) return;
    try {
      const receipt = await coordinatorRef.current.undo(latestReceipt.id);
      setLatestReceipt(receipt);
      setAssistantMemory(null);
      setSuspendedRequest(null);
      setAssistantContextNotice("档案已撤销到上一版本，工具记忆已清空。");
      toast.success("已按收据恢复到提交前的完整档案");
    } catch (error) {
      toast.error((error as Error).message);
    }
  };

  return (
    <div className="min-w-0 space-y-6">
      {/* 配置编辑 */}
      <div className="rounded-2xl border border-border bg-card/40 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm font-medium">{t("模型配置")}</span>
          <div className="flex flex-wrap gap-1.5">
            {(["lovable", "openai", "ollama"] as ProviderKind[]).map((kind) => (
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
                <span className="ml-1.5 text-[11px] text-muted-foreground">
                  {KIND_LABEL[item.kind].split("（")[0]}
                  {item.model ? ` · ${item.model}` : ""}
                </span>
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
            {editing.kind === "lovable" ? (
              <Select value={editing.model} onValueChange={(model) => patch({ model })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LOVABLE_MODELS.map((model) => (
                    <SelectItem key={model.id} value={model.id}>
                      {model.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Input
                value={editing.model}
                placeholder={
                  editing.kind === "ollama" ? "llava / qwen2.5vl" : "gpt-4o-mini / deepseek-chat"
                }
                onChange={(e) => patch({ model: e.target.value, visionVerified: false })}
              />
            )}
          </div>
          {editing.kind !== "lovable" && (
            <div className="space-y-1.5">
              <Label className="text-xs">{t("接口地址")}</Label>
              <Input
                value={editing.baseUrl}
                placeholder="https://api.deepseek.com/v1"
                onChange={(e) => patch({ baseUrl: e.target.value, visionVerified: false })}
              />
            </div>
          )}
          {editing.kind === "openai" && (
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
                {t("密钥仅保存在当前浏览器会话，关闭标签页后清除。")}
              </p>
            </div>
          )}
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
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
          {t("当前选中的这套配置会用于全部任务：文字整理、图片和录音。")}
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
              history={assistantTrace.map((item) => item.text)}
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
              <Button size="sm" variant="outline" onClick={rejectUpdate} disabled={approving}>
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
