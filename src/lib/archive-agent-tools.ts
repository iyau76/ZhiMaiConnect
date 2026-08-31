import { z } from "zod";

import { agentMutationRequestSchema } from "./archive-mutation-agent";
import { MemoryAgentRunRecorder, type AgentRunRecorder } from "./agent-run-log";
import {
  AgentToolRegistry,
  defineAgentTool,
  type AgentToolPermission,
} from "./agent-tool-registry";
import { rankConnectionPaths, rankTargetSideEntries } from "./connection-paths";
import type {
  CollectionMembershipRecord,
  CollectionRecord,
  LifeEventRecord,
  PersonRecord,
  RelationRecord,
} from "./face-db";
import { rankCandidates, rankCapabilityCandidates, taskSafetyNotice } from "./recommendation";
import { callWebTool } from "./web-tools-client";

export interface ArchiveAgentData {
  persons: PersonRecord[];
  relations: RelationRecord[];
  events: LifeEventRecord[];
  collections?: CollectionRecord[];
  collectionMemberships?: CollectionMembershipRecord[];
}

export interface ArchiveAgentServices {
  archive: ArchiveAgentData;
  intakeStaging?: {
    stagePersonUpdate(personId: string, changes: Record<string, unknown>): unknown;
    stageEventUpdate(eventId: string, changes: Record<string, unknown>): unknown;
    stageRelationUpdate(relationId: string, changes: Record<string, unknown>): unknown;
  };
  mutationPlanning?: {
    propose(request: z.infer<typeof agentMutationRequestSchema>): unknown | Promise<unknown>;
  };
}

function clipped(value: unknown, max = 800) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function redactDirectIdentifiers(value: string) {
  return value
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, "[邮箱已隐藏]")
    .replace(/(?<!\d)1[3-9]\d{9}(?!\d)/g, "[手机号已隐藏]")
    .replace(/(?<!\d)(?:\+?86[- ]?)?0\d{2,3}[- ]?\d{7,8}(?!\d)/g, "[电话已隐藏]");
}

export function cleanArchiveText(value: unknown, max = 800) {
  return redactDirectIdentifiers(clipped(value, max)).replace(/</g, "＜").replace(/>/g, "＞");
}

export function compactArchivePerson(person: PersonRecord) {
  const profile = person.profile ?? {};
  return {
    id: person.id,
    name: cleanArchiveText(person.name, 80),
    entityRole: person.entityRole ?? "contact",
    relation: cleanArchiveText(profile.relation, 80),
    title: cleanArchiveText(profile.title, 100),
    org: cleanArchiveText(profile.org, 120),
    department: cleanArchiveText(profile.department, 100),
    tags: (profile.tags ?? []).slice(0, 12).map((item) => cleanArchiveText(item, 60)),
    projects: (profile.projects ?? []).slice(0, 8).map((item) => cleanArchiveText(item, 100)),
    closeness: profile.closeness,
    hasContact: Boolean(profile.contact?.trim()),
    updatedAt: person.updatedAt ?? person.createdAt,
  };
}

const PROFILE_INDEX_FIELDS = [
  "id",
  "name",
  "entityRole",
  "relation",
  "title",
  "org",
  "department",
  "tags",
  "projects",
  "closeness",
  "hasContact",
  "updatedAt",
] as const;

const PROFILE_DETAIL_ONLY_FIELDS = [
  "age",
  "birthday",
  "gender",
  "address",
  "reportsTo",
  "likes",
  "dislikes",
  "gifts",
  "metAt",
  "aliases",
  "extra",
  "note",
  "sourceKind",
] as const;

function profileProjection(kind: "profile_index" | "profile_detail") {
  return kind === "profile_index"
    ? {
        projection: kind,
        returnedFields: PROFILE_INDEX_FIELDS,
        omittedFields: PROFILE_DETAIL_ONLY_FIELDS,
        omissionMeaning: "not_loaded" as const,
        detailTool: "get_profiles" as const,
      }
    : {
        projection: kind,
        returnedFields: [...PROFILE_INDEX_FIELDS, ...PROFILE_DETAIL_ONLY_FIELDS],
        omittedFields: [] as string[],
        omissionMeaning: "field_absence_is_visible" as const,
      };
}

export function detailedArchivePerson(person: PersonRecord) {
  const profile = person.profile ?? {};
  return {
    ...compactArchivePerson(person),
    age: cleanArchiveText(profile.age, 30),
    birthday: cleanArchiveText(profile.birthday, 30),
    gender: cleanArchiveText(profile.gender, 30),
    address: cleanArchiveText(profile.address, 160),
    reportsTo: cleanArchiveText(profile.reportsTo, 100),
    likes: (profile.likes ?? []).slice(0, 20).map((item) => cleanArchiveText(item, 80)),
    dislikes: (profile.dislikes ?? []).slice(0, 20).map((item) => cleanArchiveText(item, 80)),
    gifts: (profile.gifts ?? []).slice(0, 20).map((item) => cleanArchiveText(item, 100)),
    metAt: cleanArchiveText(profile.metAt, 160),
    aliases: (profile.identities ?? []).slice(0, 20).map((item) => ({
      platform: cleanArchiveText(item.platform, 50),
      alias: cleanArchiveText(item.alias, 80),
      validFrom: cleanArchiveText(item.validFrom, 20),
      validTo: cleanArchiveText(item.validTo, 20),
    })),
    extra: Object.fromEntries(
      Object.entries(profile.extra ?? {})
        .slice(0, 50)
        .map(([key, value]) => [cleanArchiveText(key, 60), cleanArchiveText(value, 300)]),
    ),
    note: cleanArchiveText(person.note, 1_500),
    sourceKind: person.source?.kind ?? "manual",
  };
}

export function compactArchiveRelation(
  relation: RelationRecord,
  names: ReadonlyMap<string, string>,
) {
  return {
    id: relation.id,
    recordType: relation.recordType ?? "assertion",
    fromId: relation.fromId,
    from: names.get(relation.fromId) ?? "未知人物",
    toId: relation.toId,
    to: names.get(relation.toId) ?? "未知人物",
    predicate: relation.predicate ?? relation.semanticKind,
    qualifiers: relation.qualifiers,
    label: cleanArchiveText(relation.label, 100),
    mutual: relation.mutual,
    note: cleanArchiveText(relation.note, 300),
    basis: cleanArchiveText(relation.basis, 500),
    confirmationStatus: relation.confirmationStatus ?? "confirmed",
    evidenceMode: relation.evidenceMode ?? "unknown",
    supportingAssertionIds: relation.supportingRelationIds ??
      relation.derivedFromRelationIds ?? [relation.id],
    validity:
      relation.qualifiers?.temporalStatus === "former"
        ? "ended"
        : relation.qualifiers?.temporalStatus === "current"
          ? "active"
          : "unknown",
    updatedAt: relation.updatedAt ?? relation.createdAt,
  };
}

export function compactArchiveEvent(event: LifeEventRecord, names: ReadonlyMap<string, string>) {
  return {
    id: event.id,
    date: event.date,
    dateEnd: event.dateEnd,
    precision: event.precision ?? "day",
    title: cleanArchiveText(event.title, 180),
    detail: cleanArchiveText(event.detail, 500),
    place: cleanArchiveText(event.place, 120),
    kind: cleanArchiveText(event.kind, 60),
    personIds: (event.personIds ?? []).slice(0, 30),
    persons: (event.personIds ?? []).slice(0, 30).map((id) => names.get(id) ?? "未知人物"),
    updatedAt: event.updatedAt ?? event.createdAt,
  };
}

function normalizedSearch(value: string) {
  return value.toLocaleLowerCase("zh-CN").replace(/[\s，。！？、；：,.!?;:()（）/]+/g, "");
}

function searchTerms(query: string) {
  const compact = normalizedSearch(query);
  const split = query
    .toLocaleLowerCase("zh-CN")
    .split(/[\s，。！？、；：,.!?;:()（）/]+/)
    .map(normalizedSearch)
    .filter(Boolean);
  return [...new Set([compact, ...split])];
}

/** Search is only recall. A miss is never evidence that the archive lacks a record. */
export function archivePersonSearchScore(query: string, person: PersonRecord) {
  const terms = searchTerms(query);
  if (!terms.length) return 0;
  const name = normalizedSearch(person.name);
  const aliases = (person.profile?.identities ?? []).map((identity) =>
    normalizedSearch(identity.alias),
  );
  const compact = normalizedSearch(JSON.stringify(detailedArchivePerson(person)));
  return terms.reduce((score, term) => {
    if (!term) return score;
    if (name === term || aliases.includes(term)) return score + 20;
    if (name.includes(term) || aliases.some((alias) => alias.includes(term))) return score + 10;
    return score + (compact.includes(term) ? 1 : 0);
  }, 0);
}

function namesOf(data: ArchiveAgentData) {
  return new Map(data.persons.map((person) => [person.id, person.name]));
}

const cursorSchema = z
  .object({
    cursor: z.number().int().nonnegative().optional(),
    limit: z.number().int().min(1).max(50).optional(),
  })
  .strict();

const querySchema = z
  .object({
    query: z.string().trim().min(1).max(160),
    limit: z.number().int().min(1).max(30).optional(),
  })
  .strict();

const idsSchema = z
  .object({ personIds: z.array(z.string().min(1).max(200)).min(1).max(20) })
  .strict();

const recommendationCapabilitySchema = z
  .object({
    id: z.string().trim().min(1).max(80),
    label: z.string().trim().min(1).max(60),
    deliverable: z.string().trim().min(1).max(160),
    searchTerms: z.array(z.string().trim().min(1).max(40)).min(1).max(10),
  })
  .strict();

export const archiveAgentToolRegistry = new AgentToolRegistry<ArchiveAgentServices>();

archiveAgentToolRegistry
  .register(
    defineAgentTool({
      name: "get_collections",
      label: "读取圈层与成员",
      description: "读取关系圈层/场景集合及稳定 collectionId、personId；圈层批改前必须先调用。",
      input: z.object({}).strict(),
      permission: "private_read",
      handler: (_input, { services }) => {
        const people = new Map(services.archive.persons.map((person) => [person.id, person.name]));
        const memberships = services.archive.collectionMemberships ?? [];
        return {
          hint: "圈层由 collections/memberships 表示，不以 profile.circle 为唯一真相",
          rows: (services.archive.collections ?? []).map((collection) => ({
            ...collection,
            members: memberships
              .filter((membership) => membership.collectionId === collection.id)
              .map((membership) => ({
                personId: membership.personId,
                personName: people.get(membership.personId) ?? "未知人物",
              })),
          })),
        };
      },
    }),
  )
  .register(
    defineAgentTool({
      name: "get_archive_manifest",
      label: "读取档案清单",
      description: "返回本机人物、关系和事件数量；用于决定下一步检索，不返回私密正文。",
      input: z.object({}).strict(),
      permission: "private_read",
      handler: (_input, { services }) => ({
        persons: services.archive.persons.length,
        relations: services.archive.relations.length,
        events: services.archive.events.length,
      }),
    }),
  )
  .register(
    defineAgentTool({
      name: "list_profiles",
      label: "浏览人物索引",
      description: "分页读取人物 ID 与非敏感摘要；关键词未命中时可用它继续浏览。",
      input: cursorSchema,
      permission: "private_read",
      handler: ({ cursor = 0, limit = 12 }, { services }) => {
        const rows = services.archive.persons
          .slice(cursor, cursor + limit)
          .map(compactArchivePerson);
        return {
          ...profileProjection("profile_index"),
          rows,
          nextCursor:
            cursor + rows.length < services.archive.persons.length ? cursor + rows.length : null,
          total: services.archive.persons.length,
        };
      },
    }),
  )
  .register(
    defineAgentTool({
      name: "search_profiles",
      label: "检索人物档案",
      description:
        "按姓名、别名与档案正文做召回，返回稳定 personId。零结果只代表本次检索词未命中。",
      input: querySchema,
      permission: "private_read",
      handler: ({ query, limit = 8 }, { services }) => {
        const matches = services.archive.persons
          .map((person) => ({ person, score: archivePersonSearchScore(query, person) }))
          .filter((item) => item.score > 0)
          .sort(
            (left, right) =>
              right.score - left.score ||
              left.person.name.localeCompare(right.person.name, "zh-CN"),
          );
        return {
          ...profileProjection("profile_index"),
          query,
          rows: matches.slice(0, limit).map((item) => ({
            ...compactArchivePerson(item.person),
            matchScore: item.score,
          })),
          totalMatches: matches.length,
          exhausted: matches.length <= limit,
        };
      },
    }),
  )
  .register(
    defineAgentTool({
      name: "get_profiles",
      label: "读取人物详情",
      description: "按稳定 personId 读取人物详情；不返回联系方式原文、人脸特征或照片。",
      input: idsSchema,
      permission: "private_read",
      handler: ({ personIds }, { services }) => ({
        ...profileProjection("profile_detail"),
        rows: services.archive.persons
          .filter((person) => personIds.includes(person.id))
          .map(detailedArchivePerson),
      }),
    }),
  )
  .register(
    defineAgentTool({
      name: "get_relationships",
      label: "读取人物关系",
      description: "按人物 ID 读取事实关系和本地派生关系，明确 recordType、语义谓词与支持事实 ID。",
      input: idsSchema,
      permission: "private_read",
      handler: ({ personIds }, { services }) => {
        const names = namesOf(services.archive);
        return {
          rows: services.archive.relations
            .filter(
              (relation) =>
                personIds.includes(relation.fromId) || personIds.includes(relation.toId),
            )
            .slice(0, 120)
            .map((relation) => compactArchiveRelation(relation, names)),
        };
      },
    }),
  )
  .register(
    defineAgentTool({
      name: "search_events",
      label: "检索事件",
      description: "按标题、详情、地点、日期或人物名称检索事件并返回稳定 eventId。",
      input: querySchema,
      permission: "private_read",
      handler: ({ query, limit = 10 }, { services }) => {
        const names = namesOf(services.archive);
        const term = normalizedSearch(query);
        const matches = services.archive.events.filter((event) =>
          normalizedSearch(JSON.stringify(compactArchiveEvent(event, names))).includes(term),
        );
        return {
          query,
          rows: matches.slice(0, limit).map((event) => compactArchiveEvent(event, names)),
          totalMatches: matches.length,
        };
      },
    }),
  )
  .register(
    defineAgentTool({
      name: "search_relations",
      label: "检索关系",
      description: "按人物姓名、关系标签、规范谓词、依据或备注检索关系并返回稳定 ID。",
      input: querySchema,
      permission: "private_read",
      handler: ({ query, limit = 10 }, { services }) => {
        const names = namesOf(services.archive);
        const term = normalizedSearch(query);
        const matches = services.archive.relations.filter((relation) =>
          normalizedSearch(JSON.stringify(compactArchiveRelation(relation, names))).includes(term),
        );
        return {
          query,
          rows: matches.slice(0, limit).map((relation) => compactArchiveRelation(relation, names)),
          totalMatches: matches.length,
        };
      },
    }),
  )
  .register(
    defineAgentTool({
      name: "get_event",
      label: "读取单个事件",
      description: "按稳定 eventId 读取一条事件，供变更前核对。",
      input: z.object({ eventId: z.string().min(1).max(200) }).strict(),
      permission: "private_read",
      handler: ({ eventId }, { services }) => {
        const event = services.archive.events.find((candidate) => candidate.id === eventId);
        return event
          ? compactArchiveEvent(event, namesOf(services.archive))
          : { error: "事件不存在" };
      },
    }),
  )
  .register(
    defineAgentTool({
      name: "get_relation",
      label: "读取单个关系",
      description: "按稳定关系 ID 读取事实或派生关系，供变更前核对。",
      input: z.object({ relationId: z.string().min(1).max(300) }).strict(),
      permission: "private_read",
      handler: ({ relationId }, { services }) => {
        const relation = services.archive.relations.find(
          (candidate) => candidate.id === relationId,
        );
        return relation
          ? compactArchiveRelation(relation, namesOf(services.archive))
          : { error: "关系不存在" };
      },
    }),
  )
  .register(
    defineAgentTool({
      name: "get_events",
      label: "读取人物事件",
      description: "按人物 ID 读取共同事件与稳定 eventId，供核对或后续变更提案使用。",
      input: idsSchema,
      permission: "private_read",
      handler: ({ personIds }, { services }) => {
        const names = namesOf(services.archive);
        return {
          rows: services.archive.events
            .filter((event) => event.personIds?.some((id) => personIds.includes(id)))
            .slice()
            .sort((left, right) => right.date.localeCompare(left.date))
            .slice(0, 100)
            .map((event) => compactArchiveEvent(event, names)),
        };
      },
    }),
  )
  .register(
    defineAgentTool({
      name: "propose_archive_mutations",
      label: "生成批量档案变更计划",
      description:
        "把人物、事实关系、事件、圈层或删除变更组合成一个待批准计划；不会直接写库。必须先读取目标稳定 ID。跨圈迁移使用一次 migrate_collection_members 声明源圈、目标圈和选中人物；目标不存在时省略 target.collectionId，compiler 会原子地创建目标、移出源圈并加入目标圈。delete_person 是完整的原子级联操作，会自动删除或解绑该人物关联的关系、事件、提醒、事务、项目、圈层成员和证据；删除人物时只提交一次 delete_person，不要再为其依赖追加 update_relation、update_event、organize_collection 或重复 delete_person。",
      input: agentMutationRequestSchema,
      permission: "proposal",
      handler: (request, { services }) => {
        if (!services.mutationPlanning) throw new Error("当前 Agent 不支持档案变更计划");
        return services.mutationPlanning.propose(request);
      },
    }),
  )
  .register(
    defineAgentTool({
      name: "propose_person_deletion",
      label: "生成原子人物删除计划",
      description:
        "为一个稳定 personId 生成待批准的原子删除计划。此工具会自动预览并级联处理关系、事件、提醒、待办、事务、项目、圈层成员和证据；不要先逐项修改依赖，也不要与 propose_archive_mutations 组合使用。",
      input: z
        .object({
          personId: z.string().min(1).max(200),
          reason: z.string().trim().min(1).max(500),
        })
        .strict(),
      permission: "proposal",
      handler: ({ personId, reason }, { services }) => {
        if (!services.mutationPlanning) throw new Error("当前 Agent 不支持人物删除计划");
        const person = services.archive.persons.find((candidate) => candidate.id === personId);
        if (!person) throw new Error(`人物 ${personId} 不存在`);
        return services.mutationPlanning.propose({
          title: `删除 ${cleanArchiveText(person.name, 100)}`,
          reason,
          operations: [{ kind: "delete_person", personId, reason }],
        });
      },
    }),
  )
  .register(
    defineAgentTool({
      name: "stage_person_update",
      label: "暂存人物修改",
      description: "在录入草稿中暂存人物字段修改；必须先定位稳定 personId，只形成待用户确认内容。",
      input: z
        .object({ personId: z.string().min(1).max(200), changes: z.record(z.unknown()) })
        .strict(),
      permission: "proposal",
      handler: ({ personId, changes }, { services }) => {
        if (!services.intakeStaging) throw new Error("当前 Agent 不支持录入暂存");
        return services.intakeStaging.stagePersonUpdate(personId, changes);
      },
    }),
  )
  .register(
    defineAgentTool({
      name: "stage_event_update",
      label: "暂存事件修改",
      description: "在录入草稿中暂存事件修改；必须先定位稳定 eventId，只形成待用户确认内容。",
      input: z
        .object({ eventId: z.string().min(1).max(200), changes: z.record(z.unknown()) })
        .strict(),
      permission: "proposal",
      handler: ({ eventId, changes }, { services }) => {
        if (!services.intakeStaging) throw new Error("当前 Agent 不支持录入暂存");
        return services.intakeStaging.stageEventUpdate(eventId, changes);
      },
    }),
  )
  .register(
    defineAgentTool({
      name: "stage_relation_update",
      label: "暂存关系修改",
      description: "在录入草稿中暂存事实关系修改；派生关系不可直接改，只形成待用户确认内容。",
      input: z
        .object({ relationId: z.string().min(1).max(300), changes: z.record(z.unknown()) })
        .strict(),
      permission: "proposal",
      handler: ({ relationId, changes }, { services }) => {
        if (!services.intakeStaging) throw new Error("当前 Agent 不支持录入暂存");
        return services.intakeStaging.stageRelationUpdate(relationId, changes);
      },
    }),
  )
  .register(
    defineAgentTool({
      name: "rank_task_candidates",
      label: "评估任务候选人",
      description: "按能力证据、联系可行性和互动记录确定性排序开放任务候选；专业能力优先于亲密度。",
      input: z
        .object({
          task: z.string().trim().min(1).max(1_500),
          capability: recommendationCapabilitySchema.optional(),
          limit: z.number().int().min(1).max(10).optional(),
        })
        .strict(),
      permission: "private_read",
      handler: ({ task, capability, limit = 5 }, { services }) => {
        const candidates = capability
          ? rankCapabilityCandidates(capability, services.archive.persons, services.archive.events)
          : rankCandidates(task, services.archive.persons, services.archive.events);
        return {
          rankingLocked: true,
          safetyNotice: taskSafetyNotice(task),
          capability,
          rows: candidates.slice(0, limit).map((candidate) => ({
            personId: candidate.person.id,
            personName: candidate.person.name,
            score: candidate.score,
            confidence: candidate.confidence,
            reasons: candidate.reasons,
            evidence: candidate.evidence,
            risks: candidate.risks,
            capabilityMatches: candidate.capabilityMatches,
          })),
          note: capability
            ? "先在全库按槽位档案证据形成候选集合，再按证据强度与联系可行性排序；模型不能补人或调序。"
            : "候选、分数和顺序由本地证据算法锁定；模型只能解释，不能调序或添加人物。",
        };
      },
    }),
  )
  .register(
    defineAgentTool({
      name: "find_connection_paths",
      label: "计算真实引荐路径",
      description:
        "从可实际联系的人出发，计算到目标人物的可审计路径；输出顺序与分数由本地算法锁定。",
      input: z
        .object({
          targetPersonId: z.string().min(1).max(200),
          task: z.string().max(800).optional(),
          maxHops: z.number().int().min(1).max(5).optional(),
          limit: z.number().int().min(1).max(20).optional(),
          includeInferred: z.boolean().optional(),
        })
        .strict(),
      permission: "private_read",
      handler: (
        { targetPersonId, task = "", maxHops = 3, limit = 5, includeInferred = false },
        { services },
      ) => {
        const rows = rankConnectionPaths({
          ...services.archive,
          targetId: targetPersonId,
          task,
          maxHops,
          limit,
          includeInferred,
          includePending: false,
        }).map((candidate) => ({
          personId: candidate.person.id,
          personName: candidate.person.name,
          score: candidate.score,
          confidence: candidate.confidence,
          reasons: candidate.reasons,
          evidence: candidate.evidence,
          risks: candidate.risks,
          path: candidate.path,
        }));
        return {
          targetPersonId,
          rankingLocked: true,
          rows,
          note:
            rows.length > 0
              ? "候选、分数与路径是本地确定性结果；模型只能解释，不能调序或增删人物。"
              : "没有找到符合确认状态与引荐策略的可达路径。",
        };
      },
    }),
  )
  .register(
    defineAgentTool({
      name: "rank_target_side_entries",
      label: "评估目标侧潜在入口",
      description:
        "当本人到目标没有已验证路径时，列出目标身边关系明确的人；结果不代表用户能联系到这些人。",
      input: z
        .object({
          targetPersonId: z.string().min(1).max(200),
          task: z.string().max(800).optional(),
          limit: z.number().int().min(1).max(20).optional(),
          includeInferred: z.boolean().optional(),
        })
        .strict(),
      permission: "private_read",
      handler: (
        { targetPersonId, task = "", limit = 5, includeInferred = false },
        { services },
      ) => ({
        targetPersonId,
        accessVerified: false,
        scoreMeaning: "target_side_affinity",
        rows: rankTargetSideEntries({
          ...services.archive,
          targetId: targetPersonId,
          task,
          limit,
          includeInferred,
          includePending: false,
        }).map((candidate) => ({
          personId: candidate.person.id,
          personName: candidate.person.name,
          score: candidate.score,
          confidence: candidate.confidence,
          reasons: candidate.reasons,
          evidence: candidate.evidence,
          risks: candidate.risks,
          targetEntry: candidate.targetEntry,
        })),
        note: "这些人只在目标侧有关系证据；不得声称用户已有联系渠道或把分数解释为可达概率。",
      }),
    }),
  )
  .register(
    defineAgentTool({
      name: "get_datetime",
      label: "读取日期时间",
      description: "按 IANA 时区返回当前精确日期和时间。",
      input: z.object({ timeZone: z.string().max(80).optional() }).strict(),
      permission: "public_read",
      handler: ({ timeZone = "Asia/Shanghai" }) => {
        try {
          return {
            timeZone,
            iso: new Date().toISOString(),
            local: new Intl.DateTimeFormat("zh-CN", {
              timeZone,
              dateStyle: "full",
              timeStyle: "long",
            }).format(new Date()),
          };
        } catch {
          throw new Error("时区无效，请使用 IANA 时区名，例如 Asia/Shanghai");
        }
      },
    }),
  )
  .register(
    defineAgentTool({
      name: "get_weather",
      label: "查询实时天气",
      description: "联网查询地点的实时天气和预报；只发送 location，不发送人物档案。",
      input: z.object({ location: z.string().trim().min(1).max(100) }).strict(),
      permission: "network",
      handler: ({ location }, { signal }) => callWebTool({ tool: "weather", location }, signal),
    }),
  )
  .register(
    defineAgentTool({
      name: "search_news",
      label: "检索近期资讯",
      description: "联网检索近期资讯；只发送 query，不发送人物档案。",
      input: z.object({ query: z.string().trim().min(2).max(160) }).strict(),
      permission: "network",
      handler: ({ query }, { signal }) => callWebTool({ tool: "news", query }, signal),
    }),
  )
  .register(
    defineAgentTool({
      name: "search_web",
      label: "检索公开网页",
      description: "联网检索公开网页；只发送 query，不发送人物档案。",
      input: z.object({ query: z.string().trim().min(2).max(160) }).strict(),
      permission: "network",
      handler: ({ query }, { signal }) => callWebTool({ tool: "search", query }, signal),
    }),
  );

const ARCHIVE_READ_TOOL_NAMES = [
  "get_collections",
  "get_archive_manifest",
  "list_profiles",
  "search_profiles",
  "get_profiles",
  "get_relationships",
  "search_events",
  "search_relations",
  "get_event",
  "get_relation",
  "get_events",
] as const;

const RECOMMENDATION_TOOL_NAMES = [
  "rank_task_candidates",
  "find_connection_paths",
  "rank_target_side_entries",
] as const;

const PUBLIC_TOOL_NAMES = ["get_datetime", "get_weather", "search_news", "search_web"] as const;

export interface ArchiveAgentToolScope {
  permissions: readonly AgentToolPermission[];
  toolNames: readonly string[];
}

/**
 * Capabilities and concrete tools are resolved together. An Agent never sees a
 * tool whose backing service is absent, and Runtime enforces the same list.
 */
export const ARCHIVE_AGENT_TOOL_SCOPES = {
  assistantPublic: {
    permissions: ["public_read", "network"],
    toolNames: PUBLIC_TOOL_NAMES,
  },
  assistantArchive: {
    permissions: ["public_read", "private_read", "network", "proposal"],
    toolNames: [
      ...ARCHIVE_READ_TOOL_NAMES,
      ...RECOMMENDATION_TOOL_NAMES,
      "propose_archive_mutations",
      "propose_person_deletion",
      ...PUBLIC_TOOL_NAMES,
    ],
  },
  intakeArchive: {
    permissions: ["private_read", "proposal"],
    toolNames: [
      ...ARCHIVE_READ_TOOL_NAMES,
      "stage_person_update",
      "stage_event_update",
      "stage_relation_update",
    ],
  },
  recommendation: {
    permissions: ["public_read", "private_read", "network"],
    toolNames: [...ARCHIVE_READ_TOOL_NAMES, ...RECOMMENDATION_TOOL_NAMES, ...PUBLIC_TOOL_NAMES],
  },
} as const satisfies Record<string, ArchiveAgentToolScope>;

export function archiveToolLabel(name: string) {
  return archiveAgentToolRegistry.get(name)?.label ?? "未知工具";
}

/** Compatibility/testing adapter. Production Agents should own one shared AgentRuntime per run. */
export async function executeArchiveAgentTool(
  name: string,
  input: unknown,
  archive: ArchiveAgentData,
  options: {
    permissions?: readonly AgentToolPermission[];
    signal?: AbortSignal;
    recorder?: AgentRunRecorder;
  } = {},
) {
  return archiveAgentToolRegistry.execute(name, input, {
    services: { archive },
    recorder: options.recorder ?? new MemoryAgentRunRecorder(),
    permissions: options.permissions ?? ["public_read", "private_read", "network"],
    signal: options.signal,
  });
}
