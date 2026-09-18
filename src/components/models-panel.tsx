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
  isFreeTierPreset,
  isLocalEndpoint,
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
  focusRunId?: string;
  focusProposalId?: string;
  focusNonce?: number;
}

export function ModelsPanel({
  presets,
  onPresetsChange,
  onSavePresets,
  activeId,
  onActiveIdChange,
  frame,
  onFrameUsed,
  focusRunId,
  focusProposalId,
  focusNonce,
}: Props) {
  const [editId, setEditId] = useState(activeId);
  const [testing, setTesting] = useState(false);
  const [auditing, setAuditing] = useState(false);

  const editing = presets.find((preset) => preset.id === editId) ?? presets[0];

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
            {(["openai", "gemini"] as ProviderKind[]).map((kind) => (
              <Button key={kind} size="sm" variant="outline" onClick={() => addPreset(kind)}>
                <Plus className="size-3.5" aria-hidden="true" />
                {t(KIND_LABEL[kind].split("（")[0])}
              </Button>
            ))}
          </div>
        </div>

        <details className="rounded-xl border border-dashed border-border px-3 py-2 text-[11px] text-muted-foreground">
          <summary className="cursor-pointer select-none font-medium text-foreground">
            {t("第一次配模型？三步搞定")}
          </summary>
          <ol className="mt-1.5 list-inside list-decimal space-y-1 leading-relaxed">
            <li>{t("点右上方「＋」加一套接口，常用开发平台任选一家：")}</li>
            <li className="pl-4">
              <a
                href="https://open.bigmodel.cn/"
                target="_blank"
                rel="noreferrer"
                className="text-primary underline underline-offset-2"
              >
                {t("智谱")} https://open.bigmodel.cn/
              </a>
              <span className="ml-1">{t("（注册即送免费额度，手机号即可）")}</span>
              {" · "}
              <a
                href="https://platform.deepseek.com/"
                target="_blank"
                rel="noreferrer"
                className="text-primary underline underline-offset-2"
              >
                DeepSeek https://platform.deepseek.com/
              </a>
              {" · "}
              <a
                href="https://platform.moonshot.cn/"
                target="_blank"
                rel="noreferrer"
                className="text-primary underline underline-offset-2"
              >
                Moonshot https://platform.moonshot.cn/
              </a>
              {" · "}
              <a
                href="https://aistudio.google.com/apikey"
                target="_blank"
                rel="noreferrer"
                className="text-primary underline underline-offset-2"
              >
                Gemini https://aistudio.google.com/apikey
              </a>
              {t(" —— 到平台申请 API Key，粘贴到下方「API Key」输入框。")}
            </li>
            <li>
              {t("点「测试连接」，通过后再点「保存模型配置」。密钥只保存在这台设备的浏览器里。")}
            </li>
          </ol>
        </details>

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
                {/* 内置档位名要走字典；用户自己起的名字不在表里，t() 会原样返回。 */}
                <span className="truncate font-medium">{t(item.name) || t("未命名")}</span>
                {isFreeTierPreset(item) ? (
                  <span className="ml-1.5 text-[11px] text-muted-foreground">
                    {t("免密钥 · 官方免费额度")}
                  </span>
                ) : (
                  (item.name.trim() !== KIND_LABEL[item.kind].split("（")[0] || item.model) && (
                    <span className="ml-1.5 text-[11px] text-muted-foreground">
                      {item.name.trim() !== KIND_LABEL[item.kind].split("（")[0]
                        ? t(KIND_LABEL[item.kind].split("（")[0])
                        : ""}
                      {item.model ? ` · ${item.model}` : ""}
                    </span>
                  )
                )}
              </button>
              {item.id === activeId && (
                <span className="shrink-0 rounded-full bg-primary/15 px-2 py-0.5 text-[10px] text-primary">
                  {t("使用中")}
                </span>
              )}
              {!isFreeTierPreset(item) && (
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
              )}
            </div>
          ))}
        </div>

        {isFreeTierPreset(editing) ? (
          <div
            data-testid="free-tier-note"
            className="mt-3 space-y-1.5 rounded-xl border border-primary/30 bg-primary/5 p-3 text-[11px] leading-relaxed text-muted-foreground"
          >
            <p className="text-xs font-medium text-foreground">{t("免费体验不需要填密钥")}</p>
            <p>
              {t(
                "请求会经知脉的体验服务器转给免费模型，服务器只转发、不保存内容。额度有限，忙的时候可能要排队。",
              )}
            </p>
            <p>
              {t("需要更稳定的服务，点右上方「＋」加一套自己的模型接口。免费体验不包含语音转写。")}
            </p>
          </div>
        ) : (
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
                  editing.kind === "gemini"
                    ? "gemini-3.7-flash"
                    : "gpt-4o-mini / deepseek-v4-flash / llava"
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
                    : "https://api.deepseek.com/v1 或本机 http://localhost:11434/v1"
                }
                onChange={(e) => patch({ baseUrl: e.target.value, visionVerified: false })}
              />
            </div>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <Label className="text-xs">
                  {t("API Key")}
                  {isLocalEndpoint(editing) && (
                    <span className="ml-1.5 font-normal text-muted-foreground">
                      {t("本机接口可不填")}
                    </span>
                  )}
                </Label>
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
          </div>
        )}

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
          {editing.kind === "openai" && !isFreeTierPreset(editing) && (
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

      <AgentControlCenter />
    </div>
  );
}
