import { Loader2, Mic, Square, Trash2, Upload, Waves } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { SourceBadge } from "@/components/source-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { startRecording, type Recorder } from "@/lib/audio-client";
import { facesDb, type PersonRecord, type VoiceprintRecord } from "@/lib/face-db";
import { getLang, t } from "@/lib/i18n";
import { makeSource } from "@/lib/provenance";
import {
  extractVoiceEmbedding,
  voiceSimilarity,
  VOICE_MATCH_THRESHOLD,
  VOICE_MAYBE_THRESHOLD,
} from "@/lib/voice-engine";

interface Pending {
  vector: number[];
  durationMs: number;
  best: { record: VoiceprintRecord; score: number } | null;
}

export function VoiceprintPanel() {
  const [prints, setPrints] = useState<VoiceprintRecord[]>([]);
  const [people, setPeople] = useState<PersonRecord[]>([]);
  const [pending, setPending] = useState<Pending | null>(null);
  const [name, setName] = useState("");
  const [personId, setPersonId] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const recorderRef = useRef<Recorder | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    const [v, p] = await Promise.all([facesDb.listVoiceprints(), facesDb.listPersons()]);
    setPrints(v);
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

  const analyse = async (blob: Blob) => {
    setBusy(true);
    try {
      const embedding = await extractVoiceEmbedding(blob);
      const existing = await facesDb.listVoiceprints();
      let best: Pending["best"] = null;
      for (const record of existing) {
        const score = voiceSimilarity(embedding.vector, record.vector);
        if (!best || score > best.score) best = { record, score };
      }
      setPending({ vector: embedding.vector, durationMs: embedding.durationMs, best });
      if (best && best.score >= VOICE_MAYBE_THRESHOLD) {
        setName(best.record.name);
        setPersonId(best.record.personId ?? "");
      }
      toast.success(t("声纹已提取"));
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const toggleRecording = async () => {
    if (recording) {
      const recorder = recorderRef.current;
      recorderRef.current = null;
      setRecording(false);
      if (!recorder) return;
      await analyse(await recorder.stop());
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
    if (!pending) return;
    const label = name.trim() || people.find((person) => person.id === personId)?.name || "";
    if (!label) {
      toast.error(t("请填写说话人名称"));
      return;
    }
    await facesDb.putVoiceprint({
      id: crypto.randomUUID(),
      personId: personId || null,
      name: label,
      vector: pending.vector,
      durationMs: pending.durationMs,
      createdAt: Date.now(),
      source: makeSource("voice", `${Math.round(pending.durationMs / 1000)}s`),
    });
    setPending(null);
    setName("");
    setPersonId("");
    await refresh();
    toast.success(t("声纹样本已入库"));
  };

  const verdict = (score: number) =>
    score >= VOICE_MATCH_THRESHOLD
      ? t("疑似同一说话人")
      : score >= VOICE_MAYBE_THRESHOLD
        ? t("存疑，需人工复核")
        : t("与库内样本都不像");

  return (
    <div className="space-y-4 pt-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant={recording ? "destructive" : "outline"}
          className="rounded-full px-4"
          onClick={() => void toggleRecording()}
          disabled={busy && !recording}
        >
          {recording ? (
            <>
              <Square className="size-3.5" aria-hidden="true" />
              {t("停止并提取声纹")} · {seconds}s
            </>
          ) : (
            <>
              <Mic className="size-3.5" aria-hidden="true" />
              {t("录一段声纹")}
            </>
          )}
        </Button>
        <Button
          type="button"
          variant="outline"
          className="rounded-full px-4"
          onClick={() => fileRef.current?.click()}
          disabled={busy}
        >
          <Upload className="size-3.5" aria-hidden="true" />
          {t("上传录音比对")}
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept="audio/*"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void analyse(file);
          }}
        />
        {busy && (
          <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
            {t("分析中")}
          </span>
        )}
      </div>

      {pending && (
        <div className="space-y-3 rounded-xl border border-primary/40 bg-primary/5 p-3">
          <p className="flex items-center gap-1.5 text-sm font-medium">
            <Waves className="size-4 text-primary" aria-hidden="true" />
            {t("本次样本")} · {Math.round(pending.durationMs / 1000)}s
          </p>
          {pending.best ? (
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              {t("最接近")}：<span className="text-foreground">{pending.best.record.name}</span> ·{" "}
              {t("相似度")} {pending.best.score.toFixed(3)} · {verdict(pending.best.score)}
            </p>
          ) : (
            <p className="text-[11px] text-muted-foreground">{t("声纹库还是空的，这是第一条样本")}</p>
          )}

          <div className="flex flex-col gap-2 sm:flex-row">
            <select
              value={personId}
              onChange={(event) => {
                setPersonId(event.target.value);
                const person = people.find((item) => item.id === event.target.value);
                if (person) setName(person.name);
              }}
              className="h-9 rounded-md border border-border bg-background px-3 text-xs outline-none"
            >
              <option value="">{t("不关联档案")}</option>
              {people.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.name}
                </option>
              ))}
            </select>
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={t("说话人名称")}
            />
            <Button className="rounded-full px-5" onClick={() => void save()}>
              {t("存为声纹样本")}
            </Button>
          </div>
        </div>
      )}

      <p className="rounded-lg border border-dashed border-border p-3 text-[11px] leading-relaxed text-muted-foreground">
        {t("声纹为本机统计式近似特征，只能提示「疑似同一说话人」，不具备司法鉴定效力，不能单独作为证据。")}
      </p>

      {prints.length === 0 ? (
        <p className="py-8 text-center text-xs text-muted-foreground">{t("还没有声纹样本")}</p>
      ) : (
        <div className="space-y-2">
          {prints.map((record) => (
            <div
              key={record.id}
              className="flex items-center justify-between gap-3 rounded-xl border border-border p-3"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{record.name}</p>
                <p className="text-[10px] text-muted-foreground">
                  {Math.round(record.durationMs / 1000)}s · {new Date(record.createdAt).toLocaleString()}
                  {record.personId ? ` · ${getLang() === "en" ? "linked" : "已关联档案"}` : ""}
                </p>
                <div className="mt-1">
                  <SourceBadge source={record.source} />
                </div>
              </div>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-destructive"
                onClick={async () => {
                  await facesDb.deleteVoiceprint(record.id);
                  await refresh();
                }}
              >
                <Trash2 className="size-3.5" aria-hidden="true" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
