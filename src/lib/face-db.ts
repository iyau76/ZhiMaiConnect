/** 浏览器本地人脸库（IndexedDB），完全离线，人脸数据不出本机 */

import type { Provenance } from "./provenance";

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
  /** 圈子：家人 / 亲戚 / 朋友 / 同学 / 同事 / 邻居 */
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
  /** 自定义栏位（人物卡模板里自己加的字段）+ AI 整理出的其它字段 */
  extra?: Record<string, string>;
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
  /** 图片备注（合照、名片、聊天截图等） */
  photos?: PhotoNote[];
  /** 这条档案是怎么来的 */
  source?: Provenance;
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
  /** 来源证据 id，用于溯源；没有就是人工手填 */
  sourceId?: string;
  createdAt: number;
  source?: Provenance;
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
}

const DB_NAME = "openglass-faces";
const DB_VERSION = 8;
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


let dbPromise: Promise<IDBDatabase> | null = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(PERSONS)) db.createObjectStore(PERSONS, { keyPath: "id" });
      if (!db.objectStoreNames.contains(SIGHTINGS)) {
        const store = db.createObjectStore(SIGHTINGS, { keyPath: "id" });
        store.createIndex("at", "at");
      }
      if (!db.objectStoreNames.contains(RELATIONS)) db.createObjectStore(RELATIONS, { keyPath: "id" });
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

    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("无法打开本地数据库"));
  });
  return dbPromise;
}


async function run<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest) {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const request = fn(tx.objectStore(store));
    request.onsuccess = () => resolve(request.result as T);
    request.onerror = () => reject(request.error ?? new Error("数据库操作失败"));
  });
}

export const facesDb = {
  listPersons: () =>
    run<PersonRecord[]>(PERSONS, "readonly", (s) => s.getAll()).then((rows) =>
      rows.sort((a, b) => b.createdAt - a.createdAt),
    ),
  putPerson: (person: PersonRecord) => run<void>(PERSONS, "readwrite", (s) => s.put(person)),
  /** 删除人物时，级联删除与其相关的所有关系 */
  deletePerson: async (id: string) => {
    await run<void>(PERSONS, "readwrite", (s) => s.delete(id));
    const relations = await run<RelationRecord[]>(RELATIONS, "readonly", (s) => s.getAll());
    for (const relation of relations) {
      if (relation.fromId === id || relation.toId === id)
        await run<void>(RELATIONS, "readwrite", (s) => s.delete(relation.id));
    }
  },
  /** 清掉指向已不存在人物的孤儿关系 */
  pruneOrphanRelations: async () => {
    const [persons, relations] = await Promise.all([
      run<PersonRecord[]>(PERSONS, "readonly", (s) => s.getAll()),
      run<RelationRecord[]>(RELATIONS, "readonly", (s) => s.getAll()),
    ]);
    const ids = new Set(persons.map((person) => person.id));
    let removed = 0;
    for (const relation of relations) {
      if (!ids.has(relation.fromId) || !ids.has(relation.toId)) {
        await run<void>(RELATIONS, "readwrite", (s) => s.delete(relation.id));
        removed += 1;
      }
    }
    return removed;
  },
  listSightings: () =>
    run<SightingRecord[]>(SIGHTINGS, "readonly", (s) => s.getAll()).then((rows) =>
      rows.sort((a, b) => b.at - a.at),
    ),
  addSighting: (record: SightingRecord) => run<void>(SIGHTINGS, "readwrite", (s) => s.put(record)),
  putSighting: (record: SightingRecord) => run<void>(SIGHTINGS, "readwrite", (s) => s.put(record)),
  deleteSighting: (id: string) => run<void>(SIGHTINGS, "readwrite", (s) => s.delete(id)),
  clearSightings: () => run<void>(SIGHTINGS, "readwrite", (s) => s.clear()),
  listRelations: () =>
    run<RelationRecord[]>(RELATIONS, "readonly", (s) => s.getAll()).then((rows) =>
      rows.sort((a, b) => b.createdAt - a.createdAt),
    ),
  putRelation: (relation: RelationRecord) => run<void>(RELATIONS, "readwrite", (s) => s.put(relation)),
  deleteRelation: (id: string) => run<void>(RELATIONS, "readwrite", (s) => s.delete(id)),
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
  putVoiceprint: (record: VoiceprintRecord) => run<void>(VOICEPRINTS, "readwrite", (s) => s.put(record)),
  deleteVoiceprint: (id: string) => run<void>(VOICEPRINTS, "readwrite", (s) => s.delete(id)),
  listCaseEvents: () =>
    run<CaseEventRecord[]>(CASE_EVENTS, "readonly", (s) => s.getAll()).then((rows) =>
      rows.sort((a, b) => a.at - b.at),
    ),
  putCaseEvent: (record: CaseEventRecord) => run<void>(CASE_EVENTS, "readwrite", (s) => s.put(record)),
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
  putLifeEvent: (record: LifeEventRecord) => run<void>(LIFE_EVENTS, "readwrite", (s) => s.put(record)),
  deleteLifeEvent: (id: string) => run<void>(LIFE_EVENTS, "readwrite", (s) => s.delete(id)),
  listReminders: () =>
    run<ReminderRecord[]>(REMINDERS, "readonly", (s) => s.getAll()).then((rows) =>
      rows.sort((a, b) => b.createdAt - a.createdAt),
    ),
  putReminder: (record: ReminderRecord) => run<void>(REMINDERS, "readwrite", (s) => s.put(record)),
  deleteReminder: (id: string) => run<void>(REMINDERS, "readwrite", (s) => s.delete(id)),
};


