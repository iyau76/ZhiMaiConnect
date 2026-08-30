import { z } from "zod";

import {
  facesDb,
  type ArchiveMutationWriteBatch,
  type CaseEventRecord,
  type CollectionMembershipRecord,
  type CollectionRecord,
  type EvidenceRecord,
  type LifeEventRecord,
  type PersonProfile,
  type PersonRecord,
  type ProjectRecord,
  type ReferralPolicyRecord,
  type RelationAssertionRecord,
  type RelationEvidenceLinkRecord,
  type RelationViewPreferenceRecord,
  type ReminderRecord,
  type TaskRecord,
} from "./face-db";
import type { DerivedRelationshipRecord } from "./kinship-projector";
import {
  RELATION_PREDICATES,
  relationIsSymmetric,
  type RelationQualifiers,
} from "./relation-ontology";

const targetIdSchema = z.string().min(1).max(200);
const reasonSchema = z.string().trim().min(1).max(1_000);
const revisionSchema = z.string().regex(/^r1:[0-9a-f]{8}$/);
const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "日期必须为 YYYY-MM-DD");
const preconditionSchema = z.object({ expectedRevision: revisionSchema }).strict();

const PROFILE_TEXT_FIELDS = [
  "age",
  "gender",
  "relation",
  "title",
  "department",
  "org",
  "reportsTo",
  "employeeId",
  "contact",
  "address",
  "fingerprintRef",
  "birthday",
  "metAt",
] as const;
const PROFILE_LIST_FIELDS = ["projects", "tags", "likes", "dislikes", "gifts"] as const;
const PERSON_UNSET_FIELDS = [
  "profile.age",
  "profile.gender",
  "profile.relation",
  "profile.title",
  "profile.department",
  "profile.org",
  "profile.reportsTo",
  "profile.employeeId",
  "profile.contact",
  "profile.address",
  "profile.fingerprintRef",
  "profile.birthday",
  "profile.metAt",
  "profile.projects",
  "profile.tags",
  "profile.likes",
  "profile.dislikes",
  "profile.gifts",
  "profile.closeness",
  "profile.extra",
] as const;
const PERSON_CLEAR_FIELDS = [
  "note",
  "profile.projects",
  "profile.tags",
  "profile.likes",
  "profile.dislikes",
  "profile.gifts",
] as const;

const shortText = z.string().trim().min(1).max(500);
const textList = z.array(z.string().trim().min(1).max(120)).max(30);
const profileSetSchema = z
  .object({
    age: shortText.optional(),
    gender: shortText.optional(),
    relation: shortText.optional(),
    title: shortText.optional(),
    department: shortText.optional(),
    org: shortText.optional(),
    reportsTo: shortText.optional(),
    employeeId: shortText.optional(),
    contact: shortText.optional(),
    address: shortText.optional(),
    fingerprintRef: shortText.optional(),
    birthday: shortText.optional(),
    metAt: shortText.optional(),
    projects: textList.optional(),
    tags: textList.optional(),
    likes: textList.optional(),
    dislikes: textList.optional(),
    gifts: textList.optional(),
    closeness: z.number().int().min(1).max(5).optional(),
    extra: z.record(z.string().trim().min(1).max(100), z.string().max(2_000)).optional(),
  })
  .strict();

export const personMutationPatchSchema = z
  .object({
    set: z
      .object({
        name: z.string().trim().min(1).max(200).optional(),
        note: z.string().max(4_000).optional(),
        profile: profileSetSchema.optional(),
      })
      .strict()
      .optional(),
    unset: z.array(z.enum(PERSON_UNSET_FIELDS)).max(PERSON_UNSET_FIELDS.length).optional(),
    clear: z.array(z.enum(PERSON_CLEAR_FIELDS)).max(PERSON_CLEAR_FIELDS.length).optional(),
  })
  .strict()
  .superRefine((patch, context) => {
    const setPaths = new Set<string>([
      ...(patch.set?.name !== undefined ? ["name"] : []),
      ...(patch.set?.note !== undefined ? ["note"] : []),
      ...Object.keys(patch.set?.profile ?? {}).map((field) => `profile.${field}`),
    ]);
    const unset = new Set(patch.unset ?? []);
    const clear = new Set(patch.clear ?? []);
    if (!setPaths.size && !unset.size && !clear.size) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "人物修改不能为空" });
    }
    for (const path of setPaths) {
      if (unset.has(path as never) || clear.has(path as never)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `字段 ${path} 不能同时 set/unset/clear`,
        });
      }
    }
    for (const path of unset) {
      if (clear.has(path as never)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `字段 ${path} 不能同时 unset/clear`,
        });
      }
    }
  });

const qualifierSchema = z
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
  })
  .strict();

export const relationReplacementSchema = z
  .object({
    label: z.string().trim().min(1).max(300),
    predicate: z.enum(RELATION_PREDICATES),
    qualifiers: qualifierSchema,
    direction: z.enum(["ontology", "directed", "symmetric"]),
    note: z.string().max(4_000).nullable(),
    evidence: z
      .object({
        mode: z.enum(["manual", "source_claim", "legacy_unknown"]),
        basis: z.string().max(2_000).nullable(),
        sourceIds: z.array(targetIdSchema).max(30),
      })
      .strict(),
    validity: z
      .object({
        status: z.enum(["active", "ended", "unknown"]),
        validFrom: z.string().trim().min(1).max(40).nullable(),
        validTo: z.string().trim().min(1).max(40).nullable(),
      })
      .strict(),
    confidence: z.number().min(0).max(1).nullable(),
    /** Applying the plan is the user's confirmation boundary. */
    confirmationStatus: z.literal("confirmed"),
  })
  .strict()
  .superRefine((replacement, context) => {
    if (replacement.direction === "ontology" && replacement.predicate === "custom") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "custom 关系必须明确 directed 或 symmetric",
      });
    }
    if (
      replacement.direction === "symmetric" &&
      replacement.predicate !== "custom" &&
      !relationIsSymmetric(replacement.predicate)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${replacement.predicate} 在本体中不是对称关系`,
      });
    }
  });

const eventSetSchema = z
  .object({
    date: isoDateSchema.optional(),
    dateEnd: isoDateSchema.optional(),
    precision: z.enum(["day", "month", "year", "range"]).optional(),
    title: z.string().trim().min(1).max(500).optional(),
    detail: z.string().max(4_000).optional(),
    place: z.string().trim().min(1).max(500).optional(),
    personIds: z.array(targetIdSchema).max(100).optional(),
    kind: z.string().trim().min(1).max(100).optional(),
  })
  .strict();
const EVENT_UNSET_FIELDS = ["dateEnd", "precision", "detail", "place", "kind"] as const;
const EVENT_CLEAR_FIELDS = ["personIds"] as const;

export const eventMutationPatchSchema = z
  .object({
    set: eventSetSchema.optional(),
    unset: z.array(z.enum(EVENT_UNSET_FIELDS)).max(EVENT_UNSET_FIELDS.length).optional(),
    clear: z.array(z.enum(EVENT_CLEAR_FIELDS)).max(EVENT_CLEAR_FIELDS.length).optional(),
  })
  .strict()
  .superRefine((patch, context) => {
    const setFields = new Set(Object.keys(patch.set ?? {}));
    const unset = new Set<string>(patch.unset ?? []);
    const clear = new Set<string>(patch.clear ?? []);
    if (!setFields.size && !unset.size && !clear.size) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "事件修改不能为空" });
    }
    for (const field of setFields) {
      if (unset.has(field) || clear.has(field)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `字段 ${field} 不能同时 set/unset/clear`,
        });
      }
    }
  });

const updatePersonOperationSchema = z
  .object({
    id: targetIdSchema,
    kind: z.literal("update_person"),
    targetId: targetIdSchema,
    reason: reasonSchema,
    precondition: preconditionSchema,
    changes: personMutationPatchSchema,
  })
  .strict();

const supersedeRelationOperationSchema = z
  .object({
    id: targetIdSchema,
    kind: z.literal("supersede_relation"),
    targetId: targetIdSchema,
    newAssertionId: targetIdSchema,
    reason: reasonSchema,
    precondition: preconditionSchema,
    replacement: relationReplacementSchema,
  })
  .strict()
  .refine((operation) => operation.newAssertionId !== operation.targetId, {
    message: "替代断言必须使用新 ID，不能覆盖原断言",
    path: ["newAssertionId"],
  });

const updateEventOperationSchema = z
  .object({
    id: targetIdSchema,
    kind: z.literal("update_event"),
    targetId: targetIdSchema,
    reason: reasonSchema,
    precondition: preconditionSchema,
    changes: eventMutationPatchSchema,
  })
  .strict();

const collectionReplacementSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    /** Computed communities are projector-owned and cannot be hand-edited. */
    kind: z.enum(["relationship_circle", "context"]),
    color: z.string().trim().min(1).max(50).nullable(),
  })
  .strict();
const membershipChangeSchema = z
  .object({
    membershipId: targetIdSchema,
    personId: targetIdSchema,
    action: z.enum(["add", "remove"]),
    expectedRevision: revisionSchema.nullable(),
  })
  .strict()
  .superRefine((change, context) => {
    if (change.action === "add" && change.expectedRevision !== null) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "新增成员必须预期成员关系不存在" });
    }
    if (change.action === "remove" && change.expectedRevision === null) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "移除成员必须携带当前版本" });
    }
  });
const organizeCollectionOperationSchema = z
  .object({
    id: targetIdSchema,
    kind: z.literal("organize_collection"),
    targetId: targetIdSchema,
    reason: reasonSchema,
    expectedRevision: revisionSchema.nullable(),
    replacement: collectionReplacementSchema,
    memberships: z.array(membershipChangeSchema).max(200),
  })
  .strict();

const deleteRelationResolutionSchema = z
  .object({
    kind: z.literal("relation_assertion"),
    targetId: targetIdSchema,
    action: z.literal("delete"),
  })
  .strict();
const deleteMembershipResolutionSchema = z
  .object({
    kind: z.literal("collection_membership"),
    targetId: targetIdSchema,
    action: z.literal("delete"),
  })
  .strict();
const detachableResolutionSchema = z
  .object({
    kind: z.enum(["life_event", "reminder", "task"]),
    targetId: targetIdSchema,
    action: z.enum(["delete", "detach"]),
  })
  .strict();
const caseEventResolutionSchema = z
  .object({
    kind: z.literal("case_event"),
    targetId: targetIdSchema,
    action: z.literal("detach"),
  })
  .strict();
const evidenceResolutionSchema = z
  .object({
    kind: z.literal("evidence"),
    targetId: targetIdSchema,
    action: z.literal("detach"),
  })
  .strict();
const projectResolutionSchema = z
  .object({
    kind: z.literal("project"),
    targetId: targetIdSchema,
    role: z.enum(["owner", "member", "owner_and_member"]),
    action: z.enum(["delete", "detach", "reassign"]),
    replacementPersonId: targetIdSchema.optional(),
  })
  .strict()
  .superRefine((resolution, context) => {
    if (resolution.action === "reassign" && !resolution.replacementPersonId) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "reassign 必须指定接替人物 ID" });
    }
    if (resolution.action !== "reassign" && resolution.replacementPersonId) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "只有 reassign 可以指定接替人物" });
    }
    if (resolution.action === "detach" && resolution.role !== "member") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "负责人不能 detach 后留下无主事务",
      });
    }
  });
const deleteResolutionSchema = z.union([
  deleteRelationResolutionSchema,
  deleteMembershipResolutionSchema,
  detachableResolutionSchema,
  caseEventResolutionSchema,
  evidenceResolutionSchema,
  projectResolutionSchema,
]);

const deletePersonOperationSchema = z
  .object({
    id: targetIdSchema,
    kind: z.literal("delete_person"),
    targetId: targetIdSchema,
    reason: reasonSchema,
    precondition: preconditionSchema,
    expectedDependencyRevision: revisionSchema,
    resolutions: z.array(deleteResolutionSchema).max(1_000),
  })
  .strict();

export const archiveMutationOperationSchema = z.union([
  updatePersonOperationSchema,
  supersedeRelationOperationSchema,
  updateEventOperationSchema,
  organizeCollectionOperationSchema,
  deletePersonOperationSchema,
]);

export const archiveMutationPlanSchema = z
  .object({
    version: z.literal(1),
    id: targetIdSchema,
    title: z.string().trim().min(1).max(300),
    reason: reasonSchema,
    createdAt: z.number().int().nonnegative(),
    operations: z.array(archiveMutationOperationSchema).min(1).max(500),
  })
  .strict()
  .superRefine((plan, context) => {
    const operationIds = new Set<string>();
    const exclusiveTargets = new Set<string>();
    const newAssertionIds = new Set<string>();
    const membershipIds = new Set<string>();
    const deletingPeople = new Set(
      plan.operations
        .filter((operation) => operation.kind === "delete_person")
        .map((operation) => operation.targetId),
    );
    for (const [index, operation] of plan.operations.entries()) {
      if (operationIds.has(operation.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `重复的操作 ID：${operation.id}`,
          path: ["operations", index, "id"],
        });
      }
      operationIds.add(operation.id);
      const targetKey = `${operation.kind}:${operation.targetId}`;
      if (exclusiveTargets.has(targetKey)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `同一计划不能重复修改目标 ${operation.targetId}`,
          path: ["operations", index, "targetId"],
        });
      }
      exclusiveTargets.add(targetKey);
      if (operation.kind === "update_person" && deletingPeople.has(operation.targetId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `不能在同一计划中先修改再删除人物 ${operation.targetId}`,
          path: ["operations", index],
        });
      }
      if (operation.kind === "supersede_relation") {
        if (newAssertionIds.has(operation.newAssertionId)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: `重复的新断言 ID：${operation.newAssertionId}`,
            path: ["operations", index, "newAssertionId"],
          });
        }
        newAssertionIds.add(operation.newAssertionId);
      }
      if (operation.kind === "organize_collection") {
        for (const membership of operation.memberships) {
          if (membershipIds.has(membership.membershipId)) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              message: `同一成员关系不能变更多次：${membership.membershipId}`,
              path: ["operations", index, "memberships"],
            });
          }
          membershipIds.add(membership.membershipId);
        }
      }
    }
  });

export type PersonMutationPatch = z.infer<typeof personMutationPatchSchema>;
export type RelationReplacement = z.infer<typeof relationReplacementSchema>;
export type EventMutationPatch = z.infer<typeof eventMutationPatchSchema>;
export type ArchiveMutationOperation = z.infer<typeof archiveMutationOperationSchema>;
export type ArchiveMutationPlan = z.infer<typeof archiveMutationPlanSchema>;
export type DeleteResolution = z.infer<typeof deleteResolutionSchema>;

export interface ArchiveMutationSnapshot {
  persons: PersonRecord[];
  assertions: RelationAssertionRecord[];
  derivedRelations: DerivedRelationshipRecord[];
  evidenceLinks: RelationEvidenceLinkRecord[];
  evidence: EvidenceRecord[];
  caseEvents: CaseEventRecord[];
  viewPreferences: RelationViewPreferenceRecord[];
  referralPolicies: ReferralPolicyRecord[];
  lifeEvents: LifeEventRecord[];
  reminders: ReminderRecord[];
  tasks: TaskRecord[];
  projects: ProjectRecord[];
  collections: CollectionRecord[];
  collectionMemberships: CollectionMembershipRecord[];
}

export interface ArchiveMutationRepository {
  listPersons(): Promise<PersonRecord[]>;
  listRelationAssertions(): Promise<RelationAssertionRecord[]>;
  listDerivedRelations(): Promise<DerivedRelationshipRecord[]>;
  listRelationEvidenceLinks(): Promise<RelationEvidenceLinkRecord[]>;
  listEvidence(): Promise<EvidenceRecord[]>;
  listCaseEvents(): Promise<CaseEventRecord[]>;
  listRelationViewPreferences(): Promise<RelationViewPreferenceRecord[]>;
  listReferralPolicies(): Promise<ReferralPolicyRecord[]>;
  listLifeEvents(): Promise<LifeEventRecord[]>;
  listReminders(): Promise<ReminderRecord[]>;
  listTasks(): Promise<TaskRecord[]>;
  listProjects(): Promise<ProjectRecord[]>;
  listCollections(): Promise<CollectionRecord[]>;
  listCollectionMemberships(): Promise<CollectionMembershipRecord[]>;
  applyArchiveMutationBatch(batch: ArchiveMutationWriteBatch): Promise<void>;
}

export async function loadArchiveMutationSnapshot(
  repository: ArchiveMutationRepository = facesDb,
): Promise<ArchiveMutationSnapshot> {
  const [
    persons,
    assertions,
    derivedRelations,
    evidenceLinks,
    evidence,
    caseEvents,
    viewPreferences,
    referralPolicies,
    lifeEvents,
    reminders,
    tasks,
    projects,
    collections,
    collectionMemberships,
  ] = await Promise.all([
    repository.listPersons(),
    repository.listRelationAssertions(),
    repository.listDerivedRelations(),
    repository.listRelationEvidenceLinks(),
    repository.listEvidence(),
    repository.listCaseEvents(),
    repository.listRelationViewPreferences(),
    repository.listReferralPolicies(),
    repository.listLifeEvents(),
    repository.listReminders(),
    repository.listTasks(),
    repository.listProjects(),
    repository.listCollections(),
    repository.listCollectionMemberships(),
  ]);
  return {
    persons,
    assertions,
    derivedRelations,
    evidenceLinks,
    evidence,
    caseEvents,
    viewPreferences,
    referralPolicies,
    lifeEvents,
    reminders,
    tasks,
    projects,
    collections,
    collectionMemberships,
  };
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableValue(item)]),
    );
  }
  return value;
}

/** Stable content revision used for optimistic concurrency, independent of timestamps. */
export function archiveRecordRevision(value: unknown) {
  const text = JSON.stringify(stableValue(value));
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `r1:${hash.toString(16).padStart(8, "0")}`;
}

export function collectionMembershipId(collectionId: string, personId: string) {
  return `${collectionId}\u0000${personId}`;
}

function operationId(prefix: string) {
  return `${prefix}:${crypto.randomUUID()}`;
}

export function createArchiveMutationPlan(
  input: Pick<ArchiveMutationPlan, "title" | "reason" | "operations">,
  options: { id?: string; createdAt?: number } = {},
) {
  return archiveMutationPlanSchema.parse({
    version: 1,
    id: options.id ?? operationId("plan"),
    title: input.title,
    reason: input.reason,
    createdAt: options.createdAt ?? Date.now(),
    operations: input.operations,
  });
}

export function createUpdatePersonOperation(
  snapshot: ArchiveMutationSnapshot,
  input: { personId: string; reason: string; changes: PersonMutationPatch; id?: string },
) {
  const person = snapshot.persons.find((row) => row.id === input.personId);
  if (!person) throw new Error(`找不到人物 ${input.personId}`);
  return updatePersonOperationSchema.parse({
    id: input.id ?? operationId("update-person"),
    kind: "update_person",
    targetId: person.id,
    reason: input.reason,
    precondition: { expectedRevision: archiveRecordRevision(person) },
    changes: input.changes,
  });
}

function replacementFromAssertion(assertion: RelationAssertionRecord): RelationReplacement {
  const {
    temporalStatus: _temporalStatus,
    validFrom: _validFrom,
    validTo: _validTo,
    ...qualifiers
  } = assertion.qualifiers;
  return {
    label: assertion.label,
    predicate: assertion.predicate,
    qualifiers,
    direction: assertion.direction,
    note: assertion.note ?? null,
    evidence: {
      mode: assertion.evidence.mode,
      basis: assertion.evidence.basis ?? null,
      sourceIds: assertion.evidence.sourceIds,
    },
    validity: {
      status: assertion.validity.status,
      validFrom: assertion.validity.validFrom ?? null,
      validTo: assertion.validity.validTo ?? null,
    },
    confidence: assertion.confidence ?? null,
    confirmationStatus: "confirmed",
  };
}

function currentAssertionById(snapshot: ArchiveMutationSnapshot, assertionId: string) {
  const supersededIds = new Set(
    snapshot.assertions
      .map((assertion) => assertion.supersedesAssertionId)
      .filter((id): id is string => Boolean(id)),
  );
  const assertion = snapshot.assertions.find((row) => row.id === assertionId);
  return assertion &&
    !supersededIds.has(assertion.id) &&
    assertion.confirmationStatus !== "rejected"
    ? assertion
    : undefined;
}

export function createSupersedeRelationOperation(
  snapshot: ArchiveMutationSnapshot,
  input: {
    assertionId: string;
    reason: string;
    replacement?: RelationReplacement;
    id?: string;
    newAssertionId?: string;
  },
) {
  const assertion = currentAssertionById(snapshot, input.assertionId);
  if (!assertion) {
    if (snapshot.derivedRelations.some((row) => row.id === input.assertionId)) {
      throw new Error("派生关系不能直接编辑；请修改它列出的支持事实，投影会自动重建");
    }
    if (snapshot.assertions.some((row) => row.id === input.assertionId)) {
      throw new Error("历史或已拒绝的关系不能直接编辑；请读取当前事实关系");
    }
    throw new Error(`找不到事实关系 ${input.assertionId}`);
  }
  return supersedeRelationOperationSchema.parse({
    id: input.id ?? operationId("supersede-relation"),
    kind: "supersede_relation",
    targetId: assertion.id,
    newAssertionId: input.newAssertionId ?? operationId("relation-assertion"),
    reason: input.reason,
    precondition: { expectedRevision: archiveRecordRevision(assertion) },
    replacement: input.replacement ?? replacementFromAssertion(assertion),
  });
}

export function createUpdateEventOperation(
  snapshot: ArchiveMutationSnapshot,
  input: { eventId: string; reason: string; changes: EventMutationPatch; id?: string },
) {
  const event = snapshot.lifeEvents.find((row) => row.id === input.eventId);
  if (!event) throw new Error(`找不到事件 ${input.eventId}`);
  return updateEventOperationSchema.parse({
    id: input.id ?? operationId("update-event"),
    kind: "update_event",
    targetId: event.id,
    reason: input.reason,
    precondition: { expectedRevision: archiveRecordRevision(event) },
    changes: input.changes,
  });
}

export function createOrganizeCollectionOperation(
  snapshot: ArchiveMutationSnapshot,
  input: {
    collectionId: string;
    reason: string;
    replacement: z.input<typeof collectionReplacementSchema>;
    memberships?: Array<{ personId: string; action: "add" | "remove" }>;
    id?: string;
  },
) {
  const collection = snapshot.collections.find((row) => row.id === input.collectionId);
  const existingMemberships = new Map(
    snapshot.collectionMemberships.map((membership) => [membership.id, membership]),
  );
  const memberships = (input.memberships ?? []).map((change) => {
    if (!snapshot.persons.some((person) => person.id === change.personId)) {
      throw new Error(`圈层成员不存在：${change.personId}`);
    }
    const membershipId = collectionMembershipId(input.collectionId, change.personId);
    const existing = existingMemberships.get(membershipId);
    if (change.action === "add" && existing) throw new Error(`${change.personId} 已在该圈层中`);
    if (change.action === "remove" && !existing) throw new Error(`${change.personId} 不在该圈层中`);
    return {
      membershipId,
      personId: change.personId,
      action: change.action,
      expectedRevision: existing ? archiveRecordRevision(existing) : null,
    };
  });
  return organizeCollectionOperationSchema.parse({
    id: input.id ?? operationId("organize-collection"),
    kind: "organize_collection",
    targetId: input.collectionId,
    reason: input.reason,
    expectedRevision: collection ? archiveRecordRevision(collection) : null,
    replacement: input.replacement,
    memberships,
  });
}

type DeleteDependency = {
  kind: DeleteResolution["kind"];
  targetId: string;
  record: unknown;
  role?: "owner" | "member" | "owner_and_member";
};

function deleteDependencies(
  snapshot: ArchiveMutationSnapshot,
  personId: string,
): DeleteDependency[] {
  const dependencies: DeleteDependency[] = [];
  for (const assertion of snapshot.assertions) {
    if (assertion.fromId === personId || assertion.toId === personId) {
      dependencies.push({ kind: "relation_assertion", targetId: assertion.id, record: assertion });
    }
  }
  const appendPersonIds = (
    kind: "life_event" | "reminder" | "task" | "case_event",
    records: Array<LifeEventRecord | ReminderRecord | TaskRecord | CaseEventRecord>,
  ) => {
    for (const record of records) {
      if (record.personIds?.includes(personId)) {
        dependencies.push({ kind, targetId: record.id, record });
      }
    }
  };
  appendPersonIds("life_event", snapshot.lifeEvents);
  appendPersonIds("reminder", snapshot.reminders);
  appendPersonIds("task", snapshot.tasks);
  appendPersonIds("case_event", snapshot.caseEvents);
  for (const evidence of snapshot.evidence) {
    const linksPerson = evidence.linkedPersonIds?.includes(personId) ?? false;
    const namesPerson = evidence.entities?.some((entity) => entity.personId === personId) ?? false;
    if (linksPerson || namesPerson) {
      dependencies.push({ kind: "evidence", targetId: evidence.id, record: evidence });
    }
  }
  for (const project of snapshot.projects) {
    const owner = project.ownerId === personId;
    const member = project.memberIds?.includes(personId) ?? false;
    if (owner || member) {
      dependencies.push({
        kind: "project",
        targetId: project.id,
        record: project,
        role: owner && member ? "owner_and_member" : owner ? "owner" : "member",
      });
    }
  }
  for (const membership of snapshot.collectionMemberships) {
    if (membership.personId === personId) {
      dependencies.push({
        kind: "collection_membership",
        targetId: membership.id,
        record: membership,
      });
    }
  }
  return dependencies.sort((left, right) =>
    `${left.kind}:${left.targetId}`.localeCompare(`${right.kind}:${right.targetId}`),
  );
}

function dependencyRevision(dependencies: DeleteDependency[]) {
  return archiveRecordRevision(
    dependencies.map((dependency) => ({
      kind: dependency.kind,
      targetId: dependency.targetId,
      role: dependency.role,
      revision: archiveRecordRevision(dependency.record),
    })),
  );
}

export function createDeletePersonOperation(
  snapshot: ArchiveMutationSnapshot,
  input: { personId: string; reason: string; id?: string },
) {
  const person = snapshot.persons.find((row) => row.id === input.personId);
  if (!person) throw new Error(`找不到人物 ${input.personId}`);
  const dependencies = deleteDependencies(snapshot, person.id);
  const resolutions: DeleteResolution[] = dependencies.map((dependency) => {
    if (dependency.kind === "relation_assertion") {
      return { kind: dependency.kind, targetId: dependency.targetId, action: "delete" };
    }
    if (dependency.kind === "collection_membership") {
      return { kind: dependency.kind, targetId: dependency.targetId, action: "delete" };
    }
    if (dependency.kind === "project") {
      const role = dependency.role ?? "member";
      return {
        kind: "project",
        targetId: dependency.targetId,
        role,
        action: role === "member" ? "detach" : "delete",
      };
    }
    if (dependency.kind === "case_event" || dependency.kind === "evidence") {
      return { kind: dependency.kind, targetId: dependency.targetId, action: "detach" };
    }
    const record = dependency.record as LifeEventRecord | ReminderRecord | TaskRecord;
    const remainingPeople = (record.personIds ?? []).filter((id) => id !== person.id);
    return {
      kind: dependency.kind,
      targetId: dependency.targetId,
      action: remainingPeople.length ? "detach" : "delete",
    };
  });
  return deletePersonOperationSchema.parse({
    id: input.id ?? operationId("delete-person"),
    kind: "delete_person",
    targetId: person.id,
    reason: input.reason,
    precondition: { expectedRevision: archiveRecordRevision(person) },
    expectedDependencyRevision: dependencyRevision(dependencies),
    resolutions,
  });
}

/**
 * Build coordinated delete operations for one approval. Shared records are
 * resolved against the whole deletion set, so the plan shown to the user is
 * exactly the batch later committed by `prepareArchiveMutationPlan`.
 */
export function createDeletePeopleOperations(
  snapshot: ArchiveMutationSnapshot,
  inputs: Array<{ personId: string; reason: string; id?: string }>,
) {
  const deletingIds = new Set(inputs.map((input) => input.personId));
  const lifeEvents = new Map(snapshot.lifeEvents.map((row) => [row.id, row]));
  const reminders = new Map(snapshot.reminders.map((row) => [row.id, row]));
  const tasks = new Map(snapshot.tasks.map((row) => [row.id, row]));
  const projects = new Map(snapshot.projects.map((row) => [row.id, row]));
  return inputs.map((input) => {
    const operation = createDeletePersonOperation(snapshot, input);
    return {
      ...operation,
      resolutions: operation.resolutions.map((resolution): DeleteResolution => {
        if (
          resolution.kind === "life_event" ||
          resolution.kind === "reminder" ||
          resolution.kind === "task"
        ) {
          const record =
            resolution.kind === "life_event"
              ? lifeEvents.get(resolution.targetId)
              : resolution.kind === "reminder"
                ? reminders.get(resolution.targetId)
                : tasks.get(resolution.targetId);
          return {
            kind: resolution.kind,
            targetId: resolution.targetId,
            action: record?.personIds?.some((id) => !deletingIds.has(id)) ? "detach" : "delete",
          };
        }
        if (resolution.kind === "project") {
          const project = projects.get(resolution.targetId);
          return {
            kind: "project",
            targetId: resolution.targetId,
            role: resolution.role,
            action: project?.ownerId && deletingIds.has(project.ownerId) ? "delete" : "detach",
          };
        }
        return resolution;
      }),
    };
  });
}

export interface ArchiveMutationDiffRow {
  operationId: string;
  targetId: string;
  targetLabel: string;
  field: string;
  before: string;
  after: string;
  destructive: boolean;
}

type ArchiveMutationDiffDraft = Omit<ArchiveMutationDiffRow, "targetLabel">;

function displayValue(value: unknown) {
  if (value === undefined || value === null || value === "") return "（空）";
  if (Array.isArray(value)) return value.length ? value.join("、") : "（空列表）";
  if (typeof value === "object") return JSON.stringify(stableValue(value));
  return String(value);
}

function assertRevision(target: unknown, expectedRevision: string, label: string) {
  if (!target) throw new Error(`${label} 已不存在，请重新生成计划`);
  if (archiveRecordRevision(target) !== expectedRevision) {
    throw new Error(`${label} 在计划生成后已变化，请重新读取档案并生成计划`);
  }
}

function applyPersonPatch(person: PersonRecord, patch: PersonMutationPatch, now: number) {
  const profile = { ...(person.profile ?? {}) } as PersonProfile;
  const setProfile = patch.set?.profile ?? {};
  Object.assign(profile, setProfile);
  const fieldSources = { ...(profile.fieldSources ?? {}) };
  const approvedSource = {
    kind: "ai" as const,
    detail: "智能体提议，经用户批准",
    at: now,
  };
  for (const key of Object.keys(setProfile)) fieldSources[key] = approvedSource;
  if (patch.set?.name !== undefined) fieldSources.name = approvedSource;
  if (patch.set?.note !== undefined || (patch.clear ?? []).includes("note")) {
    fieldSources.note = approvedSource;
  }
  for (const path of patch.unset ?? []) {
    const key = path.slice("profile.".length) as keyof PersonProfile;
    delete profile[key];
    delete fieldSources[key];
  }
  for (const path of patch.clear ?? []) {
    if (path === "note") continue;
    const key = path.slice("profile.".length) as (typeof PROFILE_LIST_FIELDS)[number];
    profile[key] = [];
    fieldSources[key] = approvedSource;
  }
  if (Object.keys(fieldSources).length) profile.fieldSources = fieldSources;
  return {
    ...person,
    ...(patch.set?.name !== undefined ? { name: patch.set.name } : {}),
    ...(patch.set?.note !== undefined ? { note: patch.set.note } : {}),
    ...((patch.clear ?? []).includes("note") ? { note: "" } : {}),
    profile,
    updatedAt: now,
  } satisfies PersonRecord;
}

function applyEventPatch(event: LifeEventRecord, patch: EventMutationPatch, now: number) {
  const updated = { ...event, ...(patch.set ?? {}), updatedAt: now } as LifeEventRecord;
  for (const field of patch.unset ?? []) delete updated[field];
  if (patch.clear?.includes("personIds")) updated.personIds = [];
  if (updated.precision === "range" && !updated.dateEnd) {
    throw new Error(`事件 ${event.id} 是时间范围，必须保留结束日期`);
  }
  if (updated.dateEnd && updated.dateEnd < updated.date) {
    throw new Error(`事件 ${event.id} 的结束日期不能早于开始日期`);
  }
  return updated;
}

function personPatchDiff(
  operation: Extract<ArchiveMutationOperation, { kind: "update_person" }>,
  before: PersonRecord,
  after: PersonRecord,
) {
  const paths = new Set<string>([
    ...Object.keys(operation.changes.set ?? {}).filter((key) => key !== "profile"),
    ...Object.keys(operation.changes.set?.profile ?? {}).map((key) => `profile.${key}`),
    ...(operation.changes.unset ?? []),
    ...(operation.changes.clear ?? []),
  ]);
  const read = (record: PersonRecord, path: string) =>
    path.startsWith("profile.")
      ? record.profile?.[path.slice(8) as keyof PersonProfile]
      : record[path as "name" | "note"];
  return [...paths].flatMap((path) => {
    const previous = read(before, path);
    const next = read(after, path);
    return displayValue(previous) === displayValue(next)
      ? []
      : [
          {
            operationId: operation.id,
            targetId: operation.targetId,
            field: path,
            before: displayValue(previous),
            after: displayValue(next),
            destructive:
              (operation.changes.unset ?? []).includes(path as never) ||
              (operation.changes.clear ?? []).includes(path as never),
          } satisfies ArchiveMutationDiffDraft,
        ];
  });
}

function mutationDiffTargetLabel(
  row: ArchiveMutationDiffDraft,
  snapshot: ArchiveMutationSnapshot,
  batch: ArchiveMutationWriteBatch,
) {
  const persons = new Map(
    [...snapshot.persons, ...(batch.persons ?? [])].map((record) => [record.id, record]),
  );
  const collections = new Map(
    [...snapshot.collections, ...(batch.collections ?? [])].map((record) => [record.id, record]),
  );
  const memberships = new Map(
    [...snapshot.collectionMemberships, ...(batch.collectionMemberships ?? [])].map((record) => [
      record.id,
      record,
    ]),
  );
  const personName = (id: string) => persons.get(id)?.name ?? id;

  if (row.field === "collection.membership" || row.field === "delete.collection_membership") {
    const membership = memberships.get(row.targetId);
    if (membership) {
      return `${personName(membership.personId)} · ${
        collections.get(membership.collectionId)?.name ?? membership.collectionId
      }`;
    }
  }

  if (row.field.startsWith("relation.") || row.field === "delete.relation_assertion") {
    const assertion = [...snapshot.assertions, ...(batch.assertions ?? [])].find(
      (record) => record.id === row.targetId,
    );
    if (assertion) {
      return `${personName(assertion.fromId)} → ${personName(assertion.toId)} · ${assertion.label}`;
    }
  }

  if (row.field === "person" || row.field === "name" || row.field === "note") {
    return persons.get(row.targetId)?.name ?? row.targetId;
  }
  if (row.field.startsWith("profile.")) return persons.get(row.targetId)?.name ?? row.targetId;

  if (row.field.startsWith("event.") || row.field === "delete.life_event") {
    return snapshot.lifeEvents.find((record) => record.id === row.targetId)?.title ?? row.targetId;
  }
  if (row.field.startsWith("collection.")) {
    return collections.get(row.targetId)?.name ?? row.targetId;
  }
  if (row.field === "delete.reminder") {
    return snapshot.reminders.find((record) => record.id === row.targetId)?.title ?? row.targetId;
  }
  if (row.field === "delete.task") {
    return snapshot.tasks.find((record) => record.id === row.targetId)?.title ?? row.targetId;
  }
  if (row.field === "delete.case_event") {
    return snapshot.caseEvents.find((record) => record.id === row.targetId)?.title ?? row.targetId;
  }
  if (row.field === "delete.evidence") {
    return snapshot.evidence.find((record) => record.id === row.targetId)?.title ?? row.targetId;
  }
  if (row.field === "delete.project") {
    return snapshot.projects.find((record) => record.id === row.targetId)?.title ?? row.targetId;
  }
  return row.targetId;
}

function pushUnique<T>(target: T[] | undefined, value: T) {
  if (target) target.push(value);
  else return [value];
  return target;
}

export interface PreparedArchiveMutationPlan {
  plan: ArchiveMutationPlan;
  batch: ArchiveMutationWriteBatch;
  diff: ArchiveMutationDiffRow[];
}

/** Validate preconditions and materialize a plan without writing to IndexedDB. */
export function prepareArchiveMutationPlan(
  rawPlan: unknown,
  snapshot: ArchiveMutationSnapshot,
  options: { now?: number } = {},
): PreparedArchiveMutationPlan {
  const plan = archiveMutationPlanSchema.parse(rawPlan);
  const now = options.now ?? Date.now();
  const batch: ArchiveMutationWriteBatch = {};
  const diff: ArchiveMutationDiffDraft[] = [];
  const personById = new Map(snapshot.persons.map((row) => [row.id, row]));
  const assertionById = new Map(snapshot.assertions.map((row) => [row.id, row]));
  const eventById = new Map(snapshot.lifeEvents.map((row) => [row.id, row]));
  const caseEventById = new Map(snapshot.caseEvents.map((row) => [row.id, row]));
  const evidenceById = new Map(snapshot.evidence.map((row) => [row.id, row]));
  const reminderById = new Map(snapshot.reminders.map((row) => [row.id, row]));
  const taskById = new Map(snapshot.tasks.map((row) => [row.id, row]));
  const projectById = new Map(snapshot.projects.map((row) => [row.id, row]));
  const collectionById = new Map(snapshot.collections.map((row) => [row.id, row]));
  const membershipById = new Map(snapshot.collectionMemberships.map((row) => [row.id, row]));
  const deletingPeople = new Set(
    plan.operations
      .filter((operation) => operation.kind === "delete_person")
      .map((operation) => operation.targetId),
  );
  const deleteOperations: Array<Extract<ArchiveMutationOperation, { kind: "delete_person" }>> = [];

  for (const operation of plan.operations) {
    if (operation.kind === "update_person") {
      const current = personById.get(operation.targetId);
      assertRevision(
        current,
        operation.precondition.expectedRevision,
        `人物 ${operation.targetId}`,
      );
      const updated = applyPersonPatch(current!, operation.changes, now);
      batch.persons = pushUnique(batch.persons, updated);
      personById.set(updated.id, updated);
      diff.push(...personPatchDiff(operation, current!, updated));
      continue;
    }

    if (operation.kind === "supersede_relation") {
      const current = currentAssertionById(snapshot, operation.targetId);
      if (!current && snapshot.derivedRelations.some((row) => row.id === operation.targetId)) {
        throw new Error("派生关系不能直接编辑；请修改支持事实，投影会自动重建");
      }
      assertRevision(
        current,
        operation.precondition.expectedRevision,
        `事实关系 ${operation.targetId}`,
      );
      if (
        assertionById.has(operation.newAssertionId) ||
        snapshot.derivedRelations.some((row) => row.id === operation.newAssertionId)
      ) {
        throw new Error(`新断言 ID 已存在：${operation.newAssertionId}`);
      }
      if (deletingPeople.has(current!.fromId) || deletingPeople.has(current!.toId)) {
        throw new Error("不能在同一计划中更新一条将随人物删除的关系");
      }
      const replacement = operation.replacement;
      const evidenceIds = new Set(snapshot.evidence.map((row) => row.id));
      const missingEvidenceId = replacement.evidence.sourceIds.find(
        (sourceId) => !evidenceIds.has(sourceId),
      );
      if (missingEvidenceId) {
        throw new Error(`关系依据不存在：${missingEvidenceId}`);
      }
      const next: RelationAssertionRecord = {
        id: operation.newAssertionId,
        recordType: "assertion",
        fromId: current!.fromId,
        toId: current!.toId,
        predicate: replacement.predicate,
        qualifiers: {
          ...(replacement.qualifiers as RelationQualifiers),
          temporalStatus:
            replacement.validity.status === "active"
              ? "current"
              : replacement.validity.status === "ended"
                ? "former"
                : "unknown",
          validFrom: replacement.validity.validFrom ?? undefined,
          validTo: replacement.validity.validTo ?? undefined,
        },
        label: replacement.label,
        direction: replacement.direction,
        note: replacement.note ?? undefined,
        evidence: {
          mode: replacement.evidence.mode,
          basis: replacement.evidence.basis ?? undefined,
          sourceIds: replacement.evidence.sourceIds,
        },
        validity: {
          status: replacement.validity.status,
          validFrom: replacement.validity.validFrom ?? undefined,
          validTo: replacement.validity.validTo ?? undefined,
        },
        confidence: replacement.confidence ?? undefined,
        confirmationStatus: replacement.confirmationStatus,
        createdAt: now,
        updatedAt: now,
        supersedesAssertionId: current!.id,
        source: { kind: "ai", detail: "智能体提议，经用户批准", at: now },
      };
      batch.assertions = pushUnique(batch.assertions, next);
      assertionById.set(next.id, next);
      for (const sourceId of next.evidence.sourceIds) {
        batch.evidenceLinks = pushUnique(batch.evidenceLinks, {
          id: `${next.id}\u0000${sourceId}`,
          assertionId: next.id,
          evidenceId: sourceId,
          createdAt: now,
        });
      }
      const preference = snapshot.viewPreferences.find((row) => row.subjectId === current!.id);
      if (preference) {
        batch.viewPreferences = pushUnique(batch.viewPreferences, {
          ...preference,
          id: next.id,
          subjectId: next.id,
          updatedAt: now,
        });
      }
      const referral = snapshot.referralPolicies.find((row) => row.subjectId === current!.id);
      if (referral) {
        batch.referralPolicies = pushUnique(batch.referralPolicies, {
          ...referral,
          id: next.id,
          subjectId: next.id,
          updatedAt: now,
        });
      }
      const before = replacementFromAssertion(current!);
      for (const field of Object.keys(replacement) as Array<keyof RelationReplacement>) {
        if (displayValue(before[field]) !== displayValue(replacement[field])) {
          diff.push({
            operationId: operation.id,
            targetId: operation.targetId,
            field: `relation.${field}`,
            before: displayValue(before[field]),
            after: displayValue(replacement[field]),
            destructive: replacement[field] === null,
          });
        }
      }
      continue;
    }

    if (operation.kind === "update_event") {
      const current = eventById.get(operation.targetId);
      assertRevision(
        current,
        operation.precondition.expectedRevision,
        `事件 ${operation.targetId}`,
      );
      const updated = applyEventPatch(current!, operation.changes, now);
      if (updated.personIds?.some((id) => deletingPeople.has(id))) {
        throw new Error("事件更新后仍引用本计划将删除的人物");
      }
      batch.lifeEvents = pushUnique(batch.lifeEvents, updated);
      eventById.set(updated.id, updated);
      const fields = new Set([
        ...Object.keys(operation.changes.set ?? {}),
        ...(operation.changes.unset ?? []),
        ...(operation.changes.clear ?? []),
      ]);
      for (const field of fields) {
        const previous = current![field as keyof LifeEventRecord];
        const next = updated[field as keyof LifeEventRecord];
        if (displayValue(previous) !== displayValue(next)) {
          diff.push({
            operationId: operation.id,
            targetId: operation.targetId,
            field: `event.${field}`,
            before: displayValue(previous),
            after: displayValue(next),
            destructive:
              (operation.changes.unset ?? []).includes(field as never) ||
              (operation.changes.clear ?? []).includes(field as never),
          });
        }
      }
      continue;
    }

    if (operation.kind === "organize_collection") {
      const current = collectionById.get(operation.targetId);
      if (operation.expectedRevision === null) {
        if (current) throw new Error(`圈层 ${operation.targetId} 已存在，请重新生成计划`);
      } else {
        assertRevision(current, operation.expectedRevision, `圈层 ${operation.targetId}`);
      }
      const collection: CollectionRecord = {
        id: operation.targetId,
        name: operation.replacement.name,
        kind: operation.replacement.kind,
        color: operation.replacement.color ?? undefined,
        createdAt: current?.createdAt ?? now,
        updatedAt: now,
      };
      batch.collections = pushUnique(batch.collections, collection);
      collectionById.set(collection.id, collection);
      for (const field of ["name", "kind", "color"] as const) {
        if (displayValue(current?.[field]) !== displayValue(collection[field])) {
          diff.push({
            operationId: operation.id,
            targetId: operation.targetId,
            field: `collection.${field}`,
            before: displayValue(current?.[field]),
            after: displayValue(collection[field]),
            destructive: false,
          });
        }
      }
      for (const change of operation.memberships) {
        if (change.membershipId !== collectionMembershipId(operation.targetId, change.personId)) {
          throw new Error(`成员关系 ID 与圈层/人物 ID 不一致：${change.membershipId}`);
        }
        if (!personById.has(change.personId) || deletingPeople.has(change.personId)) {
          throw new Error(`不能把不存在或即将删除的人物加入圈层：${change.personId}`);
        }
        const existing = membershipById.get(change.membershipId);
        if (change.expectedRevision === null) {
          if (existing) throw new Error(`成员关系 ${change.membershipId} 已存在`);
        } else {
          assertRevision(existing, change.expectedRevision, `成员关系 ${change.membershipId}`);
        }
        if (change.action === "add") {
          const membership: CollectionMembershipRecord = {
            id: change.membershipId,
            collectionId: operation.targetId,
            personId: change.personId,
            source: "ai_approved",
            createdAt: now,
          };
          batch.collectionMemberships = pushUnique(batch.collectionMemberships, membership);
          membershipById.set(membership.id, membership);
        } else {
          batch.deleteCollectionMembershipIds = pushUnique(
            batch.deleteCollectionMembershipIds,
            change.membershipId,
          );
          membershipById.delete(change.membershipId);
        }
        diff.push({
          operationId: operation.id,
          targetId: change.membershipId,
          field: "collection.membership",
          before: change.action === "add" ? "不在圈层" : "在圈层",
          after: change.action === "add" ? "加入圈层" : "移出圈层",
          destructive: change.action === "remove",
        });
      }
      continue;
    }

    const currentPerson = personById.get(operation.targetId);
    assertRevision(
      currentPerson,
      operation.precondition.expectedRevision,
      `人物 ${operation.targetId}`,
    );
    const dependencies = deleteDependencies(snapshot, operation.targetId);
    if (dependencyRevision(dependencies) !== operation.expectedDependencyRevision) {
      throw new Error("人物删除计划生成后，相关关系/事件/提醒/事务/圈层已变化，请重新预览");
    }
    const expectedDependencyKeys = new Set(
      dependencies.map((dependency) => `${dependency.kind}:${dependency.targetId}`),
    );
    const resolutionKeys = new Set(
      operation.resolutions.map((resolution) => `${resolution.kind}:${resolution.targetId}`),
    );
    if (
      expectedDependencyKeys.size !== resolutionKeys.size ||
      [...expectedDependencyKeys].some((key) => !resolutionKeys.has(key))
    ) {
      throw new Error("删除计划必须逐项处理全部依赖，不能遗漏或添加不存在的依赖");
    }
    deleteOperations.push(operation);
  }

  // Deleting several people is one domain decision, not N sequential database
  // jobs. Shared events, evidence and relationships are resolved once against
  // the complete deletion set and committed by one IndexedDB transaction.
  const groupedResolutions = new Map<
    string,
    Array<{
      operation: Extract<ArchiveMutationOperation, { kind: "delete_person" }>;
      resolution: DeleteResolution;
    }>
  >();
  for (const operation of deleteOperations) {
    for (const resolution of operation.resolutions) {
      const key = `${resolution.kind}:${resolution.targetId}`;
      groupedResolutions.set(key, [
        ...(groupedResolutions.get(key) ?? []),
        { operation, resolution },
      ]);
    }
  }

  for (const entries of groupedResolutions.values()) {
    const { resolution } = entries[0];
    const operationIds = entries.map((entry) => entry.operation.id);
    const actions = new Set(entries.map((entry) => entry.resolution.action));
    const addDiff = (after: string, destructive: boolean) =>
      diff.push({
        operationId: operationIds.join(","),
        targetId: resolution.targetId,
        field: `delete.${resolution.kind}`,
        before: `关联 ${entries.length} 个待删除人物`,
        after,
        destructive,
      });

    if (resolution.kind === "relation_assertion") {
      if (actions.size !== 1 || !actions.has("delete"))
        throw new Error(`事实关系 ${resolution.targetId} 的批量删除决策不一致`);
      batch.deleteAssertionIds = pushUnique(batch.deleteAssertionIds, resolution.targetId);
      addDiff("删除记录", true);
      continue;
    }
    if (resolution.kind === "collection_membership") {
      if (actions.size !== 1 || !actions.has("delete"))
        throw new Error(`集合成员关系 ${resolution.targetId} 的批量删除决策不一致`);
      batch.deleteCollectionMembershipIds = pushUnique(
        batch.deleteCollectionMembershipIds,
        resolution.targetId,
      );
      addDiff("移出集合", true);
      continue;
    }
    if (
      resolution.kind === "life_event" ||
      resolution.kind === "reminder" ||
      resolution.kind === "task"
    ) {
      const record =
        resolution.kind === "life_event"
          ? eventById.get(resolution.targetId)!
          : resolution.kind === "reminder"
            ? reminderById.get(resolution.targetId)!
            : taskById.get(resolution.targetId)!;
      const personIds = (record.personIds ?? []).filter((id) => !deletingPeople.has(id));
      const expectedAction = personIds.length ? "detach" : "delete";
      if (actions.size !== 1 || !actions.has(expectedAction)) {
        throw new Error(
          `${resolution.kind} ${record.id} 的计划应当${expectedAction === "delete" ? "删除" : "解除人物引用"}，请重新预览`,
        );
      }
      if (expectedAction === "delete") {
        if (resolution.kind === "life_event")
          batch.deleteLifeEventIds = pushUnique(batch.deleteLifeEventIds, record.id);
        else if (resolution.kind === "reminder")
          batch.deleteReminderIds = pushUnique(batch.deleteReminderIds, record.id);
        else batch.deleteTaskIds = pushUnique(batch.deleteTaskIds, record.id);
        addDiff("删除记录", true);
      } else if (resolution.kind === "life_event") {
        batch.lifeEvents = pushUnique(batch.lifeEvents, {
          ...(record as LifeEventRecord),
          personIds,
          updatedAt: now,
        });
        addDiff("解除待删除人物引用", false);
      } else if (resolution.kind === "reminder") {
        batch.reminders = pushUnique(batch.reminders, {
          ...(record as ReminderRecord),
          personIds,
        });
        addDiff("解除待删除人物引用", false);
      } else {
        batch.tasks = pushUnique(batch.tasks, { ...(record as TaskRecord), personIds });
        addDiff("解除待删除人物引用", false);
      }
      continue;
    }
    if (resolution.kind === "case_event") {
      if (actions.size !== 1 || !actions.has("detach"))
        throw new Error(`时间线事件 ${resolution.targetId} 只能保留并解除人物引用`);
      const record = caseEventById.get(resolution.targetId)!;
      const personIds = (record.personIds ?? []).filter((id) => !deletingPeople.has(id));
      batch.caseEvents = pushUnique(batch.caseEvents, { ...record, personIds });
      addDiff("保留时间线并解除待删除人物引用", false);
      continue;
    }
    if (resolution.kind === "evidence") {
      if (actions.size !== 1 || !actions.has("detach"))
        throw new Error(`证据 ${resolution.targetId} 只能保留并解除人物引用`);
      const record = evidenceById.get(resolution.targetId)!;
      const linkedPersonIds = (record.linkedPersonIds ?? []).filter(
        (id) => !deletingPeople.has(id),
      );
      const entities = record.entities?.map((entity) =>
        entity.personId && deletingPeople.has(entity.personId)
          ? { ...entity, personId: undefined }
          : entity,
      );
      batch.evidence = pushUnique(batch.evidence, { ...record, linkedPersonIds, entities });
      addDiff("保留证据并解除待删除人物引用", false);
      continue;
    }
    if (!("role" in resolution)) throw new Error("不支持的删除依赖类型");
    const project = projectById.get(resolution.targetId)!;
    const ownerDeleted = Boolean(project.ownerId && deletingPeople.has(project.ownerId));
    if (actions.has("delete")) {
      if (actions.size !== 1)
        throw new Error(`事务 ${project.id} 的批量删除决策不一致，请重新预览`);
      batch.deleteProjectIds = pushUnique(batch.deleteProjectIds, project.id);
      addDiff("删除事务", true);
      continue;
    }
    const reassignments = entries
      .map((entry) =>
        "replacementPersonId" in entry.resolution
          ? entry.resolution.replacementPersonId
          : undefined,
      )
      .filter((id): id is string => Boolean(id));
    const replacements = new Set(reassignments);
    if (ownerDeleted && replacements.size !== 1) {
      throw new Error(`事务 ${project.id} 的负责人将被删除，必须统一改派或删除事务`);
    }
    if (!ownerDeleted && replacements.size) {
      throw new Error(`事务 ${project.id} 的负责人未删除，不应改派`);
    }
    const replacementId = [...replacements][0];
    const replacement = replacementId ? personById.get(replacementId) : undefined;
    if (replacementId && (!replacement || deletingPeople.has(replacementId))) {
      throw new Error(`接替人物不存在或也将被删除：${replacementId}`);
    }
    const removedMember = project.memberIds?.some((id) => deletingPeople.has(id)) ?? false;
    const memberIds = (project.memberIds ?? []).filter((id) => !deletingPeople.has(id));
    if (replacement && removedMember) memberIds.push(replacement.id);
    batch.projects = pushUnique(batch.projects, {
      ...project,
      ownerId: replacement?.id ?? project.ownerId,
      ownerName: replacement?.name ?? project.ownerName,
      memberIds: [...new Set(memberIds)],
      updatedAt: now,
    });
    addDiff(replacement ? `改派给 ${replacement.name}` : "解除待删除成员引用", false);
  }

  for (const operation of deleteOperations) {
    const currentPerson = personById.get(operation.targetId)!;
    batch.deletePersonIds = pushUnique(batch.deletePersonIds, operation.targetId);
    personById.delete(operation.targetId);
    diff.push({
      operationId: operation.id,
      targetId: operation.targetId,
      field: "person",
      before: currentPerson.name,
      after: "删除人物档案",
      destructive: true,
    });
  }

  if (!diff.length) throw new Error("计划与当前档案没有差异，无需批准");
  return {
    plan,
    batch,
    diff: diff.map((row) => ({
      ...row,
      targetLabel: mutationDiffTargetLabel(row, snapshot, batch),
    })),
  };
}

export async function applyArchiveMutationPlan(
  rawPlan: unknown,
  options: { repository?: ArchiveMutationRepository; now?: number } = {},
) {
  const repository = options.repository ?? facesDb;
  const snapshot = await loadArchiveMutationSnapshot(repository);
  const prepared = prepareArchiveMutationPlan(rawPlan, snapshot, { now: options.now });
  await repository.applyArchiveMutationBatch(prepared.batch);
  return {
    planId: prepared.plan.id,
    operationIds: prepared.plan.operations.map((operation) => operation.id),
    appliedAt: options.now ?? Date.now(),
    diff: prepared.diff,
  };
}
