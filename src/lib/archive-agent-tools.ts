import { z } from "zod";

import { ArchiveAgentReferenceSession } from "./archive-agent-reference-session";
import type { AgentMutationRequest } from "./archive-mutation-agent";
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
import {
  RECOMMENDATION_CAPABILITY_EVIDENCE_FIELDS,
  rankCandidates,
  rankCapabilityCandidates,
  taskSafetyNotice,
  type CandidateRecommendation,
} from "./recommendation";
import type { ResolvedRecordDomain } from "./archive-record-resolver";
import { semanticRecordRefSchema } from "./intake-semantic-plan";
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
  /**
   * Stable namespace for a continuing conversation. Standalone agents omit
   * this and receive run-scoped handles; a persisted chat thread supplies its
   * thread id so locally reusable tool observations keep valid opaque refs.
   */
  referenceNamespace?: string;
  mutationPlanning?: {
    propose(request: AgentMutationRequest): unknown | Promise<unknown>;
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
  "personRef",
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

function referenceSessionFor(services: ArchiveAgentServices, runId: string) {
  return new ArchiveAgentReferenceSession(
    {
      persons: services.archive.persons,
      relations: services.archive.relations,
      events: services.archive.events,
      collections: services.archive.collections ?? [],
      collectionMemberships: services.archive.collectionMemberships ?? [],
    },
    services.referenceNamespace ?? runId,
  );
}

function archiveHandle(
  session: ArchiveAgentReferenceSession,
  domain: ResolvedRecordDomain,
  stableId: string,
  label: string,
) {
  return session.reference(domain, stableId, label).handle;
}

function restoreArchiveHandle(
  session: ArchiveAgentReferenceSession,
  handle: string,
  domain: ResolvedRecordDomain,
) {
  const resolution = session.restoreHandle(handle, domain);
  if (resolution.status !== "resolved") throw new Error(resolution.reason);
  return resolution.stableId;
}

function restoreArchiveHandles(
  session: ArchiveAgentReferenceSession,
  handles: readonly string[],
  domain: ResolvedRecordDomain,
) {
  return handles.map((handle) => restoreArchiveHandle(session, handle, domain));
}

function visibleArchivePerson(person: PersonRecord, session: ArchiveAgentReferenceSession) {
  const { id, ...profile } = compactArchivePerson(person);
  return {
    personRef: archiveHandle(session, "person", id, profile.name),
    ...profile,
  };
}

function visibleDetailedArchivePerson(person: PersonRecord, session: ArchiveAgentReferenceSession) {
  const { id, ...profile } = detailedArchivePerson(person);
  return {
    personRef: archiveHandle(session, "person", id, profile.name),
    ...profile,
  };
}

function visibleArchiveRelation(
  relation: RelationRecord,
  names: ReadonlyMap<string, string>,
  session: ArchiveAgentReferenceSession,
) {
  const { id, fromId, toId, supportingAssertionIds, ...record } = compactArchiveRelation(
    relation,
    names,
  );
  return {
    relationRef: archiveHandle(session, "relation", id, record.label),
    ...record,
    fromRef: archiveHandle(session, "person", fromId, record.from),
    toRef: archiveHandle(session, "person", toId, record.to),
    supportingAssertionRefs: supportingAssertionIds.map((assertionId) =>
      archiveHandle(session, "relation", assertionId, "支持关系"),
    ),
  };
}

function visibleArchiveEvent(
  event: LifeEventRecord,
  names: ReadonlyMap<string, string>,
  session: ArchiveAgentReferenceSession,
) {
  const { id, personIds, ...record } = compactArchiveEvent(event, names);
  return {
    eventRef: archiveHandle(session, "event", id, record.title),
    ...record,
    personRefs: personIds.map((personId, index) =>
      archiveHandle(session, "person", personId, record.persons[index] ?? "未知人物"),
    ),
  };
}

function visibleRecommendationCandidate(
  candidate: CandidateRecommendation,
  session: ArchiveAgentReferenceSession,
) {
  return {
    personRef: archiveHandle(session, "person", candidate.person.id, candidate.person.name),
    personName: candidate.person.name,
    score: candidate.score,
    confidence: candidate.confidence,
    reasons: candidate.reasons,
    evidence: candidate.evidence,
    risks: candidate.risks,
    capabilityMatches: candidate.capabilityMatches,
    ...(candidate.path
      ? {
          path: {
            targetPersonRef: archiveHandle(
              session,
              "person",
              candidate.path.targetId,
              candidate.path.personNames.at(-1) ?? "目标人物",
            ),
            personRefs: candidate.path.personIds.map((personId, index) =>
              archiveHandle(
                session,
                "person",
                personId,
                candidate.path?.personNames[index] ?? "未知人物",
              ),
            ),
            personNames: candidate.path.personNames,
            relationRefs: candidate.path.relationIds.map((relationId, index) =>
              archiveHandle(
                session,
                "relation",
                relationId,
                candidate.path?.labels[index] ?? "关系",
              ),
            ),
            labels: candidate.path.labels,
            cost: candidate.path.cost,
            direct: candidate.path.direct,
          },
        }
      : {}),
    ...(candidate.targetEntry
      ? {
          targetEntry: {
            targetPersonRef: archiveHandle(
              session,
              "person",
              candidate.targetEntry.targetId,
              "目标人物",
            ),
            relationRefs: candidate.targetEntry.relationIds.map((relationId, index) =>
              archiveHandle(
                session,
                "relation",
                relationId,
                candidate.targetEntry?.labels[index] ?? "关系",
              ),
            ),
            labels: candidate.targetEntry.labels,
          },
        }
      : {}),
  };
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
    cursor: z.number().int().nonnegative().optional(),
    limit: z.number().int().min(1).max(30).optional(),
  })
  .strict();

const archiveHandleSchema = z
  .string()
  .regex(/^ref_[0-9a-f]{32}$/)
  .describe("当前 Agent 运行中由档案工具返回的 opaque handle");

const personRefsSchema = z
  .object({ personRefs: z.array(archiveHandleSchema).min(1).max(20) })
  .strict();

const personRefsPageSchema = z
  .object({
    personRefs: z.array(archiveHandleSchema).min(1).max(20),
    cursor: z.number().int().nonnegative().optional(),
    limit: z.number().int().min(1).max(50).optional(),
  })
  .strict();

const eventRefSchema = z.object({ eventRef: archiveHandleSchema }).strict();

const relationRefSchema = z.object({ relationRef: archiveHandleSchema }).strict();

const semanticRefsSchema = z
  .object({
    refs: z.array(semanticRecordRefSchema).min(1).max(50),
    cursor: z.number().int().nonnegative().optional(),
    limit: z.number().int().min(1).max(20).optional(),
    candidateCursor: z.number().int().nonnegative().optional(),
    candidateLimit: z.number().int().min(1).max(30).optional(),
  })
  .strict();

const collectionsPageSchema = z
  .object({
    collectionRef: archiveHandleSchema.optional(),
    cursor: z.number().int().nonnegative().optional(),
    limit: z.number().int().min(1).max(30).optional(),
  })
  .strict();

function pageOf<T>(rows: readonly T[], cursor: number, limit: number) {
  const pageRows = rows.slice(cursor, cursor + limit);
  const nextCursor = cursor + pageRows.length < rows.length ? cursor + pageRows.length : null;
  return {
    cursor,
    rows: pageRows,
    returnedCount: pageRows.length,
    sourceCount: rows.length,
    nextCursor,
    exhausted: nextCursor === null,
  };
}

const recommendationCapabilitySchema = z
  .object({
    id: z.string().trim().min(1).max(80),
    label: z.string().trim().min(1).max(60),
    deliverable: z.string().trim().min(1).max(160),
    searchTerms: z.array(z.string().trim().min(1).max(40)).min(1).max(10),
  })
  .strict();

const recommendationSemanticCandidateSchema = z
  .object({
    personRef: archiveHandleSchema,
    evidenceFields: z.array(z.enum(RECOMMENDATION_CAPABILITY_EVIDENCE_FIELDS)).min(1).max(5),
    reason: z.string().trim().max(200).optional(),
  })
  .strict();

export const archiveAgentToolRegistry = new AgentToolRegistry<ArchiveAgentServices>();

archiveAgentToolRegistry
  .register(
    defineAgentTool({
      name: "resolve_record_refs",
      label: "解析语义引用",
      description:
        "把姓名、别名、我、圈层、关系或事件等语义 recordRef 在完整本地档案中解析为本次运行可用的 opaque handle；不受人物分页位置影响，歧义和缺失按条返回。",
      input: semanticRefsSchema,
      permission: "private_read",
      handler: (
        { refs, cursor = 0, limit = 12, candidateCursor = 0, candidateLimit = 12 },
        { services, runId },
      ) => {
        const session = referenceSessionFor(services, runId);
        const resolutions = session.resolveMany(refs);
        const page = pageOf(resolutions, cursor, limit);
        return {
          ...page,
          rows: page.rows.map((resolution, index) => {
            const candidatePage = pageOf(resolution.candidates, candidateCursor, candidateLimit);
            return {
              index: cursor + index,
              status: resolution.status,
              cardinality: resolution.status === "resolved" ? resolution.cardinality : undefined,
              reason: resolution.status === "resolved" ? undefined : resolution.reason,
              candidateCursor: candidatePage.cursor,
              candidates: candidatePage.rows,
              candidateCount: candidatePage.sourceCount,
              nextCandidateCursor: candidatePage.nextCursor,
              candidatesExhausted: candidatePage.exhausted,
            };
          }),
        };
      },
    }),
  )
  .register(
    defineAgentTool({
      name: "get_collections",
      label: "读取圈层与成员",
      description:
        "分页读取圈层索引；传 collectionRef 时分页读取该圈层成员。返回的 nextCursor 非空时继续调用同一工具。",
      input: collectionsPageSchema,
      permission: "private_read",
      handler: ({ collectionRef, cursor = 0, limit = 12 }, { services, runId }) => {
        const session = referenceSessionFor(services, runId);
        const people = new Map(services.archive.persons.map((person) => [person.id, person.name]));
        const memberships = services.archive.collectionMemberships ?? [];
        if (collectionRef) {
          const collectionId = restoreArchiveHandle(session, collectionRef, "collection");
          const collection = (services.archive.collections ?? []).find(
            (candidate) => candidate.id === collectionId,
          );
          if (!collection) return { error: "圈层不存在" };
          const memberRows = memberships
            .filter((membership) => membership.collectionId === collection.id)
            .map((membership) => {
              const personName = people.get(membership.personId) ?? "未知人物";
              return {
                personRef: archiveHandle(session, "person", membership.personId, personName),
                personName,
              };
            });
          return {
            mode: "collection_members",
            collectionRef,
            name: cleanArchiveText(collection.name, 100),
            ...pageOf(memberRows, cursor, limit),
          };
        }
        const collectionRows = (services.archive.collections ?? []).map((collection) => ({
          collectionRef: archiveHandle(session, "collection", collection.id, collection.name),
          name: cleanArchiveText(collection.name, 100),
          kind: collection.kind,
          color: collection.color,
          memberCount: memberships.filter((membership) => membership.collectionId === collection.id)
            .length,
          createdAt: collection.createdAt,
          updatedAt: collection.updatedAt,
        }));
        return {
          mode: "collection_index",
          hint: "圈层由 collections/memberships 表示，不以 profile.circle 为唯一真相",
          ...pageOf(collectionRows, cursor, limit),
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
      description: "分页读取人物引用与非敏感摘要；关键词未命中时可用它继续浏览。",
      input: cursorSchema,
      permission: "private_read",
      handler: ({ cursor = 0, limit = 12 }, { services, runId }) => {
        const session = referenceSessionFor(services, runId);
        const rows = services.archive.persons
          .slice(cursor, cursor + limit)
          .map((person) => visibleArchivePerson(person, session));
        return {
          ...profileProjection("profile_index"),
          cursor,
          rows,
          returnedCount: rows.length,
          sourceCount: services.archive.persons.length,
          nextCursor:
            cursor + rows.length < services.archive.persons.length ? cursor + rows.length : null,
          total: services.archive.persons.length,
          exhausted: cursor + rows.length >= services.archive.persons.length,
        };
      },
    }),
  )
  .register(
    defineAgentTool({
      name: "search_profiles",
      label: "检索人物档案",
      description:
        "按姓名、别名与档案正文做召回，返回本次运行可用的 personRef。零结果只代表本次检索词未命中。",
      input: querySchema,
      permission: "private_read",
      handler: ({ query, cursor = 0, limit = 8 }, { services, runId }) => {
        const session = referenceSessionFor(services, runId);
        const matches = services.archive.persons
          .map((person) => ({ person, score: archivePersonSearchScore(query, person) }))
          .filter((item) => item.score > 0)
          .sort(
            (left, right) =>
              right.score - left.score ||
              left.person.name.localeCompare(right.person.name, "zh-CN"),
          );
        const page = pageOf(matches, cursor, limit);
        return {
          ...profileProjection("profile_index"),
          query,
          ...page,
          rows: page.rows.map((item) => ({
            ...visibleArchivePerson(item.person, session),
            matchScore: item.score,
          })),
          totalMatches: matches.length,
        };
      },
    }),
  )
  .register(
    defineAgentTool({
      name: "get_profiles",
      label: "读取人物详情",
      description: "按本次运行的 personRef 读取人物详情；不返回联系方式原文、人脸特征或照片。",
      input: personRefsSchema,
      permission: "private_read",
      handler: ({ personRefs }, { services, runId }) => {
        const session = referenceSessionFor(services, runId);
        const personIds = restoreArchiveHandles(session, personRefs, "person");
        return {
          ...profileProjection("profile_detail"),
          rows: services.archive.persons
            .filter((person) => personIds.includes(person.id))
            .map((person) => visibleDetailedArchivePerson(person, session)),
        };
      },
    }),
  )
  .register(
    defineAgentTool({
      name: "get_relationships",
      label: "读取人物关系",
      description:
        "按本次运行的 personRef 读取事实关系和本地派生关系，明确 recordType、语义谓词与支持事实引用。",
      input: personRefsPageSchema,
      permission: "private_read",
      handler: ({ personRefs, cursor = 0, limit = 30 }, { services, runId }) => {
        const session = referenceSessionFor(services, runId);
        const personIds = restoreArchiveHandles(session, personRefs, "person");
        const names = namesOf(services.archive);
        const matches = services.archive.relations.filter(
          (relation) => personIds.includes(relation.fromId) || personIds.includes(relation.toId),
        );
        const page = pageOf(matches, cursor, limit);
        return {
          ...page,
          rows: page.rows.map((relation) => visibleArchiveRelation(relation, names, session)),
        };
      },
    }),
  )
  .register(
    defineAgentTool({
      name: "search_events",
      label: "检索事件",
      description: "按标题、详情、地点、日期或人物名称检索事件并返回本次运行的 eventRef。",
      input: querySchema,
      permission: "private_read",
      handler: ({ query, cursor = 0, limit = 10 }, { services, runId }) => {
        const session = referenceSessionFor(services, runId);
        const names = namesOf(services.archive);
        const term = normalizedSearch(query);
        const matches = services.archive.events.filter((event) =>
          normalizedSearch(JSON.stringify(compactArchiveEvent(event, names))).includes(term),
        );
        const page = pageOf(matches, cursor, limit);
        return {
          query,
          ...page,
          rows: page.rows.map((event) => visibleArchiveEvent(event, names, session)),
          totalMatches: matches.length,
        };
      },
    }),
  )
  .register(
    defineAgentTool({
      name: "search_relations",
      label: "检索关系",
      description: "按人物姓名、关系标签、规范谓词、依据或备注检索关系并返回 relationRef。",
      input: querySchema,
      permission: "private_read",
      handler: ({ query, cursor = 0, limit = 10 }, { services, runId }) => {
        const session = referenceSessionFor(services, runId);
        const names = namesOf(services.archive);
        const term = normalizedSearch(query);
        const matches = services.archive.relations.filter((relation) =>
          normalizedSearch(JSON.stringify(compactArchiveRelation(relation, names))).includes(term),
        );
        const page = pageOf(matches, cursor, limit);
        return {
          query,
          ...page,
          rows: page.rows.map((relation) => visibleArchiveRelation(relation, names, session)),
          totalMatches: matches.length,
        };
      },
    }),
  )
  .register(
    defineAgentTool({
      name: "get_event",
      label: "读取单个事件",
      description: "按本次运行的 eventRef 读取一条事件，供变更前核对。",
      input: eventRefSchema,
      permission: "private_read",
      handler: ({ eventRef }, { services, runId }) => {
        const session = referenceSessionFor(services, runId);
        const eventId = restoreArchiveHandle(session, eventRef, "event");
        const event = services.archive.events.find((candidate) => candidate.id === eventId);
        return event
          ? visibleArchiveEvent(event, namesOf(services.archive), session)
          : { error: "事件不存在" };
      },
    }),
  )
  .register(
    defineAgentTool({
      name: "get_relation",
      label: "读取单个关系",
      description: "按本次运行的 relationRef 读取事实或派生关系，供变更前核对。",
      input: relationRefSchema,
      permission: "private_read",
      handler: ({ relationRef }, { services, runId }) => {
        const session = referenceSessionFor(services, runId);
        const relationId = restoreArchiveHandle(session, relationRef, "relation");
        const relation = services.archive.relations.find(
          (candidate) => candidate.id === relationId,
        );
        return relation
          ? visibleArchiveRelation(relation, namesOf(services.archive), session)
          : { error: "关系不存在" };
      },
    }),
  )
  .register(
    defineAgentTool({
      name: "get_events",
      label: "读取人物事件",
      description: "按 personRef 读取共同事件与 eventRef，供核对或后续变更提案使用。",
      input: personRefsPageSchema,
      permission: "private_read",
      handler: ({ personRefs, cursor = 0, limit = 30 }, { services, runId }) => {
        const session = referenceSessionFor(services, runId);
        const personIds = restoreArchiveHandles(session, personRefs, "person");
        const names = namesOf(services.archive);
        const matches = services.archive.events
          .filter((event) => event.personIds?.some((id) => personIds.includes(id)))
          .slice()
          .sort((left, right) => right.date.localeCompare(left.date));
        const page = pageOf(matches, cursor, limit);
        return {
          ...page,
          rows: page.rows.map((event) => visibleArchiveEvent(event, names, session)),
        };
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
          semanticCandidates: z.array(recommendationSemanticCandidateSchema).max(12).optional(),
          limit: z.number().int().min(1).max(10).optional(),
        })
        .strict(),
      permission: "private_read",
      handler: ({ task, capability, semanticCandidates = [], limit = 5 }, { services, runId }) => {
        const session = referenceSessionFor(services, runId);
        const candidates = capability
          ? rankCapabilityCandidates(
              capability,
              services.archive.persons,
              services.archive.events,
              new Date(),
              semanticCandidates.map((candidate) => ({
                personId: restoreArchiveHandle(session, candidate.personRef, "person"),
                evidenceFields: candidate.evidenceFields,
                reason: candidate.reason,
              })),
            )
          : rankCandidates(task, services.archive.persons, services.archive.events);
        return {
          rankingLocked: true,
          safetyNotice: taskSafetyNotice(task),
          capability,
          rows: candidates
            .slice(0, limit)
            .map((candidate) => visibleRecommendationCandidate(candidate, session)),
          note: capability
            ? "语义候选须逐条命中本地档案事实；词面命中只增加证据分。候选再按证据强度与联系可行性稳定排序。"
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
          targetPersonRef: archiveHandleSchema,
          task: z.string().max(800).optional(),
          maxHops: z.number().int().min(1).max(5).optional(),
          limit: z.number().int().min(1).max(20).optional(),
          includeInferred: z.boolean().optional(),
        })
        .strict(),
      permission: "private_read",
      handler: (
        { targetPersonRef, task = "", maxHops, limit = 5, includeInferred = false },
        { services, runId },
      ) => {
        const session = referenceSessionFor(services, runId);
        const targetPersonId = restoreArchiveHandle(session, targetPersonRef, "person");
        const rows = rankConnectionPaths({
          ...services.archive,
          targetId: targetPersonId,
          task,
          maxHops,
          limit,
          includeInferred,
          includePending: false,
        }).map((candidate) => visibleRecommendationCandidate(candidate, session));
        return {
          targetPersonRef,
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
          targetPersonRef: archiveHandleSchema,
          task: z.string().max(800).optional(),
          limit: z.number().int().min(1).max(20).optional(),
          includeInferred: z.boolean().optional(),
        })
        .strict(),
      permission: "private_read",
      handler: (
        { targetPersonRef, task = "", limit = 5, includeInferred = false },
        { services, runId },
      ) => {
        const session = referenceSessionFor(services, runId);
        const targetPersonId = restoreArchiveHandle(session, targetPersonRef, "person");
        return {
          targetPersonRef,
          accessVerified: false,
          scoreMeaning: "target_side_affinity",
          rows: rankTargetSideEntries({
            ...services.archive,
            targetId: targetPersonId,
            task,
            limit,
            includeInferred,
            includePending: false,
          }).map((candidate) => visibleRecommendationCandidate(candidate, session)),
          note: "这些人只在目标侧有关系证据；不得声称用户已有联系渠道或把分数解释为可达概率。",
        };
      },
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
  "resolve_record_refs",
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
    permissions: ["public_read", "private_read", "network"],
    toolNames: [...ARCHIVE_READ_TOOL_NAMES, ...RECOMMENDATION_TOOL_NAMES, ...PUBLIC_TOOL_NAMES],
  },
  intakeArchive: {
    permissions: ["private_read"],
    toolNames: ARCHIVE_READ_TOOL_NAMES,
  },
  recommendation: {
    permissions: ["public_read", "private_read", "network"],
    toolNames: [...ARCHIVE_READ_TOOL_NAMES, ...RECOMMENDATION_TOOL_NAMES, ...PUBLIC_TOOL_NAMES],
  },
  planning: {
    permissions: ["public_read", "private_read"],
    toolNames: [...ARCHIVE_READ_TOOL_NAMES, "get_datetime"],
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
