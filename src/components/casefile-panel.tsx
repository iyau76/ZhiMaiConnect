import {
  FileText,
  Loader2,
  Mic,
  Package,
  Square,
  Trash2,
  Upload,
  Sparkles,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  facesDb,
  type EvidenceKind,
  type EvidenceRecord,
  type PersonRecord,
} from "@/lib/face-db";
import { getLang, t } from "@/lib/i18n";
import { SPEECH_VARIANTS } from "@/lib/dialects";
import { makeSource } from "@/lib/provenance";
import { SourceBadge } from "@/components/source-badge";
import { VoiceprintPanel } from "@/components/voiceprint-panel";
import { startRecording, transcribeAudio, type Recorder, type SttLang } from "@/lib/audio-client";
import { askModel } from "@/lib/vision-client";
import { inferMutual } from "@/lib/relation-kind";
import type { ProviderPreset } from "@/lib/vision-providers";

interface Props {
  preset: ProviderPreset;
  /** 多模态辅助模型：录音转写用它 */
  audioPreset?: ProviderPreset;
}

const EXTRACT_PROMPT = `你是办案信息整理助手。用户会给你一段材料（询问笔录 / 录音转写 / 物证登记说明）。
只输出 JSON，不要解释、不要代码块标记，结构如下：
{"entities":[{"type":"人物|地点|物品|时间|组织","value":"原文中的表述"}],
 "people":[{"name":"姓名","note":"这段材料里关于此人的信息"}],
 "relations":[{"from":"姓名A","to":"姓名B","label":"关系，如同事/亲属/雇佣"}],
 "summary":"两三句话概括这份材料"}
严格只写材料里出现的内容，不要推测、不要编造。关系里的人必须也出现在 people 里。`;

const EXTRACT_PROMPT_EN = `You organise case material. The user gives you one document (interview record / audio transcript / exhibit registration note).
Output JSON only, no explanation and no code fences:
{"entities":[{"type":"person|place|item|time|organisation","value":"as written in the text"}],
 "people":[{"name":"name","note":"what this material says about them"}],
 "relations":[{"from":"name A","to":"name B","label":"relation, e.g. colleague/relative/employer"}],
 "summary":"two or three sentences summarising the material"}
Only include what the material states. Do not speculate. Everyone in relations must appear in people. Write values in English.`;

interface Extracted {
  entities?: Array<{ type?: string; value?: string }>;
  people?: Array<{ name?: string; note?: string }>;
  relations?: Array<{ from?: string; to?: string; label?: string }>;
  summary?: string;
}

function parseJson(text: string): Extracted {
  const cleaned = text.replace(/^\s*```(?:json)?/i, "").replace(/```\s*$/, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error(t("AI 没有返回可解析的内容"));
  return JSON.parse(cleaned.slice(start, end + 1)) as Extracted;
}

const KIND_META: Record<EvidenceKind, { label: string; icon: typeof FileText }> = {
  audio: { label: "录音转写", icon: Mic },
  note: { label: "笔录", icon: FileText },
  exhibit: { label: "物证", icon: Package },
  frame: { label: "抓拍", icon: Package },
};

export function CasefilePanel({ preset, audioPreset }: Props) {
  const [records, setRecords] = useState<EvidenceRecord[]>([]);
  const [people, setPeople] = useState<PersonRecord[]>([]);
  const [kind, setKind] = useState<EvidenceKind>("note");
  const [title, setTitle] = useState("");
  const [origin, setOrigin] = useState("");
  const [uploader, setUploader] = useState("");

  useEffect(() => {
    try {
      setUploader(localStorage.getItem("openglass.officer") ?? "");
    } catch {
      /* ignore */
    }
  }, []);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [sttLang, setSttLang] = useState<SttLang>("auto");
  /** 正文是否来自转写（决定归档时标什么来源） */
  const [audioOrigin, setAudioOrigin] = useState<string | null>(null);
  const recorderRef = useRef<Recorder | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);


  const refresh = useCallback(async () => {
    const [e, p] = await Promise.all([facesDb.listEvidence(), facesDb.listPersons()]);
    setRecords(e);
    setPeople(p);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!recording) return;
    const timer = setInterval(() => setSeconds((prev) => prev + 1), 1000);
    return () => clearInterval(timer);
  }, [recording]);

  const runTranscription = async (blob: Blob, filename?: string) => {
    setBusy(t("转写中"));
    try {
      const result = await transcribeAudio(blob, {
        preset: audioPreset ?? preset,
        filename,
        language: sttLang,
        hint: people.map((person) => person.name).join("、").slice(0, 300) || undefined,
      });

      if (!result) throw new Error(t("没有识别到语音内容"));
      setKind("audio");
      setAudioOrigin(filename ?? "recording");
      setText((prev) => (prev ? `${prev}\n${result}` : result));
      if (!title.trim()) setTitle(filename || `${t("录音转写")} ${new Date().toLocaleString()}`);
      toast.success(t("转写完成"));
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const toggleRecording = async () => {
    if (recording) {
      const recorder = recorderRef.current;
      recorderRef.current = null;
      setRecording(false);
      if (!recorder) return;
      const blob = await recorder.stop();
      await runTranscription(blob, `recording-${Date.now()}.webm`);
      return;
    }
    try {
      recorderRef.current = await startRecording();
      setSeconds(0);
      setRecording(true);
    } catch (error) {
      toast.error((error as Error).message);
    }
  };

  const save = async () => {
    const content = text.trim();
    if (!content) {
      toast.error(t("材料内容不能为空"));
      return;
    }
    const record: EvidenceRecord = {
      id: crypto.randomUUID(),
      kind,
      title: title.trim() || `${KIND_META[kind].label} ${new Date().toLocaleString()}`,
      text: content,
      origin: origin.trim() || undefined,
      uploader: uploader.trim() || undefined,
      speechVariant: audioOrigin ? sttLang : undefined,
      createdAt: Date.now(),
      source: audioOrigin
        ? makeSource(
            "audio",
            [audioOrigin, origin.trim(), uploader.trim() && `${t("上传人")}：${uploader.trim()}`]
              .filter(Boolean)
              .join(" · "),
          )
        : makeSource(
            "manual",
            [origin.trim(), uploader.trim() && `${t("上传人")}：${uploader.trim()}`]
              .filter(Boolean)
              .join(" · ") || undefined,
          ),
    };
    await facesDb.putEvidence(record);
    setTitle("");
    setOrigin("");
    setText("");
    setAudioOrigin(null);
    await refresh();
    toast.success(t("材料已归档"));
  };


  /** 从一条材料里抽实体 → 写回人物库和关系网，并记录来源 */
  const extract = async (record: EvidenceRecord) => {
    setBusy(record.id);
    let answer = "";
    try {
      const en = getLang() === "en";
      await askModel(
        preset,
        `${en ? EXTRACT_PROMPT_EN : EXTRACT_PROMPT}\n\n${en ? "Known people" : "已有的人"}: ${
          people.map((person) => person.name).join(en ? ", " : "、") || (en ? "none" : t("无"))
        }\n\n${en ? "Material" : "材料"}（${record.title}）：\n${record.text}`,
        null,
        [],
        (chunk) => {
          answer += chunk;
        },
        new AbortController().signal,
      );
      const parsed = parseJson(answer);

      const current = await facesDb.listPersons();
      const byName = new Map(current.map((person) => [person.name, person]));
      const linked: string[] = [];
      let created = 0;

      for (const item of parsed.people ?? []) {
        const name = (item.name ?? "").trim();
        if (!name) continue;
        const exist = byName.get(name);
        if (exist) {
          if (item.note && !exist.note.includes(item.note)) {
            await facesDb.putPerson({
              ...exist,
              note: [exist.note, item.note].filter(Boolean).join("；"),
            });
          }
          linked.push(exist.id);
          continue;
        }
        const person: PersonRecord = {
          id: crypto.randomUUID(),
          name,
          note: item.note ?? "",
          rawProfileText: item.note ?? "",
          descriptors: [],
          thumb: "",
          createdAt: Date.now(),
          source: makeSource("ai", record.title, record.id),
        };
        await facesDb.putPerson(person);
        byName.set(name, person);
        linked.push(person.id);
        created += 1;
      }

      let links = 0;
      for (const item of parsed.relations ?? []) {
        const a = byName.get((item.from ?? "").trim());
        const b = byName.get((item.to ?? "").trim());
        if (!a || !b || a.id === b.id) continue;
        await facesDb.putRelation({
          id: crypto.randomUUID(),
          fromId: a.id,
          toId: b.id,
          label: (item.label ?? "").trim() || t("认识"),
          mutual: inferMutual((item.label ?? "").trim()),
          note: record.title,
          sourceId: record.id,
          createdAt: Date.now(),
          source: makeSource("ai", record.title, record.id),
        });
        links += 1;
      }


      await facesDb.putEvidence({
        ...record,
        entities: (parsed.entities ?? [])
          .map((entity) => ({ type: entity.type ?? "", value: entity.value ?? "" }))
          .filter((entity) => entity.value),
        linkedPersonIds: linked,
        origin: record.origin,
        text: parsed.summary ? record.text : record.text,
      });
      await refresh();
      toast.success(`${t("新建档案")} ${created} · ${t("新增关系")} ${links}`);
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const remove = async (record: EvidenceRecord) => {
    await facesDb.deleteEvidence(record.id);
    await refresh();
  };

  return (
    <section className="flex min-w-0 flex-col gap-5 rounded-2xl border border-border bg-card/60 p-5">
      <header className="flex items-center justify-between gap-3">
        <h2 className="flex items-baseline gap-2.5">
          <span className="font-display text-xl leading-none tracking-tight">{t("卷宗")}</span>
          <span className="text-[10px] uppercase tracking-[0.24em] text-muted-foreground">Evidence</span>
        </h2>
        <span className="text-[11px] text-muted-foreground">
          {records.length} {t("条材料")}
        </span>
      </header>

      <Tabs defaultValue="new">
        <TabsList>
          <TabsTrigger value="new">{t("录入")}</TabsTrigger>
          <TabsTrigger value="list">{t("已归档")}</TabsTrigger>
          <TabsTrigger value="voice">{t("声纹")}</TabsTrigger>
        </TabsList>

        <TabsContent value="voice">
          <VoiceprintPanel />
        </TabsContent>


        <TabsContent value="new" className="space-y-4 pt-4">
          <div className="flex flex-wrap gap-1.5">
            {(Object.keys(KIND_META) as EvidenceKind[])
              .filter((item) => item !== "frame")
              .map((item) => (
                <Button
                  key={item}
                  type="button"
                  size="sm"
                  variant={kind === item ? "default" : "outline"}
                  className="rounded-full px-4 text-xs"
                  onClick={() => setKind(item)}
                >
                  {t(KIND_META[item].label)}
                </Button>
              ))}
          </div>

          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder={t("材料标题，如 5月1日询问笔录")}
            />
            <Input
              value={origin}
              onChange={(event) => setOrigin(event.target.value)}
              placeholder={t("来源：从哪来的，如 现场勘查 / 物证编号 A-013")}
            />
            <Input
              value={uploader}
              onChange={(event) => {
                setUploader(event.target.value);
                try {
                  localStorage.setItem("openglass.officer", event.target.value);
                } catch {
                  /* ignore */
                }
              }}
              placeholder={t("上传人：谁登记的")}
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] text-muted-foreground">{t("语音语言 / 方言")}</span>
            <select
              value={sttLang}
              onChange={(event) => setSttLang(event.target.value)}
              className="h-8 rounded-full border border-border bg-background px-3 text-[11px] outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              {SPEECH_VARIANTS.map((variant) => (
                <option key={variant.id} value={variant.id}>
                  {getLang() === "en" ? variant.en : variant.zh}
                </option>
              ))}
            </select>
            <span className="text-[10px] text-muted-foreground">
              {t("方言通过提示词引导，口音重时手动选更准")}
            </span>
          </div>


          <div className="flex flex-wrap items-center gap-2">

            <Button
              type="button"
              variant={recording ? "destructive" : "outline"}
              className="rounded-full px-4"
              onClick={() => void toggleRecording()}
              disabled={busy !== null && !recording}
            >
              {recording ? (
                <>
                  <Square className="size-3.5" aria-hidden="true" />
                  {t("停止并转写")} · {seconds}s
                </>
              ) : (
                <>
                  <Mic className="size-3.5" aria-hidden="true" />
                  {t("现场录音")}
                </>
              )}
            </Button>
            <Button
              type="button"
              variant="outline"
              className="rounded-full px-4"
              onClick={() => fileRef.current?.click()}
              disabled={busy !== null}
            >
              <Upload className="size-3.5" aria-hidden="true" />
              {t("上传录音文件")}
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept="audio/*"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void runTranscription(file, file.name);
              }}
            />
            {busy === t("转写中") && (
              <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                {t("转写中")}
              </span>
            )}
          </div>

          <Textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            rows={8}
            placeholder={t("转写稿会出现在这里，也可以直接粘贴笔录或手写物证描述")}
          />

          <Button onClick={() => void save()} className="rounded-full px-5">
            {t("归档")}
          </Button>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {t("录音只在本机录制，转写后音频不保存；文字材料存在浏览器本地库里。")}
          </p>
        </TabsContent>

        <TabsContent value="list" className="space-y-3 pt-4">
          {records.length === 0 ? (
            <p className="py-10 text-center text-xs text-muted-foreground">{t("还没有归档任何材料")}</p>
          ) : (
            records.map((record) => {
              const Icon = KIND_META[record.kind].icon;
              return (
                <div key={record.id} className="space-y-2 rounded-xl border border-border p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="flex items-center gap-1.5 truncate text-sm font-medium">
                        <Icon className="size-3.5 shrink-0 text-primary" aria-hidden="true" />
                        {record.title}
                      </p>
                      <p className="text-[10px] text-muted-foreground">
                        {t(KIND_META[record.kind].label)} ·{" "}
                        {new Date(record.createdAt).toLocaleString()}
                        {record.origin ? ` · ${record.origin}` : ""}
                        {record.uploader ? ` · ${t("上传人")} ${record.uploader}` : ""}
                      </p>
                      <div className="mt-1 flex flex-wrap gap-1">
                        <SourceBadge source={record.source} detailed />
                        {record.speechVariant && record.speechVariant !== "auto" && (
                          <span className="rounded-full border border-border px-2 py-0.5 text-[10px] text-muted-foreground">
                            {getLang() === "en"
                              ? SPEECH_VARIANTS.find((item) => item.id === record.speechVariant)?.en
                              : SPEECH_VARIANTS.find((item) => item.id === record.speechVariant)?.zh}
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="flex shrink-0 gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-[11px]"
                        title={t("让 AI 把这段材料里出现的人物、地点、物品、时间、组织挑出来做成标签，方便检索和对上人物档案")}
                        disabled={busy !== null}
                        onClick={() => void extract(record)}
                      >
                        {busy === record.id ? (
                          <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                        ) : (
                          <Sparkles className="size-3.5" aria-hidden="true" />
                        )}
                        {t("抽取实体")}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-destructive"
                        onClick={() => void remove(record)}
                      >
                        <Trash2 className="size-3.5" aria-hidden="true" />
                      </Button>
                    </div>
                  </div>

                  <p className="line-clamp-4 whitespace-pre-wrap text-[11px] leading-relaxed text-muted-foreground">
                    {record.text}
                  </p>

                  {record.entities && record.entities.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {record.entities.map((entity, index) => (
                        <span
                          key={`${entity.value}-${index}`}
                          className="rounded-full border border-border px-2 py-0.5 text-[10px] text-muted-foreground"
                        >
                          {entity.type}·{entity.value}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </TabsContent>
      </Tabs>
    </section>
  );
}
