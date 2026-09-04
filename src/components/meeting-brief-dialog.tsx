import {
  AlertCircle,
  CalendarClock,
  CheckCircle2,
  FileClock,
  Link2,
  Loader2,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
  UserRound,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { mentionedArchivePeople } from "@/lib/connection-paths";
import { facesDb, type MeetingBriefLine, type MeetingBriefSourceRef } from "@/lib/face-db";
import {
  buildMeetingBrief,
  inspectMeetingBrief,
  loadMeetingBriefWorkspace,
} from "@/lib/meeting-brief";
import { cn } from "@/lib/utils";

interface MeetingBriefDialogProps {
  open: boolean;
  initialQuery?: string;
  initialPersonId?: string;
  requestNonce?: number;
  onOpenChange: (open: boolean) => void;
  onOpenSource: (source: MeetingBriefSourceRef, personId: string) => void;
}

type Workspace = Awaited<ReturnType<typeof loadMeetingBriefWorkspace>>;

const SOURCE_LABEL: Record<MeetingBriefSourceRef["kind"], string> = {
  person: "人物档案",
  relation_assertion: "关系事实",
  relation_projection: "推导关系",
  event: "事件",
  reminder: "提醒",
  task: "任务",
};

function BriefSection({
  title,
  lines,
  empty,
  advice = false,
  onOpenSource,
}: {
  title: string;
  lines: MeetingBriefLine[];
  empty: string;
  advice?: boolean;
  onOpenSource: (source: MeetingBriefSourceRef) => void;
}) {
  return (
    <section className="rounded-xl border border-border bg-background/60 p-3.5">
      <div className="flex items-center gap-2">
        <h3 className="text-xs font-semibold">{title}</h3>
        {advice && (
          <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] text-primary">
            建议
          </span>
        )}
      </div>
      {lines.length ? (
        <ul className="mt-2.5 space-y-2.5">
          {lines.map((item, index) => (
            <li key={`${item.text}:${index}`} className="text-xs leading-relaxed">
              <p>{item.text}</p>
              <div className="mt-1 flex flex-wrap gap-1">
                {item.sources.map((source) => (
                  <button
                    key={`${source.kind}:${source.id}`}
                    type="button"
                    title={`${SOURCE_LABEL[source.kind]} · ${source.id}`}
                    className="inline-flex items-center gap-1 rounded-full border border-border px-1.5 py-0.5 text-[9px] text-muted-foreground transition-colors hover:border-primary/50 hover:text-primary"
                    onClick={() => onOpenSource(source)}
                  >
                    <Link2 className="size-2.5" aria-hidden="true" />
                    {SOURCE_LABEL[source.kind]}
                  </button>
                ))}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-[11px] text-muted-foreground">{empty}</p>
      )}
    </section>
  );
}

export function MeetingBriefDialog({
  open,
  initialQuery = "",
  initialPersonId,
  requestNonce,
  onOpenChange,
  onOpenSource,
}: MeetingBriefDialogProps) {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [query, setQuery] = useState("");
  const [selectedPersonId, setSelectedPersonId] = useState("");
  const [selectedBriefId, setSelectedBriefId] = useState("");
  const [candidateIds, setCandidateIds] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  const choosePerson = useCallback((personId: string, data: Workspace) => {
    setSelectedPersonId(personId);
    setCandidateIds([]);
    setMessage("");
    const latest = data.briefs
      .filter((brief) => brief.personId === personId)
      .sort((left, right) => right.createdAt - left.createdAt)[0];
    setSelectedBriefId(latest?.id ?? "");
  }, []);

  const resolveQuery = useCallback(
    (text: string, data: Workspace) => {
      const matches = mentionedArchivePeople(text, data.input.persons);
      if (matches.length === 1) {
        choosePerson(matches[0].id, data);
        return;
      }
      setSelectedPersonId("");
      setSelectedBriefId("");
      setCandidateIds(matches.map((person) => person.id));
      setMessage(
        matches.length > 1
          ? "找到了多个同名或别名人物，请选择这次要见的人。"
          : "没有在这句话里找到人物姓名，可以输入档案中的姓名或别名。",
      );
    },
    [choosePerson],
  );

  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoading(true);
    setQuery(initialQuery);
    setMessage("");
    void loadMeetingBriefWorkspace()
      .then((data) => {
        if (!active) return;
        setWorkspace(data);
        if (initialPersonId && data.input.persons.some((person) => person.id === initialPersonId)) {
          choosePerson(initialPersonId, data);
        } else if (initialQuery.trim()) {
          resolveQuery(initialQuery, data);
        } else {
          setSelectedPersonId("");
          setSelectedBriefId("");
          setCandidateIds([]);
        }
      })
      .catch((cause) => {
        if (active) setMessage(cause instanceof Error ? cause.message : "见面简报读取失败");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [choosePerson, initialPersonId, initialQuery, open, requestNonce, resolveQuery]);

  const selectedPerson = workspace?.input.persons.find((person) => person.id === selectedPersonId);
  const versions = useMemo(
    () =>
      (workspace?.briefs ?? [])
        .filter((brief) => brief.personId === selectedPersonId)
        .sort((left, right) => right.createdAt - left.createdAt),
    [selectedPersonId, workspace?.briefs],
  );
  const latest = versions[0];
  const selectedBrief =
    versions.find((brief) => brief.id === selectedBriefId) ?? latest ?? undefined;
  const status =
    selectedBrief && workspace ? inspectMeetingBrief(selectedBrief, workspace.input) : undefined;
  const viewingHistory = Boolean(selectedBrief && latest && selectedBrief.id !== latest.id);

  const search = () => {
    if (!workspace) return;
    if (!query.trim()) {
      setCandidateIds(
        workspace.input.persons
          .filter((person) => person.entityRole !== "ego")
          .slice(0, 20)
          .map((person) => person.id),
      );
      setMessage("选择这次要见的人。");
      return;
    }
    resolveQuery(query, workspace);
  };

  const saveVersion = async () => {
    if (!workspace || !selectedPerson) return;
    setLoading(true);
    try {
      const record = buildMeetingBrief(workspace.input, selectedPerson.id, {
        previous: latest,
      });
      await facesDb.putMeetingBrief(record);
      const next = await loadMeetingBriefWorkspace();
      setWorkspace(next);
      setSelectedBriefId(record.id);
      toast.success(latest ? "已保存简报新版，旧版仍可查看" : "见面简报已保存");
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "保存见面简报失败");
    } finally {
      setLoading(false);
    }
  };

  const removeVersion = async () => {
    if (!selectedBrief || !workspace) return;
    await facesDb.deleteMeetingBrief(selectedBrief.id);
    const next = await loadMeetingBriefWorkspace();
    setWorkspace(next);
    const remaining = next.briefs
      .filter((brief) => brief.personId === selectedPersonId)
      .sort((left, right) => right.createdAt - left.createdAt);
    setSelectedBriefId(remaining[0]?.id ?? "");
    toast.success("已删除这一版简报");
  };

  const candidates = (workspace?.input.persons ?? []).filter((person) =>
    candidateIds.includes(person.id),
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] w-[calc(100vw-1.5rem)] max-w-5xl overflow-y-auto p-4 sm:p-6">
        <DialogHeader className="pr-8">
          <DialogTitle className="flex items-center gap-2">
            <FileClock className="size-5 text-primary" aria-hidden="true" />
            见面简报
          </DialogTitle>
          <DialogDescription>
            从人物档案、关系、事件与未完成事项生成一页会前记忆。事实带来源，话题单独标为建议。
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") search();
            }}
            placeholder="例如：明天要见唐悦"
            aria-label="输入要见的人"
          />
          <Button onClick={search} variant="outline" disabled={loading}>
            <Search className="size-4" aria-hidden="true" />
            找到人物
          </Button>
        </div>

        {loading && !workspace ? (
          <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            正在读取本地档案…
          </div>
        ) : (
          <>
            {message && (
              <p className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
                {message}
              </p>
            )}
            {candidates.length > 0 && (
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {candidates.map((person) => (
                  <button
                    key={person.id}
                    type="button"
                    className="rounded-xl border border-border bg-card p-3 text-left transition-colors hover:border-primary/60"
                    onClick={() => workspace && choosePerson(person.id, workspace)}
                  >
                    <span className="flex items-center gap-2 text-sm font-medium">
                      <UserRound className="size-4 text-primary" aria-hidden="true" />
                      {person.name}
                    </span>
                    <span className="mt-1 block text-[10px] text-muted-foreground">
                      {[person.profile?.org, person.profile?.title, person.profile?.metAt]
                        .filter(Boolean)
                        .join(" · ") || "暂无身份说明"}
                    </span>
                  </button>
                ))}
              </div>
            )}

            {selectedPerson && !selectedBrief && (
              <section className="flex flex-col items-start justify-between gap-4 rounded-2xl border border-primary/30 bg-primary/5 p-5 sm:flex-row sm:items-center">
                <div>
                  <p className="text-sm font-semibold">
                    为 {selectedPerson.name} 准备第一次见面简报
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    简报保存当时的文字和来源版本，以后档案变化时会提示生成新版。
                  </p>
                </div>
                <Button onClick={() => void saveVersion()} disabled={loading}>
                  {loading ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Sparkles className="size-4" />
                  )}
                  生成并保存
                </Button>
              </section>
            )}

            {selectedBrief && selectedPerson && (
              <div className="space-y-4">
                <section className="flex flex-col justify-between gap-3 rounded-xl border border-border bg-card p-4 sm:flex-row sm:items-start">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-base font-semibold">{selectedBrief.title}</h2>
                      {viewingHistory ? (
                        <span className="rounded-full border border-border px-2 py-0.5 text-[10px] text-muted-foreground">
                          历史版本
                        </span>
                      ) : status?.state === "stale" ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-700 dark:text-amber-200">
                          <AlertCircle className="size-3" /> 有更新
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] text-emerald-700 dark:text-emerald-200">
                          <CheckCircle2 className="size-3" /> 来源一致
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-[10px] text-muted-foreground">
                      保存于 {new Date(selectedBrief.createdAt).toLocaleString()} · 引用{" "}
                      {selectedBrief.sourceRefs.length} 条本地记录
                      {status?.changes.length ? ` · ${status.changes.length} 条来源发生变化` : ""}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {versions.length > 1 && (
                      <select
                        value={selectedBrief.id}
                        onChange={(event) => setSelectedBriefId(event.target.value)}
                        className="h-9 rounded-md border border-input bg-background px-2 text-xs"
                        aria-label="选择简报版本"
                      >
                        {versions.map((version, index) => (
                          <option key={version.id} value={version.id}>
                            {index === 0 ? "最新版" : `历史版 ${versions.length - index}`} ·{" "}
                            {new Date(version.createdAt).toLocaleString()}
                          </option>
                        ))}
                      </select>
                    )}
                    {!viewingHistory && status?.state === "stale" && (
                      <Button size="sm" onClick={() => void saveVersion()} disabled={loading}>
                        <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
                        生成新版
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-muted-foreground hover:text-destructive"
                      onClick={() => void removeVersion()}
                      aria-label="删除这一版简报"
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                </section>

                <div className="grid gap-3 lg:grid-cols-2">
                  <BriefSection
                    title="人物速记"
                    lines={selectedBrief.content.profile}
                    empty="人物档案还没有可展示的资料。"
                    onOpenSource={(source) => onOpenSource(source, selectedBrief.personId)}
                  />
                  <BriefSection
                    title="近期共同事件"
                    lines={selectedBrief.content.recentEvents}
                    empty="还没有共同事件。"
                    onOpenSource={(source) => onOpenSource(source, selectedBrief.personId)}
                  />
                  <BriefSection
                    title="未完成事项"
                    lines={selectedBrief.content.openItems}
                    empty="当前没有关联的提醒或任务。"
                    onOpenSource={(source) => onOpenSource(source, selectedBrief.personId)}
                  />
                  <BriefSection
                    title="相关人物"
                    lines={selectedBrief.content.relatedPeople}
                    empty="还没有可用的关系记录。"
                    onOpenSource={(source) => onOpenSource(source, selectedBrief.personId)}
                  />
                  <BriefSection
                    title="可聊话题"
                    lines={selectedBrief.content.talkingPoints}
                    empty="补充偏好、项目或共同事件后，会出现更具体的话题。"
                    advice
                    onOpenSource={(source) => onOpenSource(source, selectedBrief.personId)}
                  />
                  <section className="rounded-xl border border-border bg-background/60 p-3.5">
                    <h3 className="text-xs font-semibold">资料缺口</h3>
                    {selectedBrief.content.gaps.length ? (
                      <ul className="mt-2.5 space-y-1.5 text-xs text-muted-foreground">
                        {selectedBrief.content.gaps.map((gap) => (
                          <li key={gap}>· {gap}</li>
                        ))}
                      </ul>
                    ) : (
                      <p className="mt-2 text-[11px] text-muted-foreground">
                        这份简报没有明显资料缺口。
                      </p>
                    )}
                    <button
                      type="button"
                      className="mt-3 text-[10px] text-primary hover:underline"
                      onClick={() =>
                        onOpenSource(
                          selectedBrief.sourceRefs.find((source) => source.kind === "person") ?? {
                            kind: "person",
                            id: selectedBrief.personId,
                            revision: "",
                          },
                          selectedBrief.personId,
                        )
                      }
                    >
                      打开人物卡补充
                    </button>
                  </section>
                </div>

                <p className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                  <CalendarClock className="size-3" aria-hidden="true" />
                  简报不会改动人物档案；建议由现有资料生成，请结合当时情境判断。
                </p>
              </div>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
