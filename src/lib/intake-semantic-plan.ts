import { z } from "zod";

const semanticText = (maximum: number) => z.string().trim().min(1).max(maximum);

export const semanticPersonHintsSchema = z
  .object({
    alias: semanticText(200).optional(),
    relation: semanticText(200).optional(),
    title: semanticText(200).optional(),
    org: semanticText(300).optional(),
    department: semanticText(200).optional(),
  })
  .strict();

export const semanticSelfRefSchema = z.object({ kind: z.literal("self") }).strict();

export const semanticPersonRefSchema = z
  .object({
    kind: z.literal("person"),
    name: semanticText(200),
    hints: semanticPersonHintsSchema.optional(),
  })
  .strict();

export const semanticWorkspaceDomainSchema = z.enum([
  "person",
  "fact",
  "relation",
  "event",
  "reminder",
  "evidence",
]);

export const semanticWorkspaceRefSchema = z
  .object({
    kind: z.literal("workspace"),
    domain: semanticWorkspaceDomainSchema,
    recordRef: semanticText(300),
  })
  .strict();

export const semanticPersonWorkspaceRefSchema = z
  .object({
    kind: z.literal("workspace"),
    domain: z.literal("person"),
    recordRef: semanticText(300),
  })
  .strict();

export const semanticPersonEndpointSchema = z.discriminatedUnion("kind", [
  semanticSelfRefSchema,
  semanticPersonRefSchema,
  semanticPersonWorkspaceRefSchema,
]);

export const semanticEventRefSchema = z
  .object({
    kind: z.literal("event"),
    title: semanticText(500),
    date: semanticText(40).optional(),
    eventKind: semanticText(100).optional(),
    person: semanticPersonEndpointSchema.optional(),
  })
  .strict();

export const semanticFactRefSchema = z
  .object({
    kind: z.literal("fact"),
    person: semanticPersonEndpointSchema,
    key: semanticText(200),
  })
  .strict();

export const semanticReminderRefSchema = z
  .object({
    kind: z.literal("reminder"),
    title: semanticText(500),
    due: semanticText(40).optional(),
    person: semanticPersonEndpointSchema.optional(),
  })
  .strict();

export const semanticEvidenceRefSchema = z
  .object({
    kind: z.literal("evidence"),
    title: semanticText(500),
    origin: semanticText(300).optional(),
  })
  .strict();

export const semanticRelationRefSchema = z
  .object({
    kind: z.literal("relation"),
    from: semanticPersonEndpointSchema,
    to: semanticPersonEndpointSchema,
    label: semanticText(300).optional(),
    direction: z.enum(["either", "from_to"]).optional(),
    recordType: z.enum(["assertion", "derived", "any"]).optional(),
  })
  .strict();

export const semanticCollectionRefSchema = z
  .object({
    kind: z.literal("collection"),
    name: semanticText(100),
    collectionKind: z.enum(["relationship_circle", "context", "computed_community"]).optional(),
  })
  .strict();

const allPeopleSelectionSchema = z
  .object({
    kind: z.literal("person_selection"),
    scope: z.literal("all"),
  })
  .strict();

const collectionPeopleSelectionSchema = z
  .object({
    kind: z.literal("person_selection"),
    scope: z.literal("collection"),
    collection: semanticCollectionRefSchema,
  })
  .strict();

export const semanticPersonSelectionSchema = z.discriminatedUnion("scope", [
  allPeopleSelectionSchema,
  collectionPeopleSelectionSchema,
]);

export const semanticRecordRefSchema = z.union([
  semanticSelfRefSchema,
  semanticPersonRefSchema,
  semanticWorkspaceRefSchema,
  semanticFactRefSchema,
  semanticEventRefSchema,
  semanticReminderRefSchema,
  semanticEvidenceRefSchema,
  semanticRelationRefSchema,
  semanticCollectionRefSchema,
  semanticPersonSelectionSchema,
]);

const changesSchema = z.record(z.unknown()).superRefine((changes, context) => {
  const forbidden = new Set([
    "id",
    "fromId",
    "toId",
    "personId",
    "personDraftId",
    "fromPersonId",
    "toPersonId",
    "fromDraftId",
    "toDraftId",
    "peopleIds",
    "peoplePersonIds",
    "peopleDraftIds",
    "targetPersonId",
    "relationId",
    "targetRelationId",
    "eventId",
    "targetEventId",
    "reminderId",
    "evidenceId",
    "collectionId",
    "membershipId",
    "_draftId",
  ]);
  const visit = (value: unknown, path: Array<string | number>) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, [...path, index]));
      return;
    }
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (forbidden.has(key)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `模型语义计划不能携带稳定 ID 字段：${key}`,
          path: [...path, key],
        });
      }
      visit(item, [...path, key]);
    }
  };
  visit(changes, []);
});
const taskIdSchema = semanticText(100);

const personTaskSchema = z
  .object({
    id: taskIdSchema,
    domain: z.literal("person"),
    intent: z.enum(["create", "update"]),
    target: z.union([
      semanticSelfRefSchema,
      semanticPersonRefSchema,
      semanticPersonWorkspaceRefSchema,
    ]),
    changes: changesSchema,
  })
  .strict();

const eventTaskSchema = z
  .object({
    id: taskIdSchema,
    domain: z.literal("event"),
    intent: z.enum(["create", "update"]),
    target: z.union([
      semanticEventRefSchema,
      semanticWorkspaceRefSchema.refine((value) => value.domain === "event", {
        message: "事件任务的 workspace 引用必须指向 event",
      }),
    ]),
    changes: changesSchema,
  })
  .strict();

const factTaskSchema = z
  .object({
    id: taskIdSchema,
    domain: z.literal("fact"),
    intent: z.enum(["create", "update"]),
    target: z.union([
      semanticFactRefSchema,
      semanticWorkspaceRefSchema.refine((value) => value.domain === "fact", {
        message: "事实任务的 workspace 引用必须指向 fact",
      }),
    ]),
    changes: changesSchema,
  })
  .strict();

const relationTaskSchema = z
  .object({
    id: taskIdSchema,
    domain: z.literal("relation"),
    intent: z.enum(["create", "update"]),
    target: z.union([
      semanticRelationRefSchema,
      semanticWorkspaceRefSchema.refine((value) => value.domain === "relation", {
        message: "关系任务的 workspace 引用必须指向 relation",
      }),
    ]),
    changes: changesSchema,
  })
  .strict();

const reminderTaskSchema = z
  .object({
    id: taskIdSchema,
    domain: z.literal("reminder"),
    intent: z.enum(["create", "update"]),
    target: z.union([
      semanticReminderRefSchema,
      semanticWorkspaceRefSchema.refine((value) => value.domain === "reminder", {
        message: "提醒任务的 workspace 引用必须指向 reminder",
      }),
    ]),
    changes: changesSchema,
  })
  .strict();

const evidenceTaskSchema = z
  .object({
    id: taskIdSchema,
    domain: z.literal("evidence"),
    intent: z.enum(["create", "update"]),
    target: z.union([
      semanticEvidenceRefSchema,
      semanticWorkspaceRefSchema.refine((value) => value.domain === "evidence", {
        message: "材料任务的 workspace 引用必须指向 evidence",
      }),
    ]),
    changes: changesSchema,
  })
  .strict();

const collectionMembershipSchema = z
  .object({
    people: z.union([semanticPersonEndpointSchema, semanticPersonSelectionSchema]),
    action: z.enum(["add", "remove"]),
  })
  .strict();

export const organizeCollectionTaskSchema = z
  .object({
    id: taskIdSchema,
    domain: z.literal("collection"),
    intent: z.literal("organize"),
    target: semanticCollectionRefSchema,
    changes: z
      .object({
        name: semanticText(100).optional(),
        collectionKind: z.enum(["relationship_circle", "context"]).optional(),
        color: z.string().trim().max(50).nullable().optional(),
      })
      .strict()
      .optional(),
    memberships: z.array(collectionMembershipSchema).max(500).default([]),
  })
  .strict();

/**
 * A whole-library classification request is only an intent declaration. The
 * model does not enumerate archive people here; the intake harness expands the
 * selection into bounded batches with opaque, run-local references.
 */
const classifyCollectionTaskSchema = z
  .object({
    id: taskIdSchema,
    domain: z.literal("collection"),
    intent: z.literal("classify"),
    target: semanticPersonSelectionSchema,
    guidance: z.string().trim().max(1_000).optional(),
  })
  .strict();

export const semanticIntakeTaskSchema = z.union([
  personTaskSchema,
  factTaskSchema,
  eventTaskSchema,
  relationTaskSchema,
  reminderTaskSchema,
  evidenceTaskSchema,
  organizeCollectionTaskSchema,
  classifyCollectionTaskSchema,
]);

export const semanticCollectionClassificationSchema = z
  .object({
    name: semanticText(100),
    color: z.string().trim().max(50).nullable().optional(),
  })
  .strict();

const semanticCollectionClassificationAssignmentSchema = z
  .object({
    ref: semanticText(100),
    collections: z.array(semanticCollectionClassificationSchema).max(12),
    reason: z.string().trim().max(300).optional(),
  })
  .strict();

export const semanticCollectionClassificationBatchSchema = z
  .object({
    version: z.literal(1),
    type: z.literal("collection_classification_batch"),
    taskRef: semanticText(100),
    batchRef: semanticText(100),
    assignments: z.array(z.unknown()).max(1_000),
  })
  .strict();

export const semanticIntakePlanSchema = z
  .object({
    version: z.literal(1),
    type: z.literal("semantic_plan"),
    summary: z.string().trim().max(1_000).optional(),
    tasks: z.array(semanticIntakeTaskSchema).min(1).max(1_000),
  })
  .strict()
  .superRefine((plan, context) => {
    const ids = new Set<string>();
    for (const [index, task] of plan.tasks.entries()) {
      if (ids.has(task.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `语义计划存在重复任务 ID：${task.id}`,
          path: ["tasks", index, "id"],
        });
      }
      ids.add(task.id);
    }
  });

export type SemanticPersonHints = z.infer<typeof semanticPersonHintsSchema>;
export type SemanticSelfRef = z.infer<typeof semanticSelfRefSchema>;
export type SemanticPersonRef = z.infer<typeof semanticPersonRefSchema>;
export type SemanticWorkspaceRef = z.infer<typeof semanticWorkspaceRefSchema>;
export type SemanticPersonEndpoint = z.infer<typeof semanticPersonEndpointSchema>;
export type SemanticFactRef = z.infer<typeof semanticFactRefSchema>;
export type SemanticEventRef = z.infer<typeof semanticEventRefSchema>;
export type SemanticReminderRef = z.infer<typeof semanticReminderRefSchema>;
export type SemanticEvidenceRef = z.infer<typeof semanticEvidenceRefSchema>;
export type SemanticRelationRef = z.infer<typeof semanticRelationRefSchema>;
export type SemanticCollectionRef = z.infer<typeof semanticCollectionRefSchema>;
export type SemanticPersonSelection = z.infer<typeof semanticPersonSelectionSchema>;
export type SemanticRecordRef = z.infer<typeof semanticRecordRefSchema>;
export type SemanticIntakeTask = z.infer<typeof semanticIntakeTaskSchema>;
export type SemanticIntakePlan = z.infer<typeof semanticIntakePlanSchema>;
export type SemanticCollectionClassification = z.infer<
  typeof semanticCollectionClassificationSchema
>;
export type SemanticCollectionClassificationAssignment = z.infer<
  typeof semanticCollectionClassificationAssignmentSchema
>;

export interface SemanticCollectionClassificationParseIssue {
  assignmentIndex?: number;
  ref?: string;
  message: string;
}

/** Parse one classifier response item by item so a malformed row stays local. */
export function parseSemanticCollectionClassificationBatch(raw: unknown): {
  taskRef: string;
  batchRef: string;
  assignments: SemanticCollectionClassificationAssignment[];
  issues: SemanticCollectionClassificationParseIssue[];
} {
  const root = semanticCollectionClassificationBatchSchema.parse(raw);
  const assignments: SemanticCollectionClassificationAssignment[] = [];
  const issues: SemanticCollectionClassificationParseIssue[] = [];
  const seen = new Set<string>();
  root.assignments.forEach((rawAssignment, assignmentIndex) => {
    const parsed = semanticCollectionClassificationAssignmentSchema.safeParse(rawAssignment);
    const rawRef =
      rawAssignment && typeof rawAssignment === "object" && !Array.isArray(rawAssignment)
        ? (rawAssignment as Record<string, unknown>).ref
        : undefined;
    const ref = typeof rawRef === "string" && rawRef.trim() ? rawRef.trim() : undefined;
    if (!parsed.success) {
      issues.push({
        assignmentIndex,
        ref,
        message: parsed.error.issues.map((issue) => issue.message).join("；"),
      });
      return;
    }
    if (seen.has(parsed.data.ref)) {
      issues.push({
        assignmentIndex,
        ref: parsed.data.ref,
        message: `批次中重复出现人物引用：${parsed.data.ref}`,
      });
      return;
    }
    seen.add(parsed.data.ref);
    assignments.push(parsed.data);
  });
  return { taskRef: root.taskRef, batchRef: root.batchRef, assignments, issues };
}

export interface SemanticPlanParseIssue {
  taskIndex?: number;
  taskId?: string;
  message: string;
}

/**
 * Parse a model plan item by item. A malformed sibling remains a visible issue
 * and cannot invalidate tasks whose contracts are already complete.
 */
export function parseSemanticIntakePlan(raw: unknown): {
  plan: SemanticIntakePlan;
  issues: SemanticPlanParseIssue[];
} {
  const root = z
    .object({
      version: z.literal(1),
      type: z.literal("semantic_plan"),
      summary: z.string().trim().max(1_000).optional(),
      tasks: z.array(z.unknown()).min(1).max(1_000),
    })
    .strict()
    .parse(raw);
  const tasks: SemanticIntakeTask[] = [];
  const issues: SemanticPlanParseIssue[] = [];
  const seen = new Set<string>();
  root.tasks.forEach((rawTask, taskIndex) => {
    const parsed = semanticIntakeTaskSchema.safeParse(rawTask);
    const rawId =
      rawTask && typeof rawTask === "object" && !Array.isArray(rawTask)
        ? (rawTask as Record<string, unknown>).id
        : undefined;
    const taskId = typeof rawId === "string" && rawId.trim() ? rawId.trim() : undefined;
    if (!parsed.success) {
      issues.push({
        taskIndex,
        taskId,
        message: parsed.error.issues.map((issue) => issue.message).join("；"),
      });
      return;
    }
    if (seen.has(parsed.data.id)) {
      issues.push({
        taskIndex,
        taskId: parsed.data.id,
        message: `语义计划存在重复任务 ID：${parsed.data.id}`,
      });
      return;
    }
    seen.add(parsed.data.id);
    tasks.push(parsed.data);
  });
  return {
    plan: {
      version: 1,
      type: "semantic_plan",
      summary: root.summary,
      tasks,
    },
    issues,
  };
}
