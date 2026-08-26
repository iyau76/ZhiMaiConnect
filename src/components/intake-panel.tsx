import { ArrowRight, Briefcase, Check, Loader2, Paperclip, Plus, Sparkles, Trash2, TriangleAlert, X } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";

import { DraftGraph } from "@/components/draft-graph";
import { Button } from "@/components/ui/button";

import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Textarea } from "@/components/ui/textarea";
import { askText, parseLooseJson } from "@/lib/ai-text";
import { importFiles } from "@/lib/doc-import";
import {
  claimIntakeJob,
  getIntakeJob,
  startIntakeJob,
  subscribeIntakeJob,
} from "@/lib/intake-job";
import { facesDb, type PersonRecord } from "@/lib/face-db";
import { getLang, t } from "@/lib/i18n";
import { inferMutual } from "@/lib/relation-kind";
import { makeSource } from "@/lib/provenance";
import { cn } from "@/lib/utils";
import type { ProviderPreset } from "@/lib/vision-providers";


interface DraftPerson {
  name: string;
  note?: string;
  age?: string;
  gender?: string;
  relation?: string;
  contact?: string;
  address?: string;
  title?: string;
  department?: string;
  org?: string;
  projects?: string[];
  reportsTo?: string;
  employeeId?: string;
  birthday?: string;
  circle?: string;
  closeness?: number;
  likes?: string[];
  dislikes?: string[];
  gifts?: string[];
  metAt?: string;
  tags?: string[];
}

interface DraftRelation {
  from: string;
  to: string;
  label: string;
  note?: string;
}

interface DraftEvidence {
  kind?: string;
  title?: string;
  text?: string;
  origin?: string;
}

interface DraftProject {
  title: string;
  detail?: string;
  department?: string;
  owner?: string;
  members?: string[];
  status?: string;
  priority?: string;
  due?: string;
  tags?: string[];
}

interface Draft {
  people?: DraftPerson[];
  relations?: DraftRelation[];
  projects?: DraftProject[];
  evidence?: DraftEvidence[];
  summary?: string;
}


/** 一个人物档案里希望齐全的字段 */
const REQUIRED: Array<{ key: keyof DraftPerson; zh: string; en: string }> = [
  { key: "relation", zh: "和我的关系", en: "relationship to me" },
  { key: "birthday", zh: "生日", en: "birthday" },
  { key: "contact", zh: "联系方式", en: "contact" },
  { key: "likes", zh: "喜好", en: "likes" },
];

function missingOf(person: DraftPerson) {
  return REQUIRED.filter((field) => {
    const value = person[field.key];
    if (Array.isArray(value)) return value.length === 0;
    return !value || (typeof value === "string" && !value.trim());
  });
}

const SCHEMA = `{"people":[{"name":"","note":"","age":"","gender":"","relation":"","birthday":"","circle":"","closeness":3,"likes":[],"dislikes":[],"gifts":[],"metAt":"","contact":"","address":"","title":"","org":"","tags":[]}],"relations":[{"from":"","to":"","label":"","note":""}],"projects":[{"title":"","detail":"","owner":"","members":[],"status":"planned|active|blocked|done","priority":"high|normal|low","due":"","tags":[]}],"evidence":[{"kind":"note|audio|exhibit|frame","title":"","text":"","origin":""}],"summary":""}`;

function buildPrompt(text: string, known: string[], previous: Draft | null) {
  const zh = getLang() !== "en";
  const base = zh
    ? `你是个人人脉整理助手。把下面这段自然语言材料整理成结构化 JSON，只输出 JSON，不要解释、不要 markdown。
严格使用这个结构：${SCHEMA}
规则：
- 材料里没写的字段留空字符串或空数组，绝对不要编造。
- relation 写这个人和「我」的关系，如大学同学、表哥、前同事。
- circle 只能是：家人 / 亲戚 / 朋友 / 同学 / 同事 / 邻居 / 其它。closeness 是 1-5 的亲密度整数。
- birthday 用 MM-DD 或 YYYY-MM-DD。likes 喜好、dislikes 忌口或不喜欢、gifts 送过的礼物。
- relations 写人和人之间的关系，如夫妻、父子、室友、同事。
- projects 放要做的事 / 待办，如「帮小雨看简历」，owner 是主要负责的人，due 用 yyyy-mm-dd。
- summary 用一两句话说明这份材料讲了什么。`
    : `You organise a personal contact network. Convert the text below into structured JSON. Output JSON only, no markdown, no explanation.
Use exactly this structure: ${SCHEMA}
Rules:
- Leave a field empty when the text does not state it. Never invent facts.
- relation = how this person relates to me (college roommate, cousin, ex-colleague).
- circle is one of family / relatives / friends / classmates / colleagues / neighbours / other. closeness is 1-5.
- birthday as MM-DD or YYYY-MM-DD. likes, dislikes, gifts are short arrays.
- relations = ties between people (spouse, parent, roommate, colleague).
- projects = todos such as "review Xiaoyu's resume", owner is the main person, due as yyyy-mm-dd.
- summary = one or two sentences about the material.`;

  const knownLine = zh
    ? `\n已有档案：${known.join("、") || "无"}`
    : `\nExisting profiles: ${known.join(", ") || "none"}`;
  const prev = previous
    ? (zh ? `\n\n这是上一轮整理结果，请在它基础上合并补充：\n` : `\n\nMerge and extend this previous draft:\n`) +
      JSON.stringify(previous)
    : "";
  return `${base}${knownLine}${prev}\n\n${zh ? "材料" : "Material"}：\n${text}`;
}

/** 切到别的页签再回来时，未提交的录入内容不能丢 —— 存在本地，15 秒自动暂存一次 */
const DRAFT_KEY = "zhimai.intake.draft.v1";

interface StashShape {
  raw: string;
  supplement: string;
  draft: Draft | null;
  attached: { name: string; block: string }[];
  at: number;
}

function readStash(): StashShape | null {
  if (typeof window === "undefined") return null;
  try {
    const text = window.localStorage.getItem(DRAFT_KEY);
    return text ? (JSON.parse(text) as StashShape) : null;
  } catch {
    return null;
  }
}

export function IntakePanel({ preset }: { preset: ProviderPreset }) {
  const stash = useRef<StashShape | null>(readStash()).current;
  const [raw, setRaw] = useState(stash?.raw ?? "");
  const [supplement, setSupplement] = useState(stash?.supplement ?? "");
  const [draft, setDraft] = useState<Draft | null>(stash?.draft ?? null);
  const job = useSyncExternalStore(subscribeIntakeJob, getIntakeJob, getIntakeJob);
  const busy = job.busy;
  const [saving, setSaving] = useState(false);
  const [known, setKnown] = useState<string[]>([]);
  const [reading, setReading] = useState<string | null>(null);
  const [attached, setAttached] = useState<{ name: string; block: string }[]>(
    stash?.attached ?? [],
  );
  const [progress, setProgress] = useState(0);
  const [stashedAt, setStashedAt] = useState<number | null>(stash?.at ?? null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void facesDb.listPersons().then((rows) => setKnown(rows.map((row) => row.name)));
  }, []);

  /** 暂存：15 秒一次 + 离开页面时再存一次，回来接着改 */
  const snapshot = useRef({ raw, supplement, draft, attached });
  snapshot.current = { raw, supplement, draft, attached };
  useEffect(() => {
    const write = () => {
      const now = snapshot.current;
      const empty = !now.raw.trim() && !now.supplement.trim() && !now.draft && !now.attached.length;
      try {
        if (empty) {
          window.localStorage.removeItem(DRAFT_KEY);
          return;
        }
        window.localStorage.setItem(DRAFT_KEY, JSON.stringify({ ...now, at: Date.now() }));
        setStashedAt(Date.now());
      } catch {
        /* 存不下就算了，不打扰用户 */
      }
    };
    const timer = window.setInterval(write, 15000);
    window.addEventListener("beforeunload", write);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("beforeunload", write);
      write();
    };
  }, []);


  /** 传错了可以撤掉：把这份文件抽出来的文字从输入框里删掉 */
  const removeAttached = (index: number) => {
    const item = attached[index];
    if (!item) return;
    setAttached((prev) => prev.filter((_, i) => i !== index));
    setRaw((prev) =>
      prev
        .split("\n\n")
        .filter((block) => block.trim() !== item.block.trim())
        .join("\n\n")
        .trim(),
    );
  };

  /** 上传简历 / 截图 / PDF / Word：抽成文字后拼进输入框，再走同一套 AI 整理 */
  const pickFiles = async (files: FileList | File[] | null) => {
    if (!files?.length) return;
    setReading(t("正在读取文件"));
    setProgress(0);
    try {
      const docs = await importFiles(
        [...files],
        preset,
        (step) => setReading(step),
        (done, total) => setProgress(total ? Math.round((done / total) * 100) : 0),
      );
      const entries = docs
        .filter((doc) => doc.text.trim())
        .map((doc) => ({
          name: doc.name,
          block: `【${t("来自文件")}：${doc.name}】\n${doc.text.trim()}`,
        }));
      if (!entries.length) {
        toast.error(t("没有从文件里读到文字"));
        return;
      }
      setRaw((prev) => [prev.trim(), ...entries.map((item) => item.block)].filter(Boolean).join("\n\n"));
      setAttached((prev) => [...prev, ...entries]);
      toast.success(`${t("已读取")} ${entries.length} ${t("份文件")}`);
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setReading(null);
      setProgress(0);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  /** Ctrl/⌘+V：直接把剪贴板里的截图或文件贴进来 */
  const pasteRef = useRef(pickFiles);
  pasteRef.current = pickFiles;
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const files = [...(event.clipboardData?.files ?? [])];
      if (!files.length) return;
      event.preventDefault();
      void pasteRef.current(files);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, []);


  /** 交给模块层跑：切到别的页签也继续整理，回来自动显示结果 */
  const organize = (extra?: string) => {
    const text = extra ? `${raw}\n\n${extra}` : raw;
    if (!text.trim()) {
      toast.error(t("先把知道的情况写下来，怎么写都行"));
      return;
    }
    const base = extra ? draft : null;
    startIntakeJob({
      text,
      extra: extra ?? null,
      run: async () => parseLooseJson<Draft>(await askText(preset, buildPrompt(text, known, base))),
    });
  };

  /** 认领后台整理好的结果（可能是在别的页签跑完的） */
  useEffect(() => {
    if (job.result) {
      setDraft(job.result as Draft);
      if (job.extra) {
        setRaw(job.text ?? "");
        setSupplement("");
      }
      claimIntakeJob();
      toast.success(t("已整理成档案草稿"));
    } else if (job.error) {
      const message = job.error;
      claimIntakeJob();
      toast.error(message);
    }
  }, [job]);


  const patchPerson = (index: number, patch: Partial<DraftPerson>) => {
    setDraft((prev) => {
      if (!prev?.people) return prev;
      const people = prev.people.map((person, i) => (i === index ? { ...person, ...patch } : person));
      return { ...prev, people };
    });
  };

  const removePerson = (index: number) =>
    setDraft((prev) =>
      prev ? { ...prev, people: (prev.people ?? []).filter((_, i) => i !== index) } : prev,
    );

  const patchRelation = (index: number, patch: Partial<DraftRelation>) =>
    setDraft((prev) =>
      prev
        ? { ...prev, relations: (prev.relations ?? []).map((r, i) => (i === index ? { ...r, ...patch } : r)) }
        : prev,
    );

  const removeRelation = (index: number) =>
    setDraft((prev) =>
      prev ? { ...prev, relations: (prev.relations ?? []).filter((_, i) => i !== index) } : prev,
    );

  const patchEvidence = (index: number, patch: Partial<DraftEvidence>) =>
    setDraft((prev) =>
      prev
        ? { ...prev, evidence: (prev.evidence ?? []).map((e, i) => (i === index ? { ...e, ...patch } : e)) }
        : prev,
    );

  const removeEvidence = (index: number) =>
    setDraft((prev) =>
      prev ? { ...prev, evidence: (prev.evidence ?? []).filter((_, i) => i !== index) } : prev,
    );

  const patchProject = (index: number, patch: Partial<DraftProject>) =>
    setDraft((prev) =>
      prev
        ? { ...prev, projects: (prev.projects ?? []).map((p, i) => (i === index ? { ...p, ...patch } : p)) }
        : prev,
    );

  const removeProject = (index: number) =>
    setDraft((prev) =>
      prev ? { ...prev, projects: (prev.projects ?? []).filter((_, i) => i !== index) } : prev,
    );

  const addProject = () =>
    setDraft((prev) => ({
      ...(prev ?? {}),
      projects: [...(prev?.projects ?? []), { title: "", status: "planned", priority: "normal" }],
    }));


  const commit = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const current = await facesDb.listPersons();
      const byName = new Map(current.map((person) => [person.name, person]));
      let created = 0;
      let updated = 0;

      for (const item of draft.people ?? []) {
        const name = (item.name ?? "").trim();
        if (!name) continue;
        const profile = {
          age: item.age || undefined,
          gender: item.gender || undefined,
          relation: item.relation || undefined,
          contact: item.contact || undefined,
          address: item.address || undefined,
          title: item.title || undefined,
          department: item.department || undefined,
          org: item.org || undefined,
          projects: item.projects?.length ? item.projects : undefined,
          reportsTo: item.reportsTo || undefined,
          employeeId: item.employeeId || undefined,
          birthday: item.birthday || undefined,
          circle: item.circle || undefined,
          closeness: typeof item.closeness === "number" ? item.closeness : undefined,
          likes: item.likes?.length ? item.likes : undefined,
          dislikes: item.dislikes?.length ? item.dislikes : undefined,
          gifts: item.gifts?.length ? item.gifts : undefined,
          metAt: item.metAt || undefined,
          tags: item.tags?.length ? item.tags : undefined,
        };
        const exist = byName.get(name);
        if (exist) {
          await facesDb.putPerson({
            ...exist,
            note: [exist.note, item.note].filter(Boolean).join("；"),
            profile: { ...exist.profile, ...profile },
          });
          updated += 1;
          continue;
        }
        const record: PersonRecord = {
          id: crypto.randomUUID(),
          name,
          note: item.note ?? "",
          profile,
          rawProfileText: raw,
          descriptors: [],
          thumb: "",
          createdAt: Date.now(),
          source: makeSource("ai", t("资料整理")),
        };
        await facesDb.putPerson(record);
        byName.set(name, record);
        created += 1;
      }

      let links = 0;
      for (const item of draft.relations ?? []) {
        const a = byName.get((item.from ?? "").trim());
        const b = byName.get((item.to ?? "").trim());
        if (!a || !b || a.id === b.id) continue;
        await facesDb.putRelation({
          id: crypto.randomUUID(),
          fromId: a.id,
          toId: b.id,
          label: (item.label ?? "").trim() || t("认识"),
          mutual: inferMutual((item.label ?? "").trim()),
          note: item.note,
          createdAt: Date.now(),
          source: makeSource("ai", t("资料整理")),
        });
        links += 1;
      }

      let docs = 0;
      for (const item of draft.evidence ?? []) {
        const body = (item.text ?? "").trim();
        if (!body) continue;
        const kind = item.kind === "audio" || item.kind === "exhibit" || item.kind === "frame" ? item.kind : "note";
        await facesDb.putEvidence({
          id: crypto.randomUUID(),
          kind,
          title: (item.title ?? "").trim() || t("未命名材料"),
          text: body,
          origin: item.origin,
          linkedPersonIds: (draft.people ?? [])
            .map((person) => byName.get((person.name ?? "").trim())?.id)
            .filter((id): id is string => Boolean(id)),
          createdAt: Date.now(),
          source: makeSource("ai", t("资料整理")),
        });
        docs += 1;
      }

      let jobs = 0;
      for (const item of draft.projects ?? []) {
        const title = (item.title ?? "").trim();
        if (!title) continue;
        const ownerName = (item.owner ?? "").trim();
        const owner = ownerName ? byName.get(ownerName) : undefined;
        const status = (["planned", "active", "blocked", "done"] as const).includes(
          item.status as "planned",
        )
          ? (item.status as "planned" | "active" | "blocked" | "done")
          : "planned";
        const priority = (["high", "normal", "low"] as const).includes(item.priority as "high")
          ? (item.priority as "high" | "normal" | "low")
          : "normal";
        await facesDb.putProject({
          id: crypto.randomUUID(),
          title,
          detail: item.detail || undefined,
          department: item.department || undefined,
          ownerId: owner?.id ?? null,
          ownerName: ownerName || undefined,
          memberIds: (item.members ?? [])
            .map((name) => byName.get(name.trim())?.id)
            .filter((id): id is string => Boolean(id)),
          status,
          priority,
          due: item.due || undefined,
          tags: item.tags?.length ? item.tags : undefined,
          createdAt: Date.now(),
          source: makeSource("ai", t("资料整理")),
        });
        jobs += 1;
      }

      setDraft(null);
      setRaw("");
      setSupplement("");
      setAttached([]);
      setStashedAt(null);
      try {
        window.localStorage.removeItem(DRAFT_KEY);
      } catch {
        /* ignore */
      }
      setKnown([...byName.keys()]);
      toast.success(
        `${t("新建")} ${created} · ${t("更新")} ${updated} · ${t("关系")} ${links} · ${t("事务")} ${jobs} · ${t("材料")} ${docs}`,
      );

    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const gaps = (draft?.people ?? []).flatMap((person) =>
    missingOf(person).map((field) => `${person.name || t("未命名")} · ${getLang() === "en" ? field.en : field.zh}`),
  );

  return (
    <section className="flex min-w-0 flex-col gap-5">
      <div className="rounded-2xl border border-border bg-card/60 p-5">
        <h2 className="flex items-baseline gap-2.5">
          <span className="font-display text-xl leading-none tracking-tight">{t("随手写，AI 来整理")}</span>
          <span className="text-[10px] uppercase tracking-[0.24em] text-muted-foreground">Intake</span>
        </h2>
        <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
          {t("不用一格一格填表。把你知道的人和事一口气写下来，人物、关系、待办会自动拆好，缺的内容会提醒你补。")}
        </p>
        <ul className="mt-2 list-inside list-disc space-y-1 text-[11px] text-muted-foreground">
          <li>
            {t("写人：小雨，大学室友，3 月 12 日生日，爱喝手冲咖啡、不吃香菜，现在在杭州做产品。")}
          </li>
          <li>
            {t("写待办：下周去看外婆，顺便帮她换手机卡，5 月 30 日前。")}
          </li>
        </ul>

        <Textarea
          value={raw}
          onChange={(event) => setRaw(event.target.value)}
          rows={8}
          className="mt-4 text-sm"
          placeholder=""
        />


        <p className="mt-1.5 text-[10px] text-muted-foreground">
          {stashedAt
            ? `${t("已自动暂存")} · ${new Date(stashedAt).toLocaleTimeString()}`
            : t("每 15 秒自动暂存，切到别的页签再回来内容还在")}
        </p>


        {attached.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {attached.map((item, index) => (
              <span
                key={`${item.name}-${index}`}
                className="flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[10px] text-muted-foreground"
              >
                <Paperclip className="size-3" aria-hidden="true" />
                {item.name}
                <button
                  type="button"
                  aria-label={t("移除这份文件")}
                  className="rounded-full p-0.5 hover:bg-muted hover:text-foreground"
                  onClick={() => removeAttached(index)}
                >
                  <X className="size-3" aria-hidden="true" />
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button className="rounded-full px-5" onClick={() => void organize()} disabled={busy || !!reading}>
            {busy ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <Sparkles className="size-3.5" aria-hidden="true" />
            )}
            {t("AI 整理成档案")}
          </Button>
          <input
            ref={fileRef}
            type="file"
            multiple
            accept="image/*,.pdf,.docx,.txt,.md,.csv,.json"
            className="hidden"
            onChange={(event) => void pickFiles(event.target.files)}
          />
          <Button
            variant="outline"
            className="rounded-full px-4"
            disabled={!!reading || busy}
            onClick={() => fileRef.current?.click()}
          >
            {reading ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <Paperclip className="size-3.5" aria-hidden="true" />
            )}
            {t("上传简历 / 截图 / PDF")}
          </Button>
          <span className="text-[11px] text-muted-foreground">{t("也可以直接 Ctrl/⌘+V 粘贴截图或文件")}</span>
          {draft && (
            <Button variant="ghost" className="rounded-full px-4" onClick={() => setDraft(null)}>
              <X className="size-3.5" aria-hidden="true" />
              {t("丢弃草稿")}
            </Button>
          )}
        </div>
        {reading && (
          <div className="mt-2 space-y-1">
            <Progress value={progress} className="h-1.5" />
            <p className="text-[11px] text-muted-foreground">
              {reading}… {progress}%
            </p>
          </div>
        )}
        {busy && !reading && (
          <div className="mt-2 space-y-1">
            <div className="h-1.5 overflow-hidden rounded-full bg-muted">
              <div className="h-full w-1/3 animate-[pulse_1.2s_ease-in-out_infinite] rounded-full bg-primary" />
            </div>
            <p className="text-[11px] text-muted-foreground">{t("AI 正在整理")}…</p>
          </div>
        )}

      </div>

      {draft && (
        <div className="space-y-4 rounded-2xl border border-border bg-card/60 p-5">
          {draft.summary && (
            <p className="text-[11px] leading-relaxed text-muted-foreground">{draft.summary}</p>
          )}

          {gaps.length > 0 && (
            <div className="rounded-xl border border-primary/40 bg-primary/5 p-3">
              <p className="flex items-center gap-1.5 text-sm font-medium">
                <TriangleAlert className="size-4 text-primary" aria-hidden="true" />
                {t("这些必要信息还缺")}
              </p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {gaps.map((gap) => (
                  <span key={gap} className="rounded-full border border-border px-2 py-0.5 text-[10px]">
                    {gap}
                  </span>
                ))}
              </div>
              <Textarea
                value={supplement}
                onChange={(event) => setSupplement(event.target.value)}
                rows={3}
                className="mt-3 text-sm"
                placeholder={t("补一句就行，例：小雨微信 xiaoyu_0312，生日 3 月 12 日，爱喝手冲咖啡")}
              />
              <Button
                variant="outline"
                className="mt-2 rounded-full px-4"
                disabled={busy || !supplement.trim()}
                onClick={() => void organize(supplement.trim())}
              >
                {busy ? (
                  <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <Sparkles className="size-3.5" aria-hidden="true" />
                )}
                {t("补充并重新整理")}
              </Button>
            </div>
          )}

          <div className="space-y-3">
            {(draft.people ?? []).map((person, index) => (
              <div key={`${person.name}-${index}`} className="rounded-xl border border-border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    value={person.name ?? ""}
                    onChange={(event) => patchPerson(index, { name: event.target.value })}
                    className="h-8 w-40 text-sm"
                    placeholder={t("姓名")}
                  />
                  <button
                    type="button"
                    className="order-last ml-auto text-muted-foreground transition-colors hover:text-destructive"
                    onClick={() => removePerson(index)}
                  >
                    <Trash2 className="size-3.5" aria-hidden="true" />
                  </button>
                  {missingOf(person).map((field) => (
                    <span
                      key={String(field.key)}
                      className="rounded-full border border-primary/50 px-2 py-0.5 text-[10px] text-primary"
                    >
                      {t("缺")} {getLang() === "en" ? field.en : field.zh}
                    </span>
                  ))}
                </div>
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  {(
                    [
                      ["relation", t("和我的关系")],
                      ["birthday", t("生日")],
                      ["contact", t("联系方式")],
                      ["circle", t("圈子")],
                    ] as Array<[keyof DraftPerson, string]>
                  ).map(([key, label]) => (
                    <Input
                      key={String(key)}
                      value={(person[key] as string) ?? ""}
                      onChange={(event) => patchPerson(index, { [key]: event.target.value })}
                      className="h-8 text-xs"
                      placeholder={label}
                    />
                  ))}
                </div>
                <Textarea
                  value={person.note ?? ""}
                  onChange={(event) => patchPerson(index, { note: event.target.value })}
                  rows={2}
                  className="mt-2 text-xs"
                  placeholder={t("备注")}
                />
              </div>
            ))}
          </div>

          <DraftGraph
            people={draft.people ?? []}
            relations={(draft.relations ?? []).map((r) => ({
              from: r.from ?? "",
              to: r.to ?? "",
              label: r.label ?? "",
            }))}
            onAddPerson={(name) =>
              setDraft((prev) => ({ ...(prev ?? {}), people: [...(prev?.people ?? []), { name }] }))
            }
            onAddRelation={(from, to, label) =>
              setDraft((prev) => ({
                ...(prev ?? {}),
                relations: [...(prev?.relations ?? []), { from, to, label }],
              }))
            }
            onPatchRelation={(index, label) => patchRelation(index, { label })}
            onRemoveRelation={removeRelation}
          />

          {(draft.relations ?? []).length > 0 && (

            <div className="space-y-2">
              {(draft.relations ?? []).map((relation, index) => (
                <div
                  key={index}
                  className="flex flex-wrap items-center gap-2 rounded-xl border border-border p-2"
                >
                  <Input
                    value={relation.from ?? ""}
                    onChange={(event) => patchRelation(index, { from: event.target.value })}
                    className="h-8 w-28 text-xs"
                    placeholder={t("谁")}
                  />
                  <ArrowRight className="size-3.5 shrink-0 text-primary" aria-hidden="true" />
                  <Input
                    value={relation.label ?? ""}
                    onChange={(event) => patchRelation(index, { label: event.target.value })}
                    className="h-8 w-32 text-xs"
                    placeholder={t("关系")}
                  />
                  <ArrowRight className="size-3.5 shrink-0 text-primary" aria-hidden="true" />
                  <Input
                    value={relation.to ?? ""}
                    onChange={(event) => patchRelation(index, { to: event.target.value })}
                    className="h-8 w-28 text-xs"
                    placeholder={t("对谁")}
                  />
                  <button
                    type="button"
                    className="ml-auto text-muted-foreground transition-colors hover:text-destructive"
                    onClick={() => removeRelation(index)}
                  >
                    <Trash2 className="size-3.5" aria-hidden="true" />
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="space-y-2 rounded-xl border border-dashed border-border p-3">
            <div className="flex items-center gap-2">
              <Briefcase className="size-3.5 text-primary" aria-hidden="true" />
              <span className="text-xs font-medium">
                {t("事务草稿")} · {(draft.projects ?? []).length}
              </span>
              <Button variant="ghost" size="sm" className="ml-auto h-7 rounded-full px-3 text-xs" onClick={addProject}>
                <Plus className="size-3.5" aria-hidden="true" />
                {t("加一条事务")}
              </Button>
            </div>
            {(draft.projects ?? []).length === 0 && (
              <p className="text-[11px] text-muted-foreground">
                {t("材料里没读到事务，可以手动补一条：事务名称、负责人、参与人、截止日期。")}
              </p>
            )}
            {(draft.projects ?? []).map((project, index) => (
              <div key={index} className="space-y-2 rounded-xl border border-border p-3">
                <div className="flex items-center gap-2">
                  <Input
                    value={project.title ?? ""}
                    onChange={(event) => patchProject(index, { title: event.target.value })}
                    className="h-8 flex-1 text-sm"
                    placeholder={t("事务名称")}
                  />
                  <button
                    type="button"
                    className="shrink-0 text-muted-foreground transition-colors hover:text-destructive"
                    onClick={() => removeProject(index)}
                  >
                    <Trash2 className="size-3.5" aria-hidden="true" />
                  </button>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  <Input
                    value={project.owner ?? ""}
                    onChange={(event) => patchProject(index, { owner: event.target.value })}
                    className="h-8 text-xs"
                    placeholder={t("负责人")}
                  />
                  <Input
                    value={(project.members ?? []).join("、")}
                    onChange={(event) =>
                      patchProject(index, {
                        members: event.target.value
                          .split(/[、,，\s]+/)
                          .map((name) => name.trim())
                          .filter(Boolean),
                      })
                    }
                    className="h-8 text-xs"
                    placeholder={t("参与人（顿号分隔）")}
                  />
                  <Input
                    value={project.department ?? ""}
                    onChange={(event) => patchProject(index, { department: event.target.value })}
                    className="h-8 text-xs"
                    placeholder={t("归属部门")}
                  />
                  <Input
                    value={project.due ?? ""}
                    onChange={(event) => patchProject(index, { due: event.target.value })}
                    className="h-8 text-xs"
                    placeholder={t("截止 yyyy-mm-dd")}
                  />
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {(
                    [
                      ["planned", t("待启动")],
                      ["active", t("进行中")],
                      ["blocked", t("受阻")],
                      ["done", t("已完成")],
                    ] as Array<[string, string]>
                  ).map(([id, label]) => (
                    <button
                      key={id}
                      type="button"
                      onClick={() => patchProject(index, { status: id })}
                      className={cn(
                        "rounded-full border px-2.5 py-0.5 text-[10px] transition-colors",
                        (project.status ?? "planned") === id
                          ? "border-primary bg-primary/10 text-primary"
                          : "border-border text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {label}
                    </button>
                  ))}
                  <span className="mx-1 text-[10px] text-muted-foreground">|</span>
                  {(
                    [
                      ["high", t("高")],
                      ["normal", t("中")],
                      ["low", t("低")],
                    ] as Array<[string, string]>
                  ).map(([id, label]) => (
                    <button
                      key={id}
                      type="button"
                      onClick={() => patchProject(index, { priority: id })}
                      className={cn(
                        "rounded-full border px-2.5 py-0.5 text-[10px] transition-colors",
                        (project.priority ?? "normal") === id
                          ? "border-primary bg-primary/10 text-primary"
                          : "border-border text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <Textarea
                  value={project.detail ?? ""}
                  onChange={(event) => patchProject(index, { detail: event.target.value })}
                  rows={2}
                  className="text-xs"
                  placeholder={t("事务说明")}
                />
              </div>
            ))}
          </div>


          {(draft.evidence ?? []).length > 0 && (
            <div className="space-y-2">
              {(draft.evidence ?? []).map((item, index) => (
                <div key={index} className="space-y-2 rounded-xl border border-dashed border-border p-3">
                  <div className="flex items-center gap-2">
                    <Input
                      value={item.title ?? ""}
                      onChange={(event) => patchEvidence(index, { title: event.target.value })}
                      className="h-8 flex-1 text-sm"
                      placeholder={t("材料标题")}
                    />
                    <button
                      type="button"
                      className="shrink-0 text-muted-foreground transition-colors hover:text-destructive"
                      onClick={() => removeEvidence(index)}
                    >
                      <Trash2 className="size-3.5" aria-hidden="true" />
                    </button>
                  </div>
                  <Textarea
                    value={item.text ?? ""}
                    onChange={(event) => patchEvidence(index, { text: event.target.value })}
                    rows={3}
                    className="text-xs"
                    placeholder={t("材料正文")}
                  />
                </div>
              ))}
            </div>
          )}

          <Button className="rounded-full px-5" onClick={() => void commit()} disabled={saving}>
            {saving ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <Check className="size-3.5" aria-hidden="true" />
            )}
            {t("确认入库")}
          </Button>
        </div>
      )}
    </section>
  );
}
