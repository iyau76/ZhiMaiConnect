/** 浏览器本地人脸库（IndexedDB），完全离线，人脸数据不出本机 */

import type { Provenance } from "./provenance";
import { normalizeCloseness } from "./person-profile";
import {
  KINSHIP_PROJECTOR_VERSION,
  projectKinshipRelations,
  type DerivedRelationshipRecord,
} from "./kinship-projector";
import {
  relationIsSymmetric,
  resolveRelationSemantics,
  type RelationPredicate,
  type RelationQualifiers,
} from "./relation-ontology";

export interface PersonProfile {
  age?: string;
  gender?: string;
  relation?: string;
  /** 职位 / 职务，如「运营部副主管」 */
  title?: string;
  /** 部门 / 科室 */
  department?: string;
  /** 单位 / 公司 / 机关 */
  org?: string;
  /** 负责项目 / 分管事项 */
  projects?: string[];
  /** 汇报对象 / 直属上级 */
  reportsTo?: string;
  /** 工号 / 编号 */
  employeeId?: string;
  tags?: string[];
  contact?: string;
  /** 办公地点 / 常出现地点 */
  address?: string;
  /** 指纹卡编号（仅登记，不做比对） */
  fingerprintRef?: string;
  /** 生日，格式 MM-DD 或 YYYY-MM-DD */
  birthday?: string;
  /** @deprecated v11 migration input only. Current grouping uses collections/memberships. */
  circle?: string;
  /** 亲密度 1-5 */
  closeness?: number;
  /** 喜好 */
  likes?: string[];
  /** 忌口 / 不喜欢 */
  dislikes?: string[];
  /** 送礼记录 */
  gifts?: string[];
  /** 相识场景 */
  metAt?: string;
  /** 平台账号与历史昵称；按时间保留，避免只用当前姓名判断是否同一人。 */
  identities?: Array<{
    platform: string;
    account?: string;
    alias: string;
    validFrom?: string;
    validTo?: string;
    source?: Provenance;
  }>;
  /** 自定义栏位（人物卡模板里自己加的字段）+ AI 整理出的其它字段 */
  extra?: Record<string, string>;
  /** Per-field provenance for sensitive values accepted from intake. */
  fieldSources?: Record<string, Provenance>;
}

/** 图片备注：直接存 dataURL，跟着记录留在本机 */
export interface PhotoNote {
  id: string;
  dataUrl: string;
  caption?: string;
  addedAt: number;
}

export interface PersonRecord {
  id: string;
  name: string;
  note: string;
  /** 结构化资料（可由 AI 从一段话自动整理） */
  profile?: PersonProfile;
  /** 用户输入的原始描述文本 */
  rawProfileText?: string;
  /** 每个样本是 128 维特征向量 */
  descriptors: number[][];
  thumb: string;
  createdAt: number;
  updatedAt?: number;
  /** 图片备注（合照、名片、聊天截图等） */
  photos?: PhotoNote[];
  /** 这条档案是怎么来的 */
  source?: Provenance;
  /** Stable graph role. `ego` replaces the former per-feature virtual “我”. */
  entityRole?: "ego" | "contact" | "placeholder";
  /** Placeholder names such as “爸爸” are unique only inside this source/context scope. */
  identityScopeId?: string;
}

/** Apply profile invariants at the persistence boundary. */
export function normalizePersonRecord(person: PersonRecord): PersonRecord {
  if (!person.profile) return person;
  const { closeness: rawCloseness, ...rest } = person.profile;
  const closeness = normalizeCloseness(rawCloseness);
  return {
    ...person,
    profile: closeness === undefined ? rest : { ...rest, closeness },
  };
}

function stableValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableValue(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Opaque revision token used by the database-level compare-and-swap write. */
export function personRecordRevision(person: PersonRecord): string {
  return stableValue(person);
}

export interface SightingRecord {
  id: string;
  personId: string | null;
  name: string;
  distance: number;
  thumb: string;
  /** 如果记录这张人脸时抓到了 descriptor，后续补标名字/合并样本会用到 */
  descriptor?: number[];
  at: number;
  source?: Provenance;
}

export interface RelationRecord {
  id: string;
  fromId: string;
  toId: string;
  /** 关系描述，如「同事」「大学室友」 */
  label: string;
  /** true = 对等关系（双箭头），false = 有方向（单箭头），未设置则按关系词推断 */
  mutual?: boolean;
  note?: string;
  /** 原文摘录或可审计的关系推导依据。 */
  basis?: string;
  /** 来源证据 id，用于溯源；没有就是人工手填 */
  sourceId?: string;
  createdAt: number;
  /** 最近一次人工编辑或确认时间；旧数据缺省回退到 createdAt。 */
  updatedAt?: number;
  /** AI 抽取先进入待确认；人工创建或在草稿页确认后为 confirmed。 */
  confirmationStatus?: "pending" | "confirmed" | "rejected";
  /** 关系是材料明说、规则/AI 推导，还是旧数据中暂时无法判断。 */
  evidenceMode?: "explicit" | "inferred" | "unknown";
  /** 关系事实本身的置信度；未知时留空，不能默认为 0。 */
  confidence?: number;
  /** 仅控制关系图展示，不代表删除关系，也不决定推荐资格。 */
  visibility?: "always" | "auto" | "hidden";
  /** 单独控制该关系能否用于引荐路径。 */
  recommendationPolicy?: "allow" | "avoid" | "block";
  /** 规范化语义类型；label 始终保留用户原文。 */
  semanticKind?: string;
  /** 推导关系所依赖的基础关系，便于基础事实变化后重新核验。 */
  derivedFromRelationIds?: string[];
  source?: Provenance;
  /** Compatibility view fields backed by the v10 assertion/projection stores. */
  recordType?: "assertion" | "derived";
  predicate?: RelationPredicate;
  qualifiers?: RelationQualifiers;
  ruleId?: string;
  ruleVersion?: number;
  supportingRelationIds?: string[];
}

export interface RelationAssertionEvidence {
  mode: "manual" | "source_claim" | "legacy_unknown";
  basis?: string;
  /** Evidence links are many-to-many; an assertion is not limited to one source. */
  sourceIds: string[];
}

export interface RelationEvidenceLinkRecord {
  id: string;
  assertionId: string;
  evidenceId: string;
  excerpt?: string;
  createdAt: number;
}

export interface RelationValidity {
  status: "active" | "ended" | "unknown";
  validFrom?: string;
  validTo?: string;
}

/** A claim entered by a person or extracted directly from source material. */
export interface RelationAssertionRecord {
  id: string;
  recordType: "assertion";
  fromId: string;
  toId: string;
  predicate: RelationPredicate;
  qualifiers: RelationQualifiers;
  /** Display wording; never used as the semantic truth for new records. */
  label: string;
  direction: "ontology" | "directed" | "symmetric";
  note?: string;
  evidence: RelationAssertionEvidence;
  validity: RelationValidity;
  confidence?: number;
  confirmationStatus: "pending" | "confirmed" | "rejected";
  createdAt: number;
  updatedAt: number;
  supersedesAssertionId?: string;
  source?: Provenance;
}

/** Display policy is deliberately independent from factual assertion timestamps/source. */
export interface RelationViewPreferenceRecord {
  id: string;
  subjectId: string;
  visibility: "always" | "auto" | "hidden";
  updatedAt: number;
}

/** Referral policy can evolve without mutating the relationship fact. */
export interface ReferralPolicyRecord {
  id: string;
  subjectId: string;
  policy: "allow" | "avoid" | "block";
  direction: "both" | "from_to" | "to_from";
  contexts: string[];
  updatedAt: number;
}

export interface CollectionRecord {
  id: string;
  name: string;
  kind: "relationship_circle" | "context" | "computed_community";
  color?: string;
  createdAt: number;
  updatedAt: number;
}

export interface CollectionMembershipRecord {
  id: string;
  collectionId: string;
  personId: string;
  source: "manual" | "ai_approved" | "migration" | "computed";
  createdAt: number;
}

/** 证据/线索：录音转写、笔录、物证登记、摄像头抓拍说明等 */
export type EvidenceKind = "audio" | "note" | "exhibit" | "frame";

export interface EvidenceRecord {
  id: string;
  kind: EvidenceKind;
  /** 标题，如「2024-05-01 询问笔录」「物证 A-013 手机」 */
  title: string;
  /** 正文：转写稿 / 笔录 / 物证描述 */
  text: string;
  /** 登记来源说明：录音文件名、办案人、地点等 */
  origin?: string;
  /** 上传人 / 登记人（谁把这份材料放进系统） */
  uploader?: string;
  /** 抽取出的实体（人物/地点/物品/时间/组织） */
  entities?: Array<{ type: string; value: string; personId?: string }>;
  /** 已经根据这条证据写入库的人物 id */
  linkedPersonIds?: string[];
  /** 缩略图（物证照片 / 抓拍帧） */
  thumb?: string;
  /** 转写时使用的语言 / 方言 */
  speechVariant?: string;
  createdAt: number;
  source?: Provenance;
}

/** 声纹样本：从一段录音提取的说话人特征向量，仅作参考不作证据 */
export interface VoiceprintRecord {
  id: string;
  personId: string | null;
  name: string;
  /** L2 归一化后的特征向量 */
  vector: number[];
  durationMs: number;
  /** 关联的证据（转写稿）id */
  evidenceId?: string;
  createdAt: number;
  source?: Provenance;
}

/** 案件时间线事件：案子本身发生了什么（区别于办案过程记录） */
export interface CaseEventRecord {
  id: string;
  /** 事件发生时间 */
  at: number;
  /** 结束时间（区间事件，如「22:00～23:00」） */
  endAt?: number;
  title: string;
  detail?: string;
  place?: string;
  /** 事实 / 推测 */
  certainty?: "fact" | "inferred";
  personIds?: string[];
  /** 依据的材料 id */
  evidenceIds?: string[];
  createdAt: number;
  source?: Provenance;
}

/** 探案计划里的一条行动项 */
export interface TaskRecord {
  id: string;
  /** 要做什么，如「走访保姆李姐核对 07:30 报警经过」 */
  title: string;
  /** 为什么做 / 想验证什么 */
  detail?: string;
  /** 负责人（办案人姓名或警号） */
  assignee?: string;
  /** 涉及的人物 id */
  personIds?: string[];
  priority: "high" | "normal" | "low";
  status: "todo" | "doing" | "done";
  /** 计划完成时间 yyyy-mm-dd */
  due?: string;
  createdAt: number;
  source?: Provenance;
}

/** 事务 / 项目：一件要推进的事，挂上负责人与参与人 */
export interface ProjectRecord {
  id: string;
  /** 事务名称，如「季度招商方案」 */
  title: string;
  /** 说明 / 目标 */
  detail?: string;
  /** 归属部门 */
  department?: string;
  /** 主要负责人（人物 id） */
  ownerId?: string | null;
  /** 负责人姓名快照，人物被删掉时仍可读 */
  ownerName?: string;
  /** 参与人（人物 id） */
  memberIds?: string[];
  status: "planned" | "active" | "blocked" | "done";
  priority: "high" | "normal" | "low";
  /** 截止日期 yyyy-mm-dd */
  due?: string;
  tags?: string[];
  createdAt: number;
  updatedAt?: number;
  source?: Provenance;
}

/** 时间精度：确定到某天 / 只记得某月 / 只记得某年 / 一段时间 */
export type DatePrecision = "day" | "month" | "year" | "range";

/** 个人版：日历事件（和谁、做了什么 / 要做什么） */
export interface LifeEventRecord {
  id: string;
  /** 起始日 yyyy-mm-dd（月精度补 -01，年精度补 -01-01），排序与定位用 */
  date: string;
  /** 结束日 yyyy-mm-dd，仅 range 用 */
  dateEnd?: string;
  /** 记忆精度，缺省视为 day（老数据兼容） */
  precision?: DatePrecision;
  title: string;
  detail?: string;
  place?: string;
  /** 关联人物 */
  personIds?: string[];
  /** 类型：聚会 / 约会 / 送礼 / 通话 / 帮忙 / 其它 */
  kind?: string;
  /** 图片备注 */
  photos?: PhotoNote[];
  createdAt: number;
  /** 最近一次人工编辑或确认更新时间；旧数据缺省回退到 createdAt。 */
  updatedAt?: number;
  source?: Provenance;
}

/** 个人版：待办 / 提醒（生日祝福、节日问候、请人帮忙等） */
export interface ReminderRecord {
  id: string;
  title: string;
  detail?: string;
  /** yyyy-mm-dd */
  due?: string;
  personIds?: string[];
  kind?: "birthday" | "festival" | "gift" | "custom";
  done: boolean;
  createdAt: number;
  source?: Provenance;
}

const DB_NAME = "openglass-faces";
const DB_VERSION = 12;
const PERSONS = "persons";
const SIGHTINGS = "sightings";
const RELATIONS = "relations";
const EVIDENCE = "evidence";
const VOICEPRINTS = "voiceprints";
const CASE_EVENTS = "caseEvents";
const TASKS = "tasks";
const PROJECTS = "projects";
const LIFE_EVENTS = "lifeEvents";
const REMINDERS = "reminders";
const RELATION_ASSERTIONS = "relationAssertions";
const DERIVED_RELATIONS = "derivedRelations";
const RELATION_EVIDENCE_LINKS = "relationEvidenceLinks";
const RELATION_VIEW_PREFERENCES = "relationViewPreferences";
const REFERRAL_POLICIES = "referralPolicies";
const COLLECTIONS = "collections";
const COLLECTION_MEMBERSHIPS = "collectionMemberships";
const APP_META = "appMeta";

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      const db = request.result;
      if (!db.objectStoreNames.contains(PERSONS)) db.createObjectStore(PERSONS, { keyPath: "id" });
      if (!db.objectStoreNames.contains(SIGHTINGS)) {
        const store = db.createObjectStore(SIGHTINGS, { keyPath: "id" });
        store.createIndex("at", "at");
      }
      if (!db.objectStoreNames.contains(RELATIONS))
        db.createObjectStore(RELATIONS, { keyPath: "id" });
      if (!db.objectStoreNames.contains(EVIDENCE)) {
        const store = db.createObjectStore(EVIDENCE, { keyPath: "id" });
        store.createIndex("createdAt", "createdAt");
      }
      if (!db.objectStoreNames.contains(VOICEPRINTS)) {
        const store = db.createObjectStore(VOICEPRINTS, { keyPath: "id" });
        store.createIndex("createdAt", "createdAt");
      }
      if (!db.objectStoreNames.contains(CASE_EVENTS)) {
        const store = db.createObjectStore(CASE_EVENTS, { keyPath: "id" });
        store.createIndex("at", "at");
      }
      if (!db.objectStoreNames.contains(TASKS)) {
        const store = db.createObjectStore(TASKS, { keyPath: "id" });
        store.createIndex("createdAt", "createdAt");
      }
      if (!db.objectStoreNames.contains(PROJECTS)) {
        const store = db.createObjectStore(PROJECTS, { keyPath: "id" });
        store.createIndex("createdAt", "createdAt");
      }
      if (!db.objectStoreNames.contains(LIFE_EVENTS)) {
        const store = db.createObjectStore(LIFE_EVENTS, { keyPath: "id" });
        store.createIndex("date", "date");
      }
      if (!db.objectStoreNames.contains(REMINDERS)) {
        const store = db.createObjectStore(REMINDERS, { keyPath: "id" });
        store.createIndex("createdAt", "createdAt");
      }
      if (!db.objectStoreNames.contains(RELATION_ASSERTIONS))
        db.createObjectStore(RELATION_ASSERTIONS, { keyPath: "id" });
      if (!db.objectStoreNames.contains(DERIVED_RELATIONS))
        db.createObjectStore(DERIVED_RELATIONS, { keyPath: "id" });
      if (!db.objectStoreNames.contains(RELATION_EVIDENCE_LINKS))
        db.createObjectStore(RELATION_EVIDENCE_LINKS, { keyPath: "id" });
      if (!db.objectStoreNames.contains(RELATION_VIEW_PREFERENCES))
        db.createObjectStore(RELATION_VIEW_PREFERENCES, { keyPath: "id" });
      if (!db.objectStoreNames.contains(REFERRAL_POLICIES))
        db.createObjectStore(REFERRAL_POLICIES, { keyPath: "id" });
      if (!db.objectStoreNames.contains(COLLECTIONS))
        db.createObjectStore(COLLECTIONS, { keyPath: "id" });
      if (!db.objectStoreNames.contains(COLLECTION_MEMBERSHIPS))
        db.createObjectStore(COLLECTION_MEMBERSHIPS, { keyPath: "id" });
      if (!db.objectStoreNames.contains(APP_META))
        db.createObjectStore(APP_META, { keyPath: "id" });

      // v9 只增加可选关系策略字段。用游标保守回填旧关系：不猜置信度，
      // 只从明确的 basis 前缀判断“原文/推断”，其它标为 unknown。
      const oldVersion = (event as IDBVersionChangeEvent).oldVersion;
      if (oldVersion > 0 && oldVersion < 9) {
        const relationStore = request.transaction?.objectStore(RELATIONS);
        relationStore?.openCursor().addEventListener("success", (cursorEvent) => {
          const cursor = (cursorEvent.target as IDBRequest<IDBCursorWithValue | null>).result;
          if (!cursor) return;
          const relation = cursor.value as RelationRecord;
          const basis = relation.basis?.trim() ?? "";
          const evidenceMode = /^推断依据\s*[:：]|^inference\s+basis\s*[:：]/i.test(basis)
            ? "inferred"
            : /^原文\s*[:：]|^original\s*[:：]/i.test(basis)
              ? "explicit"
              : "unknown";
          cursor.update({
            ...relation,
            evidenceMode: relation.evidenceMode ?? evidenceMode,
            visibility: relation.visibility ?? "auto",
            recommendationPolicy: relation.recommendationPolicy ?? "allow",
          });
          cursor.continue();
        });
      }

      // v10 replaces the mixed RelationRecord table with assertions, disposable
      // projections and independent policies. The old store remains migration-only.
      if (oldVersion > 0 && oldVersion < 10) {
        const transaction = request.transaction;
        const legacyStore = transaction?.objectStore(RELATIONS);
        const assertionStore = transaction?.objectStore(RELATION_ASSERTIONS);
        const derivedStore = transaction?.objectStore(DERIVED_RELATIONS);
        const evidenceLinkStore = transaction?.objectStore(RELATION_EVIDENCE_LINKS);
        const preferenceStore = transaction?.objectStore(RELATION_VIEW_PREFERENCES);
        const referralStore = transaction?.objectStore(REFERRAL_POLICIES);
        legacyStore?.openCursor().addEventListener("success", (cursorEvent) => {
          const cursor = (cursorEvent.target as IDBRequest<IDBCursorWithValue | null>).result;
          if (!cursor) return;
          const relation = cursor.value as RelationRecord;
          const { predicate, qualifiers } = resolveRelationSemantics(relation);
          const basis = relation.basis?.trim();
          const legacyDerived =
            relation.recordType === "derived" ||
            relation.evidenceMode === "inferred" ||
            Boolean(relation.derivedFromRelationIds?.length) ||
            /^推断依据\s*[:：]|^inference\s+basis\s*[:：]/i.test(basis ?? "");
          if (legacyDerived) {
            const derived: DerivedRelationshipRecord = {
              id: relation.id,
              recordType: "derived",
              fromId: relation.fromId,
              toId: relation.toId,
              predicate,
              qualifiers,
              label: relation.label,
              confidence: Math.min(relation.confidence ?? 0.65, 0.85),
              ruleId: relation.ruleId ?? "legacy.unverified",
              ruleVersion: relation.ruleVersion ?? 0,
              supportingRelationIds:
                relation.supportingRelationIds ?? relation.derivedFromRelationIds ?? [],
              explanation: basis || relation.note || "旧版本推导结果，等待规则引擎重建",
            };
            derivedStore?.put(derived);
          } else {
            const updatedAt = relation.updatedAt ?? relation.createdAt;
            const sourceIds = relation.sourceId ? [relation.sourceId] : [];
            const assertion: RelationAssertionRecord = {
              id: relation.id,
              recordType: "assertion",
              fromId: relation.fromId,
              toId: relation.toId,
              predicate,
              qualifiers,
              label: relation.label,
              direction:
                predicate === "custom" ? (relation.mutual ? "symmetric" : "directed") : "ontology",
              note: relation.note,
              evidence: {
                mode:
                  relation.sourceId || /^原文\s*[:：]|^original\s*[:：]/i.test(basis ?? "")
                    ? "source_claim"
                    : relation.source?.kind === "manual"
                      ? "manual"
                      : "legacy_unknown",
                basis,
                sourceIds,
              },
              validity: {
                status:
                  qualifiers.temporalStatus === "former"
                    ? "ended"
                    : qualifiers.temporalStatus === "current"
                      ? "active"
                      : "unknown",
                validFrom: qualifiers.validFrom,
                validTo: qualifiers.validTo,
              },
              confidence: relation.confidence,
              confirmationStatus: relation.confirmationStatus ?? "confirmed",
              createdAt: relation.createdAt,
              updatedAt,
              source: relation.source,
            };
            assertionStore?.put(assertion);
            for (const evidenceId of sourceIds) {
              const link: RelationEvidenceLinkRecord = {
                id: `${relation.id}\u0000${evidenceId}`,
                assertionId: relation.id,
                evidenceId,
                createdAt: updatedAt,
              };
              evidenceLinkStore?.put(link);
            }
          }
          preferenceStore?.put({
            id: relation.id,
            subjectId: relation.id,
            visibility: relation.visibility ?? "auto",
            updatedAt: relation.updatedAt ?? relation.createdAt,
          } satisfies RelationViewPreferenceRecord);
          referralStore?.put({
            id: relation.id,
            subjectId: relation.id,
            policy: relation.recommendationPolicy ?? "allow",
            direction: "both",
            contexts: [],
            updatedAt: relation.updatedAt ?? relation.createdAt,
          } satisfies ReferralPolicyRecord);
          cursor.continue();
        });

        const personStore = transaction?.objectStore(PERSONS);
        const collectionStore = transaction?.objectStore(COLLECTIONS);
        const membershipStore = transaction?.objectStore(COLLECTION_MEMBERSHIPS);
        personStore?.openCursor().addEventListener("success", (cursorEvent) => {
          const cursor = (cursorEvent.target as IDBRequest<IDBCursorWithValue | null>).result;
          if (!cursor) return;
          const person = cursor.value as PersonRecord;
          const circle = person.profile?.circle?.trim();
          if (circle) {
            const encoded = encodeURIComponent(circle);
            const collectionId = `legacy-circle:${encoded}`;
            collectionStore?.put({
              id: collectionId,
              name: circle,
              kind: "relationship_circle",
              createdAt: person.createdAt,
              updatedAt: person.updatedAt ?? person.createdAt,
            } satisfies CollectionRecord);
            membershipStore?.put({
              id: `${collectionId}\u0000${person.id}`,
              collectionId,
              personId: person.id,
              source: "migration",
              createdAt: person.updatedAt ?? person.createdAt,
            } satisfies CollectionMembershipRecord);
          }
          cursor.continue();
        });
      }

      // v12 makes profile.closeness a storage invariant. Repair legacy values
      // once in-place so every durable row is either an integer in 1..5 or has
      // no closeness field at all.
      if (oldVersion > 0 && oldVersion < 12) {
        const personStore = request.transaction?.objectStore(PERSONS);
        personStore?.openCursor().addEventListener("success", (cursorEvent) => {
          const cursor = (cursorEvent.target as IDBRequest<IDBCursorWithValue | null>).result;
          if (!cursor) return;
          const person = cursor.value as PersonRecord;
          cursor.update(normalizePersonRecord(person));
          cursor.continue();
        });
      }

      // v11 adds a projection-version marker. Existing databases rebuild lazily
      // on first read, after every migration cursor has finished committing.
      request.transaction?.objectStore(APP_META).put({
        id: "kinshipProjectionVersion",
        value: oldVersion === 0 ? KINSHIP_PROJECTOR_VERSION : 0,
      });
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("无法打开本地数据库"));
  });
  return dbPromise;
}

async function run<T>(
  store: string,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest,
) {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const request = fn(tx.objectStore(store));
    request.onsuccess = () => resolve(request.result as T);
    request.onerror = () => reject(request.error ?? new Error("数据库操作失败"));
  });
}

function assertionFromRelationView(relation: RelationRecord): RelationAssertionRecord {
  if (relation.recordType === "derived" || relation.evidenceMode === "inferred") {
    throw new Error("派生关系是可重建投影，不能作为事实写入；请修改它所依据的事实关系");
  }
  const { predicate, qualifiers } = resolveRelationSemantics(relation);
  const updatedAt = relation.updatedAt ?? relation.createdAt;
  return {
    id: relation.id,
    recordType: "assertion",
    fromId: relation.fromId,
    toId: relation.toId,
    predicate,
    qualifiers,
    label: relation.label,
    direction: predicate === "custom" ? (relation.mutual ? "symmetric" : "directed") : "ontology",
    note: relation.note,
    evidence: {
      mode:
        relation.sourceId || /^原文\s*[:：]|^original\s*[:：]/i.test(relation.basis?.trim() ?? "")
          ? "source_claim"
          : relation.source?.kind === "manual"
            ? "manual"
            : "legacy_unknown",
      basis: relation.basis,
      sourceIds: relation.sourceId ? [relation.sourceId] : [],
    },
    validity: {
      status:
        qualifiers.temporalStatus === "former"
          ? "ended"
          : qualifiers.temporalStatus === "current"
            ? "active"
            : "unknown",
      validFrom: qualifiers.validFrom,
      validTo: qualifiers.validTo,
    },
    confidence: relation.confidence,
    confirmationStatus: relation.confirmationStatus ?? "confirmed",
    createdAt: relation.createdAt,
    updatedAt,
    source: relation.source,
  };
}

function assertionToRelationView(
  assertion: RelationAssertionRecord,
  preference?: RelationViewPreferenceRecord,
  referral?: ReferralPolicyRecord,
): RelationRecord {
  return {
    id: assertion.id,
    recordType: "assertion",
    fromId: assertion.fromId,
    toId: assertion.toId,
    predicate: assertion.predicate,
    qualifiers: assertion.qualifiers,
    label: assertion.label,
    mutual:
      assertion.direction === "symmetric" ||
      (assertion.direction === "ontology" && relationIsSymmetric(assertion.predicate)),
    note: assertion.note,
    basis: assertion.evidence.basis,
    sourceId: assertion.evidence.sourceIds[0],
    createdAt: assertion.createdAt,
    updatedAt: assertion.updatedAt,
    confirmationStatus: assertion.confirmationStatus,
    evidenceMode: "explicit",
    confidence: assertion.confidence,
    visibility: preference?.visibility ?? "auto",
    recommendationPolicy: referral?.policy ?? "allow",
    semanticKind: assertion.predicate,
    source: assertion.source,
  };
}

function derivedToRelationView(
  relation: DerivedRelationshipRecord,
  preference?: RelationViewPreferenceRecord,
  referral?: ReferralPolicyRecord,
): RelationRecord {
  return {
    id: relation.id,
    recordType: "derived",
    fromId: relation.fromId,
    toId: relation.toId,
    predicate: relation.predicate,
    qualifiers: relation.qualifiers,
    label: relation.label,
    mutual: relationIsSymmetric(relation.predicate),
    note: "本地规则投影；修改支持事实后会自动重建",
    basis: `规则 ${relation.ruleId}：${relation.explanation}`,
    createdAt: 0,
    confirmationStatus: "confirmed",
    evidenceMode: "inferred",
    confidence: relation.confidence,
    visibility: preference?.visibility ?? "auto",
    recommendationPolicy: referral?.policy ?? "allow",
    semanticKind: relation.predicate,
    derivedFromRelationIds: relation.supportingRelationIds,
    supportingRelationIds: relation.supportingRelationIds,
    ruleId: relation.ruleId,
    ruleVersion: relation.ruleVersion,
  };
}

function currentRelationAssertions(assertions: RelationAssertionRecord[]) {
  const supersededIds = new Set(
    assertions
      .map((assertion) => assertion.supersedesAssertionId)
      .filter((id): id is string => Boolean(id)),
  );
  return assertions.filter(
    (assertion) => !supersededIds.has(assertion.id) && assertion.confirmationStatus !== "rejected",
  );
}

export interface RelationshipWriteBatch {
  persons?: PersonRecord[];
  assertions?: RelationAssertionRecord[];
  deleteAssertionIds?: string[];
  evidence?: EvidenceRecord[];
  evidenceLinks?: RelationEvidenceLinkRecord[];
  lifeEvents?: LifeEventRecord[];
  reminders?: ReminderRecord[];
  viewPreferences?: RelationViewPreferenceRecord[];
  referralPolicies?: ReferralPolicyRecord[];
}

/**
 * Atomic persistence boundary for an approved archive mutation plan.
 *
 * Domain code must resolve delete/detach/reassign decisions before calling this
 * method. The database then commits the complete decision as one transaction,
 * so an approval can never leave half of a batch applied.
 */
export interface ArchiveMutationWriteBatch extends RelationshipWriteBatch {
  deletePersonIds?: string[];
  deleteEvidenceIds?: string[];
  deleteEvidenceLinkIds?: string[];
  deleteViewPreferenceIds?: string[];
  deleteReferralPolicyIds?: string[];
  deleteLifeEventIds?: string[];
  caseEvents?: CaseEventRecord[];
  deleteCaseEventIds?: string[];
  deleteReminderIds?: string[];
  tasks?: TaskRecord[];
  deleteTaskIds?: string[];
  projects?: ProjectRecord[];
  deleteProjectIds?: string[];
  collections?: CollectionRecord[];
  deleteCollectionIds?: string[];
  collectionMemberships?: CollectionMembershipRecord[];
  deleteCollectionMembershipIds?: string[];
}

/**
 * One consistent read of every durable archive store. Compatibility views,
 * biometric caches and runtime logs are intentionally outside this contract.
 */
export interface FaceDbArchiveSnapshot {
  persons: PersonRecord[];
  relationAssertions: RelationAssertionRecord[];
  derivedRelations: DerivedRelationshipRecord[];
  relationEvidenceLinks: RelationEvidenceLinkRecord[];
  relationViewPreferences: RelationViewPreferenceRecord[];
  referralPolicies: ReferralPolicyRecord[];
  collections: CollectionRecord[];
  collectionMemberships: CollectionMembershipRecord[];
  evidence: EvidenceRecord[];
  caseEvents: CaseEventRecord[];
  tasks: TaskRecord[];
  projects: ProjectRecord[];
  lifeEvents: LifeEventRecord[];
  reminders: ReminderRecord[];
}

export type FaceDbArchiveReplacement = Omit<FaceDbArchiveSnapshot, "derivedRelations">;

async function readArchiveSnapshot(): Promise<FaceDbArchiveSnapshot> {
  await ensureCurrentKinshipProjection();
  const db = await openDb();
  const stores = [
    PERSONS,
    RELATION_ASSERTIONS,
    DERIVED_RELATIONS,
    RELATION_EVIDENCE_LINKS,
    RELATION_VIEW_PREFERENCES,
    REFERRAL_POLICIES,
    COLLECTIONS,
    COLLECTION_MEMBERSHIPS,
    EVIDENCE,
    CASE_EVENTS,
    TASKS,
    PROJECTS,
    LIFE_EVENTS,
    REMINDERS,
  ];
  return new Promise<FaceDbArchiveSnapshot>((resolve, reject) => {
    const tx = db.transaction(stores, "readonly");
    const requests = Object.fromEntries(
      stores.map((storeName) => [storeName, tx.objectStore(storeName).getAll()]),
    ) as Record<string, IDBRequest<unknown[]>>;
    tx.onerror = () => reject(tx.error ?? new Error("读取完整档案快照失败"));
    tx.onabort = () => reject(tx.error ?? new Error("读取完整档案快照已中止"));
    tx.oncomplete = () =>
      resolve({
        persons: (requests[PERSONS].result as PersonRecord[]).map(normalizePersonRecord),
        relationAssertions: requests[RELATION_ASSERTIONS].result as RelationAssertionRecord[],
        derivedRelations: requests[DERIVED_RELATIONS].result as DerivedRelationshipRecord[],
        relationEvidenceLinks: requests[RELATION_EVIDENCE_LINKS]
          .result as RelationEvidenceLinkRecord[],
        relationViewPreferences: requests[RELATION_VIEW_PREFERENCES]
          .result as RelationViewPreferenceRecord[],
        referralPolicies: requests[REFERRAL_POLICIES].result as ReferralPolicyRecord[],
        collections: requests[COLLECTIONS].result as CollectionRecord[],
        collectionMemberships: requests[COLLECTION_MEMBERSHIPS]
          .result as CollectionMembershipRecord[],
        evidence: requests[EVIDENCE].result as EvidenceRecord[],
        caseEvents: requests[CASE_EVENTS].result as CaseEventRecord[],
        tasks: requests[TASKS].result as TaskRecord[],
        projects: requests[PROJECTS].result as ProjectRecord[],
        lifeEvents: requests[LIFE_EVENTS].result as LifeEventRecord[],
        reminders: requests[REMINDERS].result as ReminderRecord[],
      });
  });
}

function assertUniqueIds(label: string, rows: Array<{ id: string }>) {
  const ids = new Set<string>();
  for (const row of rows) {
    if (ids.has(row.id)) throw new Error(`${label} 含重复 ID：${row.id}`);
    ids.add(row.id);
  }
  return ids;
}

/** Replace the durable archive as one validated transaction and rebuild projections. */
async function replaceArchiveSnapshot(replacement: FaceDbArchiveReplacement) {
  const normalizedPersons = replacement.persons.map(normalizePersonRecord);
  for (const person of normalizedPersons) assertValidPersonName(person.name);
  const personIds = assertUniqueIds("人物", normalizedPersons);
  const assertionIds = assertUniqueIds("关系事实", replacement.relationAssertions);
  const evidenceIds = assertUniqueIds("证据", replacement.evidence);
  const collectionIds = assertUniqueIds("集合", replacement.collections);
  assertUniqueIds("证据链接", replacement.relationEvidenceLinks);
  assertUniqueIds("关系展示策略", replacement.relationViewPreferences);
  assertUniqueIds("关系引荐策略", replacement.referralPolicies);
  assertUniqueIds("集合成员", replacement.collectionMemberships);
  assertUniqueIds("案件事件", replacement.caseEvents);
  assertUniqueIds("待办", replacement.tasks);
  assertUniqueIds("事务", replacement.projects);
  assertUniqueIds("日历事件", replacement.lifeEvents);
  assertUniqueIds("提醒", replacement.reminders);

  const requirePerson = (id: string, context: string) => {
    if (!personIds.has(id)) throw new Error(`${context} 引用了不存在的人物：${id}`);
  };
  for (const assertion of replacement.relationAssertions) {
    requirePerson(assertion.fromId, `关系 ${assertion.id}`);
    requirePerson(assertion.toId, `关系 ${assertion.id}`);
    for (const id of assertion.evidence.sourceIds) {
      if (!evidenceIds.has(id)) throw new Error(`关系 ${assertion.id} 引用了不存在的证据：${id}`);
    }
  }
  for (const link of replacement.relationEvidenceLinks) {
    if (!assertionIds.has(link.assertionId))
      throw new Error(`证据链接 ${link.id} 引用了不存在的关系：${link.assertionId}`);
    if (!evidenceIds.has(link.evidenceId))
      throw new Error(`证据链接 ${link.id} 引用了不存在的证据：${link.evidenceId}`);
  }
  for (const membership of replacement.collectionMemberships) {
    if (!collectionIds.has(membership.collectionId))
      throw new Error(`集合成员 ${membership.id} 引用了不存在的集合：${membership.collectionId}`);
    requirePerson(membership.personId, `集合成员 ${membership.id}`);
  }
  for (const evidence of replacement.evidence) {
    for (const id of evidence.linkedPersonIds ?? []) requirePerson(id, `证据 ${evidence.id}`);
    for (const entity of evidence.entities ?? []) {
      if (entity.personId) requirePerson(entity.personId, `证据 ${evidence.id}`);
    }
  }
  const requirePeople = (ids: string[] | undefined, context: string) => {
    for (const id of ids ?? []) requirePerson(id, context);
  };
  for (const event of replacement.caseEvents) {
    requirePeople(event.personIds, `案件事件 ${event.id}`);
    for (const id of event.evidenceIds ?? []) {
      if (!evidenceIds.has(id)) throw new Error(`案件事件 ${event.id} 引用了不存在的证据：${id}`);
    }
  }
  for (const task of replacement.tasks) requirePeople(task.personIds, `待办 ${task.id}`);
  for (const event of replacement.lifeEvents)
    requirePeople(event.personIds, `日历事件 ${event.id}`);
  for (const reminder of replacement.reminders)
    requirePeople(reminder.personIds, `提醒 ${reminder.id}`);
  for (const project of replacement.projects) {
    if (project.ownerId) requirePerson(project.ownerId, `事务 ${project.id}`);
    requirePeople(project.memberIds, `事务 ${project.id}`);
  }

  const activeAssertions = currentRelationAssertions(replacement.relationAssertions);
  const projection = projectKinshipRelations({
    assertions: activeAssertions.map((assertion) => ({
      id: assertion.id,
      fromId: assertion.fromId,
      toId: assertion.toId,
      label: assertion.label,
      predicate: assertion.predicate,
      qualifiers: assertion.qualifiers,
      confidence: assertion.confidence,
      confirmationStatus: assertion.confirmationStatus,
      evidenceMode: "explicit" as const,
      basis: assertion.evidence.basis,
    })),
    persons: normalizedPersons,
  });
  const validSubjectIds = new Set([
    ...replacement.relationAssertions.map((row) => row.id),
    ...projection.relations.map((row) => row.id),
  ]);
  for (const preference of replacement.relationViewPreferences) {
    if (!validSubjectIds.has(preference.subjectId))
      throw new Error(`展示策略 ${preference.id} 引用了不存在的关系：${preference.subjectId}`);
  }
  for (const policy of replacement.referralPolicies) {
    if (!validSubjectIds.has(policy.subjectId))
      throw new Error(`引荐策略 ${policy.id} 引用了不存在的关系：${policy.subjectId}`);
  }

  const db = await openDb();
  const stores = [
    PERSONS,
    RELATION_ASSERTIONS,
    DERIVED_RELATIONS,
    RELATION_EVIDENCE_LINKS,
    RELATION_VIEW_PREFERENCES,
    REFERRAL_POLICIES,
    COLLECTIONS,
    COLLECTION_MEMBERSHIPS,
    EVIDENCE,
    CASE_EVENTS,
    TASKS,
    PROJECTS,
    LIFE_EVENTS,
    REMINDERS,
    SIGHTINGS,
    VOICEPRINTS,
    APP_META,
  ];
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(stores, "readwrite");
    tx.onerror = () => reject(tx.error ?? new Error("恢复完整档案失败"));
    tx.onabort = () => reject(tx.error ?? new Error("恢复完整档案已中止"));
    tx.oncomplete = () => resolve();

    const replace = <T>(storeName: string, rows: T[]) => {
      const store = tx.objectStore(storeName);
      store.clear();
      for (const row of rows) store.put(row);
    };
    replace(PERSONS, normalizedPersons);
    replace(RELATION_ASSERTIONS, replacement.relationAssertions);
    replace(DERIVED_RELATIONS, projection.relations);
    replace(RELATION_EVIDENCE_LINKS, replacement.relationEvidenceLinks);
    replace(RELATION_VIEW_PREFERENCES, replacement.relationViewPreferences);
    replace(REFERRAL_POLICIES, replacement.referralPolicies);
    replace(COLLECTIONS, replacement.collections);
    replace(COLLECTION_MEMBERSHIPS, replacement.collectionMemberships);
    replace(EVIDENCE, replacement.evidence);
    replace(CASE_EVENTS, replacement.caseEvents);
    replace(TASKS, replacement.tasks);
    replace(PROJECTS, replacement.projects);
    replace(LIFE_EVENTS, replacement.lifeEvents);
    replace(REMINDERS, replacement.reminders);

    const detachUnknownPerson = <T extends { id: string; personId: string | null }>(
      storeName: string,
    ) => {
      const store = tx.objectStore(storeName);
      const request = store.getAll();
      request.onsuccess = () => {
        for (const row of request.result as T[]) {
          if (row.personId && !personIds.has(row.personId)) store.put({ ...row, personId: null });
        }
      };
    };
    detachUnknownPerson<SightingRecord>(SIGHTINGS);
    detachUnknownPerson<VoiceprintRecord>(VOICEPRINTS);
    tx.objectStore(APP_META).put({
      id: "kinshipProjectionVersion",
      value: KINSHIP_PROJECTOR_VERSION,
    });
  });
}

/** Commit a fully validated archive mutation as one IndexedDB transaction. */
async function applyArchiveMutationBatch(batch: ArchiveMutationWriteBatch) {
  const normalizedPersons = (batch.persons ?? []).map(normalizePersonRecord);
  for (const person of normalizedPersons) assertValidPersonName(person.name);
  const db = await openDb();
  const stores = [
    PERSONS,
    RELATION_ASSERTIONS,
    DERIVED_RELATIONS,
    RELATION_EVIDENCE_LINKS,
    EVIDENCE,
    CASE_EVENTS,
    LIFE_EVENTS,
    REMINDERS,
    TASKS,
    PROJECTS,
    COLLECTIONS,
    COLLECTION_MEMBERSHIPS,
    RELATION_VIEW_PREFERENCES,
    REFERRAL_POLICIES,
    APP_META,
  ];

  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(stores, "readwrite");
    tx.onerror = () => reject(tx.error ?? new Error("档案变更事务失败"));
    tx.onabort = () => reject(tx.error ?? new Error("档案变更事务已中止"));
    tx.oncomplete = () => resolve();

    const personStore = tx.objectStore(PERSONS);
    const assertionStore = tx.objectStore(RELATION_ASSERTIONS);
    const personRequest = personStore.getAll();
    const assertionRequest = assertionStore.getAll();
    let currentPersons: PersonRecord[] | undefined;
    let currentAssertions: RelationAssertionRecord[] | undefined;
    let applied = false;

    const apply = () => {
      if (applied || !currentPersons || !currentAssertions) return;
      applied = true;

      const personsById = new Map(currentPersons.map((person) => [person.id, person]));
      for (const id of batch.deletePersonIds ?? []) {
        personsById.delete(id);
        personStore.delete(id);
      }
      for (const person of normalizedPersons) {
        personsById.set(person.id, person);
        personStore.put(person);
      }

      const assertionsById = new Map(
        currentAssertions.map((assertion) => [assertion.id, assertion]),
      );
      for (const id of batch.deleteAssertionIds ?? []) {
        assertionsById.delete(id);
        assertionStore.delete(id);
      }
      for (const assertion of batch.assertions ?? []) {
        if (
          assertion.fromId === assertion.toId ||
          !personsById.has(assertion.fromId) ||
          !personsById.has(assertion.toId)
        ) {
          tx.abort();
          return;
        }
        assertionsById.set(assertion.id, assertion);
        assertionStore.put(assertion);
      }

      const activeAssertions = currentRelationAssertions([...assertionsById.values()]);
      const projection = projectKinshipRelations({
        assertions: activeAssertions.map((assertion) => ({
          id: assertion.id,
          fromId: assertion.fromId,
          toId: assertion.toId,
          label: assertion.label,
          predicate: assertion.predicate,
          qualifiers: assertion.qualifiers,
          confidence: assertion.confidence,
          confirmationStatus: assertion.confirmationStatus,
          evidenceMode: "explicit" as const,
          basis: assertion.evidence.basis,
        })),
        persons: [...personsById.values()],
      });
      const derivedStore = tx.objectStore(DERIVED_RELATIONS);
      derivedStore.clear();
      for (const relation of projection.relations) derivedStore.put(relation);

      const writeRows = <T extends { id: string }>(storeName: string, rows?: T[]) => {
        const store = tx.objectStore(storeName);
        for (const row of rows ?? []) store.put(row);
      };
      const deleteRows = (storeName: string, ids?: string[]) => {
        const store = tx.objectStore(storeName);
        for (const id of ids ?? []) store.delete(id);
      };

      writeRows(EVIDENCE, batch.evidence);
      deleteRows(EVIDENCE, batch.deleteEvidenceIds);
      writeRows(RELATION_EVIDENCE_LINKS, batch.evidenceLinks);
      deleteRows(RELATION_EVIDENCE_LINKS, batch.deleteEvidenceLinkIds);
      writeRows(LIFE_EVENTS, batch.lifeEvents);
      deleteRows(LIFE_EVENTS, batch.deleteLifeEventIds);
      writeRows(CASE_EVENTS, batch.caseEvents);
      deleteRows(CASE_EVENTS, batch.deleteCaseEventIds);
      writeRows(REMINDERS, batch.reminders);
      deleteRows(REMINDERS, batch.deleteReminderIds);
      writeRows(TASKS, batch.tasks);
      deleteRows(TASKS, batch.deleteTaskIds);
      writeRows(PROJECTS, batch.projects);
      deleteRows(PROJECTS, batch.deleteProjectIds);
      writeRows(COLLECTIONS, batch.collections);
      deleteRows(COLLECTIONS, batch.deleteCollectionIds);
      writeRows(COLLECTION_MEMBERSHIPS, batch.collectionMemberships);
      deleteRows(COLLECTION_MEMBERSHIPS, batch.deleteCollectionMembershipIds);
      writeRows(RELATION_VIEW_PREFERENCES, batch.viewPreferences);
      deleteRows(RELATION_VIEW_PREFERENCES, batch.deleteViewPreferenceIds);
      writeRows(REFERRAL_POLICIES, batch.referralPolicies);
      deleteRows(REFERRAL_POLICIES, batch.deleteReferralPolicyIds);

      // Relationship-side auxiliary rows may outlive an assertion after a
      // privacy deletion. Prune them inside the same transaction.
      const validSubjectIds = new Set([
        ...assertionsById.keys(),
        ...projection.relations.map((relation) => relation.id),
      ]);
      const prune = <T extends { id: string }>(storeName: string, keep: (row: T) => boolean) => {
        const store = tx.objectStore(storeName);
        const request = store.getAll();
        request.onsuccess = () => {
          for (const row of request.result as T[]) {
            if (!keep(row)) store.delete(row.id);
          }
        };
      };
      prune<RelationEvidenceLinkRecord>(RELATION_EVIDENCE_LINKS, (row) =>
        assertionsById.has(row.assertionId),
      );
      prune<RelationViewPreferenceRecord>(RELATION_VIEW_PREFERENCES, (row) =>
        validSubjectIds.has(row.subjectId),
      );
      prune<ReferralPolicyRecord>(REFERRAL_POLICIES, (row) => validSubjectIds.has(row.subjectId));

      tx.objectStore(APP_META).put({
        id: "kinshipProjectionVersion",
        value: KINSHIP_PROJECTOR_VERSION,
      });
    };

    personRequest.onsuccess = () => {
      currentPersons = personRequest.result as PersonRecord[];
      apply();
    };
    assertionRequest.onsuccess = () => {
      currentAssertions = assertionRequest.result as RelationAssertionRecord[];
      apply();
    };
  });
}

/**
 * One transaction commits assertion changes and replaces the whole disposable
 * kinship projection. No invalidation flags or second clean-up transaction exist.
 */
async function putRelationshipBatch(batch: RelationshipWriteBatch) {
  const normalizedPersons = (batch.persons ?? []).map(normalizePersonRecord);
  for (const person of normalizedPersons) assertValidPersonName(person.name);
  const db = await openDb();
  const stores = [
    PERSONS,
    RELATION_ASSERTIONS,
    DERIVED_RELATIONS,
    RELATION_EVIDENCE_LINKS,
    EVIDENCE,
    LIFE_EVENTS,
    REMINDERS,
    RELATION_VIEW_PREFERENCES,
    REFERRAL_POLICIES,
    APP_META,
  ];
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(stores, "readwrite");
    tx.onerror = () => reject(tx.error ?? new Error("关系事实与投影事务失败"));
    tx.onabort = () => reject(tx.error ?? new Error("关系事实与投影事务已中止"));
    tx.oncomplete = () => resolve();

    const personStore = tx.objectStore(PERSONS);
    const assertionStore = tx.objectStore(RELATION_ASSERTIONS);
    const derivedStore = tx.objectStore(DERIVED_RELATIONS);
    const personRequest = personStore.getAll();
    const assertionRequest = assertionStore.getAll();
    let currentPersons: PersonRecord[] | undefined;
    let currentAssertions: RelationAssertionRecord[] | undefined;

    const finish = () => {
      if (!currentPersons || !currentAssertions) return;
      const personsById = new Map(currentPersons.map((person) => [person.id, person]));
      for (const person of normalizedPersons) {
        personsById.set(person.id, person);
        personStore.put(person);
      }
      const assertionsById = new Map(
        currentAssertions.map((assertion) => [assertion.id, assertion]),
      );
      for (const id of batch.deleteAssertionIds ?? []) {
        assertionsById.delete(id);
        assertionStore.delete(id);
      }
      for (const assertion of batch.assertions ?? []) {
        if (assertion.fromId === assertion.toId) {
          tx.abort();
          return;
        }
        assertionsById.set(assertion.id, assertion);
        assertionStore.put(assertion);
      }
      const activeAssertions = currentRelationAssertions([...assertionsById.values()]);
      const projection = projectKinshipRelations({
        assertions: activeAssertions.map((assertion) => ({
          id: assertion.id,
          fromId: assertion.fromId,
          toId: assertion.toId,
          label: assertion.label,
          predicate: assertion.predicate,
          qualifiers: assertion.qualifiers,
          confidence: assertion.confidence,
          confirmationStatus: assertion.confirmationStatus,
          evidenceMode: "explicit",
          basis: assertion.evidence.basis,
        })),
        persons: [...personsById.values()],
      });
      derivedStore.clear();
      for (const relation of projection.relations) derivedStore.put(relation);
      const evidenceStore = tx.objectStore(EVIDENCE);
      for (const record of batch.evidence ?? []) evidenceStore.put(record);
      const linkStore = tx.objectStore(RELATION_EVIDENCE_LINKS);
      for (const record of batch.evidenceLinks ?? []) linkStore.put(record);
      const eventStore = tx.objectStore(LIFE_EVENTS);
      for (const record of batch.lifeEvents ?? []) eventStore.put(record);
      const reminderStore = tx.objectStore(REMINDERS);
      for (const record of batch.reminders ?? []) reminderStore.put(record);
      const preferenceStore = tx.objectStore(RELATION_VIEW_PREFERENCES);
      for (const record of batch.viewPreferences ?? []) preferenceStore.put(record);
      const referralStore = tx.objectStore(REFERRAL_POLICIES);
      for (const record of batch.referralPolicies ?? []) referralStore.put(record);
      tx.objectStore(APP_META).put({
        id: "kinshipProjectionVersion",
        value: KINSHIP_PROJECTOR_VERSION,
      });
    };
    personRequest.onsuccess = () => {
      currentPersons = personRequest.result as PersonRecord[];
      finish();
    };
    assertionRequest.onsuccess = () => {
      currentAssertions = assertionRequest.result as RelationAssertionRecord[];
      finish();
    };
  });
}

async function listRelationshipViews(
  options: { includeDerived?: boolean; includeHistory?: boolean } = {},
) {
  await ensureCurrentKinshipProjection();
  const [assertions, derived, preferences, referrals] = await Promise.all([
    run<RelationAssertionRecord[]>(RELATION_ASSERTIONS, "readonly", (store) => store.getAll()),
    options.includeDerived === false
      ? Promise.resolve([] as DerivedRelationshipRecord[])
      : run<DerivedRelationshipRecord[]>(DERIVED_RELATIONS, "readonly", (store) => store.getAll()),
    run<RelationViewPreferenceRecord[]>(RELATION_VIEW_PREFERENCES, "readonly", (store) =>
      store.getAll(),
    ),
    run<ReferralPolicyRecord[]>(REFERRAL_POLICIES, "readonly", (store) => store.getAll()),
  ]);
  const preferenceBySubject = new Map(preferences.map((row) => [row.subjectId, row]));
  const referralBySubject = new Map(referrals.map((row) => [row.subjectId, row]));
  const visibleAssertions = options.includeHistory
    ? assertions
    : currentRelationAssertions(assertions);
  return [
    ...visibleAssertions.map((assertion) =>
      assertionToRelationView(
        assertion,
        preferenceBySubject.get(assertion.id),
        referralBySubject.get(assertion.id),
      ),
    ),
    ...derived.map((relation) =>
      derivedToRelationView(
        relation,
        preferenceBySubject.get(relation.id),
        referralBySubject.get(relation.id),
      ),
    ),
  ].sort(
    (left, right) => (right.updatedAt ?? right.createdAt) - (left.updatedAt ?? left.createdAt),
  );
}

async function ensureCurrentKinshipProjection() {
  const marker = await run<{ id: string; value: number } | undefined>(
    APP_META,
    "readonly",
    (store) => store.get("kinshipProjectionVersion"),
  );
  if (marker?.value === KINSHIP_PROJECTOR_VERSION) return;
  await putRelationshipBatch({});
}

function deletePersonAndDetachReferences(id: string) {
  return openDb().then(
    (db) =>
      new Promise<string[]>((resolve, reject) => {
        const stores = [
          PERSONS,
          SIGHTINGS,
          RELATIONS,
          RELATION_ASSERTIONS,
          DERIVED_RELATIONS,
          RELATION_EVIDENCE_LINKS,
          RELATION_VIEW_PREFERENCES,
          REFERRAL_POLICIES,
          COLLECTION_MEMBERSHIPS,
          EVIDENCE,
          VOICEPRINTS,
          CASE_EVENTS,
          TASKS,
          PROJECTS,
          LIFE_EVENTS,
          REMINDERS,
        ];
        const tx = db.transaction(stores, "readwrite");
        const removedRelationIds: string[] = [];
        tx.onerror = () => reject(tx.error ?? new Error("删除人物失败"));
        tx.onabort = () => reject(tx.error ?? new Error("删除人物事务已中止"));
        tx.oncomplete = () => resolve(removedRelationIds);

        tx.objectStore(PERSONS).delete(id);

        const detach = <T>(storeName: string, update: (record: T) => T | null) => {
          const store = tx.objectStore(storeName);
          const request = store.getAll();
          request.onsuccess = () => {
            for (const record of request.result as T[]) {
              const next = update(record);
              if (next) store.put(next);
            }
          };
        };

        // The old mixed store is migration-only, but privacy deletion still removes
        // any historical rows that point at the person.
        const legacyRelationStore = tx.objectStore(RELATIONS);
        const legacyRelationRequest = legacyRelationStore.getAll();
        legacyRelationRequest.onsuccess = () => {
          for (const relation of legacyRelationRequest.result as RelationRecord[]) {
            if (relation.fromId === id || relation.toId === id) {
              legacyRelationStore.delete(relation.id);
            }
          }
        };

        const assertionStore = tx.objectStore(RELATION_ASSERTIONS);
        const derivedStore = tx.objectStore(DERIVED_RELATIONS);
        const assertionRequest = assertionStore.getAll();
        const personRequest = tx.objectStore(PERSONS).getAll();
        let remainingAssertions: RelationAssertionRecord[] | undefined;
        let remainingPersons: PersonRecord[] | undefined;
        const rebuild = () => {
          if (!remainingAssertions || !remainingPersons) return;
          const projection = projectKinshipRelations({
            assertions: currentRelationAssertions(remainingAssertions).map((assertion) => ({
              id: assertion.id,
              fromId: assertion.fromId,
              toId: assertion.toId,
              predicate: assertion.predicate,
              qualifiers: assertion.qualifiers,
              label: assertion.label,
              basis: assertion.evidence.basis,
              confidence: assertion.confidence,
              confirmationStatus: assertion.confirmationStatus,
              evidenceMode: "explicit",
            })),
            persons: remainingPersons,
          });
          derivedStore.clear();
          for (const relation of projection.relations) derivedStore.put(relation);
        };
        assertionRequest.onsuccess = () => {
          const rows = assertionRequest.result as RelationAssertionRecord[];
          remainingAssertions = rows.filter((assertion) => {
            const remove = assertion.fromId === id || assertion.toId === id;
            if (remove) {
              assertionStore.delete(assertion.id);
              removedRelationIds.push(assertion.id);
            }
            return !remove;
          });
          rebuild();
        };
        personRequest.onsuccess = () => {
          remainingPersons = (personRequest.result as PersonRecord[]).filter(
            (person) => person.id !== id,
          );
          rebuild();
        };

        const deleteMatching = <T>(storeName: string, matches: (record: T) => boolean) => {
          const store = tx.objectStore(storeName);
          const request = store.getAll();
          request.onsuccess = () => {
            for (const record of request.result as T[]) {
              if (matches(record)) store.delete((record as { id: string }).id);
            }
          };
        };
        deleteMatching<RelationEvidenceLinkRecord>(RELATION_EVIDENCE_LINKS, (record) =>
          removedRelationIds.includes(record.assertionId),
        );
        deleteMatching<RelationViewPreferenceRecord>(RELATION_VIEW_PREFERENCES, (record) =>
          removedRelationIds.includes(record.subjectId),
        );
        deleteMatching<ReferralPolicyRecord>(REFERRAL_POLICIES, (record) =>
          removedRelationIds.includes(record.subjectId),
        );
        deleteMatching<CollectionMembershipRecord>(
          COLLECTION_MEMBERSHIPS,
          (record) => record.personId === id,
        );
        detach<SightingRecord>(SIGHTINGS, (record) =>
          record.personId === id ? { ...record, personId: null } : null,
        );
        detach<VoiceprintRecord>(VOICEPRINTS, (record) =>
          record.personId === id ? { ...record, personId: null } : null,
        );
        detach<EvidenceRecord>(EVIDENCE, (record) => {
          const linkedPersonIds = record.linkedPersonIds?.filter((personId) => personId !== id);
          const entities = record.entities?.map((entity) =>
            entity.personId === id ? { ...entity, personId: undefined } : entity,
          );
          return linkedPersonIds?.length !== record.linkedPersonIds?.length ||
            entities?.some((entity, index) => entity !== record.entities?.[index])
            ? { ...record, linkedPersonIds, entities }
            : null;
        });
        const detachPersonIds = <T extends { personIds?: string[] }>(record: T) => {
          const personIds = record.personIds?.filter((personId) => personId !== id);
          return personIds?.length !== record.personIds?.length ? { ...record, personIds } : null;
        };
        detach<CaseEventRecord>(CASE_EVENTS, detachPersonIds);
        detach<TaskRecord>(TASKS, detachPersonIds);
        detach<LifeEventRecord>(LIFE_EVENTS, detachPersonIds);
        detach<ReminderRecord>(REMINDERS, detachPersonIds);
        detach<ProjectRecord>(PROJECTS, (record) => {
          const ownerChanged = record.ownerId === id;
          const memberIds = record.memberIds?.filter((personId) => personId !== id);
          const membersChanged = memberIds?.length !== record.memberIds?.length;
          return ownerChanged || membersChanged
            ? {
                ...record,
                ownerId: ownerChanged ? null : record.ownerId,
                memberIds,
                updatedAt: Date.now(),
              }
            : null;
        });
      }),
  );
}

export function assertValidPersonName(raw: string) {
  const name = raw.trim();
  if (!name) throw new Error("人物姓名不能为空");
  if (Array.from(name).length > 40) throw new Error("人物姓名不能超过 40 个字符");
  if ([...name].some((char) => char.charCodeAt(0) <= 31 || char.charCodeAt(0) === 127)) {
    throw new Error("人物姓名包含不支持的控制字符");
  }
}

export interface FacesDbWriteBatch {
  persons?: PersonRecord[];
  relations?: RelationRecord[];
  evidence?: EvidenceRecord[];
  lifeEvents?: LifeEventRecord[];
  reminders?: ReminderRecord[];
}

async function putBatch(batch: FacesDbWriteBatch) {
  const now = Date.now();
  await putRelationshipBatch({
    persons: batch.persons,
    assertions: (batch.relations ?? []).map(assertionFromRelationView),
    evidence: batch.evidence,
    lifeEvents: batch.lifeEvents,
    reminders: batch.reminders,
    viewPreferences: (batch.relations ?? []).map((relation) => ({
      id: relation.id,
      subjectId: relation.id,
      visibility: relation.visibility ?? "auto",
      updatedAt: relation.updatedAt ?? now,
    })),
    referralPolicies: (batch.relations ?? []).map((relation) => ({
      id: relation.id,
      subjectId: relation.id,
      policy: relation.recommendationPolicy ?? "allow",
      direction: "both",
      contexts: [],
      updatedAt: relation.updatedAt ?? now,
    })),
  });
}

export type PersonCompareAndSwapResult =
  | { status: "saved"; person: PersonRecord }
  | { status: "missing" }
  | { status: "conflict"; current: PersonRecord };

async function putPersons(persons: PersonRecord[]): Promise<void> {
  const normalizedPersons = persons.map(normalizePersonRecord);
  for (const person of normalizedPersons) assertValidPersonName(person.name);
  if (!normalizedPersons.length) return;
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(PERSONS, "readwrite");
    const store = tx.objectStore(PERSONS);
    tx.onerror = () => reject(tx.error ?? new Error("批量写入人物失败"));
    tx.onabort = () => reject(tx.error ?? new Error("批量写入人物已中止"));
    tx.oncomplete = () => resolve();
    for (const person of normalizedPersons) store.put(person);
  });
}

/**
 * Save an edit only if the persisted row is exactly the revision the editor
 * opened. The existence check and write share one IndexedDB transaction, so a
 * concurrent deletion can never be followed by an accidental resurrection.
 */
async function compareAndSwapPerson(
  person: PersonRecord,
  expectedRevision: string,
): Promise<PersonCompareAndSwapResult> {
  assertValidPersonName(person.name);
  const normalized = normalizePersonRecord(person);
  const db = await openDb();
  return new Promise<PersonCompareAndSwapResult>((resolve, reject) => {
    const tx = db.transaction(PERSONS, "readwrite");
    const store = tx.objectStore(PERSONS);
    let outcome: PersonCompareAndSwapResult | undefined;
    tx.onerror = () => reject(tx.error ?? new Error("人物条件写入失败"));
    tx.onabort = () => reject(tx.error ?? new Error("人物条件写入已中止"));
    tx.oncomplete = () => resolve(outcome ?? { status: "missing" });
    const request = store.get(person.id);
    request.onsuccess = () => {
      const current = request.result as PersonRecord | undefined;
      if (!current) {
        outcome = { status: "missing" };
        return;
      }
      const canonicalCurrent = normalizePersonRecord(current);
      if (personRecordRevision(canonicalCurrent) !== expectedRevision) {
        outcome = { status: "conflict", current: canonicalCurrent };
        return;
      }
      outcome = { status: "saved", person: normalized };
      store.put(normalized);
    };
  });
}

async function deleteSightings(ids: string[]): Promise<void> {
  const uniqueIds = [...new Set(ids)];
  if (!uniqueIds.length) return;
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(SIGHTINGS, "readwrite");
    const store = tx.objectStore(SIGHTINGS);
    tx.onerror = () => reject(tx.error ?? new Error("批量删除到访记录失败"));
    tx.onabort = () => reject(tx.error ?? new Error("批量删除到访记录已中止"));
    tx.oncomplete = () => resolve();
    for (const id of uniqueIds) store.delete(id);
  });
}

export const facesDb = {
  putBatch,
  putRelationshipBatch,
  applyArchiveMutationBatch,
  readArchiveSnapshot,
  replaceArchiveSnapshot,
  listRelationAssertions: () =>
    run<RelationAssertionRecord[]>(RELATION_ASSERTIONS, "readonly", (store) => store.getAll()).then(
      (rows) => rows.sort((left, right) => right.updatedAt - left.updatedAt),
    ),
  listCurrentRelationAssertions: () =>
    run<RelationAssertionRecord[]>(RELATION_ASSERTIONS, "readonly", (store) => store.getAll()).then(
      (rows) =>
        currentRelationAssertions(rows).sort((left, right) => right.updatedAt - left.updatedAt),
    ),
  putRelationAssertion: (assertion: RelationAssertionRecord) =>
    putRelationshipBatch({ assertions: [assertion] }),
  deleteRelationAssertion: (id: string) => putRelationshipBatch({ deleteAssertionIds: [id] }),
  listDerivedRelations: async () => {
    await ensureCurrentKinshipProjection();
    return run<DerivedRelationshipRecord[]>(DERIVED_RELATIONS, "readonly", (store) =>
      store.getAll(),
    );
  },
  rebuildDerivedRelations: () => putRelationshipBatch({}),
  listRelationshipViews,
  listRelationEvidenceLinks: () =>
    run<RelationEvidenceLinkRecord[]>(RELATION_EVIDENCE_LINKS, "readonly", (store) =>
      store.getAll(),
    ),
  putRelationEvidenceLink: (link: RelationEvidenceLinkRecord) =>
    run<void>(RELATION_EVIDENCE_LINKS, "readwrite", (store) => store.put(link)),
  listRelationViewPreferences: () =>
    run<RelationViewPreferenceRecord[]>(RELATION_VIEW_PREFERENCES, "readonly", (store) =>
      store.getAll(),
    ),
  putRelationViewPreference: (preference: RelationViewPreferenceRecord) =>
    run<void>(RELATION_VIEW_PREFERENCES, "readwrite", (store) => store.put(preference)),
  listReferralPolicies: () =>
    run<ReferralPolicyRecord[]>(REFERRAL_POLICIES, "readonly", (store) => store.getAll()),
  putReferralPolicy: (policy: ReferralPolicyRecord) =>
    run<void>(REFERRAL_POLICIES, "readwrite", (store) => store.put(policy)),
  listCollections: () =>
    run<CollectionRecord[]>(COLLECTIONS, "readonly", (store) => store.getAll()).then((rows) =>
      rows.sort((left, right) => left.name.localeCompare(right.name, "zh-CN")),
    ),
  putCollection: (collection: CollectionRecord) =>
    run<void>(COLLECTIONS, "readwrite", (store) => store.put(collection)),
  deleteCollection: async (id: string) => {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([COLLECTIONS, COLLECTION_MEMBERSHIPS], "readwrite");
      tx.onerror = () => reject(tx.error ?? new Error("删除集合失败"));
      tx.oncomplete = () => resolve();
      tx.objectStore(COLLECTIONS).delete(id);
      const membershipStore = tx.objectStore(COLLECTION_MEMBERSHIPS);
      const request = membershipStore.getAll();
      request.onsuccess = () => {
        for (const membership of request.result as CollectionMembershipRecord[]) {
          if (membership.collectionId === id) membershipStore.delete(membership.id);
        }
      };
    });
  },
  listCollectionMemberships: () =>
    run<CollectionMembershipRecord[]>(COLLECTION_MEMBERSHIPS, "readonly", (store) =>
      store.getAll(),
    ),
  putCollectionMembership: (membership: CollectionMembershipRecord) =>
    run<void>(COLLECTION_MEMBERSHIPS, "readwrite", (store) => store.put(membership)),
  deleteCollectionMembership: (id: string) =>
    run<void>(COLLECTION_MEMBERSHIPS, "readwrite", (store) => store.delete(id)),
  listPersons: () =>
    run<PersonRecord[]>(PERSONS, "readonly", (s) => s.getAll()).then((rows) =>
      rows.map(normalizePersonRecord).sort((a, b) => b.createdAt - a.createdAt),
    ),
  putPerson: (person: PersonRecord) => putPersons([person]),
  putPersons,
  compareAndSwapPerson,
  /** 删除人物时，级联删除与其相关的所有关系 */
  deletePerson: async (id: string) => {
    await deletePersonAndDetachReferences(id);
  },
  /** 清掉指向已不存在人物的孤儿关系 */
  pruneOrphanRelations: async () => {
    const [persons, assertions] = await Promise.all([
      run<PersonRecord[]>(PERSONS, "readonly", (s) => s.getAll()),
      run<RelationAssertionRecord[]>(RELATION_ASSERTIONS, "readonly", (s) => s.getAll()),
    ]);
    const ids = new Set(persons.map((person) => person.id));
    const removedRelationIds = assertions
      .filter((relation) => !ids.has(relation.fromId) || !ids.has(relation.toId))
      .map((relation) => relation.id);
    if (removedRelationIds.length)
      await putRelationshipBatch({ deleteAssertionIds: removedRelationIds });
    return removedRelationIds.length;
  },
  listSightings: () =>
    run<SightingRecord[]>(SIGHTINGS, "readonly", (s) => s.getAll()).then((rows) =>
      rows.sort((a, b) => b.at - a.at),
    ),
  addSighting: (record: SightingRecord) => run<void>(SIGHTINGS, "readwrite", (s) => s.put(record)),
  putSighting: (record: SightingRecord) => run<void>(SIGHTINGS, "readwrite", (s) => s.put(record)),
  deleteSighting: (id: string) => run<void>(SIGHTINGS, "readwrite", (s) => s.delete(id)),
  deleteSightings,
  clearSightings: () => run<void>(SIGHTINGS, "readwrite", (s) => s.clear()),
  /** Compatibility view. New domain code should choose assertions or projections explicitly. */
  listRelations: () => listRelationshipViews(),
  putRelation: async (relation: RelationRecord) => {
    const now = Date.now();
    await putRelationshipBatch({
      assertions: [assertionFromRelationView(relation)],
      viewPreferences: [
        {
          id: relation.id,
          subjectId: relation.id,
          visibility: relation.visibility ?? "auto",
          updatedAt: now,
        },
      ],
      referralPolicies: [
        {
          id: relation.id,
          subjectId: relation.id,
          policy: relation.recommendationPolicy ?? "allow",
          direction: "both",
          contexts: [],
          updatedAt: now,
        },
      ],
    });
  },
  deleteRelation: async (id: string) => {
    const derived = await run<DerivedRelationshipRecord | undefined>(
      DERIVED_RELATIONS,
      "readonly",
      (store) => store.get(id),
    );
    if (derived) throw new Error("派生关系不能直接删除；请修改支持事实，或把该投影设为隐藏");
    await putRelationshipBatch({ deleteAssertionIds: [id] });
    await Promise.all([
      run<void>(RELATION_VIEW_PREFERENCES, "readwrite", (store) => store.delete(id)),
      run<void>(REFERRAL_POLICIES, "readwrite", (store) => store.delete(id)),
    ]);
  },
  listEvidence: () =>
    run<EvidenceRecord[]>(EVIDENCE, "readonly", (s) => s.getAll()).then((rows) =>
      rows.sort((a, b) => b.createdAt - a.createdAt),
    ),
  putEvidence: (record: EvidenceRecord) => run<void>(EVIDENCE, "readwrite", (s) => s.put(record)),
  deleteEvidence: (id: string) => run<void>(EVIDENCE, "readwrite", (s) => s.delete(id)),
  listVoiceprints: () =>
    run<VoiceprintRecord[]>(VOICEPRINTS, "readonly", (s) => s.getAll()).then((rows) =>
      rows.sort((a, b) => b.createdAt - a.createdAt),
    ),
  putVoiceprint: (record: VoiceprintRecord) =>
    run<void>(VOICEPRINTS, "readwrite", (s) => s.put(record)),
  deleteVoiceprint: (id: string) => run<void>(VOICEPRINTS, "readwrite", (s) => s.delete(id)),
  listCaseEvents: () =>
    run<CaseEventRecord[]>(CASE_EVENTS, "readonly", (s) => s.getAll()).then((rows) =>
      rows.sort((a, b) => a.at - b.at),
    ),
  putCaseEvent: (record: CaseEventRecord) =>
    run<void>(CASE_EVENTS, "readwrite", (s) => s.put(record)),
  deleteCaseEvent: (id: string) => run<void>(CASE_EVENTS, "readwrite", (s) => s.delete(id)),
  listTasks: () =>
    run<TaskRecord[]>(TASKS, "readonly", (s) => s.getAll()).then((rows) =>
      rows.sort((a, b) => b.createdAt - a.createdAt),
    ),
  putTask: (record: TaskRecord) => run<void>(TASKS, "readwrite", (s) => s.put(record)),
  deleteTask: (id: string) => run<void>(TASKS, "readwrite", (s) => s.delete(id)),
  listProjects: () =>
    run<ProjectRecord[]>(PROJECTS, "readonly", (s) => s.getAll()).then((rows) =>
      rows.sort((a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt)),
    ),
  putProject: (record: ProjectRecord) => run<void>(PROJECTS, "readwrite", (s) => s.put(record)),
  deleteProject: (id: string) => run<void>(PROJECTS, "readwrite", (s) => s.delete(id)),
  listLifeEvents: () =>
    run<LifeEventRecord[]>(LIFE_EVENTS, "readonly", (s) => s.getAll()).then((rows) =>
      rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)),
    ),
  putLifeEvent: (record: LifeEventRecord) =>
    run<void>(LIFE_EVENTS, "readwrite", (s) => s.put(record)),
  deleteLifeEvent: (id: string) => run<void>(LIFE_EVENTS, "readwrite", (s) => s.delete(id)),
  listReminders: () =>
    run<ReminderRecord[]>(REMINDERS, "readonly", (s) => s.getAll()).then((rows) =>
      rows.sort((a, b) => b.createdAt - a.createdAt),
    ),
  putReminder: (record: ReminderRecord) => run<void>(REMINDERS, "readwrite", (s) => s.put(record)),
  deleteReminder: (id: string) => run<void>(REMINDERS, "readwrite", (s) => s.delete(id)),
};
