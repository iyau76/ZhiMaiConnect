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
          deletePersonRequestSchema,
        ]),
      )
      .min(1)
      .max(100),
  })
  .strict();

export type AgentMutationRequest = z.infer<typeof agentMutationRequestSchema>;

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
  const request = agentMutationRequestSchema.parse(rawRequest);
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
