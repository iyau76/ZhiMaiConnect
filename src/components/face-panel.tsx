import {
  Database,
  ImagePlus,
  Loader2,
  Pencil,
  ScanFace,
  Sparkles,
  Trash2,
  UserPlus,
  Wand2,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { normalizeHost } from "@/components/camera-panel";
import { PersonProfileDialog } from "@/components/person-profile-dialog";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { makeSource } from "@/lib/provenance";
import { facesDb, type PersonRecord, type SightingRecord } from "@/lib/face-db";
import { detectFaces, findMatch, loadFaceEngine, type DetectedFace } from "@/lib/face-engine";
import { askModel, captureFrame } from "@/lib/vision-client";
import type { ProviderPreset } from "@/lib/vision-providers";
import { cn } from "@/lib/utils";
import { getLang, t } from "@/lib/i18n";

interface FacePanelProps {
  host: string;
  preset: ProviderPreset;
  onUseFrame: (frame: string) => void;
}

interface Annotated extends DetectedFace {
  personId: string | null;
  name: string;
  distance: number;
}

export function FacePanel({ host, preset, onUseFrame }: FacePanelProps) {
  const [engineState, setEngineState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [engineNote, setEngineNote] = useState("");
  const [scanning, setScanning] = useState(false);
  const [auto, setAuto] = useState(false);
  const [threshold, setThreshold] = useState(0.5);
  const [shot, setShot] = useState<{ frame: string; width: number; height: number } | null>(null);
  const [faces, setFaces] = useState<Annotated[]>([]);
  const [people, setPeople] = useState<PersonRecord[]>([]);
  const [sightings, setSightings] = useState<SightingRecord[]>([]);
  const [nameDrafts, setNameDrafts] = useState<Record<number, string>>({});
  const [selectedFace, setSelectedFace] = useState(0);

  const [summary, setSummary] = useState("");
  const [summarizing, setSummarizing] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editPersonId, setEditPersonId] = useState("new");
  const [rematching, setRematching] = useState(false);
  const [editingPerson, setEditingPerson] = useState<PersonRecord | null>(null);
  const [editName, setEditName] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  const busyRef = useRef(false);
  const photoRef = useRef<HTMLInputElement>(null);

  const peopleRef = useRef<PersonRecord[]>([]);
  const thresholdRef = useRef(threshold);

  peopleRef.current = people;
  thresholdRef.current = threshold;

  const refresh = useCallback(async () => {
    const [nextPeople, nextSightings] = await Promise.all([
      facesDb.listPersons(),
      facesDb.listSightings(),
    ]);
    setPeople(nextPeople);
    setSightings(nextSightings);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const prepare = useCallback(async () => {
    if (engineState === "ready") return true;
    setEngineState("loading");
    try {
      await loadFaceEngine(setEngineNote);
      setEngineState("ready");
      return true;
    } catch (error) {
      setEngineState("error");
      setEngineNote((error as Error).message);
      toast.error(t("人脸模型加载失败，请检查网络后重试"));
      return false;
    }
  }, [engineState]);

  /** 对一张图（摄像头帧或上传的合照）做多张人脸检测 + 库内比对 */
  const analyzeFrame = useCallback(
    async (frame: string, origin: "camera" | "photo") => {
      const { faces: detected, width, height } = await detectFaces(frame);
      setShot({ frame, width, height });
      setNameDrafts({});
      setSelectedFace(0);

      const annotated: Annotated[] = detected.map((face) => {
        const match = findMatch(face.descriptor, peopleRef.current, thresholdRef.current);
        return {
          ...face,
          personId: match?.id || null,
          name: match?.name || "",
          distance: match?.distance ?? 1,
        };
      });
      setFaces(annotated);

      for (const face of annotated) {
        await facesDb.addSighting({
          id: crypto.randomUUID(),
          personId: face.personId,
          name: face.name || t("未知人员"),
          distance: Number(face.distance.toFixed(3)),
          thumb: face.thumb,
          descriptor: face.descriptor,
          at: Date.now(),
          source:
            origin === "camera"
              ? makeSource("camera", host || undefined)
              : makeSource("manual", t("合照识别")),
        });
      }

      if (annotated.length) await refresh();
      if (!detected.length) toast.info(t("没有检测到人脸，换一张更清晰的照片试试"));
      else if (origin === "photo")
        toast.success(`${t("检测到")} ${detected.length} ${t("张人脸，给每个人填上名字即可入库")}`);
    },
    [host, refresh],
  );

  const scan = useCallback(async () => {
    if (busyRef.current) return;
    if (!host) {
      setAuto(false);
      toast.error(t("请先在上面填写摄像头地址"));
      return;
    }
    busyRef.current = true;
    setScanning(true);
    try {
      if (!(await prepare())) return;
      const frame = await captureFrame(normalizeHost(host));
      await analyzeFrame(frame, "camera");
    } catch (error) {
      setAuto(false);
      toast.error(`${t("识别失败")}：${(error as Error).message}`);
    } finally {
      busyRef.current = false;
      setScanning(false);
    }
  }, [analyzeFrame, host, prepare]);

  /** 上传一张合照，识别里面所有人脸 */
  const pickPhoto = useCallback(
    async (file: File | null | undefined) => {
      if (!file) return;
      if (busyRef.current) return;
      busyRef.current = true;
      setScanning(true);
      try {
        if (!(await prepare())) return;
        const frame = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(reader.error ?? new Error(t("读取图片失败")));
          reader.readAsDataURL(file);
        });
        await analyzeFrame(frame, "photo");
      } catch (error) {
        toast.error(`${t("识别失败")}：${(error as Error).message}`);
      } finally {
        busyRef.current = false;
        setScanning(false);
      }
    },
    [analyzeFrame, prepare],
  );

  /** 只在下方人脸上传框内粘贴才识别，避免抢走其它模块的图片 */
  const onZonePaste = useCallback(
    (event: React.ClipboardEvent) => {
      const file = [...(event.clipboardData?.files ?? [])].find((item) =>
        item.type.startsWith("image/"),
      );
      if (!file) return;
      event.preventDefault();
      void pickPhoto(file);
    },
    [pickPhoto],
  );

  useEffect(() => {
    if (!auto) return;
    const timer = window.setInterval(() => void scan(), 1500);
    return () => window.clearInterval(timer);
  }, [auto, scan]);

  const enroll = async (index: number) => {
    const face = faces[index];
    const name = (nameDrafts[index] ?? "").trim();
    if (!name) {
      toast.error(t("请先填写名字"));
      return;
    }
    const existing = people.find((person) => person.name === name);
    const record: PersonRecord = existing
      ? { ...existing, descriptors: [...existing.descriptors, face.descriptor].slice(-6) }
      : {
          id: crypto.randomUUID(),
          name,
          note: "",
          descriptors: [face.descriptor],
          thumb: face.thumb,
          createdAt: Date.now(),
          source: makeSource("camera", t("人脸录入")),
        };
    await facesDb.putPerson(record);
    await refresh();
    setFaces((prev) =>
      prev.map((item, i) =>
        i === index ? { ...item, personId: record.id, name: record.name, distance: 0 } : item,
      ),
    );
    toast.success(existing ? `${t("已补充人脸样本")}：${name}` : `${t("已录入")}：${name}`);
  };

  /** 合照场景：把所有填了名字的人脸一次性入库 */
  const enrollAll = async () => {
    const pending = faces
      .map((face, index) => ({ face, index, name: (nameDrafts[index] ?? "").trim() }))
      .filter((item) => !item.face.personId && item.name);
    if (!pending.length) {
      toast.error(t("先给至少一张人脸填上名字"));
      return;
    }
    const byName = new Map(people.map((person) => [person.name, person]));
    const done: Record<number, { id: string; name: string }> = {};
    for (const item of pending) {
      const existing = byName.get(item.name);
      const record: PersonRecord = existing
        ? { ...existing, descriptors: [...existing.descriptors, item.face.descriptor].slice(-6) }
        : {
            id: crypto.randomUUID(),
            name: item.name,
            note: "",
            descriptors: [item.face.descriptor],
            thumb: item.face.thumb,
            createdAt: Date.now(),
            source: makeSource("manual", t("合照识别")),
          };
      await facesDb.putPerson(record);
      byName.set(item.name, record);
      done[item.index] = { id: record.id, name: record.name };
    }
    await refresh();
    setFaces((prev) =>
      prev.map((item, i) => (done[i] ? { ...item, ...done[i], distance: 0 } : item)),
    );
    toast.success(`${t("已入库")} ${pending.length} ${t("人")}`);
  };

  const removePerson = async (person: PersonRecord) => {
    await facesDb.deletePerson(person.id);
    await refresh();
    toast.success(`${t("已删除")}：${person.name}`);
  };

  const summarize = async () => {
    if (!sightings.length) {
      toast.error(t("还没有识别记录"));
      return;
    }
    setSummarizing(true);
    setSummary("");
    const lines = sightings
      .slice(0, 60)
      .map(
        (item) =>
          `${new Date(item.at).toLocaleString(getLang() === "en" ? "en-US" : "zh-CN")} · ${item.name} · ${t("距离")}${item.distance}`,
      )
      .join("\n");
    const prompt = `下面是摄像头的人脸识别记录（越靠前越新），人员库里已登记 ${people.length} 人：${people.map((p) => p.name).join("、") || t("无")}。请用中文简要整理：谁来过、各出现几次、时间段分布、有没有反复出现的未知人员需要留意。\n\n${lines}`;
    try {
      await askModel(
        preset,
        prompt,
        null,
        [],
        (chunk) => setSummary((prev) => prev + chunk),
        new AbortController().signal,
      );
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setSummarizing(false);
    }
  };

  const startEdit = (item: SightingRecord) => {
    setEditingId(item.id);
    setEditPersonId("new");
    setEditName("");
  };

  const assign = async (item: SightingRecord) => {
    if (editPersonId === "new") {
      const name = editName.trim();
      if (!name) {
        toast.error(t("请输入名字"));
        return;
      }
      const existingByName = people.find((person) => person.name === name);
      if (existingByName) {
        if (item.descriptor) {
          const merged = [...existingByName.descriptors, item.descriptor].slice(-6);
          await facesDb.putPerson({ ...existingByName, descriptors: merged });
        }
        await facesDb.putSighting({
          ...item,
          personId: existingByName.id,
          name: existingByName.name,
          distance: 0,
        });
        toast.success(
          getLang() === "en"
            ? `Merged into existing person “${existingByName.name}”`
            : `已并入已有人员「${existingByName.name}」`,
        );
      } else {
        const newPerson: PersonRecord = {
          id: crypto.randomUUID(),
          name,
          note: "",
          descriptors: item.descriptor ? [item.descriptor] : [],
          thumb: item.thumb,
          createdAt: Date.now(),
          source: makeSource("manual", t("到访记录补标")),
        };
        await facesDb.putPerson(newPerson);
        await facesDb.putSighting({
          ...item,
          personId: newPerson.id,
          name: newPerson.name,
          distance: 0,
        });
        toast.success(getLang() === "en" ? `New person “${name}” saved` : `已录入新人「${name}」`);
      }
    } else {
      const selectedPerson = people.find((person) => person.id === editPersonId);
      if (!selectedPerson) {
        toast.error(t("选择的人员不存在"));
        return;
      }
      if (item.descriptor) {
        const merged = [...selectedPerson.descriptors, item.descriptor].slice(-6);
        await facesDb.putPerson({ ...selectedPerson, descriptors: merged });
      }
      await facesDb.putSighting({
        ...item,
        personId: selectedPerson.id,
        name: selectedPerson.name,
        distance: 0,
      });
      toast.success(
        getLang() === "en"
          ? `Labelled as “${selectedPerson.name}”`
          : `已标注为「${selectedPerson.name}」`,
      );
    }
    await refresh();
    setEditingId(null);
  };

  const rematch = async () => {
    if (!people.length) {
      toast.error(t("人员库还是空的，先录入至少一个人"));
      return;
    }
    setRematching(true);
    try {
      const targets = sightings.filter((item) => !item.personId && item.descriptor?.length);
      if (!targets.length) {
        toast.info(t("没有可自动对应的未知记录（缺少人脸特征或已标注）"));
        return;
      }
      let matched = 0;
      for (const item of targets) {
        const best = findMatch(item.descriptor!, people, threshold);
        if (best && best.id) {
          await facesDb.putSighting({
            ...item,
            personId: best.id,
            name: best.name,
            distance: Number(best.distance.toFixed(3)),
          });
          matched += 1;
        }
      }
      await refresh();
      toast.success(
        matched
          ? getLang() === "en"
            ? `Matched ${matched} records automatically (threshold ${threshold.toFixed(2)})`
            : `已自动对应 ${matched} 条记录（阈值 ${threshold.toFixed(2)}）`
          : t("没有记录能在当前阈值下匹配上，可把严格度调大一些再试"),
      );
    } finally {
      setRematching(false);
    }
  };

  return (
    <section className="flex flex-col gap-5 rounded-2xl border border-border bg-card/60 p-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 font-display text-xl leading-none tracking-tight text-foreground">
          <ScanFace className="size-4 text-primary" aria-hidden="true" />
          {t("人脸识别与人员库")}
        </h2>
        <span className="text-xs text-muted-foreground">
          {engineState === "loading"
            ? engineNote || t("加载模型中…")
            : engineState === "ready"
              ? t("本地模型就绪 · 人脸数据不出本机")
              : engineState === "error"
                ? t("模型加载失败")
                : t("首次点击识别会下载约 6MB 模型")}
        </span>
      </header>

      <Tabs defaultValue="scan">
        <TabsList>
          <TabsTrigger value="scan">{t("实时识别")}</TabsTrigger>
          <TabsTrigger value="people">
            {t("人员库")} ({people.length})
          </TabsTrigger>
          <TabsTrigger value="log">
            {t("到访记录")} ({sightings.length})
          </TabsTrigger>
        </TabsList>

        <TabsContent value="scan" className="space-y-4 pt-4">
          <div className="flex flex-wrap items-center gap-4">
            <Button onClick={() => void scan()} disabled={scanning}>
              {scanning ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <ScanFace className="size-4" aria-hidden="true" />
              )}
              {t("识别当前画面")}
            </Button>
            <input
              ref={photoRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(event) => {
                void pickPhoto(event.target.files?.[0]);
                event.target.value = "";
              }}
            />
            <div
              tabIndex={0}
              onPaste={onZonePaste}
              onClick={() => photoRef.current?.click()}
              className="flex cursor-pointer items-center gap-2 rounded-md border border-dashed px-3 py-2 text-xs text-foreground outline-none focus:border-primary focus:text-foreground"
            >
              <ImagePlus className="size-4 text-primary" aria-hidden="true" />
              <span>{t("上传合照识别")}</span>
            </div>

            <div className="flex items-center gap-2">
              <Switch
                id="auto-scan"
                checked={auto}
                onCheckedChange={(checked) => {
                  if (checked && !host.trim()) {
                    toast.error(t("请先在上面填写摄像头地址"));
                    setAuto(false);
                    return;
                  }
                  setAuto(checked);
                }}
              />
              <Label htmlFor="auto-scan" className="text-xs text-muted-foreground">
                {t("每 1.5 秒自动识别")}
              </Label>
            </div>
            <div className="flex min-w-48 flex-1 items-center gap-3">
              <Label className="whitespace-nowrap text-xs text-muted-foreground">
                {t("严格度")} {threshold.toFixed(2)}
              </Label>
              <Slider
                value={[threshold]}
                onValueChange={([value]) => setThreshold(value)}
                min={0.35}
                max={0.7}
                step={0.01}
              />
            </div>
          </div>

          {shot ? (
            <div className="relative w-full overflow-hidden rounded-lg border border-border bg-black">
              <img src={shot.frame} alt={t("识别画面")} className="w-full object-contain" />
              {faces.map((face, index) => (
                <button
                  type="button"
                  key={index}
                  onClick={() => setSelectedFace(index)}
                  className={cn(
                    "absolute border-2",
                    face.personId ? "border-success" : "border-warning",
                    selectedFace === index && "ring-2 ring-primary ring-offset-1",
                  )}
                  style={{
                    left: `${(face.box.x / shot.width) * 100}%`,
                    top: `${(face.box.y / shot.height) * 100}%`,
                    width: `${(face.box.width / shot.width) * 100}%`,
                    height: `${(face.box.height / shot.height) * 100}%`,
                  }}
                >
                  <span
                    className={cn(
                      "absolute -top-5 left-0 whitespace-nowrap rounded px-1 text-[10px] font-medium",
                      face.personId ? "bg-success text-background" : "bg-warning text-background",
                    )}
                  >
                    {index + 1}. {face.personId ? face.name : t("未知")}
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <div
              tabIndex={0}
              onPaste={onZonePaste}
              onClick={() => photoRef.current?.click()}
              className="cursor-pointer space-y-1 rounded-lg border border-dashed border-border py-10 text-center outline-none focus:border-primary"
            >
              <p className="text-xs text-muted-foreground">
                {t(
                  "上传一张合照，会框出里面所有人脸并逐个标名字；也可以点「识别当前画面」从摄像头抓一帧。",
                )}
              </p>
              <p className="text-xs text-foreground">{t("点一下这个框，再 Ctrl/⌘+V 粘贴图片")}</p>
            </div>
          )}

          {shot && (
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={() => onUseFrame(shot.frame)}>
                <Sparkles className="size-3.5" aria-hidden="true" />
                {t("把这帧发给 AI 提问")}
              </Button>
            </div>
          )}

          <datalist id="known-person-names">
            {people.map((person) => (
              <option key={person.id} value={person.name} />
            ))}
          </datalist>

          {faces.length > 0 && (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs text-muted-foreground">
                  {t("共检测到")} {faces.length} {t("张人脸")} · {t("已认出")}{" "}
                  {faces.filter((face) => face.personId).length} ·{" "}
                  {t("给未知的填上名字，可一次性全部入库")}
                </p>
                <Button size="sm" variant="outline" onClick={() => void enrollAll()}>
                  <UserPlus className="size-3.5" aria-hidden="true" />
                  {t("全部入库")}
                </Button>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                {faces.map((face, index) => (
                  <div
                    key={index}
                    onClick={() => setSelectedFace(index)}
                    className={cn(
                      "flex cursor-pointer items-center gap-3 rounded-lg border bg-muted/30 p-2",
                      selectedFace === index
                        ? "border-primary ring-1 ring-primary"
                        : "border-border",
                    )}
                  >
                    <img
                      src={face.thumb}
                      alt={t("检测到的人脸")}
                      className="size-14 rounded object-cover"
                    />
                    <div className="min-w-0 flex-1 space-y-1.5">
                      <p className="text-[10px] text-muted-foreground">
                        {t("第")} {index + 1} {t("张人脸")}
                      </p>
                      {face.personId ? (
                        <>
                          <p className="truncate text-sm font-medium">{face.name}</p>
                          <p className="text-xs text-muted-foreground">
                            {t("相似度距离")} {face.distance.toFixed(3)} {t("（越小越像）")}
                          </p>
                        </>
                      ) : (
                        <div className="flex gap-1.5">
                          <Input
                            value={nameDrafts[index] ?? ""}
                            onChange={(event) =>
                              setNameDrafts((prev) => ({ ...prev, [index]: event.target.value }))
                            }
                            placeholder={t("这是谁？填名字入库")}
                            list="known-person-names"
                            className="h-8 text-xs"
                          />
                          <Button size="sm" className="h-8" onClick={() => void enroll(index)}>
                            <UserPlus className="size-3.5" aria-hidden="true" />
                          </Button>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </TabsContent>

        <TabsContent value="people" className="pt-4">
          {people.length === 0 ? (
            <p className="py-10 text-center text-xs text-muted-foreground">
              {t("人员库是空的。识别到未知人脸后填个名字即可入库。")}
            </p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {people.map((person) => (
                <div
                  key={person.id}
                  className="flex items-start gap-3 rounded-lg border border-border p-2"
                >
                  <img
                    src={person.thumb}
                    alt={person.name}
                    className="size-14 rounded object-cover"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{person.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {person.descriptors.length} {t("张样本")} ·{" "}
                      {new Date(person.createdAt).toLocaleDateString("zh-CN")}
                    </p>
                    {(() => {
                      const p = person.profile;
                      const bits = [
                        p?.title,
                        p?.department,
                        p?.org,
                        p?.projects?.length ? `${t("负责")}：${p.projects.join("、")}` : "",
                        p?.reportsTo ? `${t("汇报")}：${p.reportsTo}` : "",
                        p?.employeeId,
                        p?.tags?.length ? p.tags.join("/") : "",
                        p?.contact,
                        person.note,
                      ].filter(Boolean);
                      return bits.length ? (
                        <p className="mt-1 line-clamp-3 text-xs leading-relaxed text-muted-foreground">
                          {bits.join(" · ")}
                        </p>
                      ) : (
                        <p className="mt-1 text-xs text-muted-foreground/70">{t("还没有资料")}</p>
                      );
                    })()}
                  </div>
                  <div className="flex flex-col">
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`${t("编辑人物资料")}：${person.name}`}
                      onClick={() => setEditingPerson(person)}
                    >
                      <Pencil className="size-3.5" aria-hidden="true" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`${t("删除")}：${person.name}`}
                      onClick={() => void removePerson(person)}
                    >
                      <Trash2 className="size-3.5" aria-hidden="true" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="log" className="space-y-3 pt-4">
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => void summarize()} disabled={summarizing}>
              {summarizing ? (
                <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <Sparkles className="size-3.5" aria-hidden="true" />
              )}
              {t("让 AI 整理这些记录")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void rematch()}
              disabled={rematching}
            >
              {rematching ? (
                <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <Wand2 className="size-3.5" aria-hidden="true" />
              )}
              {t("自动对应人名")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={selectedIds.length === 0}
              onClick={async () => {
                for (const id of selectedIds) await facesDb.deleteSighting(id);
                setSelectedIds([]);
                await refresh();
                toast.success(t("已删除所选记录"));
              }}
            >
              <Trash2 className="size-3.5" aria-hidden="true" />
              {t("删除所选")}（{selectedIds.length}）
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={async () => {
                if (!window.confirm(t("确定清空全部到访记录？此操作不可撤销。"))) return;
                await facesDb.clearSightings();
                setSelectedIds([]);
                await refresh();
              }}
            >
              <Trash2 className="size-3.5" aria-hidden="true" />
              {t("清空全部")}
            </Button>
          </div>

          {summary && (
            <div className="whitespace-pre-wrap rounded-lg border border-border bg-muted/30 p-3 text-sm leading-relaxed">
              {summary}
            </div>
          )}

          {sightings.length === 0 ? (
            <p className="py-10 text-center text-xs text-muted-foreground">{t("还没有识别记录")}</p>
          ) : (
            <div className="max-h-80 overflow-y-auto rounded-lg border border-border">
              <table className="w-full text-left text-xs">
                <thead className="sticky top-0 bg-muted/60 text-muted-foreground">
                  <tr>
                    <th className="p-2 font-medium">
                      <input
                        type="checkbox"
                        aria-label={t("全选记录")}
                        checked={selectedIds.length === sightings.length && sightings.length > 0}
                        onChange={(event) =>
                          setSelectedIds(event.target.checked ? sightings.map((s) => s.id) : [])
                        }
                      />
                    </th>
                    <th className="p-2 font-medium">{t("人脸")}</th>
                    <th className="p-2 font-medium">{t("姓名")}</th>
                    <th className="p-2 font-medium">{t("距离")}</th>
                    <th className="p-2 font-medium">{t("时间")}</th>
                    <th className="p-2 font-medium">{t("操作")}</th>
                  </tr>
                </thead>
                <tbody>
                  {sightings.map((item) =>
                    editingId === item.id ? (
                      <tr key={item.id} className="border-t border-border bg-muted/40">
                        <td className="p-2" />
                        <td className="p-2">
                          <img src={item.thumb} alt="" className="size-8 rounded object-cover" />
                        </td>
                        <td className="p-2" colSpan={3}>
                          <div className="flex flex-wrap items-center gap-2">
                            <Select value={editPersonId} onValueChange={setEditPersonId}>
                              <SelectTrigger className="h-8 w-36 text-xs">
                                <SelectValue placeholder={t("选择或新建")} />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="new">{t("+ 新建人员")}</SelectItem>
                                {people.map((person) => (
                                  <SelectItem key={person.id} value={person.id}>
                                    {person.name}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            {editPersonId === "new" && (
                              <Input
                                value={editName}
                                onChange={(event) => setEditName(event.target.value)}
                                placeholder={t("输入名字")}
                                className="h-8 w-32 text-xs"
                              />
                            )}
                          </div>
                        </td>
                        <td className="p-2">
                          <div className="flex items-center gap-1">
                            <Button size="sm" className="h-8" onClick={() => void assign(item)}>
                              {t("确认")}
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-8"
                              onClick={() => setEditingId(null)}
                            >
                              {t("取消")}
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ) : (
                      <tr key={item.id} className="border-t border-border">
                        <td className="p-2">
                          <input
                            type="checkbox"
                            aria-label={`${t("选择人物")}：${item.name}`}
                            checked={selectedIds.includes(item.id)}
                            onChange={(event) =>
                              setSelectedIds((prev) =>
                                event.target.checked
                                  ? [...prev, item.id]
                                  : prev.filter((id) => id !== item.id),
                              )
                            }
                          />
                        </td>
                        <td className="p-2">
                          <img src={item.thumb} alt="" className="size-8 rounded object-cover" />
                        </td>
                        <td className={cn("p-2", !item.personId && "text-warning")}>{item.name}</td>
                        <td className="p-2 font-mono">{item.distance}</td>
                        <td className="p-2 text-muted-foreground">
                          {new Date(item.at).toLocaleString("zh-CN")}
                        </td>
                        <td className="p-2">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                            aria-label={`${t("标注人物")}：${item.name}`}
                            onClick={() => startEdit(item)}
                          >
                            <Pencil className="size-3.5" aria-hidden="true" />
                          </Button>
                        </td>
                      </tr>
                    ),
                  )}
                </tbody>
              </table>
            </div>
          )}
        </TabsContent>
      </Tabs>

      <PersonProfileDialog
        person={editingPerson}
        preset={preset}
        onClose={() => setEditingPerson(null)}
        onSaved={refresh}
      />

      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <Database className="size-3.5 shrink-0" aria-hidden="true" />
        {t("人员库与记录保存在本机浏览器（IndexedDB），换浏览器不共享，清理站点数据会清空。")}
      </p>
    </section>
  );
}
