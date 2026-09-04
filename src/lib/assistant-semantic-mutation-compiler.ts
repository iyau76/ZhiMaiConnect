import { z } from "zod";

import { agentMutationRequestSchema, type AgentMutationRequest } from "./archive-mutation-agent";
import {
  resolveSemanticRecordRef,
  type ArchiveRecordResolverSnapshot,
  type RecordResolution,
  type ResolvedRecordCandidate,
} from "./archive-record-resolver";
import type { CollectionRecord } from "./face-db";
import {
  semanticCollectionRefSchema,
  semanticEventRefSchema,
  semanticPersonEndpointSchema,
  semanticRelationRefSchema,
} from "./intake-semantic-plan";

const text = (maximum: number) => z.string().trim().min(1).max(maximum);
const reasonSchema = text(1_000);
const operationRefSchema = text(120).optional();
const editableCollectionKindSchema = z.enum(["relationship_circle", "context"]);

const newCollectionRefSchema = z
  .object({
    kind: z.literal("new_collection"),
    name: text(100),
    collectionKind: editableCollectionKindSchema,
    color: text(40).nullable().optional(),
  })
  .strict();

const collectionTargetSchema = z.union([semanticCollectionRefSchema, newCollectionRefSchema]);

const personUpdateSchema = z
  .object({
    operationRef: operationRefSchema,
    kind: z.literal("update_person"),
    target: semanticPersonEndpointSchema,
    reason: reasonSchema,
    changes: z.unknown(),
  })
  .strict();

const relationUpdateSchema = z
  .object({
    operationRef: operationRefSchema,
    kind: z.literal("update_relation"),
    target: semanticRelationRefSchema,
    reason: reasonSchema,
    changes: z.unknown(),
  })
  .strict();

const eventUpdateSchema = z
  .object({
    operationRef: operationRefSchema,
    kind: z.literal("update_event"),
    target: semanticEventRefSchema,
    reason: reasonSchema,
    changes: z
      .object({
        set: z
          .object({
            date: text(10).optional(),
            dateEnd: text(10).optional(),
            precision: z.enum(["day", "month", "year", "range"]).optional(),
            title: text(500).optional(),
            detail: z.string().max(4_000).optional(),
            place: text(500).optional(),
            people: z.array(semanticPersonEndpointSchema).max(100).optional(),
            kind: text(100).optional(),
          })
          .strict()
          .optional(),
        unset: z
          .array(z.enum(["dateEnd", "precision", "detail", "place", "kind"]))
          .max(5)
          .optional(),
        clear: z.array(z.literal("people")).max(1).optional(),
      })
      .strict(),
  })
  .strict();

const collectionChangesSchema = z
  .object({
    name: text(100).optional(),
    kind: editableCollectionKindSchema.optional(),
    color: text(40).nullable().optional(),
  })
  .strict();

const organizeCollectionSchema = z
  .object({
    operationRef: operationRefSchema,
    kind: z.literal("organize_collection"),
    target: collectionTargetSchema,
    reason: reasonSchema,
    changes: collectionChangesSchema.optional(),
    addPeople: z.array(semanticPersonEndpointSchema).max(200).optional(),
    removePeople: z.array(semanticPersonEndpointSchema).max(200).optional(),
  })
  .strict();

const migrateCollectionMembersSchema = z
  .object({
    operationRef: operationRefSchema,
    kind: z.literal("migrate_collection_members"),
    source: semanticCollectionRefSchema,
    target: collectionTargetSchema,
    selectedPeople: z.array(semanticPersonEndpointSchema).min(1).max(200),
    reason: reasonSchema,
  })
  .strict();

const deletePersonSchema = z
  .object({
    operationRef: operationRefSchema,
    kind: z.literal("delete_person"),
    target: semanticPersonEndpointSchema,
    reason: reasonSchema,
  })
  .strict();

const semanticMutationOperationSchema = z.discriminatedUnion("kind", [
  personUpdateSchema,
  relationUpdateSchema,
  eventUpdateSchema,
  organizeCollectionSchema,
  migrateCollectionMembersSchema,
  deletePersonSchema,
]);

const semanticProposalHeaderSchema = z
  .object({
    title: text(200),
    reason: reasonSchema,
    operations: z.array(z.unknown()).min(1).max(100),
  })
  .strict();

const RAW_ARCHIVE_ID_FIELDS = new Set([
  "personId",
  "relationId",
  "eventId",
  "collectionId",
  "sourceCollectionId",
  "selectedPersonIds",
  "addPersonIds",
  "removePersonIds",
  "targetId",
  "fromId",
  "toId",
]);

export type AssistantSemanticMutationIssueCode =
  "invalid" | "raw_id_forbidden" | "missing" | "ambiguous" | "wrong_domain" | "not_archived";

export interface AssistantSemanticMutationIssue {
  operationRef: string;
  operationIndex: number;
  code: AssistantSemanticMutationIssueCode;
  path: string;
  message: string;
  candidates?: Array<{ label: string; domain: string }>;
}

export interface AssistantSemanticMutationCompilation {
  request?: AgentMutationRequest;
  issues: AssistantSemanticMutationIssue[];
  resolvedOperationRefs: string[];
}

type SemanticMutationOperation = z.infer<typeof semanticMutationOperationSchema>;
type StableMutationOperation = AgentMutationRequest["operations"][number];

function operationRef(raw: unknown, index: number) {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const value = (raw as Record<string, unknown>).operationRef;
    if (typeof value === "string" && value.trim()) return value.trim().slice(0, 120);
  }
  return `operation-${index + 1}`;
}

function issue(options: {
  operationRef: string;
  operationIndex: number;
  code: AssistantSemanticMutationIssueCode;
  path: string;
  message: string;
  resolution?: RecordResolution;
}): AssistantSemanticMutationIssue {
  return {
    operationRef: options.operationRef,
    operationIndex: options.operationIndex,
    code: options.code,
    path: options.path,
    message: options.message,
    candidates: options.resolution?.candidates.length
      ? options.resolution.candidates.map((candidate) => ({
          label: candidate.label,
          domain: candidate.domain,
        }))
      : undefined,
  };
}

function rawIdFields(raw: unknown, path = ""): string[] {
  if (Array.isArray(raw)) {
    return raw.flatMap((value, index) => rawIdFields(value, `${path}[${index}]`));
  }
  if (!raw || typeof raw !== "object") return [];
  return Object.entries(raw as Record<string, unknown>).flatMap(([key, value]) => {
    const fieldPath = path ? `${path}.${key}` : key;
    return [
      ...(RAW_ARCHIVE_ID_FIELDS.has(key) || /PersonIds$/u.test(key) ? [fieldPath] : []),
      ...rawIdFields(value, fieldPath),
    ];
  });
}

function resolvedArchiveCandidate(options: {
  ref: unknown;
  expectedDomain: ResolvedRecordCandidate["domain"];
  snapshot: ArchiveRecordResolverSnapshot;
  operationRef: string;
  operationIndex: number;
  path: string;
  issues: AssistantSemanticMutationIssue[];
}) {
  const resolution = resolveSemanticRecordRef(options.ref, options.snapshot);
  if (resolution.status !== "resolved" || resolution.cardinality !== "one") {
    options.issues.push(
      issue({
        operationRef: options.operationRef,
        operationIndex: options.operationIndex,
        code: resolution.status === "ambiguous" ? "ambiguous" : "missing",
        path: options.path,
        message: resolution.status === "resolved" ? "语义引用没有唯一目标" : resolution.reason,
        resolution,
      }),
    );
    return undefined;
  }
  const candidate = resolution.candidates[0];
  if (candidate.domain !== options.expectedDomain) {
    options.issues.push(
      issue({
        operationRef: options.operationRef,
        operationIndex: options.operationIndex,
        code: "wrong_domain",
        path: options.path,
        message: `语义引用解析为 ${candidate.domain}，这里需要 ${options.expectedDomain}`,
        resolution,
      }),
    );
    return undefined;
  }
  if (candidate.source !== "archive") {
    options.issues.push(
      issue({
        operationRef: options.operationRef,
        operationIndex: options.operationIndex,
        code: "not_archived",
        path: options.path,
        message: `“${candidate.label}”还不是可修改的正式档案`,
        resolution,
      }),
    );
    return undefined;
  }
  return candidate;
}

function resolvePeople(options: {
  refs: readonly unknown[] | undefined;
  snapshot: ArchiveRecordResolverSnapshot;
  operationRef: string;
  operationIndex: number;
  path: string;
  issues: AssistantSemanticMutationIssue[];
}) {
  const ids: string[] = [];
  (options.refs ?? []).forEach((ref, index) => {
    const candidate = resolvedArchiveCandidate({
      ref,
      expectedDomain: "person",
      snapshot: options.snapshot,
      operationRef: options.operationRef,
      operationIndex: options.operationIndex,
      path: `${options.path}[${index}]`,
      issues: options.issues,
    });
    if (candidate) ids.push(candidate.id);
  });
  return [...new Set(ids)];
}

function collectionTarget(options: {
  target: z.infer<typeof collectionTargetSchema>;
  snapshot: ArchiveRecordResolverSnapshot;
  operationRef: string;
  operationIndex: number;
  path: string;
  issues: AssistantSemanticMutationIssue[];
}) {
  if (options.target.kind === "new_collection") {
    return {
      name: options.target.name,
      kind: options.target.collectionKind,
      color: options.target.color ?? null,
    };
  }
  const candidate = resolvedArchiveCandidate({
    ref: options.target,
    expectedDomain: "collection",
    snapshot: options.snapshot,
    operationRef: options.operationRef,
    operationIndex: options.operationIndex,
    path: options.path,
    issues: options.issues,
  });
  if (!candidate) return undefined;
  const collection = candidate.record as CollectionRecord;
  if (collection.kind === "computed_community") {
    options.issues.push(
      issue({
        operationRef: options.operationRef,
        operationIndex: options.operationIndex,
        code: "wrong_domain",
        path: options.path,
        message: `拓扑社区“${collection.name}”是可重建投影，不能手工修改`,
      }),
    );
    return undefined;
  }
  return {
    collectionId: collection.id,
    name: collection.name,
    kind: collection.kind,
    color: collection.color ?? null,
  };
}

function stableOperation(options: {
  operation: SemanticMutationOperation;
  snapshot: ArchiveRecordResolverSnapshot;
  operationRef: string;
  operationIndex: number;
  issues: AssistantSemanticMutationIssue[];
}): StableMutationOperation | undefined {
  const { operation, snapshot, operationRef: ref, operationIndex, issues } = options;
  if (operation.kind === "update_person") {
    const target = resolvedArchiveCandidate({
      ref: operation.target,
      expectedDomain: "person",
      snapshot,
      operationRef: ref,
      operationIndex,
      path: "target",
      issues,
    });
    return target
      ? {
          kind: operation.kind,
          personId: target.id,
          reason: operation.reason,
          changes: operation.changes as never,
        }
      : undefined;
  }
  if (operation.kind === "update_relation") {
    const target = resolvedArchiveCandidate({
      ref: operation.target,
      expectedDomain: "relation",
      snapshot,
      operationRef: ref,
      operationIndex,
      path: "target",
      issues,
    });
    return target
      ? {
          kind: operation.kind,
          relationId: target.id,
          reason: operation.reason,
          changes: operation.changes as never,
        }
      : undefined;
  }
  if (operation.kind === "update_event") {
    const target = resolvedArchiveCandidate({
      ref: operation.target,
      expectedDomain: "event",
      snapshot,
      operationRef: ref,
      operationIndex,
      path: "target",
      issues,
    });
    if (!target) return undefined;
    const people = resolvePeople({
      refs: operation.changes.set?.people,
      snapshot,
      operationRef: ref,
      operationIndex,
      path: "changes.set.people",
      issues,
    });
    const { people: _people, ...set } = operation.changes.set ?? {};
    return {
      kind: operation.kind,
      eventId: target.id,
      reason: operation.reason,
      changes: {
        ...(Object.keys(set).length || operation.changes.set?.people
          ? { set: { ...set, ...(people.length ? { personIds: people } : {}) } }
          : {}),
        ...(operation.changes.unset ? { unset: operation.changes.unset } : {}),
        ...(operation.changes.clear?.includes("people") ? { clear: ["personIds" as const] } : {}),
      },
    };
  }
  if (operation.kind === "organize_collection") {
    const target = collectionTarget({
      target: operation.target,
      snapshot,
      operationRef: ref,
      operationIndex,
      path: "target",
      issues,
    });
    if (!target) return undefined;
    const addPersonIds = resolvePeople({
      refs: operation.addPeople,
      snapshot,
      operationRef: ref,
      operationIndex,
      path: "addPeople",
      issues,
    });
    const removePersonIds = resolvePeople({
      refs: operation.removePeople,
      snapshot,
      operationRef: ref,
      operationIndex,
      path: "removePeople",
      issues,
    });
    return {
      kind: operation.kind,
      ...(target.collectionId ? { collectionId: target.collectionId } : {}),
      reason: operation.reason,
      replacement: {
        name: operation.changes?.name ?? target.name,
        kind: operation.changes?.kind ?? target.kind,
        color: operation.changes?.color === undefined ? target.color : operation.changes.color,
      },
      ...(operation.addPeople ? { addPersonIds } : {}),
      ...(operation.removePeople ? { removePersonIds } : {}),
    };
  }
  if (operation.kind === "migrate_collection_members") {
    const source = resolvedArchiveCandidate({
      ref: operation.source,
      expectedDomain: "collection",
      snapshot,
      operationRef: ref,
      operationIndex,
      path: "source",
      issues,
    });
    const target = collectionTarget({
      target: operation.target,
      snapshot,
      operationRef: ref,
      operationIndex,
      path: "target",
      issues,
    });
    const selectedPersonIds = resolvePeople({
      refs: operation.selectedPeople,
      snapshot,
      operationRef: ref,
      operationIndex,
      path: "selectedPeople",
      issues,
    });
    if (!source || !target || !selectedPersonIds.length) return undefined;
    return {
      kind: operation.kind,
      sourceCollectionId: source.id,
      target,
      selectedPersonIds,
      reason: operation.reason,
    };
  }
  const target = resolvedArchiveCandidate({
    ref: operation.target,
    expectedDomain: "person",
    snapshot,
    operationRef: ref,
    operationIndex,
    path: "target",
    issues,
  });
  return target
    ? { kind: operation.kind, personId: target.id, reason: operation.reason }
    : undefined;
}

function invalidOperationIssue(raw: unknown, index: number, error: z.ZodError) {
  const ref = operationRef(raw, index);
  const forbidden = rawIdFields(raw);
  if (forbidden.length) {
    return issue({
      operationRef: ref,
      operationIndex: index,
      code: "raw_id_forbidden",
      path: forbidden.join(","),
      message: `模型提案只能使用语义 target，不接受稳定 ID 字段：${forbidden.join("、")}`,
    });
  }
  const first = error.issues[0];
  return issue({
    operationRef: ref,
    operationIndex: index,
    code: "invalid",
    path: first?.path.join(".") || `operations[${index}]`,
    message: first?.message ?? "变更项不符合语义提案协议",
  });
}

/**
 * Resolve model-authored semantic targets against one complete local snapshot.
 * Stable archive IDs exist only in the returned internal transaction request.
 */
export function compileAssistantSemanticMutation(options: {
  candidate: unknown;
  snapshot: ArchiveRecordResolverSnapshot;
}): AssistantSemanticMutationCompilation {
  const parsedHeader = semanticProposalHeaderSchema.safeParse(options.candidate);
  if (!parsedHeader.success) {
    const first = parsedHeader.error.issues[0];
    return {
      issues: [
        issue({
          operationRef: "proposal",
          operationIndex: -1,
          code: "invalid",
          path: first?.path.join(".") || "proposal",
          message: first?.message ?? "提案根结构不符合协议",
        }),
      ],
      resolvedOperationRefs: [],
    };
  }

  const issues: AssistantSemanticMutationIssue[] = [];
  const operations: StableMutationOperation[] = [];
  const resolvedOperationRefs: string[] = [];
  parsedHeader.data.operations.forEach((raw, index) => {
    const parsedOperation = semanticMutationOperationSchema.safeParse(raw);
    if (!parsedOperation.success) {
      issues.push(invalidOperationIssue(raw, index, parsedOperation.error));
      return;
    }
    const ref = parsedOperation.data.operationRef ?? `operation-${index + 1}`;
    const operation = stableOperation({
      operation: parsedOperation.data,
      snapshot: options.snapshot,
      operationRef: ref,
      operationIndex: index,
      issues,
    });
    if (!operation) return;
    const stable = agentMutationRequestSchema.safeParse({
      title: parsedHeader.data.title,
      reason: parsedHeader.data.reason,
      operations: [operation],
    });
    if (!stable.success) {
      const first = stable.error.issues[0];
      issues.push(
        issue({
          operationRef: ref,
          operationIndex: index,
          code: "invalid",
          path: first?.path.join(".") || `operations[${index}]`,
          message: first?.message ?? "解析后的变更项不符合事务协议",
        }),
      );
      return;
    }
    operations.push(stable.data.operations[0]);
    resolvedOperationRefs.push(ref);
  });

  return {
    request: operations.length
      ? agentMutationRequestSchema.parse({
          title: parsedHeader.data.title,
          reason: parsedHeader.data.reason,
          operations,
        })
      : undefined,
    issues,
    resolvedOperationRefs,
  };
}
