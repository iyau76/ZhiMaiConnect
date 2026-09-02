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
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";

import { DraftGraph } from "@/components/draft-graph";
import { AgentRunInspector } from "@/components/agent-run-inspector";
import { ReasoningDisclosure } from "@/components/reasoning-disclosure";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Textarea } from "@/components/ui/textarea";
import { startRecording, transcribeAudio, type Recorder } from "@/lib/audio-client";
import { AGENT_PROMPT_MAX_CHARACTERS } from "@/lib/ai-request-contract";
import { IMPORT_LIMITS, importFiles } from "@/lib/doc-import";
import { claimIntakeJob, getIntakeJob, startIntakeJob, subscribeIntakeJob } from "@/lib/intake-job";
import {
  facesDb,
  type CollectionMembershipRecord,
  type CollectionRecord,
  type EvidenceRecord,
  type LifeEventRecord,
  type PersonRecord,
  type RelationAssertionRecord,
  type RelationEvidenceLinkRecord,
  type RelationRecord,
  type ReminderRecord,
} from "@/lib/face-db";
import { matchIdentity } from "@/lib/identity-match";
import { parseFuzzyLocal } from "@/lib/fuzzy-date";
import { getLang, t } from "@/lib/i18n";
import { isSelfReference, SELF_PERSON_ID } from "@/lib/person-identity";
import { ensureIntakeWorkspace, intakeWorkspaceView } from "@/lib/intake-workspace";
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
  rollbackIntakeBatch,
  undoLatestIntakeBatch,
  type IntakeUndoBatch,
} from "@/lib/intake-undo";
import { resolveRelationSemanticsForPeople } from "@/lib/relation-ontology";
import {
  isInferredRelationBasis,
  KINSHIP_RULES_EN,
  KINSHIP_RULES_ZH,
  relationNeedsInferenceReview,
} from "@/lib/kinship-rules";
import { makeSource } from "@/lib/provenance";
import { cn } from "@/lib/utils";
import { runIntakeAgent, type IntakePromptSections } from "@/lib/intake-agent";
import type { AgentRun } from "@/lib/agent-run-log";
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

const SCHEMA = `{"people":[{"name":"","note":"","age":"","gender":"","birthday":"","circle":"","closeness":null,"likes":[],"dislikes":[],"gifts":[],"metAt":"","contact":"","address":"","title":"","department":"","org":"","projects":[],"reportsTo":"","employeeId":"","tags":[],"identities":[{"platform":"","account":"","alias":"","validFrom":"","validTo":""}],"confidence":null}],"facts":[{"person":"","key":"","value":"","validFrom":"","validTo":"","confidence":null}],"relations":[{"from":"","to":"","label":"","note":"","basis":"","confidence":null}],"events":[{"title":"","detail":"","timeText":"原文时间短语","date":"","dateEnd":"","precision":"day|month|year|range","place":"","people":[],"kind":"","confidence":null}],"reminders":[{"title":"","detail":"","due":"","people":[],"kind":"birthday|festival|gift|custom","confidence":null}],"evidence":[{"kind":"note|audio|exhibit|frame","title":"","text":"","origin":"","confidence":null}],"summary":""}`;

const CREATE_NEW_PERSON = "__create_new_person__";
const CREATE_NEW_EVENT = "__create_new_event__";

function withIdentityDecision(person: DraftPerson, persons: PersonRecord[]): DraftPerson {
  if (
    person.targetPersonId &&
    person.targetPersonId !== CREATE_NEW_PERSON &&
    persons.some((existing) => existing.id === person.targetPersonId)
  ) {
    return {
      ...person,
      _identityCandidateIds: [person.targetPersonId],
      _identityReason: person._identityReason,
      _identityChecked: true,
    };
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
  const workspace = ensureIntakeWorkspace(draft);
  const people = (workspace.people ?? []).map((person) => ({
    ...withIdentityDecision(person, persons),
    _draftId: person._draftId,
  }));
  const uniqueDraftId = (name: string) => {
    const matches = people.filter((person) => person.name.trim() === name.trim());
    return matches.length === 1 ? matches[0]._draftId : undefined;
  };
  return {
    ...workspace,
    people,
    facts: (workspace.facts ?? []).map((fact) => ({
      ...fact,
      personDraftId:
        fact.personDraftId && people.some((person) => person._draftId === fact.personDraftId)
          ? fact.personDraftId
          : uniqueDraftId(fact.person),
    })),
    relations: (workspace.relations ?? []).map((relation) => ({
      ...relation,
      fromDraftId:
        relation.fromDraftId && people.some((person) => person._draftId === relation.fromDraftId)
          ? relation.fromDraftId
          : uniqueDraftId(relation.from),
      toDraftId:
        relation.toDraftId && people.some((person) => person._draftId === relation.toDraftId)
          ? relation.toDraftId
          : uniqueDraftId(relation.to),
    })),
    events: (workspace.events ?? []).map((event) => ({
      ...event,
      peopleDraftIds: (event.people ?? []).map(
        (name, index) => event.peopleDraftIds?.[index] ?? uniqueDraftId(name),
      ),
      targetEventId:
        event.targetEventId && events.some((existing) => existing.id === event.targetEventId)
          ? event.targetEventId
          : CREATE_NEW_EVENT,
      _eventChecked: true,
    })),
    reminders: (workspace.reminders ?? []).map((reminder) => ({
      ...reminder,
      peopleDraftIds: (reminder.people ?? []).map(
        (name, index) => reminder.peopleDraftIds?.[index] ?? uniqueDraftId(name),
      ),
    })),
  };
}

function serializeDraftForPrompt(draft: Draft) {
  return JSON.stringify(intakeWorkspaceView(draft));
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
      : (item._audit ?? makeExtractionAudit(sourceSummary, item.confidence, extractedAt)),
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

function buildPrompt(text: string, known: string[], previous: Draft | null) {
  const zh = getLang() !== "en";
  const today = new Date().toISOString().slice(0, 10);
  const base = zh
    ? `你是个人人脉整理助手。把下面这段自然语言材料整理成结构化 JSON，只输出 JSON，不要解释、不要 markdown。
严格使用这个结构：${SCHEMA}
规则：
 - 材料里没写的普通事实字段留空字符串或空数组；模型只抽取原文明说的关系，本地规则在提交后统一推导。
- title、部门、单位、项目、地址、忌口、礼物等人物字段只保留材料明确写出的值；“喜欢摄影”不能改写成“摄影师”。
- people 只承载人物自身属性，不承载人与人的关系。任何关系称谓都统一写进 relations；与用户本人的关系以「我」作为其中一个端点。
- 所属、称谓或主谓结构指向两个具体人物时，必须建立独立关系。例如“甲的学妹乙”“甲和乙是前同事”都不能只写进人物 note，也不能只把两人列进同一个事件。
- circle 只能是：家人 / 亲戚 / 朋友 / 同学 / 同事 / 邻居 / 其它。closeness 仅在材料明确给出 1-5 数值时填写，否则留空；不要根据关系称呼推断。
- birthday 用 MM-DD 或 YYYY-MM-DD。likes 喜好、dislikes 忌口或不喜欢、gifts 送过的礼物。
- identities 只记录材料明确出现的平台、账号、当时昵称与生效/失效时间；不要根据姓名猜账号或时间。
- facts 只放材料明确表达、但不属于固定人物字段的事实；person 指人物姓名，key 是短字段名，value 是原文可支持的值。validFrom/validTo 仅在材料给出有效期时填写。
- evidence 只保留能核对抽取结果的短摘要或必要原文片段，不要复制整份聊天、文档或转写稿，text 最多 500 字。
 - relations 写人和人之间原文明说的关系。每条 basis 都写“原文：最短支持片段”，不要输出推导关系。材料同时给出关系两端时，不得遗漏这条关系。
- 今天是 ${today}。events 放已经发生或计划发生、值得进入日历/时间线的事情；timeText 逐字复制原文时间短语，date 用 yyyy-mm-dd。相对时间依据今天换算；只知道月份或年份时分别补为当月 01 日或当年 01-01，并把 precision 标为 month 或 year；一段时间用 range 和 dateEnd。people 写相关人物姓名。
- reminders 放需要用户采取行动的待办，如「给小雨回电话」；due 仅在材料明确给出日期时使用 yyyy-mm-dd，people 写相关人物姓名。不要把同一件事同时放进 events 和 reminders，除非材料同时明确表达日历事件和后续行动。
- confidence 是你对每一条抽取准确性的自评（0 到 1），无法判断时留空；它只是提示，不能代替用户确认。
- summary 用一两句话说明这份材料讲了什么。
${KINSHIP_RULES_ZH}`
    : `You organise a personal contact network. Convert the text below into structured JSON. Output JSON only, no markdown, no explanation.
Use exactly this structure: ${SCHEMA}
Rules:
 - Leave ordinary fact fields empty when the text does not state them. Extract explicit relations only; deterministic local rules derive kinship after commit.
- Keep role, department, organisation, projects, address, dislikes and gifts only when explicitly stated. An interest in photography does not make someone a photographer.
- people contains attributes of the person only. Put every interpersonal tie in relations, including ties to the user, using “me” as one endpoint.
- A possessive, kinship title, or subject-predicate phrase that identifies two people requires a separate relation. Do not hide it only in a person's note or merely list both people on an event.
- circle is one of family / relatives / friends / classmates / colleagues / neighbours / other. Set closeness only when the material explicitly gives a 1-5 score; never infer it from a relationship label.
- birthday as MM-DD or YYYY-MM-DD. likes, dislikes, gifts are short arrays.
- identities contains only explicitly stated platform/account/alias and validity dates. Never guess an account or date from a name.
- facts contains only explicit facts that do not fit a fixed person field; person is the person's name and validity dates are included only when stated.
- evidence is a short source summary or the minimum excerpt needed for review (at most 500 characters), never a copy of the complete chat, document, or transcript.
 - relations = explicitly stated ties between people. Every basis starts with “Original:” and quotes the shortest supporting text. Do not output inferred ties. Never omit a tie when the material supplies both endpoints.
- Today is ${today}. Events are past or planned moments worth putting on a calendar/timeline. Copy the exact source phrase into timeText and normalize relative time to yyyy-mm-dd; use precision month/year/range when needed. people contains related names.
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
  const fitted = fitPromptMaterial(prefix, text, AGENT_PROMPT_MAX_CHARACTERS);
  const sections: IntakePromptSections = {
    instructions: base,
    knownContext: knownLine.trim(),
    previousDraft: previous ? JSON.parse(serializeDraftForPrompt(previous)) : undefined,
    sourceMaterial: text.slice(0, IMPORT_LIMITS.maxExtractedCharacters),
  };
  return { ...fitted, sections };
}

/** 未提交的录入内容随状态变化写入本地，切换页签后可以继续。 */
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

function DraftPersonReferenceInput({
  name,
  draftId,
  people,
  placeholder,
  className,
  onChange,
}: {
  name: string;
  draftId?: string;
  people: DraftPerson[];
  placeholder: string;
  className?: string;
  onChange: (name: string, draftId?: string) => void;
}) {
  const matches = people.filter((person) => person.name.trim() === name.trim());
  if (matches.length <= 1) {
    return (
      <Input
        value={name}
        onChange={(event) => onChange(event.target.value, undefined)}
        className={className}
        placeholder={placeholder}
      />
    );
  }
  return (
    <select
      value={draftId ?? ""}
      onChange={(event) => {
        const selected = matches.find((person) => person._draftId === event.target.value);
        onChange(selected?.name ?? name, selected?._draftId);
      }}
      className={cn(
        "rounded-md border border-amber-400/60 bg-background px-2 text-xs text-foreground",
        className,
      )}
      aria-label={`${placeholder}（同名人物消歧）`}
    >
      <option value="">{t("请选择同名人物")}</option>
      {matches.map((person, index) => (
        <option key={person._draftId} value={person._draftId}>
          {person.name} #{index + 1}
          {person.org || person.title ? ` · ${person.org || person.title}` : ""}
        </option>
      ))}
    </select>
  );
}

function DraftAmbiguousPeopleRefs({
  names,
  draftIds,
  people,
  onChange,
}: {
  names: string[];
  draftIds?: Array<string | undefined>;
  people: DraftPerson[];
  onChange: (draftIds: Array<string | undefined>) => void;
}) {
  const ambiguous = names
    .map((name, index) => ({
      name,
      index,
      matches: people.filter((person) => person.name.trim() === name.trim()),
    }))
    .filter((item) => item.matches.length > 1);
  if (!ambiguous.length) return null;
  return (
    <div className="mt-1 space-y-1 rounded-md border border-amber-400/50 bg-amber-400/5 p-1.5">
      {ambiguous.map((item) => (
        <label key={`${item.name}-${item.index}`} className="flex items-center gap-2 text-[10px]">
          <span className="shrink-0 text-amber-700 dark:text-amber-300">{item.name}</span>
          <select
            value={draftIds?.[item.index] ?? ""}
            onChange={(event) => {
              const next = Array.from({ length: names.length }, (_, index) => draftIds?.[index]);
              next[item.index] = event.target.value || undefined;
              onChange(next);
            }}
            className="h-7 min-w-0 flex-1 rounded border border-input bg-background px-2"
            aria-label={`${item.name}（同名人物消歧）`}
          >
            <option value="">{t("请选择同名人物")}</option>
            {item.matches.map((person, index) => (
              <option key={person._draftId} value={person._draftId}>
                {person.name} #{index + 1}
                {person.org || person.title ? ` · ${person.org || person.title}` : ""}
              </option>
            ))}
          </select>
        </label>
      ))}
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
  const [existingRelations, setExistingRelations] = useState<RelationRecord[]>([]);
  const [peopleLoaded, setPeopleLoaded] = useState(false);
  const [allowArchiveTools, setAllowArchiveTools] = useState(true);
  const [reading, setReading] = useState<string | null>(null);
  const [attached, setAttached] = useState<{ name: string; block: string }[]>([]);
  const [progress, setProgress] = useState(0);
  const [stashedAt, setStashedAt] = useState<number | null>(null);
  const [draftPersisted, setDraftPersisted] = useState(false);
  const [acceptAllOpen, setAcceptAllOpen] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [transcribing, setTranscribing] = useState(false);
  const [latestAgentRun, setLatestAgentRun] = useState<AgentRun | null>(null);
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
    setDraftPersisted(Boolean(stored.draft));
  }, []);

  useEffect(() => {
    void Promise.all([
      facesDb.listPersons(),
      facesDb.listLifeEvents(),
      facesDb.listRelationshipViews({ includeDerived: false }),
    ])
      .then(([people, events, relations]) => {
        setExistingPeople(people);
        setExistingEvents(events);
        setExistingRelations(relations);
        setKnown(people.map((row) => row.name));
      })
      .finally(() => setPeopleLoaded(true));
  }, []);

  useEffect(() => {
    if (!peopleLoaded) return;
    setDraft((previous) =>
      previous ? prepareIdentityDecisions(previous, existingPeople, existingEvents) : previous,
    );
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

  /** 草稿状态变化后立即短暂防抖写入；15 秒仅作为静态页面兜底。 */
  const snapshot = useRef({ raw, supplement, draft, attached });
  snapshot.current = { raw, supplement, draft, attached };
  const persistSnapshot = useCallback(() => {
    const now = snapshot.current;
    const empty = !now.raw.trim() && !now.supplement.trim() && !now.draft && !now.attached.length;
    if (empty) {
      window.localStorage.removeItem(DRAFT_KEY);
      setDraftPersisted(false);
      setStashedAt(null);
      return;
    }
    const at = Date.now();
    window.localStorage.setItem(DRAFT_KEY, JSON.stringify({ ...now, at }));
    setDraftPersisted(Boolean(now.draft));
    setStashedAt(at);
  }, []);

  useEffect(() => {
    setDraftPersisted(false);
    const timer = window.setTimeout(persistSnapshot, 250);
    return () => window.clearTimeout(timer);
  }, [attached, draft, persistSnapshot, raw, supplement]);

  useEffect(() => {
    const timer = window.setInterval(persistSnapshot, 15000);
    window.addEventListener("pagehide", persistSnapshot);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("pagehide", persistSnapshot);
      persistSnapshot();
    };
  }, [persistSnapshot]);

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
      const failures = docs.filter((doc) => doc.error);
      failures.forEach((doc) => toast.error(`${doc.name}：${doc.error}`));
      const entries = docs
        .filter((doc) => doc.text.trim() && !doc.error)
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
    const base = extra && draft ? ensureIntakeWorkspace(draft) : null;
    const materialSource = base ? (extra ?? "") : fullText;
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
          extractionPrompt: builtPrompt.sections,
          persons: allowArchiveTools ? existingPeople : [],
          events: allowArchiveTools ? existingEvents : [],
          relations: allowArchiveTools ? existingRelations : [],
          workspace: base ?? undefined,
          includeArchive: allowArchiveTools,
          sourceMaterial: materialSource,
          onTrace: (event) => report(event.text, event.kind),
          onRun: setLatestAgentRun,
        });
        report(t("模型输出完成，正在解析结构化草稿"), "check");
        report(t("正在核对人物字段与原文证据"), "check");
        const result = decorateDraft(parsed, sourceSummary, fullText);
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
      const oldNameUnique =
        prev.people.filter((person) => person.name.trim() === previousName).length === 1;
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
              fact.personDraftId === current._draftId ||
              (!fact.personDraftId && oldNameUnique && fact.person.trim() === previousName)
                ? mergeDraftPatch(fact, { person: nextName })
                : fact,
            )
          : prev.facts,
        relations: nameChanged
          ? (prev.relations ?? []).map((relation) =>
              relation.fromDraftId === current._draftId ||
              relation.toDraftId === current._draftId ||
              (oldNameUnique &&
                !relation.fromDraftId &&
                !relation.toDraftId &&
                (relation.from.trim() === previousName || relation.to.trim() === previousName))
                ? mergeDraftPatch(relation, {
                    from:
                      relation.fromDraftId === current._draftId ||
                      (!relation.fromDraftId && oldNameUnique)
                        ? rename(relation.from)
                        : relation.from,
                    to:
                      relation.toDraftId === current._draftId ||
                      (!relation.toDraftId && oldNameUnique)
                        ? rename(relation.to)
                        : relation.to,
                  })
                : relation,
            )
          : prev.relations,
        events: nameChanged
          ? (prev.events ?? []).map((event) =>
              (event.people ?? []).some(
                (name, personIndex) =>
                  event.peopleDraftIds?.[personIndex] === current._draftId ||
                  (!event.peopleDraftIds?.[personIndex] &&
                    oldNameUnique &&
                    name.trim() === previousName),
              )
                ? mergeDraftPatch(event, {
                    people: (event.people ?? []).map((name, personIndex) =>
                      event.peopleDraftIds?.[personIndex] === current._draftId ||
                      (!event.peopleDraftIds?.[personIndex] && oldNameUnique)
                        ? rename(name)
                        : name,
                    ),
                  })
                : event,
            )
          : prev.events,
        reminders: nameChanged
          ? (prev.reminders ?? []).map((reminder) =>
              (reminder.people ?? []).some(
                (name, personIndex) =>
                  reminder.peopleDraftIds?.[personIndex] === current._draftId ||
                  (!reminder.peopleDraftIds?.[personIndex] &&
                    oldNameUnique &&
                    name.trim() === previousName),
              )
                ? mergeDraftPatch(reminder, {
                    people: (reminder.people ?? []).map((name, personIndex) =>
                      reminder.peopleDraftIds?.[personIndex] === current._draftId ||
                      (!reminder.peopleDraftIds?.[personIndex] && oldNameUnique)
                        ? rename(name)
                        : name,
                    ),
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
          _draftId: `draft:fact:${crypto.randomUUID()}`,
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
          _draftId: `draft:event:${crypto.randomUUID()}`,
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
          _draftId: `draft:reminder:${crypto.randomUUID()}`,
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
      const [nextPeople, nextEvents, nextRelations] = await Promise.all([
        facesDb.listPersons(),
        facesDb.listLifeEvents(),
        facesDb.listRelationshipViews({ includeDerived: false }),
      ]);
      setExistingPeople(nextPeople);
      setExistingEvents(nextEvents);
      setExistingRelations(nextRelations);
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
    if (!draft) return;
    setAcceptAllOpen(true);
  };

  const confirmAcceptAllPendingItems = () => {
    if (!draft) return;
    const unresolvedRelationCount = (draft.relations ?? []).filter(
      (item) => item._audit?.confirmationStatus !== "accepted" && item._relationChecked === false,
    ).length;
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
            relations: (previous.relations ?? []).map((item) =>
              item._relationChecked === false ? item : accept(item),
            ),
            events: (previous.events ?? []).map(accept),
            reminders: (previous.reminders ?? []).map(accept),
            evidence: (previous.evidence ?? []).map(accept),
          }
        : previous,
    );
    toast.success(
      unresolvedRelationCount > 0
        ? `${t("已接受来源对齐的待确认条目")}；${unresolvedRelationCount} ${t("条证据未对齐关系仍待确认，可逐条查看或接受")}`
        : t("已接受全部来源对齐的待确认条目"),
    );
    setAcceptAllOpen(false);
  };

  const commit = async () => {
    if (!draft || saving) return;
    const commitDraft = structuredClone(draft);
    const pendingAtCommit = reviewItemsOf(commitDraft).filter(
      (item) => item._audit?.confirmationStatus !== "accepted",
    ).length;
    const unresolvedPerson = (commitDraft.people ?? []).find(
      (item) => item.name?.trim() && !item.targetPersonId,
    );
    if (unresolvedPerson) {
      toast.error(`${t("请先确认人物是新建还是更新已有档案")}：${unresolvedPerson.name}`);
      return;
    }
    const aiRelationsWithoutBasis = (commitDraft.relations ?? []).filter(
      (item) => !item._audit?.humanEdited && !item.basis?.trim(),
    );
    if (pendingAtCommit > 0 || aiRelationsWithoutBasis.length > 0) {
      toast.warning(
        `${pendingAtCommit} ${t("条 AI 内容已带待核验标记")}${
          aiRelationsWithoutBasis.length
            ? `；${aiRelationsWithoutBasis.length} ${t("条关系缺少依据并保持待确认")}`
            : ""
        }`,
      );
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
      const [current, currentEvents, currentAssertions, currentCollections] = await Promise.all([
        facesDb.listPersons(),
        facesDb.listLifeEvents(),
        facesDb.listRelationAssertions(),
        facesDb.listCollections(),
      ]);
      const byId = new Map(current.map((person) => [person.id, person]));
      const eventById = new Map(currentEvents.map((event) => [event.id, event]));
      const originalById = new Map(current.map((person) => [person.id, person]));
      const pendingPeople = new Map<string, PersonRecord>();
      const pendingAssertions = new Map<string, RelationAssertionRecord>();
      const pendingRelationEvidenceLinks: RelationEvidenceLinkRecord[] = [];
      const pendingEvidence: EvidenceRecord[] = [];
      const pendingEvents = new Map<string, LifeEventRecord>();
      const pendingReminders: ReminderRecord[] = [];
      const pendingCollections = new Map<string, CollectionRecord>();
      const pendingCollectionMemberships: CollectionMembershipRecord[] = [];
      const circleAssignments: Array<{ personId: string; name: string }> = [];
      const exactNameBuckets = new Map<string, PersonRecord[]>();
      current.forEach((person) => {
        const key = person.name.trim();
        exactNameBuckets.set(key, [...(exactNameBuckets.get(key) ?? []), person]);
      });
      const draftNameBuckets = new Map<string, DraftPerson[]>();
      for (const person of commitDraft.people ?? []) {
        const key = person.name.trim();
        if (key) draftNameBuckets.set(key, [...(draftNameBuckets.get(key) ?? []), person]);
      }
      const draftIds = new Set((commitDraft.people ?? []).map((person) => person._draftId));
      const ambiguousReference = (name: string, draftId?: string, personId?: string) => {
        const key = name.trim();
        if (!key || isSelfReference(key)) return false;
        if (personId && byId.has(personId)) return false;
        if (draftId && draftIds.has(draftId)) return false;
        const draftMatches = draftNameBuckets.get(key) ?? [];
        if (draftMatches.length) return draftMatches.length !== 1;
        return (exactNameBuckets.get(key) ?? []).length !== 1;
      };
      const ambiguous = [
        ...(commitDraft.facts ?? []).flatMap((fact) =>
          ambiguousReference(fact.person, fact.personDraftId, fact.personId)
            ? [`事实：${fact.person}`]
            : [],
        ),
        ...(commitDraft.relations ?? []).flatMap((relation) => [
          ...(ambiguousReference(relation.from, relation.fromDraftId, relation.fromPersonId)
            ? [`关系起点：${relation.from}`]
            : []),
          ...(ambiguousReference(relation.to, relation.toDraftId, relation.toPersonId)
            ? [`关系终点：${relation.to}`]
            : []),
        ]),
        ...(commitDraft.events ?? []).flatMap((event) =>
          (event.people ?? [])
            .filter((name, index) =>
              ambiguousReference(
                name,
                event.peopleDraftIds?.[index],
                event.peoplePersonIds?.[index],
              ),
            )
            .map((name) => `事件：${name}`),
        ),
        ...(commitDraft.reminders ?? []).flatMap((reminder) =>
          (reminder.people ?? [])
            .filter((name, index) => ambiguousReference(name, reminder.peopleDraftIds?.[index]))
            .map((name) => `提醒：${name}`),
        ),
      ];
      if (ambiguous.length) {
        throw new Error(
          `人物引用无法唯一确定，请在草稿中选择具体档案：${[...new Set(ambiguous)].join("、")}`,
        );
      }
      const resolvedDraftNames = new Map<string, PersonRecord | null>();
      const resolvedDraftIds = new Map<string, PersonRecord>();
      const rememberDraftName = (name: string, record: PersonRecord) => {
        const previous = resolvedDraftNames.get(name);
        resolvedDraftNames.set(name, previous && previous.id !== record.id ? null : record);
      };
      const resolvePersonName = (name: string) => {
        const key = name.trim();
        if (isSelfReference(key)) return byId.get(SELF_PERSON_ID);
        if (resolvedDraftNames.has(key)) return resolvedDraftNames.get(key) ?? undefined;
        const matches = exactNameBuckets.get(key) ?? [];
        return matches.length === 1 ? matches[0] : undefined;
      };
      const resolvePersonRef = (name: string, draftId?: string, personId?: string) =>
        (personId ? byId.get(personId) : undefined) ??
        (draftId ? resolvedDraftIds.get(draftId) : undefined) ??
        resolvePersonName(name);
      let created = 0;
      let updated = 0;

      const referencesSelf = [
        ...(commitDraft.people ?? []).map((item) => item.name),
        ...(commitDraft.facts ?? []).map((item) => item.person),
        ...(commitDraft.relations ?? []).flatMap((item) => [item.from, item.to]),
        ...(commitDraft.events ?? []).flatMap((item) => item.people ?? []),
        ...(commitDraft.reminders ?? []).flatMap((item) => item.people ?? []),
      ].some(isSelfReference);
      if (referencesSelf && !byId.has(SELF_PERSON_ID)) {
        const self: PersonRecord = {
          id: SELF_PERSON_ID,
          name: "我",
          note: "本人的本地关系锚点",
          descriptors: [],
          thumb: "",
          createdAt: Date.now(),
          entityRole: "ego",
          source: makeSource("manual", "系统创建的本人关系锚点"),
        };
        pendingPeople.set(self.id, self);
        batch.createdPersonIds.push(self.id);
        byId.set(self.id, self);
        exactNameBuckets.set(self.name, [self]);
        created += 1;
      }

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

        if (isSelfReference(name)) {
          const self = byId.get(SELF_PERSON_ID);
          if (!self) throw new Error("本人关系锚点创建失败");
          const record: PersonRecord = {
            ...self,
            name: "我",
            note: [self.note, item.note].filter(Boolean).join("；"),
            profile: { ...self.profile, ...profile },
            updatedAt: Date.now(),
          };
          pendingPeople.set(record.id, record);
          byId.set(record.id, record);
          rememberDraftName(name, record);
          if (item._draftId) resolvedDraftIds.set(item._draftId, record);
          if (item.circle?.trim())
            circleAssignments.push({ personId: record.id, name: item.circle.trim() });
          continue;
        }

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
          pendingPeople.set(record.id, record);
          byId.set(record.id, record);
          rememberDraftName(name, record);
          if (item._draftId) resolvedDraftIds.set(item._draftId, record);
          if (item.circle?.trim())
            circleAssignments.push({ personId: record.id, name: item.circle.trim() });
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
        pendingPeople.set(record.id, record);
        batch.createdPersonIds.push(record.id);
        byId.set(record.id, record);
        exactNameBuckets.set(name, [...(exactNameBuckets.get(name) ?? []), record]);
        rememberDraftName(name, record);
        if (item._draftId) resolvedDraftIds.set(item._draftId, record);
        if (item.circle?.trim())
          circleAssignments.push({ personId: record.id, name: item.circle.trim() });
        created += 1;
      }

      const collectionByName = new Map(
        currentCollections.map((collection) => [
          collection.name.trim().toLocaleLowerCase("zh-CN"),
          collection,
        ]),
      );
      for (const assignment of circleAssignments) {
        const key = assignment.name.toLocaleLowerCase("zh-CN");
        let collection = collectionByName.get(key) ?? pendingCollections.get(key);
        if (!collection) {
          const now = Date.now();
          collection = {
            id: `collection:${crypto.randomUUID()}`,
            name: assignment.name,
            kind: "relationship_circle",
            createdAt: now,
            updatedAt: now,
          };
          pendingCollections.set(key, collection);
          collectionByName.set(key, collection);
        }
        pendingCollectionMemberships.push({
          id: `${collection.id}\u0000${assignment.personId}`,
          collectionId: collection.id,
          personId: assignment.personId,
          source: "ai_approved",
          createdAt: Date.now(),
        });
      }

      let facts = 0;
      for (const item of commitDraft.facts ?? []) {
        const key = item.key?.trim();
        const value = item.value?.trim();
        const person = resolvePersonRef(item.person ?? "", item.personDraftId, item.personId);
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
        pendingPeople.set(record.id, record);
        byId.set(record.id, record);
        rememberDraftName(item.person.trim(), record);
        if (item.personDraftId) resolvedDraftIds.set(item.personDraftId, record);
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
        const evidenceRecord: EvidenceRecord = {
          id: evidenceId,
          kind,
          title: (item.title ?? "").trim() || t("未命名材料"),
          text: body.slice(0, 800),
          origin:
            body.length > 800
              ? `${item.origin ? `${item.origin} · ` : ""}${t("仅保留前 800 字摘要")}`
              : item.origin,
          linkedPersonIds: (commitDraft.people ?? [])
            .map((person) => resolvePersonRef(person.name ?? "", person._draftId)?.id)
            .filter((id): id is string => Boolean(id)),
          createdAt: Date.now(),
          source: makeSource(
            item._audit?.humanEdited ? "manual" : "ai",
            item._audit?.humanEdited ? t("草稿中人工编辑") : t("资料整理"),
          ),
        };
        pendingEvidence.push(evidenceRecord);
        evidenceIds.push(evidenceId);
        batch.createdEvidenceIds.push(evidenceId);
        docs += 1;
      }

      let links = 0;
      const currentAssertionById = new Map(
        currentAssertions.map((assertion) => [assertion.id, assertion]),
      );
      const relationDrafts = [...(commitDraft.relations ?? [])];
      for (const item of relationDrafts) {
        const a = resolvePersonRef(item.from ?? "", item.fromDraftId, item.fromPersonId);
        const b = resolvePersonRef(item.to ?? "", item.toDraftId, item.toPersonId);
        if (!a || !b) throw new Error(`关系端点无法确定：${item.from} → ${item.to}`);
        if (a.id === b.id) throw new Error(`关系不能连接同一人物：${item.from}`);
        const now = Date.now();
        const label = (item.label ?? "").trim() || t("认识");
        const semantics = resolveRelationSemanticsForPeople({
          label,
          fromGender: a.profile?.gender,
          toGender: b.profile?.gender,
        });
        const target = item.targetRelationId
          ? currentAssertionById.get(item.targetRelationId)
          : undefined;
        if (item.targetRelationId && !target) {
          throw new Error(`${t("要更新的关系已不存在")}：${item.from} → ${item.to}`);
        }
        // Every accepted source statement is an assertion. Updates supersede the
        // old assertion instead of overwriting its evidence/history in place.
        const relationId = crypto.randomUUID();
        const sourceIds = [...evidenceIds];
        const record: RelationAssertionRecord = {
          id: relationId,
          recordType: "assertion",
          fromId: a.id,
          toId: b.id,
          predicate: semantics.predicate,
          qualifiers: semantics.qualifiers,
          label,
          direction: semantics.predicate === "custom" ? "directed" : "ontology",
          note: item.note,
          evidence: {
            mode: item._audit?.humanEdited ? "manual" : "source_claim",
            basis: item.basis?.trim() || undefined,
            sourceIds,
          },
          validity: {
            status: semantics.qualifiers.temporalStatus === "former" ? "ended" : "active",
            validFrom: semantics.qualifiers.validFrom,
            validTo: semantics.qualifiers.validTo,
          },
          createdAt: now,
          updatedAt: now,
          confirmationStatus:
            item._audit?.humanEdited ||
            (item._audit?.confirmationStatus === "accepted" && Boolean(item.basis?.trim()))
              ? "confirmed"
              : "pending",
          confidence: item._audit?.confidence,
          supersedesAssertionId: target?.id,
          source: makeSource(
            item._audit?.humanEdited ? "manual" : "ai",
            item._audit?.humanEdited ? t("草稿中人工编辑") : t("资料整理"),
          ),
        };
        pendingAssertions.set(record.id, record);
        currentAssertionById.set(record.id, record);
        for (const evidenceId of sourceIds) {
          pendingRelationEvidenceLinks.push({
            id: `${record.id}\u0000${evidenceId}`,
            assertionId: record.id,
            evidenceId,
            excerpt: item.basis?.trim(),
            createdAt: now,
          });
        }
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
        const eventRecord: LifeEventRecord = {
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
                  .map(
                    (name, index) =>
                      resolvePersonRef(
                        name,
                        item.peopleDraftIds?.[index],
                        item.peoplePersonIds?.[index],
                      )?.id,
                  )
                  .filter((id): id is string => Boolean(id))
              : previous?.personIds,
          kind: item.kind !== undefined ? item.kind || undefined : previous?.kind,
          createdAt: previous?.createdAt ?? Date.now(),
          updatedAt: previous ? Date.now() : undefined,
          source: makeSource(
            item._audit?.humanEdited ? "manual" : "ai",
            item._audit?.humanEdited ? t("草稿中人工编辑") : t("资料整理"),
          ),
        };
        pendingEvents.set(eventRecord.id, eventRecord);
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
        const reminderRecord: ReminderRecord = {
          id: reminderId,
          title,
          detail: item.detail || undefined,
          due: item.due || undefined,
          personIds: (item.people ?? [])
            .map(
              (name, index) =>
                resolvePersonRef(name, item.peopleDraftIds?.[index], item.peoplePersonIds?.[index])
                  ?.id,
            )
            .filter((id): id is string => Boolean(id)),
          kind,
          done: false,
          createdAt: Date.now(),
          source: makeSource(
            item._audit?.humanEdited ? "manual" : "ai",
            item._audit?.humanEdited ? t("草稿中人工编辑") : t("资料整理"),
          ),
        };
        pendingReminders.push(reminderRecord);
        batch.createdReminderIds.push(reminderId);
        reminders += 1;
      }

      await facesDb.applyArchiveMutationBatch({
        persons: [...pendingPeople.values()],
        assertions: [...pendingAssertions.values()],
        evidence: pendingEvidence,
        evidenceLinks: pendingRelationEvidenceLinks,
        lifeEvents: [...pendingEvents.values()],
        reminders: pendingReminders,
        collections: [...pendingCollections.values()],
        collectionMemberships: pendingCollectionMemberships,
      });

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
      const [nextEvents, nextRelations] = await Promise.all([
        facesDb.listLifeEvents(),
        facesDb.listRelationshipViews(),
      ]);
      setExistingPeople(nextPeople);
      setExistingEvents(nextEvents);
      setExistingRelations(nextRelations);
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
        try {
          await rollbackIntakeBatch(batch);
          toast.error(`${(error as Error).message} · ${t("本批次已自动回滚，未留下部分数据")}`);
        } catch {
          batch.committedAt = Date.now();
          rememberIntakeBatch(batch);
          setLatestBatch(batch);
          toast.error(`${(error as Error).message} · ${t("自动回滚失败，可用下方按钮撤销")}`);
        }
      } else {
        toast.error((error as Error).message);
      }
    } finally {
      setSaving(false);
    }
  };

  const gaps = (draft?.people ?? []).flatMap((person, personIndex) =>
    missingOf(person).map((field) => ({
      key: `${person._draftId ?? `person-${personIndex}`}:${String(field.key)}`,
      text: `${person.name || t("未命名")} · ${getLang() === "en" ? field.en : field.zh}`,
    })),
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
    <section
      className="flex min-w-0 flex-col gap-5"
      data-testid="intake-panel"
      data-intake-draft-persisted={draft && draftPersisted ? "true" : "false"}
    >
      <AlertDialog open={acceptAllOpen} onOpenChange={setAcceptAllOpen}>
        <AlertDialogContent data-testid="intake-accept-all-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("接受已对齐项")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("接受来源已对齐的条目。证据未对齐的关系继续留在待确认。")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("取消")}</AlertDialogCancel>
            <AlertDialogAction
              data-testid="intake-accept-all-confirm"
              onClick={confirmAcceptAllPendingItems}
            >
              {t("确认接受")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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
            : t("内容会自动暂存在本浏览器，并于 24 小时后过期")}
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
              events={job.trace}
              stepLabel={t("步")}
            />
          </div>
        )}
        {latestAgentRun && !job.busy && (
          <div className="mt-3">
            <AgentRunInspector run={latestAgentRun} />
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
              <span>
                {t("待确认是软提醒；可逐条接受，也可直接入库，AI 内容会保留待核验标记。")}
              </span>
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
                    {t("一键接受已对齐项")} · {pendingReviewCount}
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
                    key={gap.key}
                    className="rounded-full border border-border px-2 py-0.5 text-[10px]"
                  >
                    {gap.text}
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
                key={item._draftId ?? `fact-${index}`}
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
                  <DraftPersonReferenceInput
                    name={item.person ?? ""}
                    draftId={item.personDraftId}
                    people={draft.people ?? []}
                    onChange={(person, personDraftId) =>
                      patchFact(index, { person, personDraftId })
                    }
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
                    _draftId: `draft:person:${crypto.randomUUID()}`,
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
                    _draftId: `draft:relation:${crypto.randomUUID()}`,
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
                  key={relation._draftId ?? `relation-${index}`}
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
                  <DraftPersonReferenceInput
                    name={relation.from ?? ""}
                    draftId={relation.fromDraftId}
                    people={draft.people ?? []}
                    onChange={(from, fromDraftId) =>
                      patchRelation(index, { from, fromDraftId, fromPersonId: undefined })
                    }
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
                  <DraftPersonReferenceInput
                    name={relation.to ?? ""}
                    draftId={relation.toDraftId}
                    people={draft.people ?? []}
                    onChange={(to, toDraftId) =>
                      patchRelation(index, { to, toDraftId, toPersonId: undefined })
                    }
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
                    {relation._relationChecked === false && relation._relationReason && (
                      <p className="text-[10px] leading-relaxed text-amber-700 dark:text-amber-300">
                        {relation._relationReason}
                      </p>
                    )}
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
                key={item._draftId ?? `event-${index}`}
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
                  {item.precision === "year" ? (
                    <Input
                      type="number"
                      min={1900}
                      max={2200}
                      value={item.date?.slice(0, 4) ?? ""}
                      onChange={(event) =>
                        patchEvent(index, {
                          date: /^\d{4}$/.test(event.target.value)
                            ? `${event.target.value}-01-01`
                            : "",
                        })
                      }
                      className="h-8 text-xs"
                      placeholder={t("年份")}
                      aria-label={t("事件年份")}
                    />
                  ) : (
                    <Input
                      type={item.precision === "month" ? "month" : "date"}
                      value={
                        item.precision === "month"
                          ? (item.date?.slice(0, 7) ?? "")
                          : (item.date ?? "")
                      }
                      onChange={(event) =>
                        patchEvent(index, {
                          date:
                            item.precision === "month" && event.target.value
                              ? `${event.target.value}-01`
                              : event.target.value,
                        })
                      }
                      className="h-8 text-xs"
                      aria-label={item.precision === "month" ? t("事件月份") : t("事件日期")}
                    />
                  )}
                  <select
                    value={item.precision ?? "day"}
                    onChange={(event) => {
                      const precision = event.target.value as DraftEvent["precision"];
                      const current = item.date ?? "";
                      patchEvent(index, {
                        precision,
                        date:
                          precision === "year" && current
                            ? `${current.slice(0, 4)}-01-01`
                            : precision === "month" && current
                              ? `${current.slice(0, 7)}-01`
                              : current,
                        dateEnd: precision === "range" ? item.dateEnd : undefined,
                      });
                    }}
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
                    value={item.timeText ?? ""}
                    onChange={(event) => patchEvent(index, { timeText: event.target.value })}
                    onBlur={(event) => {
                      const parsed = parseFuzzyLocal(event.target.value);
                      if (parsed) patchEvent(index, parsed);
                    }}
                    className="h-8 text-xs"
                    placeholder={t("原始时间表述，如：去年夏天")}
                    aria-label={t("原始时间表述")}
                  />
                  <Input
                    value={item.place ?? ""}
                    onChange={(event) => patchEvent(index, { place: event.target.value })}
                    className="h-8 text-xs"
                    placeholder={t("地点")}
                  />
                  <div>
                    <Input
                      value={(item.people ?? []).join("、")}
                      onChange={(event) =>
                        patchEvent(index, {
                          people: event.target.value
                            .split(/[、,，\s]+/)
                            .map((name) => name.trim())
                            .filter(Boolean),
                          peopleDraftIds: undefined,
                          peoplePersonIds: undefined,
                        })
                      }
                      className="h-8 text-xs"
                      placeholder={t("相关人物（顿号分隔）")}
                    />
                    <DraftAmbiguousPeopleRefs
                      names={item.people ?? []}
                      draftIds={item.peopleDraftIds}
                      people={draft.people ?? []}
                      onChange={(peopleDraftIds) =>
                        patchEvent(index, { peopleDraftIds, peoplePersonIds: undefined })
                      }
                    />
                  </div>
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
                key={item._draftId ?? `reminder-${index}`}
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
                  <div className="sm:col-span-2">
                    <Input
                      value={(item.people ?? []).join("、")}
                      onChange={(event) =>
                        patchReminder(index, {
                          people: event.target.value
                            .split(/[、,，\s]+/)
                            .map((name) => name.trim())
                            .filter(Boolean),
                          peopleDraftIds: undefined,
                        })
                      }
                      className="h-8 text-xs"
                      placeholder={t("相关人物（顿号分隔）")}
                    />
                    <DraftAmbiguousPeopleRefs
                      names={item.people ?? []}
                      draftIds={item.peopleDraftIds}
                      people={draft.people ?? []}
                      onChange={(peopleDraftIds) => patchReminder(index, { peopleDraftIds })}
                    />
                  </div>
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
                  key={item._draftId ?? `evidence-${index}`}
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
