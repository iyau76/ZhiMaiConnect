/**
 * 演示库（DemoPack）公共接口。
 *
 * 一个 pack 是一份自包含的合成剧本：人物、圈层、关系、事件与提醒都在包内
 * 用局部稳定 key 互相引用，装配器（assemble.ts）负责展开成全局唯一 id。
 * 生活场景与世界剧场（DLC）共用这一套接口；将来整合包与角色扮演玩法
 * 也是在这里扩展（universe / egoKey 已预留），不再回头改装配器。
 */

import type { DatePrecision, PersonProfile, RelationValidity } from "@/lib/face-db";
import type { RelationPredicate, RelationQualifiers } from "@/lib/relation-ontology";

export interface DemoPersonSeed {
  /** 包内稳定引用键（小写拼音或英文，如 "tangyue"）；装配成 demo-zhimai-<pack>-<key> */
  key: string;
  name: string;
  /** 缺省按 relation/likes 生成一句合成说明 */
  note?: string;
  profile: {
    gender?: "男" | "女";
    /** 用户视角的关系描述，如「大学摄影社搭档」「表哥」 */
    relation: string;
    /** 职位 / 身份，如「活动摄影师」「博士生」 */
    title?: string;
    /** 单位 / 组织；学生等无组织角色可省略 */
    org?: string;
    likes?: string[];
    projects?: string[];
    /** 邮箱等演示联系方式，必须用 example.invalid 域名 */
    contact?: string;
    /** 1-5 */
    closeness?: number;
    /** MM-DD 或 YYYY-MM-DD */
    birthday?: string;
    /** 相识场景 */
    metAt?: string;
    /** 平台账号与历史昵称，用于演示身份消歧 */
    identities?: PersonProfile["identities"];
  };
  /** 低置信人物：来源标为 ai 待复核，演示「未核验」状态 */
  lowConfidence?: boolean;
  /** 装配后把 updatedAt 略微后移，演示「最近更新」 */
  touched?: boolean;
}

export interface DemoRelationSeed {
  from: string;
  to: string;
  predicate: RelationPredicate;
  /** 展示措辞，如「前室友」「姨表亲」；语义一律以 predicate + qualifiers 为准 */
  label: string;
  note?: string;
  qualifiers?: RelationQualifiers;
  validity?: RelationValidity;
  /** 待确认低置信关系：confirmationStatus=pending，走人工确认闭环演示 */
  pending?: boolean;
  /** 显式置信度（0-1）；pending 缺省 0.62，其余缺省 0.96 */
  confidence?: number;
}

export interface DemoEventSeed {
  /** 起始日 yyyy-mm-dd；precision 为 unknown 时可为空串 */
  date: string;
  dateEnd?: string;
  precision?: DatePrecision;
  /** 原始时间说法，如「危机纪元 8 年」「去年夏天」；排序仍以 date 为准 */
  dateText?: string;
  title: string;
  /** 聚会 / 约会 / 送礼 / 通话 / 帮忙 / 其它 */
  kind?: string;
  detail?: string;
  place?: string;
  people: string[];
}

export interface DemoReminderSeed {
  title: string;
  /** yyyy-mm-dd */
  due?: string;
  people: string[];
  kind?: "birthday" | "festival" | "gift" | "custom";
}

export interface DemoCollectionSeed {
  name: string;
  members: string[];
}

export interface DemoPack {
  id: string;
  group: "life" | "world";
  /** 中文场景名；英文翻译进 i18n，键为该字符串 */
  name: string;
  description: string;
  /** 一句示例提问，展示这个库最擅长回答什么 */
  example: string;
  /** 世界观一句话说明（世界剧场必填；角色扮演玩法预留） */
  universe?: string;
  /**
   * 预留：主角 key。启用后该人物登记为 ego（关系以主角为原点）。
   * 当前装配器不读这个字段；世界剧场先按「无我」模式运行，验证后再开。
   */
  egoKey?: string;
  collections: DemoCollectionSeed[];
  people: DemoPersonSeed[];
  relations: DemoRelationSeed[];
  events: DemoEventSeed[];
  reminders: DemoReminderSeed[];
}

/** 跨包桥接 seed：from/to 用 `<packId>/<key>` 复合键，仅在载入完整库时装配。 */
export interface DemoCrossRelationSeed extends Omit<DemoRelationSeed, "from" | "to"> {
  from: `${string}/${string}`;
  to: `${string}/${string}`;
}

export interface DemoCrossEventSeed extends Omit<DemoEventSeed, "people"> {
  people: `${string}/${string}`[];
}
