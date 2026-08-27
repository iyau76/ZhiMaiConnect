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
import { runAssistantAgent, type AssistantAgentResult } from "@/lib/assistant-agent";
import { facesDb } from "@/lib/face-db";
import { t } from "@/lib/i18n";
import {
  applyPersonUpdateProposal,
  personUpdateDiff,
  type PersonUpdateProposal,
} from "@/lib/person-update-tool";
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
  const [pendingApproval, setPendingApproval] = useState<PersonUpdateProposal | null>(null);
  const [approvalRows, setApprovalRows] = useState<
    Array<{ field: string; before: string; after: string }>
  >([]);
  const [approving, setApproving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [auditing, setAuditing] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

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

  const handleSend = async () => {
    const prompt = input.trim();
    if (!prompt || busy || pendingApproval) return;
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

    setInput("");
    if (sentFrame) onFrameUsed();
    setBusy(true);
    setAssistantTrace([]);
    try {
      let archive: Pick<
        Parameters<typeof runAssistantAgent>[0],
        "persons" | "relations" | "events"
      > = {
        persons: [],
        relations: [],
        events: [],
      };
      if (useData) {
        try {
          const [persons, relations, events] = await Promise.all([
            facesDb.listPersons(),
            facesDb.listRelations(),
            facesDb.listLifeEvents(),
          ]);
          archive = { persons, relations, events };
        } catch {
          toast.error(t("读不到本机资料，这次按普通提问发送"));
        }
      }
      const result: AssistantAgentResult = await runAssistantAgent({
        preset,
        question: prompt,
        ...archive,
        includeArchive: useData && archive.persons.length > 0,
        history,
        image: sentFrame,
        onTrace: (event) => setAssistantTrace((prev) => [...prev.slice(-23), event]),
      });
      setTurns((prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
        next[next.length - 1] = { ...last, text: result.answer };
        return next;
      });
      if (result.pendingApproval) {
        const person = archive.persons.find((item) => item.id === result.pendingApproval?.personId);
        setPendingApproval(result.pendingApproval);
        setApprovalRows(person ? personUpdateDiff(result.pendingApproval, person) : []);
      }
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

  const approvePersonUpdate = async () => {
    if (!pendingApproval || approving) return;
    setApproving(true);
    try {
      const updated = await applyPersonUpdateProposal(pendingApproval);
      toast.success(t("人物档案修改已执行"));
      setTurns((prev) => [
        ...prev,
        { role: "assistant", text: `已按你的批准更新「${updated.name}」的人物档案。` },
      ]);
      setPendingApproval(null);
      setApprovalRows([]);
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setApproving(false);
    }
  };

  const rejectPersonUpdate = () => {
    if (!pendingApproval) return;
    const name = pendingApproval.personName;
    setPendingApproval(null);
    setApprovalRows([]);
    setTurns((prev) => [
      ...prev,
      { role: "assistant", text: `已取消对「${name}」的修改，人物库没有发生变化。` },
    ]);
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

        {pendingApproval && (
          <div
            className="mt-3 rounded-xl border border-amber-500/60 bg-amber-500/10 p-3"
            role="region"
            aria-label={t("待批准的人物修改")}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-medium">
                  {t("AI 请求修改人物档案")}：{pendingApproval.personName}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">{pendingApproval.reason}</p>
              </div>
              <span className="shrink-0 rounded-full border border-amber-500/50 px-2 py-0.5 text-[10px] text-amber-600 dark:text-amber-300">
                {t("尚未写入")}
              </span>
            </div>
            <dl className="mt-3 space-y-2 text-xs">
              {approvalRows.map((row) => (
                <div
                  key={row.field}
                  className="grid gap-1 rounded-lg bg-background/60 p-2 md:grid-cols-[5rem_1fr_1fr]"
                >
                  <dt className="font-medium">{row.field}</dt>
                  <dd className="text-muted-foreground line-through">{row.before}</dd>
                  <dd className="text-foreground">{row.after}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-2 text-[11px] text-muted-foreground">
              {t("批准前不会写入本机人物库；档案若已被其他操作修改，本提案会自动失效。")}
            </p>
            <div className="mt-3 flex justify-end gap-2">
              <Button size="sm" variant="outline" onClick={rejectPersonUpdate} disabled={approving}>
                <X className="size-3.5" aria-hidden="true" />
                {t("拒绝")}
              </Button>
              <Button size="sm" onClick={() => void approvePersonUpdate()} disabled={approving}>
                {approving ? (
                  <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <Check className="size-3.5" aria-hidden="true" />
                )}
                {t("批准并执行")}
              </Button>
            </div>
          </div>
        )}

        <div className="mt-3 flex gap-2">
          <Textarea
            value={input}
            rows={2}
            placeholder={t("问点什么，比如：这周该联系谁？")}
            onChange={(e) => setInput(e.target.value)}
            disabled={Boolean(pendingApproval)}
          />
          <Button
            onClick={handleSend}
            disabled={busy || Boolean(pendingApproval)}
            aria-label={t("发送问题")}
          >
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
