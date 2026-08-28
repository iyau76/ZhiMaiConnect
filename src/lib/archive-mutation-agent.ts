import { z } from "zod";

import {
  archiveMutationPlanSchema,
  createArchiveMutationPlan,
  createDeletePeopleOperations,
  createOrganizeCollectionOperation,
  createSupersedeRelationOperation,
  createUpdateEventOperation,
  createUpdatePersonOperation,
  eventMutationPatchSchema,
  personMutationPatchSchema,
  prepareArchiveMutationPlan,
  type ArchiveMutationPlan,
  type ArchiveMutationSnapshot,
  type RelationReplacement,
} from "./archive-mutation-plan";
import { inferRelationSemantics } from "./relation-ontology";

const reason = z.string().trim().min(1).max(1_000);
const identifier = z.string().min(1).max(300);

const updatePersonRequestSchema = z
  .object({
    kind: z.literal("update_person"),
    personId: identifier,
    reason,
    changes: personMutationPatchSchema,
  })
  .strict();

const updateRelationRequestSchema = z
  .object({
    kind: z.literal("update_relation"),
    relationId: identifier,
    reason,
    changes: z
      .object({
        label: z.string().trim().min(1).max(300).optional(),
        note: z.string().max(4_000).nullable().optional(),
        basis: z.string().max(2_000).nullable().optional(),
        confidence: z.number().min(0).max(1).nullable().optional(),
        validity: z
          .object({
            status: z.enum(["active", "ended", "unknown"]),
            validFrom: z.string().trim().min(1).max(40).nullable().optional(),
            validTo: z.string().trim().min(1).max(40).nullable().optional(),
          })
          .strict()
          .optional(),
      })
      .strict(),
  })
  .strict();

const updateEventRequestSchema = z
  .object({
    kind: z.literal("update_event"),
    eventId: identifier,
    reason,
    changes: eventMutationPatchSchema,
  })
  .strict();

const organizeCollectionRequestSchema = z
  .object({
    kind: z.literal("organize_collection"),
    collectionId: identifier.optional(),
    reason,
    replacement: z
      .object({
        name: z.string().trim().min(1).max(100),
        kind: z.enum(["relationship_circle", "context"]),
        color: z.string().trim().min(1).max(40).nullable().optional(),
      })
      .strict(),
    addPersonIds: z.array(identifier).max(200).optional(),
    removePersonIds: z.array(identifier).max(200).optional(),
  })
  .strict();

const migrateCollectionMembersRequestSchema = z
  .object({
    kind: z.literal("migrate_collection_members"),
    sourceCollectionId: identifier,
    target: z
      .object({
        collectionId: identifier.optional(),
        name: z.string().trim().min(1).max(100),
        kind: z.enum(["relationship_circle", "context"]),
        color: z.string().trim().min(1).max(40).nullable().optional(),
      })
      .strict(),
    selectedPersonIds: z.array(identifier).min(1).max(200),
    reason,
  })
  .strict();

const deletePersonRequestSchema = z
  .object({ kind: z.literal("delete_person"), personId: identifier, reason })
  .strict();

export const agentMutationRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    reason,
    operations: z
      .array(
        z.discriminatedUnion("kind", [
          updatePersonRequestSchema,
          updateRelationRequestSchema,
          updateEventRequestSchema,
          organizeCollectionRequestSchema,
          migrateCollectionMembersRequestSchema,
          deletePersonRequestSchema,
        ]),
      )
      .min(1)
      .max(100),
  })
  .strict();

export type AgentMutationRequest = z.infer<typeof agentMutationRequestSchema>;
type AgentMutationOperationRequest = AgentMutationRequest["operations"][number];
type OrganizeCollectionRequest = Extract<
  AgentMutationOperationRequest,
  { kind: "organize_collection" }
>;
type MigrateCollectionMembersRequest = Extract<
  AgentMutationOperationRequest,
  { kind: "migrate_collection_members" }
>;

export class AgentMutationCompileError extends Error {
  readonly code: string;
  readonly missing: string[];
  readonly details: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    options: { missing?: string[]; details?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = "AgentMutationCompileError";
    this.code = code;
    this.missing = options.missing ?? [];
    this.details = options.details ?? {};
  }
}

function collectionRequestKey(operation: OrganizeCollectionRequest) {
  return operation.collectionId
    ? `id:${operation.collectionId}`
    : `new:${operation.replacement.kind}:${operation.replacement.name
        .normalize("NFKC")
        .trim()
        .toLocaleLowerCase("zh-CN")}`;
}

function sameCollectionReplacement(
  left: OrganizeCollectionRequest["replacement"],
  right: OrganizeCollectionRequest["replacement"],
) {
  return (
    left.name === right.name &&
    left.kind === right.kind &&
    (left.color ?? null) === (right.color ?? null)
  );
}

/** Compile repeated membership edits for one collection into one transaction operation. */
type CompiledAgentMutationOperationRequest = Exclude<
  AgentMutationOperationRequest,
  MigrateCollectionMembersRequest
>;

function normalizeAgentMutationOperations(operations: CompiledAgentMutationOperationRequest[]) {
  const normalized: CompiledAgentMutationOperationRequest[] = [];
  const collectionIndexes = new Map<string, number>();

  for (const operation of operations) {
    if (operation.kind !== "organize_collection") {
      normalized.push(operation);
      continue;
    }
    const key = collectionRequestKey(operation);
    const existingIndex = collectionIndexes.get(key);
    if (existingIndex === undefined) {
      collectionIndexes.set(key, normalized.length);
      normalized.push({
        ...operation,
        addPersonIds: [...new Set(operation.addPersonIds ?? [])],
        removePersonIds: [...new Set(operation.removePersonIds ?? [])],
      });
      continue;
    }

    const existing = normalized[existingIndex] as OrganizeCollectionRequest;
    if (!sameCollectionReplacement(existing.replacement, operation.replacement)) {
      throw new Error(
        `同一圈层 ${operation.collectionId ?? operation.replacement.name} 的目标定义冲突`,
      );
    }
    const addPersonIds = new Set([
      ...(existing.addPersonIds ?? []),
      ...(operation.addPersonIds ?? []),
    ]);
    const removePersonIds = new Set([
      ...(existing.removePersonIds ?? []),
      ...(operation.removePersonIds ?? []),
    ]);
    const conflicts = [...addPersonIds].filter((personId) => removePersonIds.has(personId));
    if (conflicts.length) {
      throw new Error(`同一圈层不能同时添加并移除人物：${conflicts.join("、")}`);
    }
    normalized[existingIndex] = {
      ...existing,
      reason: [...new Set([existing.reason, operation.reason])].join("；"),
      addPersonIds: [...addPersonIds],
      removePersonIds: [...removePersonIds],
    };
  }

  return normalized;
}

function normalizedCollectionName(value: string) {
  return value.normalize("NFKC").trim().toLocaleLowerCase("zh-CN");
}

function collectionReplacementFromSnapshot(
  collection: ArchiveMutationSnapshot["collections"][number],
) {
  if (collection.kind === "computed_community") {
    throw new AgentMutationCompileError(
      "computed_collection_not_editable",
      `计算圈层 ${collection.name} 不能手工整理`,
      { details: { collectionId: collection.id } },
    );
  }
  return {
    name: collection.name,
    kind: collection.kind,
    color: collection.color ?? null,
  };
}

function compileCollectionMigrations(
  operations: AgentMutationOperationRequest[],
  snapshot: ArchiveMutationSnapshot,
): CompiledAgentMutationOperationRequest[] {
  const compiled: CompiledAgentMutationOperationRequest[] = [];
  for (const operation of operations) {
    if (operation.kind !== "migrate_collection_members") {
      compiled.push(operation);
      continue;
    }
    const source = snapshot.collections.find(
      (collection) => collection.id === operation.sourceCollectionId,
    );
    if (!source) {
      throw new AgentMutationCompileError(
        "source_collection_not_found",
        `找不到源圈层 ${operation.sourceCollectionId}`,
        {
          missing: ["sourceCollectionId"],
          details: { sourceCollectionId: operation.sourceCollectionId },
        },
      );
    }
    const targetMatches = operation.target.collectionId
      ? snapshot.collections.filter((collection) => collection.id === operation.target.collectionId)
      : snapshot.collections.filter(
          (collection) =>
            collection.kind !== "computed_community" &&
            normalizedCollectionName(collection.name) ===
              normalizedCollectionName(operation.target.name),
        );
    if (operation.target.collectionId && !targetMatches.length) {
      throw new AgentMutationCompileError(
        "target_collection_not_found",
        `指定的目标圈层 ${operation.target.collectionId} 不存在；新建目标时不要填写 collectionId`,
        {
          missing: ["target.name", "target.kind"],
          details: { targetCollectionId: operation.target.collectionId },
        },
      );
    }
    if (targetMatches.length > 1) {
      throw new AgentMutationCompileError(
        "target_collection_ambiguous",
        `存在多个名为 ${operation.target.name} 的目标圈层，请指定 collectionId`,
        {
          missing: ["target.collectionId"],
          details: { candidates: targetMatches.map((collection) => collection.id) },
        },
      );
    }
    const target = targetMatches[0];
    const targetCollectionId = target?.id ?? `collection:${crypto.randomUUID()}`;
    if (targetCollectionId === source.id) {
      throw new AgentMutationCompileError(
        "same_source_and_target_collection",
        "源圈层与目标圈层相同，无法形成迁移",
        { missing: ["target"], details: { collectionId: source.id } },
      );
    }
    const selectedPersonIds = [...new Set(operation.selectedPersonIds)];
    const sourceMembers = new Set(
      snapshot.collectionMemberships
        .filter((membership) => membership.collectionId === source.id)
        .map((membership) => membership.personId),
    );
    const missingSourceMembers = selectedPersonIds.filter(
      (personId) => !sourceMembers.has(personId),
    );
    if (missingSourceMembers.length) {
      throw new AgentMutationCompileError(
        "selected_people_not_in_source_collection",
        `选中人物不在源圈层中：${missingSourceMembers.join("、")}`,
        {
          missing: ["selectedPersonIds"],
          details: { sourceCollectionId: source.id, personIds: missingSourceMembers },
        },
      );
    }
    const targetMembers = new Set(
      snapshot.collectionMemberships
        .filter((membership) => membership.collectionId === targetCollectionId)
        .map((membership) => membership.personId),
    );
    compiled.push({
      kind: "organize_collection",
      collectionId: source.id,
      reason: operation.reason,
      replacement: collectionReplacementFromSnapshot(source),
      removePersonIds: selectedPersonIds,
    });
    compiled.push({
      kind: "organize_collection",
      ...(target ? { collectionId: target.id } : {}),
      reason: operation.reason,
      replacement: target
        ? collectionReplacementFromSnapshot(target)
        : {
            name: operation.target.name,
            kind: operation.target.kind,
            color: operation.target.color ?? null,
          },
      addPersonIds: selectedPersonIds.filter((personId) => !targetMembers.has(personId)),
    });
  }
  return compiled;
}

function relationReplacement(
  snapshot: ArchiveMutationSnapshot,
  request: z.infer<typeof updateRelationRequestSchema>,
) {
  const baseOperation = createSupersedeRelationOperation(snapshot, {
    assertionId: request.relationId,
    reason: request.reason,
  });
  const base = baseOperation.replacement;
  const semantics = request.changes.label
    ? inferRelationSemantics(request.changes.label)
    : undefined;
  const status =
    request.changes.validity?.status ??
    (semantics?.qualifiers.temporalStatus === "former"
      ? "ended"
      : semantics?.qualifiers.temporalStatus === "current"
        ? "active"
        : base.validity.status);
  const replacement: RelationReplacement = {
    ...base,
    label: request.changes.label ?? base.label,
    predicate: semantics?.predicate ?? base.predicate,
    qualifiers: semantics
      ? Object.fromEntries(
          Object.entries(semantics.qualifiers).filter(
            ([key]) => !["temporalStatus", "validFrom", "validTo"].includes(key),
          ),
        )
      : base.qualifiers,
    direction:
      semantics?.predicate === "custom"
        ? base.direction === "ontology"
          ? "directed"
          : base.direction
        : "ontology",
    note: request.changes.note === undefined ? base.note : request.changes.note,
    evidence: {
      mode: "source_claim",
      basis:
        request.changes.basis === undefined ? `用户更正：${request.reason}` : request.changes.basis,
      sourceIds: [],
    },
    validity: {
      status,
      validFrom:
        request.changes.validity?.validFrom === undefined
          ? (base.validity.validFrom ?? null)
          : request.changes.validity.validFrom,
      validTo:
        request.changes.validity?.validTo === undefined
          ? (base.validity.validTo ?? null)
          : request.changes.validity.validTo,
    },
    confidence:
      request.changes.confidence === undefined
        ? Math.max(base.confidence ?? 0, 0.95)
        : request.changes.confidence,
    confirmationStatus: "confirmed",
  };
  return createSupersedeRelationOperation(snapshot, {
    assertionId: request.relationId,
    reason: request.reason,
    replacement,
  });
}

export function createAgentMutationPlan(
  rawRequest: unknown,
  snapshot: ArchiveMutationSnapshot,
  options: { id?: string; createdAt?: number } = {},
) {
  const parsedRequest = agentMutationRequestSchema.parse(rawRequest);
  const request = {
    ...parsedRequest,
    operations: normalizeAgentMutationOperations(
      compileCollectionMigrations(parsedRequest.operations, snapshot),
    ),
  };
  const deleteOperations = createDeletePeopleOperations(
    snapshot,
    request.operations
      .filter(
        (operation): operation is z.infer<typeof deletePersonRequestSchema> =>
          operation.kind === "delete_person",
      )
      .map((operation) => ({ personId: operation.personId, reason: operation.reason })),
  );
  let deleteIndex = 0;
  const operations = request.operations.map((operation) => {
    if (operation.kind === "update_person") {
      return createUpdatePersonOperation(snapshot, {
        personId: operation.personId,
        reason: operation.reason,
        changes: operation.changes,
      });
    }
    if (operation.kind === "update_relation") return relationReplacement(snapshot, operation);
    if (operation.kind === "update_event") {
      return createUpdateEventOperation(snapshot, {
        eventId: operation.eventId,
        reason: operation.reason,
        changes: operation.changes,
      });
    }
    if (operation.kind === "organize_collection") {
      const collectionId = operation.collectionId ?? `collection:${crypto.randomUUID()}`;
      return createOrganizeCollectionOperation(snapshot, {
        collectionId,
        reason: operation.reason,
        replacement: { ...operation.replacement, color: operation.replacement.color ?? null },
        memberships: [
          ...(operation.addPersonIds ?? []).map((personId) => ({
            personId,
            action: "add" as const,
          })),
          ...(operation.removePersonIds ?? []).map((personId) => ({
            personId,
            action: "remove" as const,
          })),
        ],
      });
    }
    return deleteOperations[deleteIndex++];
  });
  const plan = createArchiveMutationPlan(
    { title: request.title, reason: request.reason, operations },
    options,
  );
  return {
    plan,
    diff: prepareArchiveMutationPlan(plan, snapshot, {
      now: options.createdAt ?? Date.now(),
    }).diff,
  };
}

export function parseArchiveMutationPlan(value: unknown): ArchiveMutationPlan {
  return archiveMutationPlanSchema.parse(value);
}
