import {
  ArrowRight,
  Bell,
  CalendarDays,
  Check,
  Clock3,
  Loader2,
  Mic,
  Paperclip,
  Plus,
  Sparkles,
  Square,
  Trash2,
  TriangleAlert,
  Undo2,
  X,
} from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";

import { DraftGraph } from "@/components/draft-graph";
import { ReasoningDisclosure } from "@/components/reasoning-disclosure";
import { Button } from "@/components/ui/button";

import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Textarea } from "@/components/ui/textarea";
import { startRecording, transcribeAudio, type Recorder } from "@/lib/audio-client";
import { IMPORT_LIMITS, importFiles } from "@/lib/doc-import";
import { claimIntakeJob, getIntakeJob, startIntakeJob, subscribeIntakeJob } from "@/lib/intake-job";
import { facesDb, type LifeEventRecord, type PersonRecord } from "@/lib/face-db";
import { matchIdentity } from "@/lib/identity-match";
import { getLang, t } from "@/lib/i18n";
import { carryManualState } from "@/lib/intake-manual-state";
import {
  enforceSensitiveFieldGrounding,
  isSensitivePersonField,
  markSensitiveFieldsManual,
  SENSITIVE_PERSON_FIELDS,
} from "@/lib/intake-grounding";
import {
  diffIngestPerson,
  fitPromptMaterial,
  isValidIsoDate,
  makeExtractionAudit,
  makeOfflineDemoCandidate,
  OFFLINE_DEMO_MATERIAL,
  type ExtractionAudit,
  type IngestAuditFields as DraftAuditFields,
  type IngestCandidate as Draft,
  type IngestEvent as DraftEvent,
  type IngestEvidence as DraftEvidence,
  type IngestFact as DraftFact,
  type IngestPerson as DraftPerson,
  type IngestRelation as DraftRelation,
  type IngestReminder as DraftReminder,
  type GroundingWarningField,
  type SensitivePersonField,
  validateIntakeFiles,
} from "@/lib/intake-draft";
import {
  getLatestIntakeBatch,
  rememberIntakeBatch,
  undoLatestIntakeBatch,
  type IntakeUndoBatch,
} from "@/lib/intake-undo";
import { inferMutual } from "@/lib/relation-kind";
import {
  isInferredRelationBasis,
  KINSHIP_RULES_EN,
  KINSHIP_RULES_ZH,
  relationNeedsInferenceReview,
} from "@/lib/kinship-rules";
import { makeSource } from "@/lib/provenance";
import { cn } from "@/lib/utils";
import { runIntakeAgent } from "@/lib/intake-agent";
import type { ProviderPreset } from "@/lib/vision-providers";

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

const SCHEMA = `{"people":[{"name":"","note":"","age":"","gender":"","relation":"","birthday":"","circle":"","closeness":null,"likes":[],"dislikes":[],"gifts":[],"metAt":"","contact":"","address":"","title":"","department":"","org":"","projects":[],"reportsTo":"","employeeId":"","tags":[],"identities":[{"platform":"","account":"","alias":"","validFrom":"","validTo":""}],"confidence":null}],"facts":[{"person":"","key":"","value":"","validFrom":"","validTo":"","confidence":null}],"relations":[{"from":"","to":"","label":"","note":"","basis":"","confidence":null}],"events":[{"title":"","detail":"","date":"","dateEnd":"","precision":"day|month|year|range","place":"","people":[],"kind":"","confidence":null}],"reminders":[{"title":"","detail":"","due":"","people":[],"kind":"birthday|festival|gift|custom","confidence":null}],"evidence":[{"kind":"note|audio|exhibit|frame","title":"","text":"","origin":"","confidence":null}],"summary":""}`;

const CREATE_NEW_PERSON = "__create_new_person__";
const CREATE_NEW_EVENT = "__create_new_event__";

function withIdentityDecision(person: DraftPerson, persons: PersonRecord[]): DraftPerson {
  if (
    person.targetPersonId &&
    person.targetPersonId !== CREATE_NEW_PERSON &&
    persons.some((existing) => existing.id === person.targetPersonId)
  ) {
    return { ...person, _identityChecked: true };
  }
  const result = matchIdentity(
    {
      name: person.name,
      contact: person.contact,
      identities: person.identities,
    },
    persons,
  );
  return {
    ...person,
    targetPersonId:
      result.decision === "update"
        ? result.matches[0]?.id
        : result.decision === "create"
          ? CREATE_NEW_PERSON
          : undefined,
    _identityCandidateIds: result.matches.map((match) => match.id),
    _identityReason: result.reasons.join("；"),
    _identityChecked: true,
  };
}

function prepareIdentityDecisions(
  draft: Draft,
  persons: PersonRecord[],
  events: LifeEventRecord[] = [],
): Draft {
  return {
    ...draft,
    people: (draft.people ?? []).map((person) => withIdentityDecision(person, persons)),
    events: (draft.events ?? []).map((event) => ({
      ...event,
      targetEventId:
        event.targetEventId && events.some((existing) => existing.id === event.targetEventId)
          ? event.targetEventId
          : CREATE_NEW_EVENT,
      _eventChecked: true,
    })),
  };
}

function serializeDraftForPrompt(draft: Draft) {
  return JSON.stringify(draft, (key, value: unknown) => {
    if (key === "targetPersonId" || key === "targetEventId" || key.startsWith("_")) {
      return undefined;
    }
    return value;
  });
}

function decorateDraft(result: Draft, sourceSummary: string, material: string): Draft {
  const extractedAt = Date.now();
  const decorate = <T extends DraftAuditFields>(item: T): T => ({
    ...item,
    _audit: item._audit?.humanEdited
      ? {
          ...item._audit,
          confirmationStatus: "pending",
          confidence: undefined,
          humanEdited: true,
        }
      : makeExtractionAudit(sourceSummary, item.confidence, extractedAt),
  });
  const grounded = enforceSensitiveFieldGrounding(result, material);
  return {
    ...grounded,
    people: (grounded.people ?? []).map(decorate),
    facts: (grounded.facts ?? []).map(decorate),
    relations: (grounded.relations ?? []).map(decorate),
    events: (grounded.events ?? []).map(decorate),
    reminders: (grounded.reminders ?? []).map(decorate),
    evidence: (grounded.evidence ?? []).map(decorate),
  };
}

const MAX_PROMPT_CHARACTERS = 11_800;

function buildPrompt(text: string, known: string[], previous: Draft | null) {
  const zh = getLang() !== "en";
  const base = zh
    ? `你是个人人脉整理助手。把下面这段自然语言材料整理成结构化 JSON，只输出 JSON，不要解释、不要 markdown。
严格使用这个结构：${SCHEMA}
规则：
- 材料里没写的普通事实字段留空字符串或空数组；关系推导只按下面的亲属规则进行。
- title、部门、单位、项目、地址、忌口、礼物等人物字段只保留材料明确写出的值；“喜欢摄影”不能改写成“摄影师”。
- relation 写这个人和「我」的关系，如大学同学、表哥、前同事。
- circle 只能是：家人 / 亲戚 / 朋友 / 同学 / 同事 / 邻居 / 其它。closeness 仅在材料明确给出 1-5 数值时填写，否则留空；不要根据关系称呼推断。
- birthday 用 MM-DD 或 YYYY-MM-DD。likes 喜好、dislikes 忌口或不喜欢、gifts 送过的礼物。
- identities 只记录材料明确出现的平台、账号、当时昵称与生效/失效时间；不要根据姓名猜账号或时间。
- facts 只放材料明确表达、但不属于固定人物字段的事实；person 指人物姓名，key 是短字段名，value 是原文可支持的值。validFrom/validTo 仅在材料给出有效期时填写。
- evidence 只保留能核对抽取结果的短摘要或必要原文片段，不要复制整份聊天、文档或转写稿，text 最多 500 字。
- relations 写人和人之间的关系。每条都填写 basis：明说关系写最短原文，推导关系写可复核依据。
- events 放已经发生或计划发生、值得进入日历/时间线的事情；date 用 yyyy-mm-dd。只知道月份或年份时分别补为当月 01 日或当年 01-01，并把 precision 标为 month 或 year；一段时间用 range 和 dateEnd。people 写相关人物姓名。
- reminders 放需要用户采取行动的待办，如「给小雨回电话」；due 仅在材料明确给出日期时使用 yyyy-mm-dd，people 写相关人物姓名。不要把同一件事同时放进 events 和 reminders，除非材料同时明确表达日历事件和后续行动。
- confidence 是你对每一条抽取准确性的自评（0 到 1），无法判断时留空；它只是提示，不能代替用户确认。
- summary 用一两句话说明这份材料讲了什么。
${KINSHIP_RULES_ZH}`
    : `You organise a personal contact network. Convert the text below into structured JSON. Output JSON only, no markdown, no explanation.
Use exactly this structure: ${SCHEMA}
Rules:
- Leave ordinary fact fields empty when the text does not state them. Relation inference is allowed only under the auditable kinship rules below.
- Keep role, department, organisation, projects, address, dislikes and gifts only when explicitly stated. An interest in photography does not make someone a photographer.
- relation = how this person relates to me (college roommate, cousin, ex-colleague).
- circle is one of family / relatives / friends / classmates / colleagues / neighbours / other. Set closeness only when the material explicitly gives a 1-5 score; never infer it from a relationship label.
- birthday as MM-DD or YYYY-MM-DD. likes, dislikes, gifts are short arrays.
- identities contains only explicitly stated platform/account/alias and validity dates. Never guess an account or date from a name.
- facts contains only explicit facts that do not fit a fixed person field; person is the person's name and validity dates are included only when stated.
- evidence is a short source summary or the minimum excerpt needed for review (at most 500 characters), never a copy of the complete chat, document, or transcript.
- relations = ties between people. Every relation includes basis: a short quote for explicit ties or a checkable inference basis.
- events are past or planned moments worth putting on a calendar/timeline. Use yyyy-mm-dd, with precision month/year/range when needed; people contains related names.
- reminders are actions the user still needs to take. Set due only when the material gives a date. Do not duplicate one fact across events and reminders unless both a calendar moment and a follow-up action are explicit.
- confidence is the model's 0-1 self-assessment for each extracted item and never replaces user confirmation.
- summary = one or two sentences about the material.
${KINSHIP_RULES_EN}`;

  const knownLine = zh
    ? `\n已有档案：${known.join("、").slice(0, 1_000) || "无"}`
    : `\nExisting profiles: ${known.join(", ").slice(0, 1_000) || "none"}`;
  const prev = previous
    ? (zh
        ? `\n\n这是上一轮整理结果，请在它基础上合并补充：\n`
        : `\n\nMerge and extend this previous draft:\n`) + serializeDraftForPrompt(previous)
    : "";
  const prefix = `${base}${knownLine}${prev}\n\n${zh ? "材料" : "Material"}：\n`;
  return fitPromptMaterial(prefix, text, MAX_PROMPT_CHARACTERS);
}

/** 切到别的页签再回来时，未提交的录入内容不能丢 —— 存在本地，15 秒自动暂存一次 */
const DRAFT_KEY = "zhimai.intake.draft.v1";
const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;

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
    if (!text) return null;
    const stored = JSON.parse(text) as StashShape;
    if (!Number.isFinite(stored.at) || Date.now() - stored.at > DRAFT_TTL_MS) {
      window.localStorage.removeItem(DRAFT_KEY);
      return null;
    }
    return stored;
  } catch {
    window.localStorage.removeItem(DRAFT_KEY);
    return null;
  }
}

function mergeDraftPatch<T extends DraftAuditFields>(item: T, patch: Partial<T>): T {
  const merged = { ...item, ...patch } as T;
  if (!Object.prototype.hasOwnProperty.call(patch, "_audit")) {
    merged._audit = {
      ...(item._audit ?? makeManualAudit(t("草稿中手动添加"))),
      confirmationStatus: "pending",
      confidence: undefined,
      humanEdited: true,
    };
    if ("_groundingVerified" in merged) {
      (merged as T & { _groundingVerified?: boolean })._groundingVerified = false;
    }
  }
  return merged;
}

function makeManualAudit(sourceSummary: string): ExtractionAudit {
  return {
    ...makeExtractionAudit(sourceSummary, undefined),
    humanEdited: true,
  };
}

function acceptedAudit(audit?: ExtractionAudit): ExtractionAudit {
  return {
    ...(audit ?? makeManualAudit(t("草稿中手动添加"))),
    confirmationStatus: "accepted",
  };
}

function isLowRiskBatchEvent(item: DraftEvent) {
  return (
    item._audit?.confirmationStatus !== "accepted" &&
    item._audit?.humanEdited !== true &&
    typeof item._audit?.confidence === "number" &&
    item._audit.confidence >= 0.9 &&
    item._groundingVerified === true &&
    Boolean(item.title?.trim()) &&
    isValidIsoDate(item.date) &&
    (item.precision !== "range" || (isValidIsoDate(item.dateEnd) && item.dateEnd >= item.date))
  );
}

function reviewItemsOf(value: Draft | null): DraftAuditFields[] {
  return value
    ? [
        ...(value.people ?? []),
        ...(value.facts ?? []),
        ...(value.relations ?? []),
        ...(value.events ?? []),
        ...(value.reminders ?? []),
        ...(value.evidence ?? []),
      ]
    : [];
}

function splitDraftList(value: string) {
  return value
    .split(/[，,、;；\n]+/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

function sensitiveFieldLabel(field: GroundingWarningField) {
  const labels: Record<GroundingWarningField, string> = {
    name: t("姓名"),
    note: t("备注"),
    age: t("年龄"),
    gender: t("性别"),
    relation: t("和我的关系"),
    contact: t("联系方式"),
    address: t("办公地点"),
    department: t("部门 / 科室"),
    org: t("单位 / 公司"),
    reportsTo: t("汇报对象"),
    employeeId: t("工号 / 编号"),
    birthday: t("生日"),
    circle: t("圈子"),
    title: t("职务/技能"),
    projects: t("项目/技能"),
    likes: t("喜好/技能关键词"),
    dislikes: t("忌口 / 不喜欢"),
    gifts: t("送礼记录"),
    metAt: t("相识场景"),
    tags: t("标签/技能"),
    closeness: t("亲密度"),
    identities: t("平台账号"),
    facts: t("事实"),
  };
  return labels[field];
}

function hasPersonFieldValue(person: DraftPerson, field: SensitivePersonField) {
  const value = person[field];
  return Array.isArray(value) ? value.length > 0 : value !== undefined && value !== "";
}

function DraftAuditLine({
  audit,
  onAccept,
  onReject,
}: {
  audit?: ExtractionAudit;
  onAccept: () => void;
  onReject: () => void;
}) {
  const accepted = audit?.confirmationStatus === "accepted";
  const confidence =
    typeof audit?.confidence === "number"
      ? `${t("AI 自评")} ${Math.round(audit.confidence * 100)}%`
      : t("AI 自评未提供");
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-muted-foreground">
      <span
        className={
          accepted
            ? "rounded-full border border-emerald-500/60 bg-emerald-500/10 px-2 py-0.5 text-emerald-700 dark:text-emerald-300"
            : "rounded-full border border-amber-400/60 bg-amber-400/10 px-2 py-0.5 text-amber-700 dark:text-amber-300"
        }
      >
        {accepted ? t("已接受") : t("待确认")}
      </span>
      <span>{confidence}</span>
      <span>{audit?.sourceSummary ?? t("来源未标注")}</span>
      {audit?.extractedAt && (
        <span className="inline-flex items-center gap-1">
          <Clock3 className="size-3" aria-hidden="true" />
          {new Date(audit.extractedAt).toLocaleString()}
        </span>
      )}
      <span className="ml-auto inline-flex items-center gap-1">
        <Button
          type="button"
          variant={accepted ? "secondary" : "outline"}
          size="sm"
          className="h-6 rounded-full px-2.5 text-[10px]"
          onClick={onAccept}
          disabled={accepted}
        >
          <Check className="size-3" aria-hidden="true" />
          {accepted ? t("已接受") : t("接受此项")}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 rounded-full px-2.5 text-[10px] text-destructive hover:text-destructive"
          onClick={onReject}
        >
          <X className="size-3" aria-hidden="true" />
          {t("拒绝此项")}
        </Button>
      </span>
    </div>
  );
}

export function IntakePanel({ preset }: { preset: ProviderPreset }) {
  // Keep the first client render identical to SSR; restore browser-only draft
  // state after hydration to avoid rendering localStorage data on one side only.
  const [raw, setRaw] = useState("");
  const [supplement, setSupplement] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const job = useSyncExternalStore(subscribeIntakeJob, getIntakeJob, getIntakeJob);
  const busy = job.busy;
  const [saving, setSaving] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const [latestBatch, setLatestBatch] = useState<IntakeUndoBatch | null>(() =>
    getLatestIntakeBatch(),
  );
  const [known, setKnown] = useState<string[]>([]);
  const [existingPeople, setExistingPeople] = useState<PersonRecord[]>([]);
  const [existingEvents, setExistingEvents] = useState<LifeEventRecord[]>([]);
  const [peopleLoaded, setPeopleLoaded] = useState(false);
  const [allowArchiveTools, setAllowArchiveTools] = useState(true);
  const [reading, setReading] = useState<string | null>(null);
  const [attached, setAttached] = useState<{ name: string; block: string }[]>([]);
  const [progress, setProgress] = useState(0);
  const [stashedAt, setStashedAt] = useState<number | null>(null);
  const [recording, setRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [transcribing, setTranscribing] = useState(false);
  const recorderRef = useRef<Recorder | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const stored = readStash();
    if (!stored) return;
    setRaw(stored.raw);
    setSupplement(stored.supplement);
    setDraft(
      stored.draft
        ? enforceSensitiveFieldGrounding(
            stored.draft,
            [stored.raw, stored.supplement].filter(Boolean).join("\n\n"),
          )
        : null,
    );
    setAttached(stored.attached);
    setStashedAt(stored.at);
  }, []);

  useEffect(() => {
    void Promise.all([facesDb.listPersons(), facesDb.listLifeEvents()])
      .then(([people, events]) => {
        setExistingPeople(people);
        setExistingEvents(events);
        setKnown(people.map((row) => row.name));
      })
      .finally(() => setPeopleLoaded(true));
  }, []);

  useEffect(() => {
    if (!peopleLoaded) return;
    setDraft((previous) => {
      if (
        !previous?.people?.some((person) => !person._identityChecked) &&
        !previous?.events?.some((event) => !event._eventChecked)
      )
        return previous;
      return prepareIdentityDecisions(previous, existingPeople, existingEvents);
    });
  }, [existingEvents, existingPeople, peopleLoaded]);

  useEffect(() => {
    if (!recording) return;
    const timer = window.setInterval(() => setRecordingSeconds((seconds) => seconds + 1), 1000);
    return () => window.clearInterval(timer);
  }, [recording]);

  useEffect(
    () => () => {
      recorderRef.current?.cancel();
      recorderRef.current = null;
    },
    [],
  );

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

  const clearLocalDraft = () => {
    setRaw("");
    setSupplement("");
    setDraft(null);
    setAttached([]);
    setStashedAt(null);
    window.localStorage.removeItem(DRAFT_KEY);
    toast.success(t("已清除本地录入草稿"));
  };

  /** 上传简历 / 截图 / PDF / Word：抽成文字后拼进输入框，再走同一套 AI 整理 */
  const pickFiles = async (files: FileList | File[] | null) => {
    if (!files?.length) return;
    const selected = [...files];
    const validationErrors = validateIntakeFiles(selected);
    if (validationErrors.length) {
      validationErrors.forEach((message) => toast.error(message));
      if (fileRef.current) fileRef.current.value = "";
      return;
    }
    setReading(t("正在读取文件"));
    setProgress(0);
    try {
      const docs = await importFiles(
        selected,
        preset,
        (step) => setReading(step),
        (done, total) => setProgress(total ? Math.round((done / total) * 100) : 0),
      );
      const failures = docs.filter((doc) => doc.text.trim().startsWith("[读取失败："));
      failures.forEach((doc) => toast.error(`${doc.name}：${doc.text.trim()}`));
      const entries = docs
        .filter((doc) => doc.text.trim() && !doc.text.trim().startsWith("[读取失败："))
        .map((doc) => ({
          name: doc.name,
          block: `【${t("来自文件")}：${doc.name}】\n${doc.text.trim()}`,
        }));
      if (!entries.length) {
        toast.error(t("没有从文件里读到文字"));
        return;
      }
      setRaw((prev) =>
        [prev.trim(), ...entries.map((item) => item.block)].filter(Boolean).join("\n\n"),
      );
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

  const transcribeRecording = async (blob: Blob) => {
    setTranscribing(true);
    try {
      const filename = `recording-${Date.now()}.webm`;
      const transcript = await transcribeAudio(blob, {
        preset,
        filename,
        hint: known.join("、").slice(0, 300) || undefined,
      });
      if (!transcript) throw new Error(t("没有识别到语音内容"));
      const block = `【${t("来自录音转写")}：${new Date().toLocaleString()}】\n${transcript}`;
      setRaw((previous) => [previous.trim(), block].filter(Boolean).join("\n\n"));
      toast.success(t("转写完成，请先检查文字再交给 AI 整理"));
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setTranscribing(false);
    }
  };

  const toggleRecording = async () => {
    if (recording) {
      const recorder = recorderRef.current;
      recorderRef.current = null;
      setRecording(false);
      if (!recorder) return;
      setTranscribing(true);
      try {
        await transcribeRecording(await recorder.stop());
      } catch (error) {
        toast.error((error as Error).message);
        setTranscribing(false);
      }
      return;
    }
    try {
      recorderRef.current = await startRecording();
      setRecordingSeconds(0);
      setRecording(true);
    } catch (error) {
      toast.error((error as Error).message);
    }
  };

  /** 交给模块层跑：切到别的页签也继续整理，回来自动显示结果 */
  const organize = (extra?: string) => {
    const fullText = extra ? `${raw}\n\n${extra}` : raw;
    if (!fullText.trim()) {
      toast.error(t("先把知道的情况写下来，怎么写都行"));
      return;
    }
    const previousJson = extra && draft ? serializeDraftForPrompt(draft) : "";
    const canMergeDraft = previousJson.length <= 2_500;
    const base = extra && canMergeDraft ? draft : null;
    const materialSource = extra && canMergeDraft ? extra : fullText;
    const builtPrompt = buildPrompt(materialSource, allowArchiveTools ? known : [], base);
    if (materialSource.length > builtPrompt.materialCharacters) {
      toast.warning(
        `${t("发送给 AI 的材料本次保留")} ${builtPrompt.materialCharacters.toLocaleString()} / ${materialSource.length.toLocaleString()} ${t("个字符；超出部分未发送，原文仍保留在输入框中。")}`,
      );
    }
    const sourceParts = [
      raw.includes("来自录音转写") || raw.includes("Transcript") ? t("录音转写") : "",
      attached.length ? `${t("文件")}：${attached.map((item) => item.name).join("、")}` : "",
      raw.trim() ? t("手动输入") : "",
      extra ? t("补充说明") : "",
    ].filter(Boolean);
    const sourceSummary = [...new Set(sourceParts)].join(" · ");
    startIntakeJob({
      text: fullText,
      extra: extra ?? null,
      initialTrace: t("正在准备整理材料"),
      run: async (report) => {
        report(
          `${t("已准备待整理材料")} · ${builtPrompt.materialCharacters.toLocaleString()} ${t("个字符")}`,
        );
        const parsed = await runIntakeAgent({
          preset,
          extractionPrompt: builtPrompt.prompt,
          persons: allowArchiveTools ? existingPeople : [],
          events: allowArchiveTools ? existingEvents : [],
          includeArchive: allowArchiveTools,
          onTrace: (event) =>
            report(
              event.text,
              event.kind === "check" ? "check" : event.kind === "model" ? "model" : "status",
            ),
        });
        report(t("模型输出完成，正在解析结构化草稿"), "check");
        report(t("正在核对人物字段与原文证据"), "check");
        const result = decorateDraft(
          base ? carryManualState(parsed, base) : parsed,
          sourceSummary,
          fullText,
        );
        report(
          `${t("整理完成")} · ${result.people?.length ?? 0} ${t("人")} · ${result.relations?.length ?? 0} ${t("条关系")} · ${result.events?.length ?? 0} ${t("个事件")}`,
          "done",
        );
        return result;
      },
    });
  };

  /** 认领后台整理好的结果（可能是在别的页签跑完的） */
  useEffect(() => {
    if (job.result) {
      if (!peopleLoaded) return;
      setDraft(prepareIdentityDecisions(job.result as Draft, existingPeople, existingEvents));
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
  }, [existingEvents, existingPeople, job, peopleLoaded]);

  const patchPerson = (index: number, patch: Partial<DraftPerson>) => {
    setDraft((prev) => {
      if (!prev?.people) return prev;
      const current = prev.people[index];
      if (!current) return prev;
      const nameChanged = Object.prototype.hasOwnProperty.call(patch, "name");
      const prospective = { ...current, ...patch };
      const manualFields = nameChanged
        ? SENSITIVE_PERSON_FIELDS.filter((field) => hasPersonFieldValue(prospective, field))
        : Object.keys(patch).filter(isSensitivePersonField);
      const identityChanged =
        nameChanged ||
        Object.prototype.hasOwnProperty.call(patch, "contact") ||
        Object.prototype.hasOwnProperty.call(patch, "identities");
      const previousName = current.name.trim();
      const nextName = (prospective.name ?? "").trim();
      let people = prev.people.map((person, i) => {
        if (i !== index) return person;
        const next = markSensitiveFieldsManual(
          mergeDraftPatch(person, patch),
          manualFields as SensitivePersonField[],
        );
        return identityChanged ? withIdentityDecision(next, existingPeople) : next;
      });
      if (nameChanged && previousName) {
        people = people.map((person) =>
          person.reportsTo?.trim() === previousName
            ? markSensitiveFieldsManual(mergeDraftPatch(person, { reportsTo: nextName }), [
                "reportsTo",
              ])
            : person,
        );
      }
      const rename = (value: string) =>
        nameChanged && previousName && value.trim() === previousName ? nextName : value;
      return {
        ...prev,
        people,
        facts: nameChanged
          ? (prev.facts ?? []).map((fact) =>
              fact.person.trim() === previousName
                ? mergeDraftPatch(fact, { person: nextName })
                : fact,
            )
          : prev.facts,
        relations: nameChanged
          ? (prev.relations ?? []).map((relation) =>
              relation.from.trim() === previousName || relation.to.trim() === previousName
                ? mergeDraftPatch(relation, {
                    from: rename(relation.from),
                    to: rename(relation.to),
                  })
                : relation,
            )
          : prev.relations,
        events: nameChanged
          ? (prev.events ?? []).map((event) =>
              (event.people ?? []).some((name) => name.trim() === previousName)
                ? mergeDraftPatch(event, {
                    people: (event.people ?? []).map(rename),
                  })
                : event,
            )
          : prev.events,
        reminders: nameChanged
          ? (prev.reminders ?? []).map((reminder) =>
              (reminder.people ?? []).some((name) => name.trim() === previousName)
                ? mergeDraftPatch(reminder, {
                    people: (reminder.people ?? []).map(rename),
                  })
                : reminder,
            )
          : prev.reminders,
        _groundingWarnings: (prev._groundingWarnings ?? []).filter(
          (item) =>
            item.personDraftId !== current._draftId ||
            (!nameChanged && !manualFields.includes(item.field as SensitivePersonField)),
        ),
      };
    });
  };

  const removePerson = (index: number) =>
    setDraft((prev) => {
      if (!prev) return prev;
      const personDraftId = prev.people?.[index]?._draftId;
      return {
        ...prev,
        people: (prev.people ?? []).filter((_, i) => i !== index),
        _groundingWarnings: (prev._groundingWarnings ?? []).filter(
          (item) => item.personDraftId !== personDraftId,
        ),
      };
    });

  const patchRelation = (index: number, patch: Partial<DraftRelation>) =>
    setDraft((prev) =>
      prev
        ? {
            ...prev,
            relations: (prev.relations ?? []).map((r, i) =>
              i === index ? mergeDraftPatch(r, patch) : r,
            ),
          }
        : prev,
    );

  const removeRelation = (index: number) =>
    setDraft((prev) =>
      prev ? { ...prev, relations: (prev.relations ?? []).filter((_, i) => i !== index) } : prev,
    );

  const patchEvidence = (index: number, patch: Partial<DraftEvidence>) =>
    setDraft((prev) =>
      prev
        ? {
            ...prev,
            evidence: (prev.evidence ?? []).map((e, i) =>
              i === index ? mergeDraftPatch(e, patch) : e,
            ),
          }
        : prev,
    );

  const removeEvidence = (index: number) =>
    setDraft((prev) =>
      prev ? { ...prev, evidence: (prev.evidence ?? []).filter((_, i) => i !== index) } : prev,
    );

  const patchFact = (index: number, patch: Partial<DraftFact>) =>
    setDraft((prev) =>
      (() => {
        if (!prev) return prev;
        const current = prev.facts?.[index];
        if (!current) return prev;
        return {
          ...prev,
          facts: (prev.facts ?? []).map((fact, i) =>
            i === index ? mergeDraftPatch(fact, patch) : fact,
          ),
          _groundingWarnings: (prev._groundingWarnings ?? []).filter(
            (warning) =>
              warning.field !== "facts" ||
              warning.personName !== current.person.trim() ||
              warning.rejectedValue !== `${current.key.trim()}: ${current.value.trim()}`,
          ),
        };
      })(),
    );

  const removeFact = (index: number) =>
    setDraft((prev) => {
      if (!prev) return prev;
      const current = prev.facts?.[index];
      return {
        ...prev,
        facts: (prev.facts ?? []).filter((_, i) => i !== index),
        _groundingWarnings: current
          ? (prev._groundingWarnings ?? []).filter(
              (warning) =>
                warning.field !== "facts" ||
                warning.personName !== current.person.trim() ||
                warning.rejectedValue !== `${current.key.trim()}: ${current.value.trim()}`,
            )
          : prev._groundingWarnings,
      };
    });

  const addFact = () =>
    setDraft((prev) => ({
      ...(prev ?? {}),
      facts: [
        ...(prev?.facts ?? []),
        {
          person: "",
          key: "",
          value: "",
          _audit: makeManualAudit(t("草稿中手动添加")),
        },
      ],
    }));

  const patchEvent = (index: number, patch: Partial<DraftEvent>) =>
    setDraft((prev) =>
      prev
        ? {
            ...prev,
            events: (prev.events ?? []).map((event, i) =>
              i === index ? mergeDraftPatch(event, patch) : event,
            ),
          }
        : prev,
    );

  const removeEvent = (index: number) =>
    setDraft((prev) =>
      prev ? { ...prev, events: (prev.events ?? []).filter((_, i) => i !== index) } : prev,
    );

  const addEvent = () =>
    setDraft((prev) => ({
      ...(prev ?? {}),
      events: [
        ...(prev?.events ?? []),
        {
          title: "",
          date: new Date().toLocaleDateString("sv-SE"),
          precision: "day",
          targetEventId: CREATE_NEW_EVENT,
          _eventChecked: true,
          _audit: makeManualAudit(t("草稿中手动添加")),
        },
      ],
    }));

  const patchReminder = (index: number, patch: Partial<DraftReminder>) =>
    setDraft((prev) =>
      prev
        ? {
            ...prev,
            reminders: (prev.reminders ?? []).map((reminder, i) =>
              i === index ? mergeDraftPatch(reminder, patch) : reminder,
            ),
          }
        : prev,
    );

  const removeReminder = (index: number) =>
    setDraft((prev) =>
      prev ? { ...prev, reminders: (prev.reminders ?? []).filter((_, i) => i !== index) } : prev,
    );

  const addReminder = () =>
    setDraft((prev) => ({
      ...(prev ?? {}),
      reminders: [
        ...(prev?.reminders ?? []),
        {
          title: "",
          kind: "custom",
          _audit: makeManualAudit(t("草稿中手动添加")),
        },
      ],
    }));

  const undoLastCommit = async () => {
    setUndoing(true);
    try {
      const undone = await undoLatestIntakeBatch();
      if (!undone) {
        setLatestBatch(null);
        toast.info(t("没有可撤销的录入批次"));
        return;
      }
      const [nextPeople, nextEvents] = await Promise.all([
        facesDb.listPersons(),
        facesDb.listLifeEvents(),
      ]);
      setExistingPeople(nextPeople);
      setExistingEvents(nextEvents);
      setKnown(nextPeople.map((person) => person.name));
      setLatestBatch(null);
      toast.success(t("已撤销最近一次录入批次"));
    } catch (error) {
      toast.error(`${t("撤销失败")}：${(error as Error).message}`);
    } finally {
      setUndoing(false);
    }
  };

  const loadOfflineDemoDraft = () => {
    if (
      (raw.trim() || draft) &&
      !window.confirm(t("这会替换当前未提交内容。确定载入合成的离线演示草稿吗？"))
    ) {
      return;
    }
    setRaw(OFFLINE_DEMO_MATERIAL);
    setSupplement("");
    setAttached([]);
    setDraft(
      prepareIdentityDecisions(
        enforceSensitiveFieldGrounding(makeOfflineDemoCandidate(), OFFLINE_DEMO_MATERIAL),
        existingPeople,
        existingEvents,
      ),
    );
    toast.success(t("已载入离线演示预置草稿（合成数据）"));
  };

  const acceptLowRiskItems = () => {
    setDraft((previous) => {
      if (!previous) return previous;
      return {
        ...previous,
        events: (previous.events ?? []).map((item) =>
          isLowRiskBatchEvent(item) ? { ...item, _audit: acceptedAudit(item._audit) } : item,
        ),
      };
    });
    toast.success(t("已批量接受未编辑、日期有效的高置信度本地事件；其余顶层条目仍需逐条确认"));
  };

  const acceptAllPendingItems = () => {
    if (!draft || !window.confirm(t("确定接受全部待确认条目吗？请先核对 AI 推断值和人物身份。"))) {
      return;
    }
    const accept = <T extends DraftAuditFields>(item: T): T => ({
      ...item,
      _audit: acceptedAudit(item._audit),
    });
    setDraft((previous) =>
      previous
        ? {
            ...previous,
            people: (previous.people ?? []).map(accept),
            facts: (previous.facts ?? []).map(accept),
            relations: (previous.relations ?? []).map(accept),
            events: (previous.events ?? []).map(accept),
            reminders: (previous.reminders ?? []).map(accept),
            evidence: (previous.evidence ?? []).map(accept),
          }
        : previous,
    );
    toast.success(t("已接受全部待确认条目；确认入库前仍会检查人物身份和日期格式"));
  };

  const commit = async () => {
    if (!draft || saving) return;
    const commitDraft = structuredClone(draft);
    const pendingAtCommit = reviewItemsOf(commitDraft).filter(
      (item) => item._audit?.confirmationStatus !== "accepted",
    ).length;
    if (pendingAtCommit > 0) {
      toast.error(`${t("仍有待确认条目")}：${pendingAtCommit}`);
      return;
    }
    const unresolvedPerson = (commitDraft.people ?? []).find(
      (item) => item.name?.trim() && !item.targetPersonId,
    );
    if (unresolvedPerson) {
      toast.error(`${t("请先确认人物是新建还是更新已有档案")}：${unresolvedPerson.name}`);
      return;
    }
    const inferredWithoutBasis = (commitDraft.relations ?? []).find(
      (item) =>
        !item._audit?.humanEdited &&
        relationNeedsInferenceReview({
          basis: item.basis,
          note: item.note,
          confidence: item._audit?.confidence,
        }) &&
        !isInferredRelationBasis(item.basis),
    );
    if (inferredWithoutBasis) {
      toast.error(
        `${t("推导关系缺少可核验依据")}：${inferredWithoutBasis.from} → ${inferredWithoutBasis.to}`,
      );
      return;
    }
    const invalidEvent = (commitDraft.events ?? []).find(
      (item) =>
        item.title?.trim() &&
        (!isValidIsoDate(item.date) ||
          (item.precision === "range" &&
            (!isValidIsoDate(item.dateEnd) || (item.dateEnd ?? "") < (item.date ?? "")))),
    );
    if (invalidEvent) {
      toast.error(`${t("请为事件填写有效日期")}：${invalidEvent.title}`);
      return;
    }
    const invalidReminder = (commitDraft.reminders ?? []).find(
      (item) => item.title?.trim() && item.due && !isValidIsoDate(item.due),
    );
    if (invalidReminder) {
      toast.error(`${t("请为提醒填写有效日期")}：${invalidReminder.title}`);
      return;
    }
    setSaving(true);
    const batch: IntakeUndoBatch = {
      id: crypto.randomUUID(),
      committedAt: Date.now(),
      createdPersonIds: [],
      createdRelationIds: [],
      createdEvidenceIds: [],
      createdEventIds: [],
      createdReminderIds: [],
      previousPeople: [],
      previousEvents: [],
    };
    const batchHasChanges = () =>
      batch.createdPersonIds.length > 0 ||
      batch.createdRelationIds.length > 0 ||
      batch.createdEvidenceIds.length > 0 ||
      batch.createdEventIds.length > 0 ||
      batch.createdReminderIds.length > 0 ||
      batch.previousPeople.length > 0 ||
      (batch.previousEvents?.length ?? 0) > 0;
    try {
      const [current, currentEvents] = await Promise.all([
        facesDb.listPersons(),
        facesDb.listLifeEvents(),
      ]);
      const byId = new Map(current.map((person) => [person.id, person]));
      const eventById = new Map(currentEvents.map((event) => [event.id, event]));
      const originalById = new Map(current.map((person) => [person.id, person]));
      const exactNameBuckets = new Map<string, PersonRecord[]>();
      current.forEach((person) => {
        const key = person.name.trim();
        exactNameBuckets.set(key, [...(exactNameBuckets.get(key) ?? []), person]);
      });
      const resolvedDraftNames = new Map<string, PersonRecord | null>();
      const rememberDraftName = (name: string, record: PersonRecord) => {
        const previous = resolvedDraftNames.get(name);
        resolvedDraftNames.set(name, previous && previous.id !== record.id ? null : record);
      };
      const resolvePersonName = (name: string) => {
        const key = name.trim();
        if (resolvedDraftNames.has(key)) return resolvedDraftNames.get(key) ?? undefined;
        const matches = exactNameBuckets.get(key) ?? [];
        return matches.length === 1 ? matches[0] : undefined;
      };
      let created = 0;
      let updated = 0;

      for (const item of commitDraft.people ?? []) {
        const name = (item.name ?? "").trim();
        if (!name) continue;
        const identityGroundingStatus = item._fieldGrounding?.identities?.status;
        const identitySourceKind = identityGroundingStatus === "manual" ? "manual" : "ai";
        const identityRows = (item.identities ?? [])
          .map((identity) => ({
            platform: identity.platform?.trim() ?? "",
            account: identity.account?.trim() || undefined,
            alias: identity.alias?.trim() ?? "",
            validFrom: identity.validFrom?.trim() || undefined,
            validTo: identity.validTo?.trim() || undefined,
            source: makeSource(
              identitySourceKind,
              identitySourceKind === "manual"
                ? t("草稿中人工编辑")
                : identityGroundingStatus === "unverified"
                  ? t("AI 推断，待核验")
                  : t("应用侧原文匹配"),
            ),
          }))
          .filter((identity) => identity.platform && identity.alias);
        const fieldSources = Object.fromEntries(
          SENSITIVE_PERSON_FIELDS.filter((field) => field !== "identities")
            .filter((field) => {
              if (!item._fieldGrounding?.[field]) return false;
              const value = item[field];
              return Array.isArray(value) ? value.length > 0 : value !== undefined && value !== "";
            })
            .map((field) => {
              const groundingStatus = item._fieldGrounding?.[field]?.status;
              const isManual = groundingStatus === "manual";
              return [
                field,
                makeSource(
                  isManual ? "manual" : "ai",
                  isManual
                    ? t("草稿中人工编辑")
                    : groundingStatus === "unverified"
                      ? t("AI 推断，待核验")
                      : t("应用侧原文匹配"),
                ),
              ];
            }),
        );
        const profileValues = {
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
          identities: identityRows.length ? identityRows : undefined,
          fieldSources: Object.keys(fieldSources).length ? fieldSources : undefined,
        };
        const profile = Object.fromEntries(
          Object.entries(profileValues).filter(([, value]) => value !== undefined),
        ) as NonNullable<PersonRecord["profile"]>;

        // 提交时重新运行匹配以应对草稿期间数据库发生变化；最终仍以用户在草稿中的选择为准。
        matchIdentity({ name, contact: item.contact, identities: item.identities }, current);
        if (item.targetPersonId !== CREATE_NEW_PERSON) {
          const exist = byId.get(item.targetPersonId ?? "");
          if (!exist) throw new Error(`${t("所选已有档案不存在，请重新选择")}：${name}`);
          if (!batch.previousPeople.some((person) => person.id === exist.id)) {
            batch.previousPeople.push(structuredClone(exist));
          }
          const mergedIdentities = [...(exist.profile?.identities ?? [])];
          for (const identity of identityRows) {
            const key =
              `${identity.platform}\u0000${identity.account ?? ""}\u0000${identity.alias}`.toLocaleLowerCase(
                "zh-CN",
              );
            const index = mergedIdentities.findIndex(
              (candidate) =>
                `${candidate.platform}\u0000${candidate.account ?? ""}\u0000${candidate.alias}`.toLocaleLowerCase(
                  "zh-CN",
                ) === key,
            );
            if (index >= 0) mergedIdentities[index] = { ...mergedIdentities[index], ...identity };
            else mergedIdentities.push(identity);
          }
          const record: PersonRecord = {
            ...exist,
            name,
            note: [exist.note, item.note].filter(Boolean).join("；"),
            profile: {
              ...exist.profile,
              ...profile,
              ...(profile.fieldSources
                ? {
                    fieldSources: {
                      ...exist.profile?.fieldSources,
                      ...profile.fieldSources,
                    },
                  }
                : {}),
              ...(mergedIdentities.length ? { identities: mergedIdentities } : {}),
            },
            updatedAt: Date.now(),
          };
          await facesDb.putPerson(record);
          byId.set(record.id, record);
          rememberDraftName(name, record);
          updated += 1;
          continue;
        }
        const record: PersonRecord = {
          id: crypto.randomUUID(),
          name,
          note: item.note ?? "",
          profile,
          descriptors: [],
          thumb: "",
          createdAt: Date.now(),
          source: makeSource(
            item._audit?.humanEdited ? "manual" : "ai",
            item._audit?.humanEdited ? t("草稿中人工编辑") : t("资料整理"),
          ),
        };
        await facesDb.putPerson(record);
        batch.createdPersonIds.push(record.id);
        byId.set(record.id, record);
        exactNameBuckets.set(name, [...(exactNameBuckets.get(name) ?? []), record]);
        rememberDraftName(name, record);
        created += 1;
      }

      let facts = 0;
      for (const item of commitDraft.facts ?? []) {
        const key = item.key?.trim();
        const value = item.value?.trim();
        const person = resolvePersonName(item.person ?? "");
        if (!key || !value) continue;
        if (!person) throw new Error(`${t("事实关联人物无法唯一确定")}：${item.person}`);
        if (
          !batch.createdPersonIds.includes(person.id) &&
          !batch.previousPeople.some((previous) => previous.id === person.id)
        ) {
          batch.previousPeople.push(structuredClone(originalById.get(person.id) ?? person));
        }
        const validity = [item.validFrom?.trim(), item.validTo?.trim()].filter(Boolean).join(" → ");
        const factSourceKind = item._audit?.humanEdited ? "manual" : "ai";
        const factNeedsReview = (commitDraft._groundingWarnings ?? []).some(
          (warning) =>
            warning.field === "facts" &&
            warning.personName === item.person.trim() &&
            warning.rejectedValue === `${key}: ${value}`,
        );
        const record: PersonRecord = {
          ...person,
          profile: {
            ...person.profile,
            extra: {
              ...person.profile?.extra,
              [key]: value,
              ...(validity ? { [`${key}（有效期）`]: validity } : {}),
            },
            fieldSources: {
              ...person.profile?.fieldSources,
              [`extra:${key}`]: makeSource(
                factSourceKind,
                factSourceKind === "manual"
                  ? t("草稿中人工编辑")
                  : factNeedsReview
                    ? t("AI 推断，待核验")
                    : t("应用侧原文匹配"),
              ),
            },
          },
          updatedAt: Date.now(),
        };
        await facesDb.putPerson(record);
        byId.set(record.id, record);
        rememberDraftName(item.person.trim(), record);
        facts += 1;
      }

      const evidenceIds: string[] = [];
      let docs = 0;
      for (const item of commitDraft.evidence ?? []) {
        const body = (item.text ?? "").trim();
        if (!body) continue;
        const kind =
          item.kind === "audio" || item.kind === "exhibit" || item.kind === "frame"
            ? item.kind
            : "note";
        const evidenceId = crypto.randomUUID();
        await facesDb.putEvidence({
          id: evidenceId,
          kind,
          title: (item.title ?? "").trim() || t("未命名材料"),
          text: body.slice(0, 800),
          origin:
            body.length > 800
              ? `${item.origin ? `${item.origin} · ` : ""}${t("仅保留前 800 字摘要")}`
              : item.origin,
          linkedPersonIds: (commitDraft.people ?? [])
            .map((person) => resolvePersonName(person.name ?? "")?.id)
            .filter((id): id is string => Boolean(id)),
          createdAt: Date.now(),
          source: makeSource(
            item._audit?.humanEdited ? "manual" : "ai",
            item._audit?.humanEdited ? t("草稿中人工编辑") : t("资料整理"),
          ),
        });
        evidenceIds.push(evidenceId);
        batch.createdEvidenceIds.push(evidenceId);
        docs += 1;
      }

      let links = 0;
      for (const item of commitDraft.relations ?? []) {
        const a = resolvePersonName(item.from ?? "");
        const b = resolvePersonName(item.to ?? "");
        if (!a || !b || a.id === b.id) continue;
        const now = Date.now();
        const relationId = crypto.randomUUID();
        await facesDb.putRelation({
          id: relationId,
          fromId: a.id,
          toId: b.id,
          label: (item.label ?? "").trim() || t("认识"),
          mutual: inferMutual((item.label ?? "").trim()),
          note: item.note,
          basis: item.basis?.trim() || undefined,
          sourceId: evidenceIds[0],
          createdAt: now,
          updatedAt: now,
          confirmationStatus: "confirmed",
          source: makeSource(
            item._audit?.humanEdited ? "manual" : "ai",
            item._audit?.humanEdited
              ? t("草稿中人工编辑")
              : relationNeedsInferenceReview({
                    basis: item.basis,
                    note: item.note,
                    confidence: item._audit?.confidence,
                  })
                ? t("AI 推断，经人工确认")
                : t("资料整理"),
          ),
        });
        batch.createdRelationIds.push(relationId);
        links += 1;
      }

      let events = 0;
      let eventUpdates = 0;
      for (const item of commitDraft.events ?? []) {
        const title = (item.title ?? "").trim();
        const date = (item.date ?? "").trim();
        if (!title || !date) continue;
        const precision = (["day", "month", "year", "range"] as const).includes(
          item.precision as "day",
        )
          ? item.precision
          : "day";
        const previous =
          item.targetEventId && item.targetEventId !== CREATE_NEW_EVENT
            ? eventById.get(item.targetEventId)
            : undefined;
        if (item.targetEventId && item.targetEventId !== CREATE_NEW_EVENT && !previous) {
          throw new Error(`${t("要更新的事件已不存在")}：${title}`);
        }
        const eventId = previous?.id ?? crypto.randomUUID();
        if (previous && !batch.previousEvents?.some((event) => event.id === previous.id)) {
          batch.previousEvents?.push(structuredClone(previous));
        }
        await facesDb.putLifeEvent({
          id: eventId,
          title,
          date,
          dateEnd: precision === "range" ? item.dateEnd || undefined : undefined,
          precision,
          detail: item.detail !== undefined ? item.detail || undefined : previous?.detail,
          place: item.place !== undefined ? item.place || undefined : previous?.place,
          personIds:
            item.people !== undefined
              ? item.people
                  .map((name) => resolvePersonName(name)?.id)
                  .filter((id): id is string => Boolean(id))
              : previous?.personIds,
          kind: item.kind !== undefined ? item.kind || undefined : previous?.kind,
          createdAt: previous?.createdAt ?? Date.now(),
          updatedAt: previous ? Date.now() : undefined,
          source: makeSource(
            item._audit?.humanEdited ? "manual" : "ai",
            item._audit?.humanEdited ? t("草稿中人工编辑") : t("资料整理"),
          ),
        });
        if (previous) {
          eventUpdates += 1;
        } else {
          batch.createdEventIds.push(eventId);
          events += 1;
        }
      }

      let reminders = 0;
      for (const item of commitDraft.reminders ?? []) {
        const title = (item.title ?? "").trim();
        if (!title) continue;
        const kind = (["birthday", "festival", "gift", "custom"] as const).includes(
          item.kind as "custom",
        )
          ? item.kind
          : "custom";
        const reminderId = crypto.randomUUID();
        await facesDb.putReminder({
          id: reminderId,
          title,
          detail: item.detail || undefined,
          due: item.due || undefined,
          personIds: (item.people ?? [])
            .map((name) => resolvePersonName(name)?.id)
            .filter((id): id is string => Boolean(id)),
          kind,
          done: false,
          createdAt: Date.now(),
          source: makeSource(
            item._audit?.humanEdited ? "manual" : "ai",
            item._audit?.humanEdited ? t("草稿中人工编辑") : t("资料整理"),
          ),
        });
        batch.createdReminderIds.push(reminderId);
        reminders += 1;
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
      const nextPeople = [...byId.values()];
      const nextEvents = await facesDb.listLifeEvents();
      setExistingPeople(nextPeople);
      setExistingEvents(nextEvents);
      setKnown(nextPeople.map((person) => person.name));
      if (batchHasChanges()) {
        batch.committedAt = Date.now();
        rememberIntakeBatch(batch);
        setLatestBatch(batch);
      }
      toast.success(
        `${t("新建")} ${created} · ${t("更新")} ${updated} · ${t("事实")} ${facts} · ${t("关系")} ${links} · ${t("新增事件")} ${events} · ${t("更新事件")} ${eventUpdates} · ${t("提醒")} ${reminders} · ${t("材料")} ${docs}`,
      );
    } catch (error) {
      if (batchHasChanges()) {
        batch.committedAt = Date.now();
        rememberIntakeBatch(batch);
        setLatestBatch(batch);
        toast.error(`${(error as Error).message} · ${t("已写入的部分可用下方按钮撤销")}`);
      } else {
        toast.error((error as Error).message);
      }
    } finally {
      setSaving(false);
    }
  };

  const gaps = (draft?.people ?? []).flatMap((person) =>
    missingOf(person).map(
      (field) => `${person.name || t("未命名")} · ${getLang() === "en" ? field.en : field.zh}`,
    ),
  );
  const reviewItems = reviewItemsOf(draft);
  const pendingReviewCount = reviewItems.filter(
    (item) => item._audit?.confirmationStatus !== "accepted",
  ).length;
  const lowRiskBatchCount = (draft?.events ?? []).filter(isLowRiskBatchEvent).length;
  const existingById = new Map(existingPeople.map((person) => [person.id, person]));
  const newPeople = (draft?.people ?? []).filter(
    (person) => person.targetPersonId === CREATE_NEW_PERSON,
  );
  const personUpdates = (draft?.people ?? [])
    .map((person) => {
      const current = existingById.get(person.targetPersonId ?? "");
      return current ? { person, current, changes: diffIngestPerson(person, current) } : null;
    })
    .filter(
      (
        item,
      ): item is {
        person: DraftPerson;
        current: PersonRecord;
        changes: ReturnType<typeof diffIngestPerson>;
      } => Boolean(item),
    );
  const identityConflicts = (draft?.people ?? []).filter(
    (person) => person.name?.trim() && !person.targetPersonId,
  );

  return (
    <section className="flex min-w-0 flex-col gap-5">
      <div className="rounded-2xl border border-border bg-card/60 p-5">
        <h2 className="flex items-baseline gap-2.5">
          <span className="font-display text-xl leading-none tracking-tight">
            {t("随手写，AI 来整理")}
          </span>
          <span className="text-[10px] uppercase tracking-[0.24em] text-muted-foreground">
            Intake
          </span>
        </h2>
        <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
          {t(
            "不用一格一格填表。把你知道的人和事一口气写下来，人物、关系、待办会自动拆好，缺的内容会提醒你补。",
          )}
        </p>
        <ul className="mt-2 list-inside list-disc space-y-1 text-[11px] text-muted-foreground">
          <li>
            {t("写人：小雨，大学室友，3 月 12 日生日，爱喝手冲咖啡、不吃香菜，现在在杭州做产品。")}
          </li>
          <li>{t("写待办：下周去看外婆，顺便帮她换手机卡，5 月 30 日前。")}</li>
        </ul>

        <Textarea
          value={raw}
          onChange={(event) => setRaw(event.target.value)}
          disabled={saving}
          rows={8}
          className="mt-4 text-sm"
          placeholder=""
        />

        <p className="mt-1.5 text-[10px] text-muted-foreground">
          {stashedAt
            ? `${t("已自动暂存")} · ${new Date(stashedAt).toLocaleTimeString()} · ${t("24 小时后自动过期")}`
            : t("每 15 秒自动暂存，仅保留在本浏览器并于 24 小时后过期")}
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
          <Button
            className="rounded-full px-5"
            onClick={() => void organize()}
            disabled={busy || !!reading || recording || transcribing || saving}
          >
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
            disabled={!!reading || busy || recording || transcribing || saving}
            onClick={() => fileRef.current?.click()}
          >
            {reading ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <Paperclip className="size-3.5" aria-hidden="true" />
            )}
            {t("导入图片 / PDF / Word / 文本")}
          </Button>
          <Button
            type="button"
            variant={recording ? "destructive" : "outline"}
            className="rounded-full px-4"
            onClick={() => void toggleRecording()}
            disabled={((busy || !!reading || transcribing) && !recording) || saving}
          >
            {recording ? (
              <>
                <Square className="size-3.5" aria-hidden="true" />
                {t("停止并转写")} · {recordingSeconds}s
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
            onClick={loadOfflineDemoDraft}
            disabled={busy || !!reading || recording || transcribing || saving}
          >
            <Sparkles className="size-3.5" aria-hidden="true" />
            {t("离线演示草稿")}
          </Button>
          <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <input
              type="checkbox"
              checked={allowArchiveTools}
              onChange={(event) => setAllowArchiveTools(event.target.checked)}
              className="size-3.5 accent-[hsl(var(--primary))]"
            />
            {t("允许 AI 按需读取已有档案，以识别人物或事件更新")}
          </label>
          {draft && (
            <Button
              variant="ghost"
              className="rounded-full px-4"
              onClick={() => setDraft(null)}
              disabled={saving}
            >
              <X className="size-3.5" aria-hidden="true" />
              {t("丢弃草稿")}
            </Button>
          )}
          {(raw.trim() || supplement.trim() || draft || attached.length > 0) && (
            <Button
              type="button"
              variant="ghost"
              className="rounded-full px-4 text-destructive hover:text-destructive"
              onClick={clearLocalDraft}
              disabled={saving}
            >
              <Trash2 className="size-3.5" aria-hidden="true" />
              {t("清除本地录入材料")}
            </Button>
          )}
          {latestBatch && (
            <Button
              type="button"
              variant="outline"
              className="rounded-full px-4"
              onClick={() => void undoLastCommit()}
              disabled={saving || undoing}
            >
              {undoing ? (
                <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <Undo2 className="size-3.5" aria-hidden="true" />
              )}
              {t("撤销最近一次录入")}
            </Button>
          )}
        </div>
        <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">
          {t("支持 JPG/PNG 等图片、PDF、DOCX、TXT、MD、CSV、JSON；一次最多")}{" "}
          {IMPORT_LIMITS.maxFiles} {t("个，单个不超过")} {IMPORT_LIMITS.maxFileBytes / 1024 / 1024}{" "}
          MB，PDF {t("最多读取")} {IMPORT_LIMITS.maxPdfPages} {t("页，每个文件最多提取")}{" "}
          {IMPORT_LIMITS.maxExtractedCharacters.toLocaleString()}{" "}
          {t("个字符。也可以 Ctrl/⌘+V 粘贴。")}
        </p>
        <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
          {t("录音会在停止后发送到当前转写服务；转写文字只会追加到输入框，不会自动整理或入库。")}
        </p>
        {transcribing && (
          <p
            className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground"
            role="status"
          >
            <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
            {t("录音已结束，正在转写")}
          </p>
        )}
        {reading && (
          <div className="mt-2 space-y-1">
            <Progress value={progress} className="h-1.5" />
            <p className="text-[11px] text-muted-foreground">
              {reading}… {progress}%
            </p>
          </div>
        )}
        {!reading && job.trace.length > 0 && (
          <div className="mt-2">
            <ReasoningDisclosure
              label={t("整理轨迹")}
              current={job.trace.at(-1)?.text ?? t("正在准备")}
              steps={job.trace.length}
              running={busy}
              history={job.trace.map((item) => item.text)}
              stepLabel={t("步")}
            />
          </div>
        )}
      </div>

      {draft && (
        <fieldset
          className="min-w-0 space-y-4 rounded-2xl border border-border bg-card/60 p-5 disabled:opacity-80"
          disabled={saving}
        >
          {draft.summary && (
            <p className="text-[11px] leading-relaxed text-muted-foreground">{draft.summary}</p>
          )}

          {(draft._groundingWarnings?.length ?? 0) > 0 && (
            <details
              className="group rounded-xl border border-amber-500/50 bg-amber-500/10 text-xs"
              role="alert"
            >
              <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 font-medium text-amber-800 marker:content-none dark:text-amber-200">
                <TriangleAlert className="size-3.5 shrink-0" aria-hidden="true" />
                <span>
                  {t("AI 推断值待核验")} · {draft._groundingWarnings?.length}
                </span>
                <span className="ml-auto text-[10px] font-normal text-muted-foreground">
                  {t("查看待核验项")}
                </span>
                <ArrowRight
                  className="size-3.5 shrink-0 transition-transform group-open:rotate-90"
                  aria-hidden="true"
                />
              </summary>
              <div className="border-t border-amber-500/25 px-3 pb-3 pt-2">
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  {t(
                    "这些值会保留在 AI 草稿中，感叹号表示未找到充分原文证据；请辨别真伪，编辑后会标记为人工来源。",
                  )}
                </p>
                <ul className="mt-2 space-y-1 text-[11px]">
                  {draft._groundingWarnings?.map((item, index) => (
                    <li key={`${item.personDraftId}-${item.field}-${index}`}>
                      {item.personName} · {sensitiveFieldLabel(item.field)}：
                      <span>{item.rejectedValue}</span>{" "}
                      <span
                        className="font-bold text-amber-700 dark:text-amber-300"
                        title={t("AI 推断，待核验")}
                        aria-label={t("AI 推断，待核验")}
                      >
                        !
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </details>
          )}

          <div className="rounded-xl border border-border bg-background/60 p-3">
            <p className="text-sm font-medium">{t("入库前变更预览（Diff）")}</p>
            <div className="mt-2 grid gap-2 text-[11px] text-muted-foreground sm:grid-cols-2">
              <div>
                <span className="font-medium text-foreground">{t("新人物")}</span> ·{" "}
                {newPeople.length}
                {newPeople.length > 0 && `：${newPeople.map((person) => person.name).join("、")}`}
              </div>
              <div>
                <span className="font-medium text-foreground">{t("更新已有")}</span> ·{" "}
                {personUpdates.length}
                {personUpdates.length > 0 &&
                  `：${personUpdates.map(({ current }) => current.name).join("、")}`}
              </div>
              <div className={identityConflicts.length ? "text-amber-700 dark:text-amber-300" : ""}>
                <span className="font-medium text-foreground">{t("可能同名/同人冲突")}</span> ·{" "}
                {identityConflicts.length}
                {identityConflicts.length > 0 &&
                  `：${identityConflicts.map((person) => person.name).join("、")}`}
              </div>
              <div>
                <span className="font-medium text-foreground">{t("新关系")}</span> ·{" "}
                {draft.relations?.length ?? 0}
              </div>
              <div>
                <span className="font-medium text-foreground">{t("新事实")}</span> ·{" "}
                {draft.facts?.length ?? 0}
              </div>
              <div>
                <span className="font-medium text-foreground">{t("新事件")}</span> ·{" "}
                {draft.events?.length ?? 0}
              </div>
              <div>
                <span className="font-medium text-foreground">{t("新提醒")}</span> ·{" "}
                {draft.reminders?.length ?? 0}
              </div>
            </div>
            {personUpdates.some(({ changes }) => changes.length > 0) && (
              <div className="mt-3 space-y-2 border-t border-border pt-3">
                {personUpdates.map(({ current, changes }) =>
                  changes.length ? (
                    <div key={current.id} className="space-y-1">
                      <p className="font-medium text-foreground">{current.name}</p>
                      {changes.map((change) => (
                        <p key={change.field} className="text-[10px] text-muted-foreground">
                          <span className="font-medium text-foreground">{change.field}</span>：
                          <span className="line-through opacity-70">{change.before}</span>
                          <ArrowRight className="mx-1 inline size-3" aria-hidden="true" />
                          {change.after}
                        </p>
                      ))}
                    </div>
                  ) : null,
                )}
              </div>
            )}
            <div className="mt-3 flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
              <span>{t("每个顶层草稿条目都要接受或拒绝；编辑已接受条目后会重新变为待确认。")}</span>
              <span className="rounded-full border border-border px-2 py-0.5">
                {t("待确认")} {pendingReviewCount}
              </span>
              <span className="ml-auto flex flex-wrap items-center gap-2">
                {lowRiskBatchCount > 0 && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 rounded-full px-3 text-[10px]"
                    onClick={acceptLowRiskItems}
                  >
                    <Check className="size-3" aria-hidden="true" />
                    {t("批量接受低风险高置信事件")} · {lowRiskBatchCount}
                  </Button>
                )}
                {pendingReviewCount > 0 && (
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    className="h-7 rounded-full px-3 text-[10px]"
                    onClick={acceptAllPendingItems}
                  >
                    <Check className="size-3" aria-hidden="true" />
                    {t("一键接受全部待确认")} · {pendingReviewCount}
                  </Button>
                )}
              </span>
            </div>
          </div>

          {gaps.length > 0 && (
            <div className="rounded-xl border border-primary/40 bg-primary/5 p-3">
              <p className="flex items-center gap-1.5 text-sm font-medium">
                <TriangleAlert className="size-4 text-primary" aria-hidden="true" />
                {t("这些必要信息还缺")}
              </p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {gaps.map((gap) => (
                  <span
                    key={gap}
                    className="rounded-full border border-border px-2 py-0.5 text-[10px]"
                  >
                    {gap}
                  </span>
                ))}
              </div>
              <Textarea
                value={supplement}
                onChange={(event) => setSupplement(event.target.value)}
                rows={3}
                className="mt-3 text-sm"
                placeholder={t(
                  "补一句就行，例：小雨微信 xiaoyu_0312，生日 3 月 12 日，爱喝手冲咖啡",
                )}
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
              <div
                key={person._draftId ?? `${person.name}-${index}`}
                className="rounded-xl border border-border p-3"
                data-draft-kind="person"
                data-draft-index={index}
              >
                <DraftAuditLine
                  audit={person._audit}
                  onAccept={() => patchPerson(index, { _audit: acceptedAudit(person._audit) })}
                  onReject={() => removePerson(index)}
                />
                <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg bg-muted/50 px-2.5 py-2">
                  <span className="text-[10px] text-muted-foreground">
                    {t("身份处理")} · {person._identityReason ?? t("正在比对本地档案")}
                  </span>
                  <select
                    value={person.targetPersonId ?? ""}
                    onChange={(event) =>
                      patchPerson(index, { targetPersonId: event.target.value || undefined })
                    }
                    className={`ml-auto h-8 max-w-full rounded-md border bg-background px-2 text-xs ${
                      person.targetPersonId ? "border-input" : "border-amber-500"
                    }`}
                    aria-label={t("选择新建人物或更新已有档案")}
                  >
                    {!person.targetPersonId && <option value="">{t("请选择身份处理方式")}</option>}
                    <option value={CREATE_NEW_PERSON}>{t("新建独立人物档案")}</option>
                    {(person._identityCandidateIds ?? []).map((id) => {
                      const candidate = existingPeople.find((record) => record.id === id);
                      if (!candidate) return null;
                      const detail = candidate.profile?.contact || candidate.id.slice(0, 8);
                      return (
                        <option key={candidate.id} value={candidate.id}>
                          {t("更新已有")}：{candidate.name} · {detail}
                        </option>
                      );
                    })}
                  </select>
                </div>
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
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  {(
                    [
                      ["age", t("年龄")],
                      ["gender", t("性别")],
                      ["address", t("办公地点")],
                      ["department", t("部门 / 科室")],
                      ["org", t("单位 / 公司")],
                      ["reportsTo", t("汇报对象")],
                      ["employeeId", t("工号 / 编号")],
                      ["metAt", t("相识场景")],
                    ] as Array<[keyof DraftPerson, string]>
                  ).map(([key, label]) => (
                    <Input
                      key={String(key)}
                      value={(person[key] as string) ?? ""}
                      onChange={(event) => patchPerson(index, { [key]: event.target.value })}
                      className="h-8 text-xs"
                      aria-label={label}
                      placeholder={label}
                    />
                  ))}
                </div>
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  <Input
                    value={person.title ?? ""}
                    onChange={(event) => patchPerson(index, { title: event.target.value })}
                    className="h-8 text-xs"
                    aria-label={t("职务/技能")}
                    placeholder={t("职务/技能")}
                  />
                  <select
                    value={person.closeness ?? ""}
                    onChange={(event) =>
                      patchPerson(index, {
                        closeness: event.target.value ? Number(event.target.value) : undefined,
                      })
                    }
                    className="h-8 rounded-md border border-input bg-background px-2 text-xs"
                    aria-label={t("亲密度")}
                  >
                    <option value="">{t("亲密度（未填写）")}</option>
                    {[1, 2, 3, 4, 5].map((value) => (
                      <option key={value} value={value}>
                        {t("亲密度")} {value}/5
                      </option>
                    ))}
                  </select>
                  <Input
                    value={(person.projects ?? []).join("、")}
                    onChange={(event) =>
                      patchPerson(index, { projects: splitDraftList(event.target.value) })
                    }
                    className="h-8 text-xs"
                    aria-label={t("项目/技能")}
                    placeholder={t("项目/技能（用逗号分隔）")}
                  />
                  <Input
                    value={(person.likes ?? []).join("、")}
                    onChange={(event) =>
                      patchPerson(index, { likes: splitDraftList(event.target.value) })
                    }
                    className="h-8 text-xs"
                    aria-label={t("喜好/技能关键词")}
                    placeholder={t("喜好/技能关键词（用逗号分隔）")}
                  />
                  <Input
                    value={(person.tags ?? []).join("、")}
                    onChange={(event) =>
                      patchPerson(index, { tags: splitDraftList(event.target.value) })
                    }
                    className="h-8 text-xs sm:col-span-2"
                    aria-label={t("标签/技能")}
                    placeholder={t("标签/技能（用逗号分隔）")}
                  />
                  <Input
                    value={(person.dislikes ?? []).join("、")}
                    onChange={(event) =>
                      patchPerson(index, { dislikes: splitDraftList(event.target.value) })
                    }
                    className="h-8 text-xs"
                    aria-label={t("忌口 / 不喜欢")}
                    placeholder={t("忌口 / 不喜欢（用逗号分隔）")}
                  />
                  <Input
                    value={(person.gifts ?? []).join("、")}
                    onChange={(event) =>
                      patchPerson(index, { gifts: splitDraftList(event.target.value) })
                    }
                    className="h-8 text-xs"
                    aria-label={t("送礼记录")}
                    placeholder={t("送礼记录（用逗号分隔）")}
                  />
                </div>
                {Object.keys(person._fieldGrounding ?? {}).length > 0 && (
                  <div className="mt-2 space-y-1 rounded-lg bg-muted/40 px-2.5 py-2 text-[10px] text-muted-foreground">
                    {Object.entries(person._fieldGrounding ?? {}).map(([field, detail]) => (
                      <p key={field}>
                        <span className="font-medium text-foreground">
                          {sensitiveFieldLabel(field as SensitivePersonField)}
                        </span>{" "}
                        ·{" "}
                        {detail?.status === "manual"
                          ? t("人工填写")
                          : detail?.status === "unverified"
                            ? `! ${t("AI 推断，待核验")}`
                            : t("应用侧原文匹配")}
                        {detail?.evidenceQuote ? `：${detail.evidenceQuote}` : ""}
                      </p>
                    ))}
                  </div>
                )}
                <div className="mt-2 space-y-2 rounded-lg border border-dashed border-border p-2">
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-muted-foreground">
                      {t("平台账号与历史昵称（仅保留材料明确写出的内容）")}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="ml-auto h-6 px-2 text-[10px]"
                      onClick={() =>
                        patchPerson(index, {
                          identities: [
                            ...(person.identities ?? []),
                            {
                              platform: "",
                              account: "",
                              alias: "",
                              validFrom: "",
                              validTo: "",
                            },
                          ],
                        })
                      }
                    >
                      <Plus className="size-3" aria-hidden="true" />
                      {t("添加")}
                    </Button>
                  </div>
                  {(person.identities ?? []).map((identity, identityIndex) => (
                    <div
                      key={identityIndex}
                      className="grid items-center gap-1.5 sm:grid-cols-[1fr_1fr_1fr_1fr_1fr_auto]"
                    >
                      {(
                        [
                          ["platform", t("平台")],
                          ["account", t("账号")],
                          ["alias", t("当时昵称")],
                          ["validFrom", t("生效日期")],
                          ["validTo", t("失效日期")],
                        ] as Array<
                          ["platform" | "account" | "alias" | "validFrom" | "validTo", string]
                        >
                      ).map(([key, label]) => (
                        <Input
                          key={key}
                          value={identity[key] ?? ""}
                          onChange={(event) =>
                            patchPerson(index, {
                              identities: (person.identities ?? []).map((row, rowIndex) =>
                                rowIndex === identityIndex
                                  ? { ...row, [key]: event.target.value }
                                  : row,
                              ),
                            })
                          }
                          className="h-7 text-[11px]"
                          placeholder={label}
                        />
                      ))}
                      <button
                        type="button"
                        aria-label={t("删除平台身份")}
                        className="p-1 text-muted-foreground hover:text-destructive"
                        onClick={() =>
                          patchPerson(index, {
                            identities: (person.identities ?? []).filter(
                              (_, rowIndex) => rowIndex !== identityIndex,
                            ),
                          })
                        }
                      >
                        <Trash2 className="size-3.5" aria-hidden="true" />
                      </button>
                    </div>
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

          <div className="space-y-2 rounded-xl border border-dashed border-border p-3">
            <div className="flex items-center gap-2">
              <Sparkles className="size-3.5 text-primary" aria-hidden="true" />
              <span className="text-xs font-medium">
                {t("事实草稿")} · {(draft.facts ?? []).length}
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="ml-auto h-7 rounded-full px-3 text-xs"
                onClick={addFact}
              >
                <Plus className="size-3.5" aria-hidden="true" />
                {t("加一条事实")}
              </Button>
            </div>
            {(draft.facts ?? []).length === 0 && (
              <p className="text-[11px] text-muted-foreground">
                {t("固定字段放不下、但材料明确提到的事实会在这里等待确认。")}
              </p>
            )}
            {(draft.facts ?? []).map((item, index) => (
              <div
                key={index}
                className="space-y-2 rounded-xl border border-border p-3"
                data-draft-kind="fact"
                data-draft-index={index}
              >
                <DraftAuditLine
                  audit={item._audit}
                  onAccept={() => patchFact(index, { _audit: acceptedAudit(item._audit) })}
                  onReject={() => removeFact(index)}
                />
                <div className="grid gap-2 sm:grid-cols-[1fr_1fr_2fr_auto]">
                  <Input
                    value={item.person ?? ""}
                    onChange={(event) => patchFact(index, { person: event.target.value })}
                    className="h-8 text-xs"
                    placeholder={t("人物")}
                  />
                  <Input
                    value={item.key ?? ""}
                    onChange={(event) => patchFact(index, { key: event.target.value })}
                    className="h-8 text-xs"
                    placeholder={t("事实字段")}
                  />
                  <Input
                    value={item.value ?? ""}
                    onChange={(event) => patchFact(index, { value: event.target.value })}
                    className="h-8 text-xs"
                    placeholder={t("材料明确支持的值")}
                  />
                  <button
                    type="button"
                    aria-label={t("删除事实草稿")}
                    className="p-1 text-muted-foreground hover:text-destructive"
                    onClick={() => removeFact(index)}
                  >
                    <Trash2 className="size-3.5" aria-hidden="true" />
                  </button>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  <Input
                    type="date"
                    value={item.validFrom ?? ""}
                    onChange={(event) => patchFact(index, { validFrom: event.target.value })}
                    className="h-8 text-xs"
                    aria-label={t("事实生效日期")}
                  />
                  <Input
                    type="date"
                    value={item.validTo ?? ""}
                    onChange={(event) => patchFact(index, { validTo: event.target.value })}
                    className="h-8 text-xs"
                    aria-label={t("事实失效日期")}
                  />
                </div>
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
              setDraft((prev) => {
                const person = withIdentityDecision(
                  {
                    name,
                    _draftId: crypto.randomUUID(),
                    _fieldGrounding: { name: { status: "manual" } },
                    _audit: makeManualAudit(t("草稿关系图中手动添加")),
                  },
                  existingPeople,
                );
                return { ...(prev ?? {}), people: [...(prev?.people ?? []), person] };
              })
            }
            onAddRelation={(from, to, label) =>
              setDraft((prev) => ({
                ...(prev ?? {}),
                relations: [
                  ...(prev?.relations ?? []),
                  {
                    from,
                    to,
                    label,
                    _audit: makeManualAudit(t("草稿关系图中手动添加")),
                  },
                ],
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
                  data-draft-kind="relation"
                  data-draft-index={index}
                >
                  <div className="w-full">
                    <DraftAuditLine
                      audit={relation._audit}
                      onAccept={() =>
                        patchRelation(index, { _audit: acceptedAudit(relation._audit) })
                      }
                      onReject={() => removeRelation(index)}
                    />
                  </div>
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
                  <div
                    className={cn(
                      "w-full space-y-1.5 rounded-lg border px-2.5 py-2",
                      relationNeedsInferenceReview({
                        basis: relation.basis,
                        note: relation.note,
                        confidence: relation._audit?.confidence,
                      })
                        ? "border-amber-400/50 bg-amber-400/5"
                        : "border-border bg-muted/25",
                    )}
                  >
                    <div className="flex flex-wrap items-center gap-2 text-[10px]">
                      <span
                        className={cn(
                          "rounded-full px-2 py-0.5 font-medium",
                          relationNeedsInferenceReview({
                            basis: relation.basis,
                            note: relation.note,
                            confidence: relation._audit?.confidence,
                          })
                            ? "bg-amber-400/15 text-amber-700 dark:text-amber-300"
                            : "bg-primary/10 text-primary",
                        )}
                      >
                        {relationNeedsInferenceReview({
                          basis: relation.basis,
                          note: relation.note,
                          confidence: relation._audit?.confidence,
                        })
                          ? relation._audit?.confirmationStatus === "accepted"
                            ? t("AI 推断，已人工接受")
                            : t("AI 推断，待核验")
                          : t("原文关系")}
                      </span>
                      {relation.note && (
                        <span className="text-muted-foreground">{relation.note}</span>
                      )}
                    </div>
                    <Input
                      value={relation.basis ?? ""}
                      onChange={(event) => patchRelation(index, { basis: event.target.value })}
                      className="h-8 text-xs"
                      aria-label={t("关系依据")}
                      placeholder={t("原文：… / 推断依据：…")}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="space-y-2 rounded-xl border border-dashed border-border p-3">
            <div className="flex items-center gap-2">
              <CalendarDays className="size-3.5 text-primary" aria-hidden="true" />
              <span className="text-xs font-medium">
                {t("事件草稿")} · {(draft.events ?? []).length}
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="ml-auto h-7 rounded-full px-3 text-xs"
                onClick={addEvent}
              >
                <Plus className="size-3.5" aria-hidden="true" />
                {t("加一条事件")}
              </Button>
            </div>
            {(draft.events ?? []).length === 0 && (
              <p className="text-[11px] text-muted-foreground">
                {t("材料里没读到明确事件。可手动补充往事、见面、通话或已经约定的日历事项。")}
              </p>
            )}
            {(draft.events ?? []).map((item, index) => (
              <div
                key={index}
                className="space-y-2 rounded-xl border border-border p-3"
                data-draft-kind="event"
                data-draft-index={index}
              >
                <DraftAuditLine
                  audit={item._audit}
                  onAccept={() => patchEvent(index, { _audit: acceptedAudit(item._audit) })}
                  onReject={() => removeEvent(index)}
                />
                <div className="space-y-1">
                  <select
                    value={item.targetEventId ?? CREATE_NEW_EVENT}
                    onChange={(event) =>
                      patchEvent(index, {
                        targetEventId: event.target.value,
                        _eventChecked: true,
                        _eventReason:
                          event.target.value === CREATE_NEW_EVENT
                            ? "将新建一条事件"
                            : "将覆盖所选事件；写入前仍需接受本草稿",
                      })
                    }
                    className="h-8 w-full rounded-md border border-input bg-background px-3 text-xs"
                    aria-label={t("事件写入方式")}
                  >
                    <option value={CREATE_NEW_EVENT}>{t("新增事件")}</option>
                    {existingEvents.slice(0, 100).map((event) => (
                      <option key={event.id} value={event.id}>
                        {t("更新已有")} · {event.date} · {event.title}
                      </option>
                    ))}
                  </select>
                  {item._eventReason && (
                    <p className="text-[11px] text-amber-600 dark:text-amber-300">
                      {item._eventReason}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <Input
                    value={item.title ?? ""}
                    onChange={(event) => patchEvent(index, { title: event.target.value })}
                    className="h-8 flex-1 text-sm"
                    placeholder={t("事件名称")}
                  />
                  <button
                    type="button"
                    aria-label={t("删除事件草稿")}
                    className="shrink-0 text-muted-foreground transition-colors hover:text-destructive"
                    onClick={() => removeEvent(index)}
                  >
                    <Trash2 className="size-3.5" aria-hidden="true" />
                  </button>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  <Input
                    type="date"
                    value={item.date ?? ""}
                    onChange={(event) => patchEvent(index, { date: event.target.value })}
                    className="h-8 text-xs"
                    aria-label={t("事件日期")}
                  />
                  <select
                    value={item.precision ?? "day"}
                    onChange={(event) =>
                      patchEvent(index, {
                        precision: event.target.value as DraftEvent["precision"],
                      })
                    }
                    className="h-8 rounded-md border border-input bg-background px-3 text-xs"
                    aria-label={t("日期精度")}
                  >
                    <option value="day">{t("确定到日")}</option>
                    <option value="month">{t("只确定到月")}</option>
                    <option value="year">{t("只确定到年")}</option>
                    <option value="range">{t("时间范围")}</option>
                  </select>
                  {item.precision === "range" && (
                    <Input
                      type="date"
                      value={item.dateEnd ?? ""}
                      onChange={(event) => patchEvent(index, { dateEnd: event.target.value })}
                      className="h-8 text-xs"
                      aria-label={t("事件结束日期")}
                    />
                  )}
                  <Input
                    value={item.place ?? ""}
                    onChange={(event) => patchEvent(index, { place: event.target.value })}
                    className="h-8 text-xs"
                    placeholder={t("地点")}
                  />
                  <Input
                    value={(item.people ?? []).join("、")}
                    onChange={(event) =>
                      patchEvent(index, {
                        people: event.target.value
                          .split(/[、,，\s]+/)
                          .map((name) => name.trim())
                          .filter(Boolean),
                      })
                    }
                    className="h-8 text-xs"
                    placeholder={t("相关人物（顿号分隔）")}
                  />
                  <Input
                    value={item.kind ?? ""}
                    onChange={(event) => patchEvent(index, { kind: event.target.value })}
                    className="h-8 text-xs"
                    placeholder={t("类型，如聚会 / 通话 / 帮忙")}
                  />
                </div>
                <Textarea
                  value={item.detail ?? ""}
                  onChange={(event) => patchEvent(index, { detail: event.target.value })}
                  rows={2}
                  className="text-xs"
                  placeholder={t("事件细节")}
                />
              </div>
            ))}
          </div>

          <div className="space-y-2 rounded-xl border border-dashed border-border p-3">
            <div className="flex items-center gap-2">
              <Bell className="size-3.5 text-primary" aria-hidden="true" />
              <span className="text-xs font-medium">
                {t("提醒草稿")} · {(draft.reminders ?? []).length}
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="ml-auto h-7 rounded-full px-3 text-xs"
                onClick={addReminder}
              >
                <Plus className="size-3.5" aria-hidden="true" />
                {t("加一条提醒")}
              </Button>
            </div>
            {(draft.reminders ?? []).length === 0 && (
              <p className="text-[11px] text-muted-foreground">
                {t("材料里没读到待办。可手动添加需要联系、祝福、送礼或跟进的行动。")}
              </p>
            )}
            {(draft.reminders ?? []).map((item, index) => (
              <div
                key={index}
                className="space-y-2 rounded-xl border border-border p-3"
                data-draft-kind="reminder"
                data-draft-index={index}
              >
                <DraftAuditLine
                  audit={item._audit}
                  onAccept={() => patchReminder(index, { _audit: acceptedAudit(item._audit) })}
                  onReject={() => removeReminder(index)}
                />
                <div className="flex items-center gap-2">
                  <Input
                    value={item.title ?? ""}
                    onChange={(event) => patchReminder(index, { title: event.target.value })}
                    className="h-8 flex-1 text-sm"
                    placeholder={t("要做什么")}
                  />
                  <button
                    type="button"
                    aria-label={t("删除提醒草稿")}
                    className="shrink-0 text-muted-foreground transition-colors hover:text-destructive"
                    onClick={() => removeReminder(index)}
                  >
                    <Trash2 className="size-3.5" aria-hidden="true" />
                  </button>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  <Input
                    type="date"
                    value={item.due ?? ""}
                    onChange={(event) => patchReminder(index, { due: event.target.value })}
                    className="h-8 text-xs"
                    aria-label={t("提醒日期")}
                  />
                  <select
                    value={item.kind ?? "custom"}
                    onChange={(event) =>
                      patchReminder(index, {
                        kind: event.target.value as DraftReminder["kind"],
                      })
                    }
                    className="h-8 rounded-md border border-input bg-background px-3 text-xs"
                    aria-label={t("提醒类型")}
                  >
                    <option value="custom">{t("普通待办")}</option>
                    <option value="birthday">{t("生日")}</option>
                    <option value="festival">{t("节日")}</option>
                    <option value="gift">{t("送礼")}</option>
                  </select>
                  <Input
                    value={(item.people ?? []).join("、")}
                    onChange={(event) =>
                      patchReminder(index, {
                        people: event.target.value
                          .split(/[、,，\s]+/)
                          .map((name) => name.trim())
                          .filter(Boolean),
                      })
                    }
                    className="h-8 text-xs sm:col-span-2"
                    placeholder={t("相关人物（顿号分隔）")}
                  />
                </div>
                <Textarea
                  value={item.detail ?? ""}
                  onChange={(event) => patchReminder(index, { detail: event.target.value })}
                  rows={2}
                  className="text-xs"
                  placeholder={t("提醒说明")}
                />
              </div>
            ))}
          </div>

          {(draft.evidence ?? []).length > 0 && (
            <div className="space-y-2">
              {(draft.evidence ?? []).map((item, index) => (
                <div
                  key={index}
                  className="space-y-2 rounded-xl border border-dashed border-border p-3"
                  data-draft-kind="evidence"
                  data-draft-index={index}
                >
                  <DraftAuditLine
                    audit={item._audit}
                    onAccept={() => patchEvidence(index, { _audit: acceptedAudit(item._audit) })}
                    onReject={() => removeEvidence(index)}
                  />
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
        </fieldset>
      )}
    </section>
  );
}
