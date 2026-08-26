import { CheckCircle2, Circle, CircleDot, Loader2, Plus, Sparkles, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { SourceBadge } from "@/components/source-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { askText, parseLooseJson } from "@/lib/ai-text";
import { facesDb, type EvidenceRecord, type PersonRecord, type TaskRecord } from "@/lib/face-db";
import { getLang, t } from "@/lib/i18n";
import { makeSource } from "@/lib/provenance";
import type { ProviderPreset } from "@/lib/vision-providers";

const OFFICER_KEY = "openglass.officer";

const STATUS: Array<{ id: TaskRecord["status"]; zh: string; en: string; icon: typeof Circle }> = [
  { id: "todo", zh: "待办", en: "To do", icon: Circle },
  { id: "doing", zh: "进行中", en: "In progress", icon: CircleDot },
  { id: "done", zh: "已完成", en: "Done", icon: CheckCircle2 },
];

const PRIORITY: Record<TaskRecord["priority"], { zh: string; en: string; cls: string }> = {
  high: { zh: "紧急", en: "High", cls: "border-primary text-primary" },
  normal: { zh: "一般", en: "Normal", cls: "border-border text-muted-foreground" },
  low: { zh: "可延后", en: "Low", cls: "border-border text-muted-foreground/70" },
};

export function PlanBoard({ preset }: { preset: ProviderPreset }) {
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [people, setPeople] = useState<PersonRecord[]>([]);
  const [evidence, setEvidence] = useState<EvidenceRecord[]>([]);
  const [officer, setOfficer] = useState("");
  const [title, setTitle] = useState("");
  const [detail, setDetail] = useState("");
  const [due, setDue] = useState("");
  const [priority, setPriority] = useState<TaskRecord["priority"]>("normal");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const [rows, persons, docs] = await Promise.all([
      facesDb.listTasks(),
      facesDb.listPersons(),
      facesDb.listEvidence(),
    ]);
    setTasks(rows);
    setPeople(persons);
    setEvidence(docs);
  }, []);

  useEffect(() => {
    void refresh();
    try {
      setOfficer(localStorage.getItem(OFFICER_KEY) ?? "");
    } catch {
      /* ignore */
    }
  }, [refresh]);

  const rememberOfficer = (value: string) => {
    setOfficer(value);
    try {
      localStorage.setItem(OFFICER_KEY, value);
    } catch {
      /* ignore */
    }
  };

  const add = async () => {
    if (!title.trim()) {
      toast.error(t("先写一句这一步要做什么"));
      return;
    }
    await facesDb.putTask({
      id: crypto.randomUUID(),
      title: title.trim(),
      detail: detail.trim() || undefined,
      assignee: officer.trim() || undefined,
      priority,
      status: "todo",
      due: due || undefined,
      createdAt: Date.now(),
      source: makeSource("manual", officer.trim() || undefined),
    });
    setTitle("");
    setDetail("");
    setDue("");
    await refresh();
    toast.success(t("已加入探案计划"));
  };

  const patch = async (task: TaskRecord, next: Partial<TaskRecord>) => {
    await facesDb.putTask({ ...task, ...next });
    await refresh();
  };

  const remove = async (id: string) => {
    await facesDb.deleteTask(id);
    await refresh();
  };

  const generate = async () => {
    if (!people.length && !evidence.length) {
      toast.error(t("库里还没有资料，先去「录入」写点情况"));
      return;
    }
    const zh = getLang() !== "en";
    const roster = people.map((p) => `- ${p.name}（${p.profile?.relation ?? "?"}）`).join("\n");
    const docs = evidence
      .slice(0, 20)
      .map((item) => `- [${item.kind}] ${item.title}：${item.text.slice(0, 300)}`)
      .join("\n");
    const prompt = zh
      ? `你是办案计划助手。根据下面的案件资料，排出接下来 5-8 条具体可执行的行动项（走访谁、调什么记录、送检什么），按优先级排序。只输出 JSON：{"tasks":[{"title":"一句话行动","detail":"想验证什么、注意事项","priority":"high|normal|low"}]}\n\n【人物】\n${roster || "暂无"}\n\n【材料】\n${docs || "暂无"}`
      : `You are an investigation planner. From the case material below, produce 5-8 concrete next actions ordered by priority. Output JSON only: {"tasks":[{"title":"one-line action","detail":"what it verifies, cautions","priority":"high|normal|low"}]}\n\n[People]\n${roster || "none"}\n\n[Material]\n${docs || "none"}`;

    setBusy(true);
    try {
      const raw = await askText(preset, prompt);
      const parsed = parseLooseJson<{
        tasks?: Array<{ title?: string; detail?: string; priority?: string }>;
      }>(raw);
      const list = (parsed.tasks ?? []).filter((item) => item.title?.trim());
      if (!list.length) throw new Error(t("AI 没有给出可用的行动项"));
      const now = Date.now();
      for (const [index, item] of list.entries()) {
        await facesDb.putTask({
          id: crypto.randomUUID(),
          title: item.title!.trim(),
          detail: item.detail?.trim() || undefined,
          assignee: officer.trim() || undefined,
          priority:
            item.priority === "high" || item.priority === "low"
              ? (item.priority as TaskRecord["priority"])
              : "normal",
          status: "todo",
          createdAt: now - index,
          source: makeSource("ai", preset.model),
        });
      }
      await refresh();
      toast.success(`${t("已生成行动项")} ${list.length}`);
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const en = getLang() === "en";

  return (
    <section className="flex min-w-0 flex-col gap-4 rounded-2xl border border-border bg-card/60 p-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="flex items-baseline gap-2.5">
          <span className="font-display text-xl leading-none tracking-tight">{t("探案计划")}</span>
          <span className="text-[10px] uppercase tracking-[0.24em] text-muted-foreground">Plan</span>
        </h2>
        <Button size="sm" variant="outline" className="rounded-full px-4" disabled={busy} onClick={() => void generate()}>
          {busy ? (
            <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <Sparkles className="size-3.5" aria-hidden="true" />
          )}
          {t("让 AI 排计划")}
        </Button>
      </header>

      <div className="grid gap-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_auto]">
        <Input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder={t("行动项，例：走访保姆李姐核对报警经过")}
        />
        <Input
          value={officer}
          onChange={(event) => rememberOfficer(event.target.value)}
          placeholder={t("负责人 / 办案人")}
        />
        <Input type="date" value={due} onChange={(event) => setDue(event.target.value)} className="w-auto" />
      </div>
      <Textarea
        value={detail}
        onChange={(event) => setDetail(event.target.value)}
        rows={2}
        className="text-sm"
        placeholder={t("想验证什么、注意事项（可留空）")}
      />
      <div className="flex flex-wrap items-center gap-2">
        {(Object.keys(PRIORITY) as TaskRecord["priority"][]).map((key) => (
          <Button
            key={key}
            type="button"
            size="sm"
            variant={priority === key ? "default" : "outline"}
            className="h-7 rounded-full px-3 text-[11px]"
            onClick={() => setPriority(key)}
          >
            {en ? PRIORITY[key].en : PRIORITY[key].zh}
          </Button>
        ))}
        <Button size="sm" className="rounded-full px-4" onClick={() => void add()}>
          <Plus className="size-3.5" aria-hidden="true" />
          {t("加入计划")}
        </Button>
      </div>

      <div className="grid gap-3 lg:grid-cols-3">
        {STATUS.map((column) => {
          const list = tasks.filter((task) => task.status === column.id);
          return (
            <div key={column.id} className="min-w-0 space-y-2 rounded-xl border border-border p-3">
              <p className="flex items-center gap-1.5 text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
                <column.icon className="size-3.5" aria-hidden="true" />
                {en ? column.en : column.zh} · {list.length}
              </p>
              {list.length === 0 ? (
                <p className="py-4 text-center text-[11px] text-muted-foreground">—</p>
              ) : (
                list.map((task) => (
                  <div key={task.id} className="space-y-1.5 rounded-lg border border-border bg-background/50 p-2.5">
                    <div className="flex items-start justify-between gap-2">
                      <p className="min-w-0 text-[13px] font-medium leading-snug">{task.title}</p>
                      <button
                        type="button"
                        className="shrink-0 text-muted-foreground hover:text-destructive"
                        onClick={() => void remove(task.id)}
                        aria-label={t("删除")}
                      >
                        <Trash2 className="size-3.5" aria-hidden="true" />
                      </button>
                    </div>
                    {task.detail && (
                      <p className="whitespace-pre-wrap text-[11px] leading-relaxed text-muted-foreground">
                        {task.detail}
                      </p>
                    )}
                    <div className="flex flex-wrap items-center gap-1">
                      <span className={`rounded-full border px-2 py-0.5 text-[10px] ${PRIORITY[task.priority].cls}`}>
                        {en ? PRIORITY[task.priority].en : PRIORITY[task.priority].zh}
                      </span>
                      {task.due && (
                        <span className="rounded-full border border-border px-2 py-0.5 text-[10px] text-muted-foreground">
                          {task.due}
                        </span>
                      )}
                      <SourceBadge source={task.source} />
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Input
                        value={task.assignee ?? ""}
                        onChange={(event) => void patch(task, { assignee: event.target.value })}
                        placeholder={t("负责人")}
                        className="h-7 flex-1 text-[11px]"
                      />
                      {STATUS.filter((item) => item.id !== task.status).map((item) => (
                        <Button
                          key={item.id}
                          size="sm"
                          variant="ghost"
                          className="h-7 px-2 text-[10px]"
                          onClick={() => void patch(task, { status: item.id })}
                        >
                          {en ? item.en : item.zh}
                        </Button>
                      ))}
                    </div>
                  </div>
                ))
              )}
            </div>
          );
        })}
      </div>

      <p className="text-[11px] leading-relaxed text-muted-foreground">
        {t("计划里的每条行动项都记录了负责人和来源（人工排的还是 AI 排的），AI 排的需要办案人确认后再执行。")}
      </p>
    </section>
  );
}
