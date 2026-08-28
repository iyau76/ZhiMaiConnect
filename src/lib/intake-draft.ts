import { z } from "zod";

import { parseLooseJson } from "./ai-text";
import { IMPORT_LIMITS } from "./doc-import";
import { normalizeRelationConfidence } from "./kinship-rules";
import type { PersonRecord } from "./face-db";

const SUPPORTED_EXTENSIONS = [
  ".pdf",
  ".docx",
  ".txt",
  ".md",
  ".markdown",
  ".csv",
  ".json",
] as const;

export interface IntakeFileLike {
  name: string;
  size: number;
  type?: string;
}

export interface ExtractionAudit {
  sourceSummary: string;
  extractedAt: number;
  confidence?: number;
  confirmationStatus: "pending" | "accepted";
  /** Once a user changes an extracted value, the model's old confidence is no longer applicable. */
  humanEdited?: boolean;
}

export type SensitivePersonField =
  | "name"
  | "note"
  | "age"
  | "gender"
  | "relation"
  | "contact"
  | "address"
  | "department"
  | "org"
  | "reportsTo"
  | "employeeId"
  | "birthday"
  | "circle"
  | "title"
  | "projects"
  | "likes"
  | "dislikes"
  | "gifts"
  | "metAt"
  | "tags"
  | "closeness"
  | "identities";

export type GroundingWarningField = SensitivePersonField | "facts";

export interface FieldGrounding {
  status: "supported" | "unverified" | "manual";
  /** A short review excerpt only; the complete source material is not copied into the profile. */
  evidenceQuote?: string;
}

export interface GroundingWarning {
  personIndex: number;
  personDraftId: string;
  personName: string;
  field: GroundingWarningField;
  rejectedValue: string;
}

export interface IngestAuditFields {
  /** Model self-assessment only; it never replaces user confirmation. */
  confidence?: number;
  /** Client-generated source and confirmation metadata. */
  _audit?: ExtractionAudit;
}

export interface IngestPerson extends IngestAuditFields {
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
  identities?: Array<{
    platform?: string;
    account?: string;
    alias?: string;
    validFrom?: string;
    validTo?: string;
  }>;
  /** Client-side identity decision; excluded from model prompts. */
  targetPersonId?: string;
  _identityCandidateIds?: string[];
  _identityReason?: string;
  _identityChecked?: boolean;
  _draftId?: string;
  /** Client-generated field evidence; excluded from model prompts and formal profile fields. */
  _fieldGrounding?: Partial<Record<SensitivePersonField, FieldGrounding>>;
}

export interface IngestRelation extends IngestAuditFields {
  from: string;
  to: string;
  label: string;
  note?: string;
  /** “原文：…”或“推断依据：…”，用于区分事实关系与待核验推导。 */
  basis?: string;
  /** Client-side update decision; never accepted directly from the model schema. */
  targetRelationId?: string;
  _relationChecked?: boolean;
  _relationReason?: string;
  /** Stable client-side endpoint references used when multiple people share a name. */
  fromDraftId?: string;
  toDraftId?: string;
  /** Existing archive endpoints selected by the typed intake compiler. */
  fromPersonId?: string;
  toPersonId?: string;
}

export interface IngestFact extends IngestAuditFields {
  person: string;
  key: string;
  value: string;
  validFrom?: string;
  validTo?: string;
  /** Stable client-side person reference; never accepted from the model. */
  personDraftId?: string;
  /** Existing archive person selected by the typed intake compiler. */
  personId?: string;
}

export interface IngestEvidence extends IngestAuditFields {
  kind?: string;
  title?: string;
  text?: string;
  origin?: string;
}

export interface IngestEvent extends IngestAuditFields {
  title: string;
  detail?: string;
  date?: string;
  dateEnd?: string;
  precision?: "day" | "month" | "year" | "range";
  place?: string;
  people?: string[];
  peopleDraftIds?: Array<string | undefined>;
  /** Existing archive people selected by the typed intake compiler. */
  peoplePersonIds?: Array<string | undefined>;
  kind?: string;
  /** Client-side update decision; never accepted directly from the model schema. */
  targetEventId?: string;
  _eventCandidateIds?: string[];
  _eventReason?: string;
  _eventChecked?: boolean;
  _draftId?: string;
  /** True only when every populated event field was located in this input. */
  _groundingVerified?: boolean;
}

export interface IngestReminder extends IngestAuditFields {
  title: string;
  detail?: string;
  due?: string;
  people?: string[];
  peopleDraftIds?: Array<string | undefined>;
  /** Existing archive people selected by the typed intake compiler. */
  peoplePersonIds?: Array<string | undefined>;
  kind?: "birthday" | "festival" | "gift" | "custom";
}

/** One reviewable contract shared by text, file, image and voice intake. */
export interface IngestCandidate {
  people?: IngestPerson[];
  facts?: IngestFact[];
  relations?: IngestRelation[];
  events?: IngestEvent[];
  reminders?: IngestReminder[];
  evidence?: IngestEvidence[];
  summary?: string;
  /** AI-provided values that could not be matched to the current source material. */
  _groundingWarnings?: GroundingWarning[];
}

const confidenceSchema = z
  .number()
  .min(0)
  .max(1)
  .nullish()
  .transform((value) => value ?? undefined);
const shortText = z.string().max(500).optional();
const stringList = z.array(z.string().max(300)).max(30).optional();

const ingestPersonSchema = z
  .object({
    name: z.string().max(200),
    note: z.string().max(2_000).optional(),
    age: shortText,
    gender: shortText,
    relation: shortText,
    contact: shortText,
    address: shortText,
    title: shortText,
    department: shortText,
    org: shortText,
    projects: stringList,
    reportsTo: shortText,
    employeeId: shortText,
    birthday: shortText,
    circle: shortText,
    closeness: z
      .number()
      .finite()
      .min(1)
      .max(5)
      .nullish()
      // 模型偶尔会把 1-5 档位输出成 3.5、4.2 等小数。亲密度在产品里
      // 是离散档位，因此在解析边界就归到最近一档，避免一个小数字段
      // 让整份人物草稿都无法展示。
      .transform((value) =>
        value === null || value === undefined ? undefined : Math.round(value),
      ),
    likes: stringList,
    dislikes: stringList,
    gifts: stringList,
    metAt: shortText,
    tags: stringList,
    identities: z
      .array(
        z
          .object({
            platform: shortText,
            account: shortText,
            alias: shortText,
            validFrom: shortText,
            validTo: shortText,
          })
          .strict(),
      )
      .max(30)
      .optional(),
    confidence: confidenceSchema,
  })
  .strict();

const ingestFactSchema = z
  .object({
    person: z.string().max(200),
    key: z.string().max(200),
    value: z.string().max(2_000),
    validFrom: shortText,
    validTo: shortText,
    confidence: confidenceSchema,
  })
  .strict();

const ingestRelationSchema = z
  .object({
    from: z.string().max(200),
    to: z.string().max(200),
    label: z.string().max(300),
    note: z.string().max(2_000).optional(),
    basis: shortText,
    confidence: confidenceSchema,
  })
  .strict()
  .transform((relation) => ({
    ...relation,
    confidence: normalizeRelationConfidence(relation.basis, relation.confidence),
  }));

const ingestEventSchema = z
  .object({
    title: z.string().max(500),
    detail: z.string().max(2_000).optional(),
    date: shortText,
    dateEnd: shortText,
    precision: z.enum(["day", "month", "year", "range"]).optional(),
    place: shortText,
    people: stringList,
    kind: shortText,
    confidence: confidenceSchema,
  })
  .strict();

const ingestReminderSchema = z
  .object({
    title: z.string().max(500),
    detail: z.string().max(2_000).optional(),
    due: shortText,
    people: stringList,
    kind: z.enum(["birthday", "festival", "gift", "custom"]).optional(),
    confidence: confidenceSchema,
  })
  .strict();

const ingestEvidenceSchema = z
  .object({
    kind: shortText,
    title: shortText,
    text: z.string().max(8_000).optional(),
    origin: shortText,
    confidence: confidenceSchema,
  })
  .strict();

export const ingestCandidateSchema = z
  .object({
    people: z.array(ingestPersonSchema).max(100).optional(),
    facts: z.array(ingestFactSchema).max(200).optional(),
    relations: z.array(ingestRelationSchema).max(200).optional(),
    events: z.array(ingestEventSchema).max(200).optional(),
    reminders: z.array(ingestReminderSchema).max(200).optional(),
    evidence: z.array(ingestEvidenceSchema).max(30).optional(),
    summary: z.string().max(2_000).optional(),
  })
  .strict();

/** Parse the model's loose wrapper, then enforce the runtime intake contract. */
export function parseIngestCandidate(text: string): IngestCandidate {
  return ingestCandidateSchema.parse(parseLooseJson<unknown>(text));
}

export interface IngestFieldDiff {
  field: string;
  before: string;
  after: string;
}

const PROFILE_DIFF_FIELDS: Array<
  [keyof IngestPerson, keyof NonNullable<PersonRecord["profile"]>, string]
> = [
  ["relation", "relation", "关系"],
  ["birthday", "birthday", "生日"],
  ["contact", "contact", "联系方式"],
  ["title", "title", "职务"],
  ["org", "org", "组织"],
  ["circle", "circle", "圈层"],
  ["closeness", "closeness", "亲密度"],
  ["likes", "likes", "喜好"],
  ["dislikes", "dislikes", "忌口/不喜欢"],
  ["gifts", "gifts", "送礼记录"],
  ["metAt", "metAt", "相识场景"],
  ["tags", "tags", "标签"],
];

function displayDiffValue(value: unknown) {
  if (Array.isArray(value)) return value.join("、");
  if (value === undefined || value === null || value === "") return "（空）";
  return String(value);
}

/** Describe only fields the intake would actually write over an existing record. */
export function diffIngestPerson(
  candidate: IngestPerson,
  current: PersonRecord,
): IngestFieldDiff[] {
  const result: IngestFieldDiff[] = [];
  if (candidate.name.trim() && candidate.name.trim() !== current.name) {
    result.push({ field: "姓名", before: current.name, after: candidate.name.trim() });
  }
  if (candidate.note?.trim()) {
    const after = [current.note, candidate.note.trim()].filter(Boolean).join("；");
    if (after !== current.note) result.push({ field: "备注", before: current.note, after });
  }
  for (const [candidateKey, profileKey, field] of PROFILE_DIFF_FIELDS) {
    const after = candidate[candidateKey];
    if (after === undefined || after === "" || (Array.isArray(after) && after.length === 0)) {
      continue;
    }
    const before = current.profile?.[profileKey];
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      result.push({
        field,
        before: displayDiffValue(before),
        after: displayDiffValue(after),
      });
    }
  }
  if (candidate.identities?.length) {
    const before = current.profile?.identities ?? [];
    const additions = candidate.identities.filter(
      (identity) =>
        !before.some(
          (existing) =>
            existing.platform === identity.platform &&
            existing.account === identity.account &&
            existing.alias === identity.alias &&
            existing.validFrom === identity.validFrom &&
            existing.validTo === identity.validTo,
        ),
    );
    if (additions.length) {
      result.push({
        field: "身份历史",
        before: before.map((identity) => identity.alias).join("、") || "（空）",
        after: [...before.map((identity) => identity.alias), ...additions.map((item) => item.alias)]
          .filter(Boolean)
          .join("、"),
      });
    }
  }
  return result;
}

export function fitPromptMaterial(
  prefix: string,
  material: string,
  maxPromptCharacters: number,
  maxMaterialCharacters = IMPORT_LIMITS.maxExtractedCharacters,
) {
  const minimumMaterialCharacters = Math.min(3_000, maxMaterialCharacters, material.length);
  const prefixBudget = Math.max(0, maxPromptCharacters - minimumMaterialCharacters);
  const safePrefix = prefix.slice(0, prefixBudget);
  const materialCharacters = Math.min(
    material.length,
    maxMaterialCharacters,
    Math.max(0, maxPromptCharacters - safePrefix.length),
  );
  return {
    prompt: `${safePrefix}${material.slice(0, materialCharacters)}`,
    materialCharacters,
  };
}

export function normalizeConfidence(value: unknown): number | undefined {
  if (value === null || value === "" || typeof value === "boolean") return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.max(0, Math.min(1, parsed));
}

export function makeExtractionAudit(
  sourceSummary: string,
  confidence?: unknown,
  extractedAt = Date.now(),
): ExtractionAudit {
  return {
    sourceSummary: sourceSummary.trim() || "手动输入",
    extractedAt,
    confidence: normalizeConfidence(confidence),
    confirmationStatus: "pending",
  };
}

/** Strict yyyy-mm-dd validation, including real month/day boundaries. */
export function isValidIsoDate(value: string | undefined): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

export const OFFLINE_DEMO_MATERIAL =
  "唐悦是我的大学摄影社搭档，也是大学同学。在大学摄影社（模拟）期间（2022-09-01 至 2024-06-30），大家叫她糖糖。她现在的职业是活动摄影师，擅长活动摄影和短视频。她愿意帮校园记忆展拍开幕照。唐悦的档期状态是“8 月 28 日前需再次确认”。周宁是我的大学室友，也是大学同学，职业是品牌设计师，擅长海报设计，不吃甜食。唐悦和周宁在去年的校庆展合作过。";

/** A clearly labelled synthetic fallback for demos when no model is available. */
export function makeOfflineDemoCandidate(extractedAt = Date.now()): IngestCandidate {
  const audit = (confidence: number): ExtractionAudit =>
    makeExtractionAudit("离线演示预置结果（合成数据）", confidence, extractedAt);
  return {
    summary: "离线演示预置草稿：校园记忆展（全部为合成数据，请先编辑确认）",
    people: [
      {
        name: "唐悦",
        relation: "大学摄影社搭档",
        title: "活动摄影师",
        likes: ["活动摄影", "短视频"],
        circle: "大学同学",
        identities: [
          {
            platform: "大学摄影社（模拟）",
            alias: "糖糖",
            validFrom: "2022-09-01",
            validTo: "2024-06-30",
          },
        ],
        note: "愿意帮校园记忆展拍开幕照",
        confidence: 0.94,
        _audit: audit(0.94),
      },
      {
        name: "周宁",
        relation: "大学室友",
        title: "品牌设计师",
        likes: ["海报设计"],
        dislikes: ["甜食"],
        circle: "大学同学",
        confidence: 0.92,
        _audit: audit(0.92),
      },
    ],
    relations: [
      {
        from: "唐悦",
        to: "周宁",
        label: "校庆展合作伙伴",
        note: "去年共同参与校庆展",
        basis: "原文：唐悦和周宁在去年的校庆展合作过",
        confidence: 0.86,
        _audit: audit(0.86),
      },
    ],
    facts: [
      {
        person: "唐悦",
        key: "档期状态",
        value: "8 月 28 日前需再次确认",
        confidence: 0.91,
        _audit: audit(0.91),
      },
    ],
    events: [
      {
        title: "校庆展合作",
        detail: "唐悦与周宁共同参与校庆展",
        date: "2025-09-01",
        precision: "month",
        people: ["唐悦", "周宁"],
        kind: "合作",
        confidence: 0.72,
        _audit: audit(0.72),
      },
    ],
    reminders: [
      {
        title: "向唐悦确认校园记忆展开幕照档期",
        due: "2026-08-28",
        people: ["唐悦"],
        kind: "custom",
        confidence: 0.96,
        _audit: audit(0.96),
      },
    ],
    evidence: [
      {
        kind: "note",
        title: "校园记忆展演示材料（合成）",
        text: OFFLINE_DEMO_MATERIAL,
        origin: "内置离线演示，不对应真实人物",
        confidence: 1,
        _audit: audit(1),
      },
    ],
  };
}

export function isSupportedIntakeFile(file: IntakeFileLike) {
  const lower = file.name.toLowerCase();
  return (
    file.type?.startsWith("image/") ||
    file.type?.startsWith("text/") ||
    SUPPORTED_EXTENSIONS.some((extension) => lower.endsWith(extension))
  );
}

export function validateIntakeFiles(files: IntakeFileLike[]): string[] {
  const errors: string[] = [];
  if (files.length > IMPORT_LIMITS.maxFiles) {
    errors.push(`一次最多选择 ${IMPORT_LIMITS.maxFiles} 个文件`);
  }

  const unsupported = files.filter((file) => !isSupportedIntakeFile(file));
  if (unsupported.length) {
    errors.push(`暂不支持：${unsupported.map((file) => file.name).join("、")}`);
  }

  const oversized = files.filter((file) => file.size > IMPORT_LIMITS.maxFileBytes);
  if (oversized.length) {
    errors.push(
      `单个文件不能超过 ${IMPORT_LIMITS.maxFileBytes / 1024 / 1024} MB：${oversized
        .map((file) => file.name)
        .join("、")}`,
    );
  }
  return errors;
}
