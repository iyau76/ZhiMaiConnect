/**
 * Versioned, lossless machine archive contract.
 *
 * `archive@2` separates durable user data from disposable relationship
 * projections.  Presentation exports (Markdown/Word/PDF) must never be used as
 * a restore source; callers should parse this contract and present a restore
 * preview before writing anything to IndexedDB.
 */

import { z } from "zod";
import {
  type CaseEventRecord,
  type CollectionMembershipRecord,
  type CollectionRecord,
  type EvidenceRecord,
  type LifeEventRecord,
  type MeetingBriefRecord,
  type PersonRecord,
  type ProjectRecord,
  type ReferralPolicyRecord,
  type RelationAssertionRecord,
  type RelationEvidenceLinkRecord,
  type RelationViewPreferenceRecord,
  type ReminderRecord,
  type TaskRecord,
} from "./face-db";
import { KINSHIP_PROJECTOR_VERSION, type DerivedRelationshipRecord } from "./kinship-projector";
import { RELATION_PREDICATES, resolveRelationSemantics } from "./relation-ontology";

export const ARCHIVE_V2_SCHEMA = "zhimai-connect/archive@2" as const;
export const LEGACY_ARCHIVE_V1_SCHEMA = "zhimai-connect/archive@1" as const;
export const LEGACY_PROJECTS_V1_SCHEMA = "zhimai-connect/projects@1" as const;

const finiteNumber = z.number().finite();
const timestamp = z.number().int().nonnegative();
const id = z.string().trim().min(1);
const sourceKindSchema = z.enum(["manual", "ai", "camera", "audio", "voice", "import", "web"]);

const provenanceSchema = z
  .object({
    kind: sourceKindSchema,
    detail: z.string().optional(),
    ref: z.string().optional(),
    at: timestamp,
  })
  .strict();

const identitySchema = z
  .object({
    platform: z.string(),
    account: z.string().optional(),
    alias: z.string(),
    validFrom: z.string().optional(),
    validTo: z.string().optional(),
    source: provenanceSchema.optional(),
  })
  .strict();

const personProfileSchema = z
  .object({
    age: z.string().optional(),
    gender: z.string().optional(),
    relation: z.string().optional(),
    title: z.string().optional(),
    department: z.string().optional(),
    org: z.string().optional(),
    projects: z.array(z.string()).optional(),
    reportsTo: z.string().optional(),
    employeeId: z.string().optional(),
    tags: z.array(z.string()).optional(),
    contact: z.string().optional(),
    address: z.string().optional(),
    fingerprintRef: z.string().optional(),
    birthday: z.string().optional(),
    circle: z.string().optional(),
    closeness: finiteNumber.optional(),
    likes: z.array(z.string()).optional(),
    dislikes: z.array(z.string()).optional(),
    gifts: z.array(z.string()).optional(),
    metAt: z.string().optional(),
    identities: z.array(identitySchema).optional(),
    extra: z.record(z.string()).optional(),
    fieldSources: z.record(provenanceSchema).optional(),
  })
  .strict();

// `profile.circle` existed before circles became first-class collections. Keep
// accepting it only at the legacy-import boundary; archive@2 has exactly one
// source of truth: `collections` + `collectionMemberships`.
const archivePersonProfileSchema = personProfileSchema.omit({ circle: true }).strict();

/** Safe-default person record. Photos and face descriptors are not part of it. */
export const archivePersonSchema = z
  .object({
    id,
    name: z.string().trim().min(1),
    note: z.string(),
    profile: archivePersonProfileSchema.optional(),
    rawProfileText: z.string().optional(),
    createdAt: timestamp,
    updatedAt: timestamp.optional(),
    source: provenanceSchema.optional(),
    entityRole: z.enum(["ego", "contact", "placeholder"]).optional(),
    identityScopeId: z.string().optional(),
  })
  .strict();

const relationPredicateSchema = z.enum(RELATION_PREDICATES);
const relationQualifiersSchema = z
  .object({
    parentRole: z.enum(["father", "mother", "parent"]).optional(),
    childRole: z.enum(["son", "daughter", "child"]).optional(),
    sharedParentRole: z.enum(["father", "mother", "parent"]).optional(),
    cousinBranch: z
      .enum(["paternal_uncle", "paternal_aunt", "maternal_uncle", "maternal_aunt", "unspecified"])
      .optional(),
    inverseCousinBranch: z
      .enum(["paternal_uncle", "paternal_aunt", "maternal_uncle", "maternal_aunt", "unspecified"])
      .optional(),
    inLawRole: z
      .enum(["father_in_law", "mother_in_law", "sibling_in_law", "unspecified"])
      .optional(),
    partnerRole: z.enum(["husband", "wife", "concubine", "partner"]).optional(),
    lineage: z.enum(["blood", "step", "clan", "marriage", "unknown"]).optional(),
    temporalStatus: z.enum(["current", "former", "unknown"]).optional(),
    validFrom: z.string().optional(),
    validTo: z.string().optional(),
  })
  .strict();

export const archiveRelationAssertionSchema = z
  .object({
    id,
    recordType: z.literal("assertion"),
    fromId: id,
    toId: id,
    predicate: relationPredicateSchema,
    qualifiers: relationQualifiersSchema,
    label: z.string().trim().min(1),
    direction: z.enum(["ontology", "directed", "symmetric"]),
    note: z.string().optional(),
    evidence: z
      .object({
        mode: z.enum(["manual", "source_claim", "legacy_unknown"]),
        basis: z.string().optional(),
        sourceIds: z.array(id),
      })
      .strict(),
    validity: z
      .object({
        status: z.enum(["active", "ended", "unknown"]),
        validFrom: z.string().optional(),
        validTo: z.string().optional(),
      })
      .strict(),
    confidence: finiteNumber.min(0).max(1).optional(),
    confirmationStatus: z.enum(["pending", "confirmed", "rejected"]),
    createdAt: timestamp,
    updatedAt: timestamp,
    supersedesAssertionId: id.optional(),
    source: provenanceSchema.optional(),
  })
  .strict();

const relationEvidenceLinkSchema = z
  .object({
    id,
    assertionId: id,
    evidenceId: id,
    excerpt: z.string().optional(),
    createdAt: timestamp,
  })
  .strict();

const relationViewPreferenceSchema = z
  .object({
    id,
    subjectId: id,
    visibility: z.enum(["always", "auto", "hidden"]),
    updatedAt: timestamp,
  })
  .strict();

const referralPolicySchema = z
  .object({
    id,
    subjectId: id,
    policy: z.enum(["allow", "avoid", "block"]),
    direction: z.enum(["both", "from_to", "to_from"]),
    contexts: z.array(z.string()),
    updatedAt: timestamp,
  })
  .strict();

const collectionSchema = z
  .object({
    id,
    name: z.string().trim().min(1),
    kind: z.enum(["relationship_circle", "context", "computed_community"]),
    color: z.string().optional(),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .strict();

const collectionMembershipSchema = z
  .object({
    id,
    collectionId: id,
    personId: id,
    source: z.enum(["manual", "ai_approved", "migration", "computed"]),
    createdAt: timestamp,
  })
  .strict();

/** Safe-default evidence record. Embedded image thumbnails are omitted. */
const evidenceSchema = z
  .object({
    id,
    kind: z.enum(["audio", "note", "exhibit", "frame"]),
    title: z.string(),
    text: z.string(),
    origin: z.string().optional(),
    uploader: z.string().optional(),
    entities: z
      .array(z.object({ type: z.string(), value: z.string(), personId: id.optional() }).strict())
      .optional(),
    linkedPersonIds: z.array(id).optional(),
    speechVariant: z.string().optional(),
    createdAt: timestamp,
    source: provenanceSchema.optional(),
  })
  .strict();

const caseEventSchema = z
  .object({
    id,
    at: timestamp,
    endAt: timestamp.optional(),
    title: z.string(),
    detail: z.string().optional(),
    place: z.string().optional(),
    certainty: z.enum(["fact", "inferred"]).optional(),
    personIds: z.array(id).optional(),
    evidenceIds: z.array(id).optional(),
    createdAt: timestamp,
    source: provenanceSchema.optional(),
  })
  .strict();

const taskSchema = z
  .object({
    id,
    title: z.string(),
    detail: z.string().optional(),
    assignee: z.string().optional(),
    personIds: z.array(id).optional(),
    priority: z.enum(["high", "normal", "low"]),
    status: z.enum(["todo", "doing", "done"]),
    due: z.string().optional(),
    createdAt: timestamp,
    source: provenanceSchema.optional(),
  })
  .strict();

const projectSchema = z
  .object({
    id,
    title: z.string(),
    detail: z.string().optional(),
    department: z.string().optional(),
    ownerId: id.nullable().optional(),
    ownerName: z.string().optional(),
    memberIds: z.array(id).optional(),
    status: z.enum(["planned", "active", "blocked", "done"]),
    priority: z.enum(["high", "normal", "low"]),
    due: z.string().optional(),
    tags: z.array(z.string()).optional(),
    createdAt: timestamp,
    updatedAt: timestamp.optional(),
    source: provenanceSchema.optional(),
  })
  .strict();

/** Safe-default life event. Embedded photos are omitted. */
const lifeEventSchema = z
  .object({
    id,
    date: z.string(),
    dateEnd: z.string().optional(),
    precision: z.enum(["day", "month", "year", "range"]).optional(),
    dateText: z.string().optional(),
    timeText: z.string().max(500).optional(),
    title: z.string(),
    detail: z.string().optional(),
    place: z.string().optional(),
    personIds: z.array(id).optional(),
    kind: z.string().optional(),
    createdAt: timestamp,
    updatedAt: timestamp.optional(),
    source: provenanceSchema.optional(),
  })
  .strict();

const reminderSchema = z
  .object({
    id,
    title: z.string(),
    detail: z.string().optional(),
    due: z.string().optional(),
    personIds: z.array(id).optional(),
    kind: z.enum(["birthday", "festival", "gift", "custom"]).optional(),
    done: z.boolean(),
    completionEventId: id.optional(),
    createdAt: timestamp,
    source: provenanceSchema.optional(),
  })
  .strict();

const meetingBriefSourceRefSchema = z
  .object({
    kind: z.enum([
      "person",
      "relation_assertion",
      "relation_projection",
      "event",
      "reminder",
      "task",
    ]),
    id,
    revision: z.string(),
  })
  .strict();

const meetingBriefLineSchema = z
  .object({
    text: z.string(),
    sources: z.array(meetingBriefSourceRefSchema),
  })
  .strict();

const meetingBriefSchema = z
  .object({
    id,
    seriesId: id,
    supersedesBriefId: id.optional(),
    personId: id,
    personName: z.string(),
    title: z.string(),
    sourceRevision: z.string(),
    sourceRefs: z.array(meetingBriefSourceRefSchema),
    content: z
      .object({
        profile: z.array(meetingBriefLineSchema),
        recentEvents: z.array(meetingBriefLineSchema),
        openItems: z.array(meetingBriefLineSchema),
        relatedPeople: z.array(meetingBriefLineSchema),
        talkingPoints: z.array(meetingBriefLineSchema),
        gaps: z.array(z.string()),
      })
      .strict(),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .strict();

const derivedRelationSchema = z
  .object({
    id,
    recordType: z.literal("derived"),
    fromId: id,
    toId: id,
    predicate: relationPredicateSchema,
    qualifiers: relationQualifiersSchema,
    label: z.string(),
    confidence: finiteNumber.min(0).max(1),
    ruleId: z.string(),
    ruleVersion: z.number().int().nonnegative(),
    supportingRelationIds: z.array(id),
    explanation: z.string(),
  })
  .strict();

const omissionSchema = z
  .object({
    category: z.enum(["photos", "biometrics", "credentials", "runtime_private_data"]),
    paths: z.array(z.string()).min(1),
    policy: z.enum(["excluded-by-default", "never-read-never-export"]),
    omittedRecordCount: z.number().int().nonnegative().optional(),
  })
  .strict();

export const archiveV2Schema = z
  .object({
    schema: z.literal(ARCHIVE_V2_SCHEMA),
    exportedAt: z.string().datetime({ offset: true }),
    generator: z
      .object({
        app: z.literal("zhimai-connect"),
        appVersion: z.string(),
        dataModelVersion: z.union([z.literal(11), z.literal(12), z.literal(13)]),
      })
      .strict(),
    privacy: z
      .object({
        mode: z.literal("safe-default"),
        containsPrivateText: z.literal(true),
        warning: z.string().min(1),
        omissions: z.array(omissionSchema).min(4),
      })
      .strict(),
    records: z
      .object({
        persons: z.array(archivePersonSchema),
        relationAssertions: z.array(archiveRelationAssertionSchema),
        relationEvidenceLinks: z.array(relationEvidenceLinkSchema),
        relationViewPreferences: z.array(relationViewPreferenceSchema),
        referralPolicies: z.array(referralPolicySchema),
        collections: z.array(collectionSchema),
        collectionMemberships: z.array(collectionMembershipSchema),
        evidence: z.array(evidenceSchema),
        caseEvents: z.array(caseEventSchema),
        tasks: z.array(taskSchema),
        projects: z.array(projectSchema),
        lifeEvents: z.array(lifeEventSchema),
        reminders: z.array(reminderSchema),
        meetingBriefs: z.array(meetingBriefSchema).default([]),
      })
      .strict(),
    projectionDiagnostics: z
      .object({
        importPolicy: z.literal("discard-and-rebuild"),
        projectorVersion: z.number().int().nonnegative(),
        derivedRelations: z.array(derivedRelationSchema),
      })
      .strict(),
  })
  .strict();

export type ArchiveV2 = z.infer<typeof archiveV2Schema>;
export type ArchivePersonRecord = z.infer<typeof archivePersonSchema>;

export interface ArchiveV2Source {
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
  meetingBriefs: MeetingBriefRecord[];
}

export interface ArchiveNormalizationResult {
  archive: ArchiveV2;
  sourceSchema:
    typeof ARCHIVE_V2_SCHEMA | typeof LEGACY_ARCHIVE_V1_SCHEMA | typeof LEGACY_PROJECTS_V1_SCHEMA;
  warnings: string[];
}

export interface ArchiveRestorePlan {
  sourceSchema: ArchiveNormalizationResult["sourceSchema"];
  warnings: string[];
  privacy: ArchiveV2["privacy"];
  /** Restore code writes only these durable records. */
  records: ArchiveV2["records"];
  /** Projection snapshots are never facts and are always rebuilt locally. */
  rebuildDerivedRelations: true;
  discardedProjectionCount: number;
}

export class ArchiveValidationError extends Error {
  constructor(
    message: string,
    readonly issues: string[] = [],
  ) {
    super(message);
    this.name = "ArchiveValidationError";
  }
}

function stripPerson(person: PersonRecord): ArchivePersonRecord {
  const { descriptors: _descriptors, thumb: _thumb, photos: _photos, ...safe } = person;
  if (!safe.profile) return safe;
  const { circle: _legacyCircle, ...profile } = safe.profile;
  return { ...safe, profile };
}

function stripEvidence(record: EvidenceRecord) {
  const { thumb: _thumb, ...safe } = record;
  return safe;
}

function stripLifeEvent(record: LifeEventRecord) {
  const { photos: _photos, ...safe } = record;
  return safe;
}

function omittedCounts(source: ArchiveV2Source) {
  return {
    photos:
      source.persons.reduce((sum, person) => sum + (person.photos?.length ?? 0), 0) +
      source.lifeEvents.reduce((sum, event) => sum + (event.photos?.length ?? 0), 0) +
      source.evidence.filter((record) => Boolean(record.thumb)).length,
    biometrics:
      source.persons.reduce((sum, person) => sum + person.descriptors.length, 0) +
      source.persons.filter((person) => Boolean(person.thumb)).length,
  };
}

function privacyManifest(source: ArchiveV2Source): ArchiveV2["privacy"] {
  const counts = omittedCounts(source);
  return {
    mode: "safe-default",
    containsPrivateText: true,
    warning: "此备份包含人物档案、关系依据、联系方式及事务正文，请按敏感个人数据保管。",
    omissions: [
      {
        category: "photos",
        paths: [
          "records.persons[].photos",
          "records.lifeEvents[].photos",
          "records.evidence[].thumb",
        ],
        policy: "excluded-by-default",
        omittedRecordCount: counts.photos,
      },
      {
        category: "biometrics",
        paths: [
          "records.persons[].descriptors",
          "records.persons[].thumb",
          "IndexedDB.sightings",
          "IndexedDB.voiceprints",
        ],
        policy: "excluded-by-default",
        omittedRecordCount: counts.biometrics,
      },
      {
        category: "credentials",
        paths: ["provider API keys", "session credentials", "environment variables"],
        policy: "never-read-never-export",
      },
      {
        category: "runtime_private_data",
        paths: ["agent run logs", "session drafts", "browser configuration"],
        policy: "never-read-never-export",
      },
    ],
  };
}

function duplicateIssues(label: string, rows: Array<{ id: string }>) {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.id)) duplicates.add(row.id);
    seen.add(row.id);
  }
  return [...duplicates].map((value) => `${label} 存在重复 id：${value}`);
}

function missingRefIssues(
  label: string,
  ownerId: string,
  refs: readonly string[] | undefined,
  valid: ReadonlySet<string>,
) {
  return (refs ?? [])
    .filter((ref) => !valid.has(ref))
    .map((ref) => `${label} ${ownerId} 引用了不存在的 id：${ref}`);
}

/** Validate referential integrity after Zod has validated every record shape. */
export function assertArchiveIntegrity(archive: ArchiveV2) {
  const { records } = archive;
  const issues = [
    ...duplicateIssues("persons", records.persons),
    ...duplicateIssues("relationAssertions", records.relationAssertions),
    ...duplicateIssues("relationEvidenceLinks", records.relationEvidenceLinks),
    ...duplicateIssues("relationViewPreferences", records.relationViewPreferences),
    ...duplicateIssues("referralPolicies", records.referralPolicies),
    ...duplicateIssues("collections", records.collections),
    ...duplicateIssues("collectionMemberships", records.collectionMemberships),
    ...duplicateIssues("evidence", records.evidence),
    ...duplicateIssues("caseEvents", records.caseEvents),
    ...duplicateIssues("tasks", records.tasks),
    ...duplicateIssues("projects", records.projects),
    ...duplicateIssues("lifeEvents", records.lifeEvents),
    ...duplicateIssues("reminders", records.reminders),
    ...duplicateIssues("meetingBriefs", records.meetingBriefs),
    ...duplicateIssues(
      "projectionDiagnostics.derivedRelations",
      archive.projectionDiagnostics.derivedRelations,
    ),
  ];
  const omissionCategories = archive.privacy.omissions.map((item) => item.category);
  const requiredOmissionCategories = [
    "photos",
    "biometrics",
    "credentials",
    "runtime_private_data",
  ];
  const omissionCategorySet = new Set<string>(omissionCategories);
  if (
    omissionCategorySet.size !== requiredOmissionCategories.length ||
    requiredOmissionCategories.some((category) => !omissionCategorySet.has(category))
  ) {
    issues.push(
      "privacy.omissions 必须且只能声明 photos、biometrics、credentials、runtime_private_data",
    );
  }
  const personIds = new Set(records.persons.map((person) => person.id));
  const assertionIds = new Set(records.relationAssertions.map((assertion) => assertion.id));
  const assertionById = new Map(
    records.relationAssertions.map((assertion) => [assertion.id, assertion]),
  );
  const evidenceIds = new Set(records.evidence.map((record) => record.id));
  const lifeEventIds = new Set(records.lifeEvents.map((record) => record.id));
  const collectionIds = new Set(records.collections.map((collection) => collection.id));
  const derivedIds = new Set(
    archive.projectionDiagnostics.derivedRelations.map((relation) => relation.id),
  );
  const relationSubjectIds = new Set([...assertionIds, ...derivedIds]);
  const evidenceLinkPairs = new Set(
    records.relationEvidenceLinks.map((link) => `${link.assertionId}\u0000${link.evidenceId}`),
  );

  for (const assertion of records.relationAssertions) {
    if (assertion.fromId === assertion.toId)
      issues.push(`relationAssertions ${assertion.id} 不能连接人物自身`);
    issues.push(
      ...missingRefIssues(
        "relationAssertions.person",
        assertion.id,
        [assertion.fromId, assertion.toId],
        personIds,
      ),
      ...missingRefIssues(
        "relationAssertions.evidence",
        assertion.id,
        assertion.evidence.sourceIds,
        evidenceIds,
      ),
    );
    if (assertion.supersedesAssertionId && !assertionIds.has(assertion.supersedesAssertionId))
      issues.push(
        `relationAssertions ${assertion.id} supersedes 不存在的 assertion：${assertion.supersedesAssertionId}`,
      );
    for (const evidenceId of assertion.evidence.sourceIds) {
      if (!evidenceLinkPairs.has(`${assertion.id}\u0000${evidenceId}`))
        issues.push(
          `relationAssertions ${assertion.id} 的 evidence.sourceIds 缺少对应 evidenceLink：${evidenceId}`,
        );
    }
  }
  for (const link of records.relationEvidenceLinks) {
    issues.push(
      ...missingRefIssues(
        "relationEvidenceLinks.assertion",
        link.id,
        [link.assertionId],
        assertionIds,
      ),
      ...missingRefIssues(
        "relationEvidenceLinks.evidence",
        link.id,
        [link.evidenceId],
        evidenceIds,
      ),
    );
    const assertion = assertionById.get(link.assertionId);
    if (assertion && !assertion.evidence.sourceIds.includes(link.evidenceId))
      issues.push(
        `relationEvidenceLinks ${link.id} 未出现在 assertion.evidence.sourceIds：${link.evidenceId}`,
      );
  }
  for (const preference of records.relationViewPreferences)
    issues.push(
      ...missingRefIssues(
        "relationViewPreferences.subject",
        preference.id,
        [preference.subjectId],
        relationSubjectIds,
      ),
    );
  for (const policy of records.referralPolicies)
    issues.push(
      ...missingRefIssues(
        "referralPolicies.subject",
        policy.id,
        [policy.subjectId],
        relationSubjectIds,
      ),
    );
  for (const membership of records.collectionMemberships) {
    issues.push(
      ...missingRefIssues(
        "collectionMemberships.collection",
        membership.id,
        [membership.collectionId],
        collectionIds,
      ),
      ...missingRefIssues(
        "collectionMemberships.person",
        membership.id,
        [membership.personId],
        personIds,
      ),
    );
  }
  for (const record of records.evidence) {
    issues.push(
      ...missingRefIssues("evidence.linkedPersonIds", record.id, record.linkedPersonIds, personIds),
      ...missingRefIssues(
        "evidence.entities.personId",
        record.id,
        record.entities?.flatMap((entity) => (entity.personId ? [entity.personId] : [])),
        personIds,
      ),
    );
  }
  for (const record of records.caseEvents) {
    issues.push(
      ...missingRefIssues("caseEvents.personIds", record.id, record.personIds, personIds),
      ...missingRefIssues("caseEvents.evidenceIds", record.id, record.evidenceIds, evidenceIds),
    );
  }
  for (const record of records.tasks)
    issues.push(...missingRefIssues("tasks.personIds", record.id, record.personIds, personIds));
  for (const record of records.projects) {
    issues.push(
      ...missingRefIssues(
        "projects.ownerId",
        record.id,
        record.ownerId ? [record.ownerId] : [],
        personIds,
      ),
      ...missingRefIssues("projects.memberIds", record.id, record.memberIds, personIds),
    );
  }
  for (const record of records.lifeEvents)
    issues.push(
      ...missingRefIssues("lifeEvents.personIds", record.id, record.personIds, personIds),
    );
  for (const record of records.reminders) {
    issues.push(
      ...missingRefIssues("reminders.personIds", record.id, record.personIds, personIds),
      ...missingRefIssues(
        "reminders.completionEventId",
        record.id,
        record.completionEventId ? [record.completionEventId] : [],
        lifeEventIds,
      ),
    );
  }
  for (const record of records.meetingBriefs) {
    issues.push(
      ...missingRefIssues("meetingBriefs.personId", record.id, [record.personId], personIds),
    );
  }

  if (issues.length) throw new ArchiveValidationError("备份引用完整性校验失败", issues);
}

export function createArchiveV2(
  source: ArchiveV2Source,
  options: { exportedAt?: string; appVersion?: string } = {},
): ArchiveV2 {
  const candidate = {
    schema: ARCHIVE_V2_SCHEMA,
    exportedAt: options.exportedAt ?? new Date().toISOString(),
    generator: {
      app: "zhimai-connect",
      appVersion: options.appVersion ?? "0.1.0",
      dataModelVersion: 13,
    },
    privacy: privacyManifest(source),
    records: {
      persons: source.persons.map(stripPerson),
      relationAssertions: source.relationAssertions,
      relationEvidenceLinks: source.relationEvidenceLinks,
      relationViewPreferences: source.relationViewPreferences,
      referralPolicies: source.referralPolicies,
      collections: source.collections,
      collectionMemberships: source.collectionMemberships,
      evidence: source.evidence.map(stripEvidence),
      caseEvents: source.caseEvents,
      tasks: source.tasks,
      projects: source.projects,
      lifeEvents: source.lifeEvents.map(stripLifeEvent),
      reminders: source.reminders,
      meetingBriefs: source.meetingBriefs,
    },
    projectionDiagnostics: {
      importPolicy: "discard-and-rebuild",
      projectorVersion: KINSHIP_PROJECTOR_VERSION,
      derivedRelations: source.derivedRelations,
    },
  };
  const parsed = archiveV2Schema.parse(candidate);
  assertArchiveIntegrity(parsed);
  return parsed;
}

const photoNoteSchema = z
  .object({ id, dataUrl: z.string(), caption: z.string().optional(), addedAt: timestamp })
  .strict();
const legacyPersonSchema = archivePersonSchema
  .extend({
    profile: personProfileSchema.optional(),
    descriptors: z.array(z.array(finiteNumber)).optional().default([]),
    thumb: z.string().optional().default(""),
    photos: z.array(photoNoteSchema).optional(),
  })
  .strict();
const legacyRelationSchema = z
  .object({
    id,
    fromId: id,
    toId: id,
    label: z.string().trim().min(1),
    mutual: z.boolean().optional(),
    note: z.string().optional(),
    basis: z.string().optional(),
    sourceId: z.string().optional(),
    createdAt: timestamp,
    updatedAt: timestamp.optional(),
    confirmationStatus: z.enum(["pending", "confirmed", "rejected"]).optional(),
    evidenceMode: z.enum(["explicit", "inferred", "unknown"]).optional(),
    confidence: finiteNumber.min(0).max(1).optional(),
    visibility: z.enum(["always", "auto", "hidden"]).optional(),
    recommendationPolicy: z.enum(["allow", "avoid", "block"]).optional(),
    semanticKind: z.string().optional(),
    derivedFromRelationIds: z.array(id).optional(),
    source: provenanceSchema.optional(),
    recordType: z.enum(["assertion", "derived"]).optional(),
    predicate: relationPredicateSchema.optional(),
    qualifiers: relationQualifiersSchema.optional(),
    ruleId: z.string().optional(),
    ruleVersion: z.number().int().nonnegative().optional(),
    supportingRelationIds: z.array(id).optional(),
  })
  .strict();
const legacyLifeEventSchema = lifeEventSchema
  .extend({ photos: z.array(photoNoteSchema).optional() })
  .strict();

const legacyArchiveV1Schema = z
  .object({
    schema: z.literal(LEGACY_ARCHIVE_V1_SCHEMA),
    exportedAt: z.string().datetime({ offset: true }),
    persons: z.array(legacyPersonSchema),
    relations: z.array(legacyRelationSchema),
    lifeEvents: z.array(legacyLifeEventSchema),
    reminders: z.array(reminderSchema),
  })
  .strict();

const legacyProjectsV1Schema = z
  .object({
    schema: z.literal(LEGACY_PROJECTS_V1_SCHEMA),
    exportedAt: z.string().datetime({ offset: true }),
    persons: z.array(legacyPersonSchema),
    projects: z.array(projectSchema),
  })
  .strict();

function legacyIsDerived(relation: z.infer<typeof legacyRelationSchema>) {
  const basis = relation.basis?.trim() ?? "";
  return (
    relation.recordType === "derived" ||
    relation.evidenceMode === "inferred" ||
    Boolean(relation.derivedFromRelationIds?.length) ||
    /^推断依据\s*[:：]|^inference\s+basis\s*[:：]/i.test(basis)
  );
}

function legacySemantics(relation: z.infer<typeof legacyRelationSchema>) {
  return resolveRelationSemantics(relation);
}

function legacyAssertion(relation: z.infer<typeof legacyRelationSchema>): RelationAssertionRecord {
  const { predicate, qualifiers } = legacySemantics(relation);
  const updatedAt = relation.updatedAt ?? relation.createdAt;
  const explicitBasis = /^原文\s*[:：]|^original\s*[:：]/i.test(relation.basis?.trim() ?? "");
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
        relation.sourceId || explicitBasis
          ? "source_claim"
          : relation.source?.kind === "manual"
            ? "manual"
            : "legacy_unknown",
      basis: relation.basis,
      // @1 did not export the evidence table, so sourceId cannot safely become
      // a referential evidence link. Basis/source remain available for review.
      sourceIds: [],
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

function legacyDerived(relation: z.infer<typeof legacyRelationSchema>): DerivedRelationshipRecord {
  const { predicate, qualifiers } = legacySemantics(relation);
  return {
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
    supportingRelationIds: relation.supportingRelationIds ?? relation.derivedFromRelationIds ?? [],
    explanation: relation.basis || relation.note || "旧版推导快照，仅供诊断",
  };
}

function migratedPersons(persons: Array<z.infer<typeof legacyPersonSchema>>): PersonRecord[] {
  return persons.map((person) => {
    const { descriptors, thumb, photos, ...safe } = person;
    return {
      ...safe,
      descriptors,
      thumb,
      photos,
      entityRole:
        safe.entityRole ??
        (safe.id === "zhimai:self" || safe.name.trim() === "我" ? "ego" : "contact"),
    };
  });
}

function migratedLegacyCollections(persons: PersonRecord[]) {
  const collections = new Map<string, CollectionRecord>();
  const memberships: CollectionMembershipRecord[] = [];
  for (const person of persons) {
    const circle = person.profile?.circle?.trim();
    if (!circle) continue;
    const collectionId = `legacy-circle:${encodeURIComponent(circle)}`;
    const updatedAt = person.updatedAt ?? person.createdAt;
    const existing = collections.get(collectionId);
    collections.set(collectionId, {
      id: collectionId,
      name: circle,
      kind: "relationship_circle",
      createdAt: Math.min(existing?.createdAt ?? person.createdAt, person.createdAt),
      updatedAt: Math.max(existing?.updatedAt ?? updatedAt, updatedAt),
    });
    memberships.push({
      id: `${collectionId}\u0000${person.id}`,
      collectionId,
      personId: person.id,
      source: "migration",
      createdAt: updatedAt,
    });
  }
  return { collections: [...collections.values()], memberships };
}

function emptySource(persons: PersonRecord[]): ArchiveV2Source {
  return {
    persons,
    relationAssertions: [],
    derivedRelations: [],
    relationEvidenceLinks: [],
    relationViewPreferences: [],
    referralPolicies: [],
    collections: [],
    collectionMemberships: [],
    evidence: [],
    caseEvents: [],
    tasks: [],
    projects: [],
    lifeEvents: [],
    reminders: [],
    meetingBriefs: [],
  };
}

function migrateArchiveV1(raw: z.infer<typeof legacyArchiveV1Schema>) {
  const persons = migratedPersons(raw.persons);
  const source = emptySource(persons);
  const derivedRelations: DerivedRelationshipRecord[] = [];
  let missingEvidenceLinks = 0;
  for (const relation of raw.relations) {
    if (legacyIsDerived(relation)) derivedRelations.push(legacyDerived(relation));
    else source.relationAssertions.push(legacyAssertion(relation));
    if (relation.sourceId) missingEvidenceLinks += 1;
    source.relationViewPreferences.push({
      id: relation.id,
      subjectId: relation.id,
      visibility: relation.visibility ?? "auto",
      updatedAt: relation.updatedAt ?? relation.createdAt,
    });
    source.referralPolicies.push({
      id: relation.id,
      subjectId: relation.id,
      policy: relation.recommendationPolicy ?? "allow",
      direction: "both",
      contexts: [],
      updatedAt: relation.updatedAt ?? relation.createdAt,
    });
  }
  const legacyCollections = migratedLegacyCollections(persons);
  source.collections = legacyCollections.collections;
  source.collectionMemberships = legacyCollections.memberships;
  source.lifeEvents = raw.lifeEvents;
  source.reminders = raw.reminders;
  source.derivedRelations = derivedRelations;
  const archive = createArchiveV2(source, { exportedAt: raw.exportedAt });
  const warnings = [
    `已把 ${derivedRelations.length} 条旧版推导关系保留为诊断快照；恢复时不会写成事实。`,
  ];
  if (missingEvidenceLinks)
    warnings.push(
      `旧 @1 文件未包含 evidence 表，${missingEvidenceLinks} 个 sourceId 不能恢复为证据链接；关系 basis/source 已保留。`,
    );
  return { archive, warnings };
}

function migrateProjectsV1(raw: z.infer<typeof legacyProjectsV1Schema>) {
  const persons = migratedPersons(raw.persons);
  const source = emptySource(persons);
  const legacyCollections = migratedLegacyCollections(persons);
  source.collections = legacyCollections.collections;
  source.collectionMemberships = legacyCollections.memberships;
  source.projects = raw.projects;
  return {
    archive: createArchiveV2(source, { exportedAt: raw.exportedAt }),
    warnings: ["旧 projects@1 只包含人物与项目；关系、证据、事件和提醒在原文件中不存在。"],
  };
}

function parseJson(input: string | unknown) {
  if (typeof input !== "string") return input;
  try {
    return JSON.parse(input) as unknown;
  } catch (error) {
    throw new ArchiveValidationError(`备份不是有效 JSON：${(error as Error).message}`);
  }
}

function zodMessage(error: z.ZodError) {
  return error.issues.map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`);
}

/** Parse @2 or migrate an app-generated @1 backup into the @2 in-memory contract. */
export function normalizeArchive(input: string | unknown): ArchiveNormalizationResult {
  const raw = parseJson(input);
  if (!raw || typeof raw !== "object" || !("schema" in raw))
    throw new ArchiveValidationError("文件不是知脉 Connect 机器备份：缺少 schema");
  const schema = (raw as { schema?: unknown }).schema;
  try {
    if (schema === ARCHIVE_V2_SCHEMA) {
      const archive = archiveV2Schema.parse(raw);
      assertArchiveIntegrity(archive);
      return { archive, sourceSchema: ARCHIVE_V2_SCHEMA, warnings: [] };
    }
    if (schema === LEGACY_ARCHIVE_V1_SCHEMA) {
      const migrated = migrateArchiveV1(legacyArchiveV1Schema.parse(raw));
      assertArchiveIntegrity(migrated.archive);
      return { ...migrated, sourceSchema: LEGACY_ARCHIVE_V1_SCHEMA };
    }
    if (schema === LEGACY_PROJECTS_V1_SCHEMA) {
      const migrated = migrateProjectsV1(legacyProjectsV1Schema.parse(raw));
      assertArchiveIntegrity(migrated.archive);
      return { ...migrated, sourceSchema: LEGACY_PROJECTS_V1_SCHEMA };
    }
  } catch (error) {
    if (error instanceof ArchiveValidationError) throw error;
    if (error instanceof z.ZodError)
      throw new ArchiveValidationError("备份结构校验失败", zodMessage(error));
    throw error;
  }
  throw new ArchiveValidationError(`不支持的备份 schema：${String(schema)}`);
}

/**
 * Produce a restore plan. Importers must ignore the diagnostic projection and
 * ask the local projector to rebuild it from confirmed assertions.
 */
export function archiveRestorePlan(input: string | unknown): ArchiveRestorePlan {
  const { archive, sourceSchema, warnings } = normalizeArchive(input);
  return {
    sourceSchema,
    warnings,
    privacy: archive.privacy,
    records: archive.records,
    rebuildDerivedRelations: true,
    discardedProjectionCount: archive.projectionDiagnostics.derivedRelations.length,
  };
}
