import { parseLooseJson } from "./ai-text";
import { composeAgentPrompt, fitPlainAgentContext } from "./agent-prompt-budget";
import { archiveAgentToolRegistry } from "./archive-agent-tools";
import {
  MemoryAgentRunRecorder,
  projectAgentRun,
  type AgentRun,
  type AgentRunRecorder,
} from "./agent-run-log";
import { resolveSavedAgentBudget, saveAgentRunBestEffort } from "./agent-observability";
import {
  AgentRuntime,
  resolveAgentBudget,
  type AgentBudget,
  type AgentBudgetPreset,
  type AgentBudgetSnapshot,
  type AgentFinalizeReason,
} from "./agent-runtime";
import type {
  CollectionMembershipRecord,
  CollectionRecord,
  EvidenceRecord,
  LifeEventRecord,
  PersonRecord,
  RelationRecord,
  ReminderRecord,
} from "./face-db";
import { ingestPersonSchema, type IngestCandidate, type IngestRelation } from "./intake-draft";
import { describeAgentToolInput } from "./agent-tool-registry";
import { ingestEventSchema, ingestReminderSchema } from "./intake-draft";
import { askModel } from "./vision-client";
import type { ProviderPreset } from "./vision-providers";
import { ensureIntakeWorkspace, intakeWorkspaceView } from "./intake-workspace";
import { inferRelationSemantics, type RelationPredicate } from "./relation-ontology";
import type { AgentTraceEvent } from "./agent-trace";
import { archiveRecordRevision, type ArchiveMutationPlan } from "./archive-mutation-plan";
import { ModelRetryExhaustedError } from "./model-transport-resilience";
import {
  compileSemanticIntakePlan,
  type IntakeSemanticCompilation,
  type IntakeSemanticCompilerSnapshot,
  type LocalCollectionClassificationResult,
} from "./intake-semantic-compiler";
import type { SemanticIntakeIssue, SemanticIntakeTaskSnapshot } from "./intake-task-state";
import {
  parseSemanticCollectionClassificationBatch,
  parseSemanticIntakePlan,
  organizeCollectionTaskSchema,
  type SemanticIntakeTask,
} from "./intake-semantic-plan";
import { resolveSemanticRecordRef } from "./archive-record-resolver";

const MAX_HISTORY = 8_000;

export interface IntakePromptSections {
  knownContext?: string;
  sourceMaterial: string;
}

/** @deprecated Import AgentTraceEvent from agent-trace for new integrations. */
export type IntakeAgentTrace = AgentTraceEvent;

function normalized(value: string | undefined) {
  return (value ?? "").trim().toLocaleLowerCase("zh-CN");
}

function semanticArchiveOverview(
  persons: readonly PersonRecord[],
  relations: readonly RelationRecord[],
  events: readonly LifeEventRecord[],
  collections: readonly CollectionRecord[],
  collectionMemberships: readonly CollectionMembershipRecord[],
  workspace?: IngestCandidate,
) {
  const visibleCollections = collections
    .filter((collection) => collection.kind !== "computed_community")
    .sort((left, right) => left.name.localeCompare(right.name, "zh-CN"))
    .slice(0, 40)
    .map((collection) => ({ name: collection.name, kind: collection.kind }));
  return JSON.stringify({
    archive: {
      counts: {
        people: persons.length,
        relations: relations.filter((relation) => relation.recordType !== "derived").length,
        events: events.length,
        collections: collections.length,
        memberships: collectionMemberships.length,
      },
      editableCollections: visibleCollections,
      omittedCollections: Math.max(0, collections.length - visibleCollections.length),
    },
    ...(workspace ? { workspace: intakeWorkspaceView(workspace) } : {}),
  });
}

function compactClaimText(value: string) {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/[\s，。；：、,.!?！？“”'"（）()]/g, "");
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const EXPLICIT_RELATION_CUES: Partial<Record<RelationPredicate, RegExp>> = {
  parent_of: /(父|母|爸|妈|儿子|女儿|孩子|子女|生了|parent|father|mother|son|daughter|child)/i,
  step_parent_of: /(继父|继母|stepfather|stepmother|stepparent)/i,
  spouse_of: /(夫妻|配偶|丈夫|妻|爱人|妾|嫁|娶|结婚|成婚|spouse|husband|wife|married)/i,
  sibling_of: /(兄弟|兄妹|姐弟|姐妹|哥哥|弟弟|姐姐|妹妹|同胞|sibling|brother|sister)/i,
  half_sibling_of: /(同父异母|同母异父|半血缘|half.?sibling)/i,
  step_sibling_of: /(继兄|继弟|继姐|继妹|继兄弟|继姐妹|step.?sibling)/i,
  grandparent_of: /(祖父|祖母|爷爷|奶奶|外公|外婆|祖孙|grandparent)/i,
  great_grandparent_of: /(曾祖|曾孙|great.?grand)/i,
  uncle_aunt_of: /(叔|伯|姑|舅|姨|侄|甥|uncle|aunt|nephew|niece)/i,
  cousin_of: /(堂|表亲|姑表|舅表|姨表|cousin)/i,
  in_law_of: /(翁媳|婆媳|岳父|岳母|公公|婆婆|叔嫂|姑嫂|姻亲|in.?law)/i,
};

function claimBodyWithoutEntityNames(basis: string, personNames: string[]) {
  let body = basis.replace(/^(原文|original)\s*[:：]/i, "");
  for (const name of [...new Set(personNames)].sort((a, b) => b.length - a.length)) {
    if (name.trim()) body = body.replace(new RegExp(escapeRegExp(name.trim()), "giu"), "");
  }
  return body;
}

type RelationClaimIssue = {
  relation: IngestRelation;
  message: string;
};

function personMentionIndex(passage: string, personName: string, personNames: string[]) {
  const target = compactClaimText(personName);
  if (!target) return -1;
  let body = compactClaimText(passage);
  const containingNames = [...new Set(personNames.map(compactClaimText))]
    .filter((name) => name !== target && name.length > target.length && name.includes(target))
    .sort((left, right) => right.length - left.length);
  for (const name of containingNames) body = body.replaceAll(name, " ".repeat(name.length));
  return body.indexOf(target);
}

function bodyWithPersonNamesMasked(passage: string, personNames: string[]) {
  let body = compactClaimText(passage);
  for (const name of [...new Set(personNames.map(compactClaimText))].sort(
    (left, right) => right.length - left.length,
  )) {
    if (name) body = body.replaceAll(name, " ".repeat(name.length));
  }
  return body;
}

/**
 * Bind a binary relation to the clause that states it. Cross-clause carry is
 * allowed only for an omitted subject ("王夫人是正妻，生了元春") or an
 * explicit plural pronoun ("贾兰是他们的儿子"). Merely appearing somewhere
 * in the same sentence is insufficient.
 */
function relationTextSupportsEndpoints(
  text: string,
  relation: IngestRelation,
  personNames: string[],
) {
  const predicate = inferRelationSemantics(relation.label).predicate;
  const cue = EXPLICIT_RELATION_CUES[predicate];
  const clauses = text
    .replace(/^(原文|original|推断依据|inference\s+basis)\s*[:：]/i, "")
    .split(/[，,；;。.!?！？]+/u)
    .map((clause) => clause.trim())
    .filter(Boolean);
  let fromSeen = false;
  let toSeen = false;
  for (const clause of clauses) {
    const fromIndex = personMentionIndex(clause, relation.from, personNames);
    const toIndex = personMentionIndex(clause, relation.to, personNames);
    const cueIndex = cue ? bodyWithPersonNamesMasked(clause, personNames).search(cue) : 0;
    const fromHere = fromIndex >= 0;
    const toHere = toIndex >= 0;
    if (fromHere && toHere && cueIndex >= 0) return true;

    if (cueIndex >= 0 && fromHere !== toHere && (fromHere ? toSeen : fromSeen)) {
      const unrelatedBeforeCue = personNames.some((name) => {
        if (
          normalized(name) === normalized(relation.from) ||
          normalized(name) === normalized(relation.to)
        ) {
          return false;
        }
        const index = personMentionIndex(clause, name, personNames);
        return index >= 0 && index < cueIndex;
      });
      const mentionedEndpointIndex = fromHere ? fromIndex : toIndex;
      const cueIntroducesObjects = cueIndex <= mentionedEndpointIndex;
      const explicitCarry = /(?:他们|她们|二人|两人|their)\s*(?:的|有|'s)?/i.test(clause);
      if (!unrelatedBeforeCue && (cueIntroducesObjects || explicitCarry)) return true;
    }
    fromSeen ||= fromHere;
    toSeen ||= toHere;
  }
  return false;
}

/**
 * Evidence wording is an audit concern, not a reason to regenerate a complete plan.
 * Keep the model's quote intact. Local name matching cannot choose a replacement
 * source sentence or resolve pronouns on the model's behalf.
 */
function auditModelRelations(
  draft: IngestCandidate,
  context: { sourceMaterial?: string; personNames?: string[] } = {},
) {
  const personNames = [
    ...(context.personNames ?? []),
    ...(draft.relations ?? []).flatMap((relation) => [relation.from, relation.to]),
  ];
  const issues: RelationClaimIssue[] = [];
  const addIssue = (relation: IngestRelation, message: string) => {
    issues.push({ relation, message });
  };
  for (const relation of draft.relations ?? []) {
    const basis = relation.basis?.trim() ?? "";
    if (!basis) {
      addIssue(relation, "AI 未提供可回查的原文依据");
      continue;
    }
    const explicit = /^(原文|original)\s*[:：]/i.test(basis);
    const inferred = /^(推断依据|inference\s+basis)\s*[:：]/i.test(basis);
    if (inferred) addIssue(relation, "这是 AI 推导关系，不是原文直接断言");
    if (!explicit && !inferred) {
      addIssue(relation, "依据没有标明是原文还是推断");
    }
    const basisBody = basis
      .replace(/^(原文|original|推断依据|inference\s+basis)\s*[:：]/i, "")
      .trim();
    const compactBasis = compactClaimText(basisBody);
    const basisNamesBothEndpoints = relationTextSupportsEndpoints(basisBody, relation, personNames);
    if (
      context.sourceMaterial?.trim() &&
      (!compactClaimText(context.sourceMaterial).includes(compactBasis) || !basisNamesBothEndpoints)
    ) {
      addIssue(relation, "所附依据含转述或指代，请结合原材料核对；原依据已保留");
    }
    const predicate = inferRelationSemantics(relation.label).predicate;
    const cue = EXPLICIT_RELATION_CUES[predicate];
    const semanticBody = claimBodyWithoutEntityNames(basis, personNames);
    if (cue && !cue.test(semanticBody)) {
      addIssue(relation, "关系标签与所附原文不一致，可能把经第三人关联误写成直接关系");
    }
    if (
      /(?:的|\bof\b).*(?:父|母|儿子|女儿|兄|弟|姐|妹|father|mother|son|daughter|brother|sister)/i.test(
        relation.label,
      )
    ) {
      addIssue(relation, "关系标签包含多跳称谓，尚未拆成可核对的原子关系");
    }
  }

  const pluralParentGroups = new Map<string, IngestRelation[]>();
  for (const relation of draft.relations ?? []) {
    if (inferRelationSemantics(relation.label).predicate !== "parent_of") continue;
    const basis = relation.basis?.replace(/^(原文|original)\s*[:：]/i, "").trim() ?? "";
    if (
      !/(他们(?:俩)?(?:的|有)|their)\s*(?:一?个)?\s*(?:儿子|女儿|孩子|子女|son|daughter|child)/i.test(
        basis,
      )
    ) {
      continue;
    }
    const key = `${compactClaimText(basis)}\u0000${normalized(relation.to)}`;
    pluralParentGroups.set(key, [...(pluralParentGroups.get(key) ?? []), relation]);
  }
  for (const relations of pluralParentGroups.values()) {
    if (new Set(relations.map((relation) => normalized(relation.from))).size >= 2) continue;
    const relation = relations[0];
    addIssue(
      relation,
      `“他们的孩子”只生成了一位父母到 ${relation.to} 的关系，另一位父母关系可能遗漏`,
    );
  }

  const messagesByRelation = new Map<IngestRelation, string[]>();
  for (const issue of issues) {
    messagesByRelation.set(issue.relation, [
      ...(messagesByRelation.get(issue.relation) ?? []),
      issue.message,
    ]);
  }
  for (const relation of draft.relations ?? []) {
    const messages = [...new Set(messagesByRelation.get(relation) ?? [])];
    if (messages.length) {
      relation._relationChecked = false;
      relation._relationReason = `AI 生成，请注意辨别：${messages.join("；")}`;
    } else if (!relation._relationReason) {
      relation._relationChecked = true;
      relation._relationReason = "关系依据已与本次材料对齐；仍可在入库前编辑";
    }
  }
  return issues;
}

const SEMANTIC_EXTRACTION_PRINCIPLES = `请把材料理解成语义任务，遵守以下边界：
- 只声明材料明确表达的事实；不要把亲属或社交推导写成直接关系。
- 人物自身属性写入 person；人与人之间的联系单独写 relation，并保留最短可核对依据。
- 本次材料中新介绍的每个人都单独声明 person/create，即使只知道姓名；关系、事件、提醒和圈层中的引用依赖这份人物声明。后续补充时一并完成之前缺少人物而未形成的条目。
- 已发生或计划发生、适合时间线/日历的内容写 event；仍需用户采取行动的内容写 reminder。同一内容只有同时具备两种含义时才写两项。
- 时间原句可写 timeText；能确定时再规范化 date、dateEnd 与 precision。
- evidence 只保留核对所需的短摘要或片段，不复制整份材料。
- 圈层及成员变更只写 collection 与 memberships；不要写 person.circle。
- 不确定的值留空；不得为了填满字段而猜测。`;

const SEMANTIC_RESPONSE_GUIDE = `只输出一个 semantic_plan JSON。不要调用工具，不要输出 final 或旧版 type=plan，也不要复制、猜测或生成任何 archive UUID。模型只表达语义；本地 resolver 在完整档案中解析姓名、别名、我、工作区引用、关系、事件与圈层。一个引用有歧义时，系统会单独交给用户，其他任务照常执行。

根结构：
{"version":1,"type":"semantic_plan","summary":"一句话摘要","tasks":[]}

人物 changes 字段定义（与本地解析器同源，未列出的属性用 fact 任务的 key/value 表达）：
${JSON.stringify(describeAgentToolInput(ingestPersonSchema.omit({ name: true, circle: true })))}

事件 changes 的属性（people 另用人物语义引用，标题可放 target.title）：
${JSON.stringify(describeAgentToolInput(ingestEventSchema.omit({ people: true })))}
提醒 changes 的属性（people 同样使用人物语义引用）：
${JSON.stringify(describeAgentToolInput(ingestReminderSchema.omit({ people: true })))}
事件和提醒的其他补充写入 detail，保留具体内容。

圈层 organize 任务定义（新建圈层和调整已有圈层均使用 organize；指定人物用单个 person 引用）：
${JSON.stringify(describeAgentToolInput(organizeCollectionTaskSchema))}

常用任务：
{"id":"p1","domain":"person","intent":"update","target":{"kind":"person","name":"唐悦","hints":{"org":"知脉工作室"}},"changes":{"title":"品牌总监"}}
{"id":"p2","domain":"person","intent":"create","target":{"kind":"person","name":"林柚"},"changes":{"title":"设计师"}}
{"id":"r1","domain":"relation","intent":"update","target":{"kind":"relation","from":{"kind":"person","name":"唐悦"},"to":{"kind":"person","name":"周宁"},"label":"同事"},"changes":{"label":"前同事","basis":"原文：唐悦和周宁现在是前同事"}}
{"id":"r2","domain":"relation","intent":"create","target":{"kind":"relation","from":{"kind":"self"},"to":{"kind":"person","name":"林柚"}},"changes":{"label":"同学","basis":"原文：林柚是我的同学"}}
{"id":"e1","domain":"event","intent":"create","target":{"kind":"event","title":"校园记忆展"},"changes":{"date":"2026-09-02","people":[{"kind":"person","name":"唐悦"},{"kind":"person","name":"林柚"}]}}
{"id":"f1","domain":"fact","intent":"create","target":{"kind":"fact","person":{"kind":"person","name":"唐悦"},"key":"毕业院校"},"changes":{"value":"某大学"}}
{"id":"m1","domain":"reminder","intent":"create","target":{"kind":"reminder","title":"给唐悦发送清单"},"changes":{"due":"2026-09-05","people":[{"kind":"person","name":"唐悦"}],"kind":"custom"}}
{"id":"x1","domain":"evidence","intent":"create","target":{"kind":"evidence","title":"本次材料摘要"},"changes":{"kind":"note","text":"最短可核对摘要","origin":"用户输入"}}
{"id":"c1","domain":"collection","intent":"organize","target":{"kind":"collection","name":"同事","collectionKind":"relationship_circle"},"memberships":[{"people":{"kind":"person_selection","scope":"all"},"action":"add"}]}
{"id":"c3","domain":"collection","intent":"organize","target":{"kind":"collection","name":"活动合作","collectionKind":"relationship_circle"},"memberships":[{"people":{"kind":"person","name":"林柚"},"action":"add"}]}
{"id":"c2","domain":"collection","intent":"classify","target":{"kind":"person_selection","scope":"all"},"guidance":"根据人物关系、组织和共同经历整理成少量清晰圈层"}

需要逐一判断一批或全部人物应属于哪些圈层时，只声明 intent=classify，不要在初始计划中列人物；本地会枚举范围并分批提供临时 ref。更新未提交草稿时可使用 {"kind":"workspace","domain":"person|fact|relation|event|reminder|evidence","recordRef":"draft:..."}。人物 changes 只写人物自身属性；圈层只能写 collection 任务，不得写 person.circle。关系、事件和提醒中的人物都使用语义引用。“我/me”使用 {"kind":"self"}。`;

function semanticIntakePrompt(
  extractionPrompt: string | IntakePromptSections,
  includeArchive: boolean,
  archiveIndex: string,
) {
  const legacyPrompt = typeof extractionPrompt === "string" ? extractionPrompt : null;
  const structured = typeof extractionPrompt === "string" ? null : extractionPrompt;
  return composeAgentPrompt({
    toolHistory: [],
    preferredHistoryCharacters: MAX_HISTORY,
    minimumContextCharacters: 2_500,
    fitContext: (maxCharacters) => {
      if (!structured) return fitPlainAgentContext(legacyPrompt ?? "", maxCharacters);
      const known = structured.knownContext?.trim() ?? "";
      const materialLabel = "本次材料：\n";
      const fixed = known.length + materialLabel.length;
      const available = Math.max(0, maxCharacters - fixed);
      const material = fitPlainAgentContext(structured.sourceMaterial, available);
      return `${known ? `已有语义索引：\n${known}\n\n` : ""}${materialLabel}${material}`;
    },
    render: (context) => `${SEMANTIC_EXTRACTION_PRINCIPLES}

${context}

${
  includeArchive
    ? `当前档案概览（不含人物清单与稳定 ID；最终匹配使用完整本地快照）：\n${archiveIndex}`
    : `本轮未授权读取已有档案；以下仅含本次未提交工作区，不含档案记录：\n${archiveIndex}`
}

${SEMANTIC_RESPONSE_GUIDE}

当前阶段：UNDERSTAND。后续 DISCOVER、RESOLVE、PROPOSE 均由本地执行。`,
  }).prompt;
}

type CollectionClassificationTask = Extract<
  SemanticIntakeTask,
  { domain: "collection"; intent: "classify" }
>;

interface CollectionClassificationPersonSummary {
  ref: string;
  name: string;
  entityRole: "ego" | "contact" | "placeholder";
  profile?: {
    relation?: string;
    title?: string;
    org?: string;
    department?: string;
    metAt?: string;
    tags?: string[];
    projects?: string[];
  };
  note?: string;
  relations?: Array<{ otherRef: string; otherName: string; label: string }>;
  currentCircles?: string[];
}

export interface IntakeCollectionClassificationBatch {
  batchRef: string;
  people: CollectionClassificationPersonSummary[];
  personIdsByRef: ReadonlyMap<string, string>;
}

const COLLECTION_CLASSIFICATION_BATCH_CHARACTERS = 24_000;

function compactSemanticText(value: string | undefined, maximum: number) {
  const text = value?.normalize("NFKC").replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length <= maximum ? text : `${text.slice(0, Math.max(1, maximum - 1))}…`;
}

function compactSemanticList(values: readonly string[] | undefined, maximumItems: number) {
  const selected = (values ?? [])
    .map((value) => compactSemanticText(value, 36))
    .filter((value): value is string => Boolean(value));
  return [...new Set(selected)].slice(0, maximumItems);
}

/**
 * Enumerate a local selection into complete JSON batches. Archive IDs are kept
 * only in the ref map and never serialized into a model prompt.
 */
export function buildIntakeCollectionClassificationBatches(options: {
  persons: readonly PersonRecord[];
  allPersons: readonly PersonRecord[];
  relations: readonly RelationRecord[];
  collections: readonly CollectionRecord[];
  collectionMemberships: readonly CollectionMembershipRecord[];
  maxBatchCharacters?: number;
}): IntakeCollectionClassificationBatch[] {
  const indexed = options.allPersons.map((person, index) => ({ person, index }));
  indexed.sort(
    (left, right) =>
      left.person.name.localeCompare(right.person.name, "zh-CN") ||
      (left.person.createdAt ?? 0) - (right.person.createdAt ?? 0) ||
      left.person.id.localeCompare(right.person.id) ||
      left.index - right.index,
  );
  const refByPersonId = new Map(
    indexed.map(({ person }, index) => [person.id, `person-${String(index + 1).padStart(6, "0")}`]),
  );
  const nameByPersonId = new Map(options.allPersons.map((person) => [person.id, person.name]));
  const collectionById = new Map(
    options.collections.map((collection) => [collection.id, collection]),
  );
  const circlesByPersonId = new Map<string, string[]>();
  for (const membership of options.collectionMemberships) {
    const collection = collectionById.get(membership.collectionId);
    if (!collection || collection.kind !== "relationship_circle") continue;
    circlesByPersonId.set(membership.personId, [
      ...(circlesByPersonId.get(membership.personId) ?? []),
      collection.name,
    ]);
  }
  const relationsByPersonId = new Map<
    string,
    Array<{ otherRef: string; otherName: string; label: string }>
  >();
  for (const relation of options.relations) {
    if (relation.recordType === "derived") continue;
    const endpoints: Array<[string, string]> = [
      [relation.fromId, relation.toId],
      [relation.toId, relation.fromId],
    ];
    for (const [personId, otherId] of endpoints) {
      const otherRef = refByPersonId.get(otherId);
      const otherName = nameByPersonId.get(otherId);
      if (!otherRef || !otherName) continue;
      relationsByPersonId.set(personId, [
        ...(relationsByPersonId.get(personId) ?? []),
        {
          otherRef,
          otherName: compactSemanticText(otherName, 40) ?? "未命名",
          label: compactSemanticText(relation.label, 40) ?? "关系",
        },
      ]);
    }
  }

  const selectedIds = new Set(options.persons.map((person) => person.id));
  const rows = indexed
    .filter(({ person }) => selectedIds.has(person.id))
    .map(({ person }) => {
      const profile = person.profile;
      const profileSummary = {
        relation: compactSemanticText(profile?.relation, 60),
        title: compactSemanticText(profile?.title, 60),
        org: compactSemanticText(profile?.org, 80),
        department: compactSemanticText(profile?.department, 60),
        metAt: compactSemanticText(profile?.metAt, 60),
        tags: compactSemanticList(profile?.tags, 4),
        projects: compactSemanticList(profile?.projects, 3),
      };
      const hasProfile = Object.values(profileSummary).some((value) =>
        Array.isArray(value) ? value.length > 0 : Boolean(value),
      );
      const relations = (relationsByPersonId.get(person.id) ?? [])
        .sort(
          (left, right) =>
            left.label.localeCompare(right.label, "zh-CN") ||
            left.otherName.localeCompare(right.otherName, "zh-CN"),
        )
        .slice(0, 4);
      const currentCircles = compactSemanticList(circlesByPersonId.get(person.id), 6);
      return {
        ref: refByPersonId.get(person.id)!,
        personId: person.id,
        summary: {
          ref: refByPersonId.get(person.id)!,
          name: compactSemanticText(person.name, 80) ?? "未命名",
          entityRole: person.entityRole ?? "contact",
          ...(hasProfile ? { profile: profileSummary } : {}),
          ...(compactSemanticText(person.note, 180)
            ? { note: compactSemanticText(person.note, 180) }
            : {}),
          ...(relations.length ? { relations } : {}),
          ...(currentCircles.length ? { currentCircles } : {}),
        } satisfies CollectionClassificationPersonSummary,
      };
    });

  const maximum = Math.max(
    2_000,
    options.maxBatchCharacters ?? COLLECTION_CLASSIFICATION_BATCH_CHARACTERS,
  );
  const groups: (typeof rows)[] = [];
  let current: typeof rows = [];
  for (const row of rows) {
    const candidate = [...current, row];
    if (
      current.length &&
      JSON.stringify({ people: candidate.map((item) => item.summary) }).length > maximum
    ) {
      groups.push(current);
      current = [row];
    } else {
      current = candidate;
    }
  }
  if (current.length) groups.push(current);
  return groups.map((group, index) => ({
    batchRef: `batch-${String(index + 1).padStart(4, "0")}`,
    people: group.map((row) => row.summary),
    personIdsByRef: new Map(group.map((row) => [row.ref, row.personId])),
  }));
}

function collectionClassificationPrompt(
  task: CollectionClassificationTask,
  batch: IntakeCollectionClassificationBatch,
  knownCircleNames: readonly string[],
) {
  const context = JSON.stringify({
    taskRef: task.id,
    batchRef: batch.batchRef,
    guidance: task.guidance ?? "按人物关系、组织和共同经历整理为少量、清晰、可复用的圈层",
    knownRelationshipCircles: knownCircleNames
      .map((name) => compactSemanticText(name, 60))
      .filter((name): name is string => Boolean(name))
      .slice(0, 40),
    people: batch.people,
  });
  return composeAgentPrompt({
    toolHistory: [],
    preferredHistoryCharacters: 2,
    minimumContextCharacters: context.length,
    fitContext: () => context,
    render: (
      fitted,
    ) => `你正在执行一个已经由用户发起的全库圈层分类任务。只根据本批人物摘要分类；每个人用临时 ref 区分，同名人物也必须分别返回。不要猜测或输出 archive UUID，不要输出人物姓名作为绑定键。

返回严格 JSON：
{"version":1,"type":"collection_classification_batch","taskRef":"${task.id}","batchRef":"${batch.batchRef}","assignments":[{"ref":"person-000001","collections":[{"name":"同事"}],"reason":"简短依据"}]}

assignments 必须让本批每个 ref 恰好出现一次。collections 可有多个；明确不应进入任何关系圈层时返回空数组。优先复用已知圈层名，新圈层使用稳定、宽泛、方便长期维护的名称。只输出 JSON。

本批数据：
${fitted}`,
  }).prompt;
}

async function classifyCollectionsInBatches<TServices>(options: {
  task: CollectionClassificationTask;
  snapshot: IntakeSemanticCompilerSnapshot;
  runtime: AgentRuntime<TServices>;
  preset: ProviderPreset;
  trace: (event: AgentTraceEvent) => void;
  signal?: AbortSignal;
  result: LocalCollectionClassificationResult;
  completedBatchKeys: Set<string>;
  onBatchCompleted: (batchKey: string) => void | Promise<void>;
  suspend: (reason: AgentFinalizeReason | "transport", cause?: unknown) => never;
}): Promise<LocalCollectionClassificationResult> {
  const result = options.result;
  const selection = resolveSemanticRecordRef(options.task.target, options.snapshot);
  if (selection.status !== "resolved") return result;
  const selectedPeople = selection.candidates.flatMap((candidate) =>
    candidate.domain === "person" && candidate.record ? [candidate.record as PersonRecord] : [],
  );
  const batches = buildIntakeCollectionClassificationBatches({
    persons: selectedPeople,
    allPersons: options.snapshot.persons,
    relations: options.snapshot.relations,
    collections: options.snapshot.collections,
    collectionMemberships: options.snapshot.collectionMemberships ?? [],
  });
  const knownCircleNames = new Set(
    options.snapshot.collections
      .filter((collection) => collection.kind === "relationship_circle")
      .map((collection) => collection.name),
  );
  result.assignments.forEach((assignment) => {
    assignment.collections.forEach((collection) => knownCircleNames.add(collection.name));
  });

  for (const [batchIndex, batch] of batches.entries()) {
    const batchKey = collectionClassificationBatchKey(options.task.id, batch.batchRef);
    if (options.completedBatchKeys.has(batchKey)) continue;
    options.signal?.throwIfAborted();
    options.trace({
      kind: "status",
      text: `DISCOVER · 正在分类第 ${batchIndex + 1}/${batches.length} 批（${batch.people.length} 人）`,
    });
    const prompt = collectionClassificationPrompt(options.task, batch, [...knownCircleNames]);
    let raw = "";
    const decision = await options.runtime.runModelRound(
      {
        payload: {
          prompt,
          phase: "DISCOVER",
          taskRef: options.task.id,
          batchRef: batch.batchRef,
        },
      },
      async (signal) => {
        await askModel(
          options.preset,
          prompt,
          null,
          [],
          (chunk) => {
            raw += chunk;
          },
          signal,
          {
            maxOutputTokens: Math.max(
              1,
              Math.min(12_000, options.runtime.contextBudget.snapshot().remaining.outputTokens),
            ),
            temperature: 0,
            responseMode: "structured",
          },
        );
        return { value: raw, payload: { response: raw, batchRef: batch.batchRef } };
      },
    );
    if (decision.status === "finalize") {
      options.suspend(decision.reason);
    }
    if (decision.status === "failed") {
      if (decision.error instanceof ModelRetryExhaustedError) {
        options.suspend("transport", decision.error);
      }
      throw decision.error instanceof Error ? decision.error : new Error("模型调用失败");
    }

    try {
      const parsed = parseSemanticCollectionClassificationBatch(
        parseLooseJson<unknown>(decision.value),
      );
      if (parsed.taskRef !== options.task.id || parsed.batchRef !== batch.batchRef) {
        throw new Error("分类响应的 taskRef 或 batchRef 与请求不一致");
      }
      for (const issue of parsed.issues) {
        result.issues.push({
          taskId: options.task.id,
          stage: "RESOLVE",
          code: "invalid",
          message: issue.message,
          path: `batches.${batch.batchRef}.assignments[${issue.assignmentIndex ?? "?"}]`,
        });
      }
      const acceptedRefs = new Set<string>();
      for (const assignment of parsed.assignments) {
        const personId = batch.personIdsByRef.get(assignment.ref);
        if (!personId) {
          result.issues.push({
            taskId: options.task.id,
            stage: "RESOLVE",
            code: "invalid",
            message: `${batch.batchRef} 返回了不属于本批的临时引用 ${assignment.ref}`,
            path: `batches.${batch.batchRef}.assignments`,
          });
          continue;
        }
        acceptedRefs.add(assignment.ref);
        result.assignments.push({
          personId,
          collections: assignment.collections,
          reason: assignment.reason,
        });
        assignment.collections.forEach((collection) => knownCircleNames.add(collection.name));
      }
      for (const ref of batch.personIdsByRef.keys()) {
        if (acceptedRefs.has(ref)) continue;
        result.issues.push({
          taskId: options.task.id,
          stage: "RESOLVE",
          code: "missing",
          message: `${batch.batchRef} 未返回人物 ${ref} 的分类，该人物保持原圈层`,
          path: `batches.${batch.batchRef}.${ref}`,
        });
      }
    } catch (error) {
      result.issues.push({
        taskId: options.task.id,
        stage: "RESOLVE",
        code: "invalid",
        message: `${batch.batchRef} 返回格式无效，该批人物保持原圈层：${
          error instanceof Error ? error.message : "无法解析"
        }`,
        path: `batches.${batch.batchRef}`,
      });
    }
    options.completedBatchKeys.add(batchKey);
    await options.onBatchCompleted(batchKey);
  }
  return result;
}

export interface IntakeAgentResult extends IngestCandidate {
  /** Formal mutation proposal produced locally from successfully resolved tasks. */
  proposal?: ArchiveMutationPlan;
  /** Item-scoped contract, missing and ambiguity results. */
  resolutionIssues: SemanticIntakeIssue[];
  /** Final snapshot of UNDERSTAND → DISCOVER → RESOLVE → PROPOSE. */
  intakeState: SemanticIntakeTaskSnapshot;
}

export type IntakeAgentNextAction = "understand" | "classify_collections" | "compile" | "complete";

export type IntakeAgentConsumedBudget = Pick<
  AgentBudgetSnapshot,
  "rounds" | "toolCalls" | "inputTokens" | "outputTokens"
>;

/**
 * Minimal durable execution state. Archive records and source material remain
 * owned by their existing stores; the checkpoint keeps only dependency
 * revisions and the model-derived work needed to continue.
 */
export interface IntakeAgentCheckpoint {
  version: 1;
  sourceRunId: string;
  requestRevision: string;
  archiveRevision: string;
  providerRevision: string;
  nextAction: IntakeAgentNextAction;
  semanticPlanCandidate?: unknown;
  collectionClassifications: LocalCollectionClassificationResult[];
  completedBatchKeys: string[];
  budgetLimits: AgentBudget;
  consumedBudget: IntakeAgentConsumedBudget;
  completedResult?: IntakeAgentResult;
  savedAt: number;
}

export class IntakeAgentSuspendedError extends Error {
  readonly name = "IntakeAgentSuspendedError";

  constructor(
    readonly checkpoint: IntakeAgentCheckpoint,
    readonly reason: AgentFinalizeReason | "transport",
    readonly suspensionCause?: unknown,
  ) {
    super(
      reason === "transport"
        ? suspensionCause instanceof Error
          ? suspensionCause.message
          : "上游模型暂时不可用"
        : `Agent 已暂停：${reason}`,
    );
  }
}

function collectionClassificationBatchKey(taskId: string, batchRef: string) {
  return JSON.stringify([taskId, batchRef]);
}

function intakeRequestRevision(options: {
  extractionPrompt: string | IntakePromptSections;
  includeArchive: boolean;
  sourceMaterial?: string;
}) {
  return archiveRecordRevision({
    extractionPrompt: options.extractionPrompt,
    includeArchive: options.includeArchive,
    sourceMaterial: options.sourceMaterial,
  });
}

function intakeProviderRevision(preset: ProviderPreset) {
  return archiveRecordRevision({
    kind: preset.kind,
    baseUrl: preset.baseUrl.trim().replace(/\/+$/, ""),
    model: preset.model.trim(),
  });
}

function recordsById<T extends { id: string }>(records: readonly T[]) {
  return [...records].sort((left, right) => left.id.localeCompare(right.id));
}

function intakeArchiveRevision(options: {
  includeArchive: boolean;
  persons: readonly PersonRecord[];
  relations: readonly RelationRecord[];
  events: readonly LifeEventRecord[];
  collections: readonly CollectionRecord[];
  collectionMemberships: readonly CollectionMembershipRecord[];
  reminders: readonly ReminderRecord[];
  evidence: readonly EvidenceRecord[];
  workspace?: IngestCandidate;
}) {
  const persons = options.includeArchive
    ? recordsById(options.persons).map((person) => ({
        id: person.id,
        name: person.name,
        note: person.note,
        profile: person.profile,
        rawProfileText: person.rawProfileText,
        createdAt: person.createdAt,
        updatedAt: person.updatedAt,
        source: person.source,
        entityRole: person.entityRole,
        identityScopeId: person.identityScopeId,
      }))
    : [];
  const events = options.includeArchive
    ? recordsById(options.events).map((event) => ({
        id: event.id,
        date: event.date,
        dateEnd: event.dateEnd,
        precision: event.precision,
        title: event.title,
        detail: event.detail,
        place: event.place,
        personIds: event.personIds,
        kind: event.kind,
        createdAt: event.createdAt,
        updatedAt: event.updatedAt,
        source: event.source,
      }))
    : [];
  const evidence = options.includeArchive
    ? recordsById(options.evidence).map((record) => ({
        id: record.id,
        kind: record.kind,
        title: record.title,
        text: record.text,
        origin: record.origin,
        uploader: record.uploader,
        entities: record.entities,
        linkedPersonIds: record.linkedPersonIds,
        speechVariant: record.speechVariant,
        createdAt: record.createdAt,
        source: record.source,
      }))
    : [];
  return archiveRecordRevision({
    persons,
    relations: options.includeArchive ? recordsById(options.relations) : [],
    events,
    collections: options.includeArchive ? recordsById(options.collections) : [],
    collectionMemberships: options.includeArchive ? recordsById(options.collectionMemberships) : [],
    reminders: options.includeArchive ? recordsById(options.reminders) : [],
    evidence,
    workspace: options.workspace,
  });
}

function addTokenStates(
  previous: AgentBudgetSnapshot["inputTokens"] | undefined,
  current: AgentBudgetSnapshot["inputTokens"],
) {
  return {
    total: (previous?.total ?? 0) + current.total,
    actual: (previous?.actual ?? 0) + current.actual,
    estimated: (previous?.estimated ?? 0) + current.estimated,
  };
}

function cumulativeIntakeBudget(
  previous: IntakeAgentConsumedBudget | undefined,
  current: AgentBudgetSnapshot,
): IntakeAgentConsumedBudget {
  return {
    rounds: (previous?.rounds ?? 0) + current.rounds,
    toolCalls: (previous?.toolCalls ?? 0) + current.toolCalls,
    inputTokens: addTokenStates(previous?.inputTokens, current.inputTokens),
    outputTokens: addTokenStates(previous?.outputTokens, current.outputTokens),
  };
}

function resumedIntakeBudget(full: AgentBudget, checkpoint?: IntakeAgentCheckpoint): AgentBudget {
  if (!checkpoint) return full;
  return {
    maxRounds: Math.max(1, full.maxRounds - checkpoint.consumedBudget.rounds),
    maxToolCalls: Math.max(0, full.maxToolCalls - checkpoint.consumedBudget.toolCalls),
    maxInputTokens: Math.max(1, full.maxInputTokens - checkpoint.consumedBudget.inputTokens.total),
    maxOutputTokens: Math.max(
      1,
      full.maxOutputTokens - checkpoint.consumedBudget.outputTokens.total,
    ),
    maxWallTimeMs: full.maxWallTimeMs,
  };
}

function cloneCheckpoint(checkpoint: IntakeAgentCheckpoint) {
  return structuredClone(checkpoint);
}

export interface CreateInitialIntakeAgentCheckpointOptions {
  sourceRunId: string;
  preset: ProviderPreset;
  extractionPrompt: string | IntakePromptSections;
  persons: PersonRecord[];
  events: LifeEventRecord[];
  relations?: RelationRecord[];
  collections?: CollectionRecord[];
  collectionMemberships?: CollectionMembershipRecord[];
  reminders?: ReminderRecord[];
  evidence?: EvidenceRecord[];
  workspace?: IngestCandidate;
  includeArchive: boolean;
  sourceMaterial?: string;
  budget?: AgentBudgetPreset | AgentBudget;
  savedAt?: number;
}

/**
 * Builds the exact first resumable intake state before any model request. Both
 * the UI's atomic run creation and the intake runtime use this function, so
 * request/provider/archive revisions cannot drift between the stored intent
 * and resume validation.
 */
export function createInitialIntakeAgentCheckpoint(
  options: CreateInitialIntakeAgentCheckpointOptions,
): IntakeAgentCheckpoint {
  const relations = options.relations ?? [];
  const collections = options.collections ?? [];
  const collectionMemberships = options.collectionMemberships ?? [];
  const reminders = options.reminders ?? [];
  const evidence = options.evidence ?? [];
  const workspace = options.workspace ? ensureIntakeWorkspace(options.workspace) : undefined;
  const budgetLimits = resolveAgentBudget(options.budget ?? resolveSavedAgentBudget("deep"));
  return {
    version: 1,
    sourceRunId: options.sourceRunId,
    requestRevision: intakeRequestRevision(options),
    archiveRevision: intakeArchiveRevision({
      includeArchive: options.includeArchive,
      persons: options.persons,
      relations,
      events: options.events,
      collections,
      collectionMemberships,
      reminders,
      evidence,
      workspace,
    }),
    providerRevision: intakeProviderRevision(options.preset),
    nextAction: "understand",
    collectionClassifications: [],
    completedBatchKeys: [],
    budgetLimits,
    consumedBudget: {
      rounds: 0,
      toolCalls: 0,
      inputTokens: { total: 0, actual: 0, estimated: 0 },
      outputTokens: { total: 0, actual: 0, estimated: 0 },
    },
    savedAt: options.savedAt ?? Date.now(),
  };
}

/**
 * Current intake path. The model emits one semantic plan and never receives or
 * echoes archive IDs; all discovery, resolution and proposal compilation happen
 * once against the complete local snapshot.
 */
export async function runIntakeAgent(options: {
  preset: ProviderPreset;
  extractionPrompt: string | IntakePromptSections;
  persons: PersonRecord[];
  events: LifeEventRecord[];
  relations?: RelationRecord[];
  collections?: CollectionRecord[];
  collectionMemberships?: CollectionMembershipRecord[];
  reminders?: ReminderRecord[];
  evidence?: EvidenceRecord[];
  workspace?: IngestCandidate;
  includeArchive: boolean;
  sourceMaterial?: string;
  signal?: AbortSignal;
  onTrace?: (event: AgentTraceEvent) => void;
  budget?: AgentBudgetPreset | AgentBudget;
  recorder?: AgentRunRecorder;
  onRun?: (run: AgentRun) => void;
  onCheckpoint?: (checkpoint: IntakeAgentCheckpoint) => void | Promise<void>;
  resumeFrom?: IntakeAgentCheckpoint;
  transportRetry?: { maxAttempts?: number; delaysMs?: readonly number[] };
}): Promise<IntakeAgentResult> {
  const trace = options.onTrace ?? (() => undefined);
  const relations = options.relations ?? [];
  const collections = options.collections ?? [];
  const collectionMemberships = options.collectionMemberships ?? [];
  const reminders = options.reminders ?? [];
  const evidence = options.evidence ?? [];
  const workspace = options.workspace ? ensureIntakeWorkspace(options.workspace) : undefined;
  const requestRevision = intakeRequestRevision(options);
  const providerRevision = intakeProviderRevision(options.preset);
  const archiveRevision = intakeArchiveRevision({
    includeArchive: options.includeArchive,
    persons: options.persons,
    relations,
    events: options.events,
    collections,
    collectionMemberships,
    reminders,
    evidence,
    workspace,
  });
  const resume = options.resumeFrom;
  if (
    resume &&
    (resume.requestRevision !== requestRevision ||
      resume.archiveRevision !== archiveRevision ||
      resume.providerRevision !== providerRevision)
  ) {
    throw new Error("暂停后的材料、档案或模型配置已发生变化，请作为新任务重新整理。");
  }
  if (resume?.nextAction === "complete") {
    if (!resume.completedResult) throw new Error("已完成断点缺少编译结果");
    return structuredClone(resume.completedResult);
  }

  const requestedBudget = resolveAgentBudget(
    options.budget ?? resume?.budgetLimits ?? resolveSavedAgentBudget("deep"),
  );
  const recorder =
    options.recorder ??
    new MemoryAgentRunRecorder(resume ? { runId: resume.sourceRunId } : undefined);
  if (resume && recorder.runId !== resume.sourceRunId) {
    throw new Error("恢复使用的 Agent recorder 与原运行不一致");
  }
  const runtime = new AgentRuntime({
    registry: archiveAgentToolRegistry,
    services: {
      archive: { persons: options.persons, relations, events: options.events },
    },
    permissions: [],
    toolNames: [],
    budget: resumedIntakeBudget(requestedBudget, resume),
    recorder,
    signal: options.signal,
    roundOffset: resume?.consumedBudget.rounds ?? 0,
    modelRetry: {
      maxAttempts: options.transportRetry?.maxAttempts,
      delaysMs: options.transportRetry?.delaysMs,
      onRetry: ({ round, nextAttempt }) => {
        trace({
          kind: "error",
          text: `第 ${round} 轮连接暂时失败，正在进行第 ${nextAttempt} 次有限重试`,
        });
      },
    },
  });

  const projectRun = (status: "completed" | "suspended" | "failed") => {
    if (status === "completed" || status === "suspended") runtime.finalize(status);
    const run = projectAgentRun(runtime.recorder.events(), {
      id: runtime.recorder.runId,
      title: "随手写，AI 来整理",
      agentName: "intake",
      model: options.preset.model,
      status,
    });
    saveAgentRunBestEffort(run, runtime.recorder.events());
    options.onRun?.(run);
    return run;
  };

  const snapshot: IntakeSemanticCompilerSnapshot = {
    persons: options.includeArchive ? options.persons : [],
    relations: options.includeArchive ? relations : [],
    events: options.includeArchive ? options.events : [],
    collections: options.includeArchive ? collections : [],
    collectionMemberships: options.includeArchive ? collectionMemberships : [],
    reminders: options.includeArchive ? reminders : [],
    evidence: options.includeArchive ? evidence : [],
    workspace,
  };
  let semanticPlan: unknown = resume?.semanticPlanCandidate;
  const collectionClassifications = structuredClone(resume?.collectionClassifications ?? []);
  const completedBatchKeys = new Set(resume?.completedBatchKeys ?? []);
  let lastCheckpoint = resume ? cloneCheckpoint(resume) : undefined;
  const publishCheckpoint = async (
    nextAction: IntakeAgentNextAction,
    completedResult?: IntakeAgentResult,
  ) => {
    const checkpoint: IntakeAgentCheckpoint = {
      version: 1,
      sourceRunId: runtime.recorder.runId,
      requestRevision,
      archiveRevision,
      providerRevision,
      nextAction,
      ...(semanticPlan === undefined
        ? {}
        : { semanticPlanCandidate: structuredClone(semanticPlan) }),
      collectionClassifications: structuredClone(collectionClassifications),
      completedBatchKeys: [...completedBatchKeys],
      budgetLimits: { ...requestedBudget },
      consumedBudget: cumulativeIntakeBudget(
        resume?.consumedBudget,
        runtime.contextBudget.snapshot(),
      ),
      ...(completedResult ? { completedResult: structuredClone(completedResult) } : {}),
      savedAt: Date.now(),
    };
    lastCheckpoint = cloneCheckpoint(checkpoint);
    await options.onCheckpoint?.(cloneCheckpoint(checkpoint));
    return checkpoint;
  };
  const suspend = (reason: AgentFinalizeReason | "transport", cause?: unknown): never => {
    if (reason === "aborted") {
      throw options.signal?.reason ?? new DOMException("Aborted", "AbortError");
    }
    if (!lastCheckpoint) throw new Error("Agent 尚未建立可恢复断点");
    throw new IntakeAgentSuspendedError(cloneCheckpoint(lastCheckpoint), reason, cause);
  };

  try {
    options.signal?.throwIfAborted();
    if (!resume) await publishCheckpoint("understand");
    if (!resume || resume.nextAction === "understand") {
      const archiveIndex = semanticArchiveOverview(
        options.includeArchive ? options.persons : [],
        options.includeArchive ? relations : [],
        options.includeArchive ? options.events : [],
        options.includeArchive ? collections : [],
        options.includeArchive ? collectionMemberships : [],
        workspace,
      );
      const prompt = semanticIntakePrompt(
        options.extractionPrompt,
        options.includeArchive,
        archiveIndex,
      );
      let raw = "";
      trace({ kind: "status", text: "UNDERSTAND · AI 正在理解材料并声明语义任务" });
      runtime.recordLifecycle("validation", {
        phase: "UNDERSTAND",
        contract: "semantic_intake_plan@1",
      });
      const decision = await runtime.runModelRound({ payload: { prompt } }, async (signal) => {
        await askModel(
          options.preset,
          prompt,
          null,
          [],
          (chunk) => {
            raw += chunk;
          },
          signal,
          {
            maxOutputTokens: Math.max(
              1,
              Math.min(32_768, runtime.contextBudget.snapshot().remaining.outputTokens),
            ),
            temperature: 0,
            responseMode: "structured",
          },
        );
        return { value: raw, payload: { response: raw } };
      });
      if (decision.status === "finalize") return suspend(decision.reason);
      if (decision.status === "failed") {
        if (decision.error instanceof ModelRetryExhaustedError) {
          suspend("transport", decision.error);
        }
        throw decision.error instanceof Error ? decision.error : new Error("模型调用失败");
      }
      try {
        semanticPlan = parseLooseJson<unknown>(decision.value);
      } catch {
        throw new Error("模型没有返回合法的 semantic_plan JSON");
      }

      trace({ kind: "check", text: "DISCOVER · 本地正在枚举完整档案与工作区" });
      runtime.recordLifecycle("validation", {
        phase: "DISCOVER",
        contract: "archive_record_ref@1",
        counts: {
          persons: options.includeArchive ? options.persons.length : 0,
          relations: options.includeArchive ? relations.length : 0,
          events: options.includeArchive ? options.events.length : 0,
          collections: options.includeArchive ? collections.length : 0,
        },
      });
      const hasClassificationTasks = parseSemanticIntakePlan(semanticPlan).plan.tasks.some(
        (task) => task.domain === "collection" && task.intent === "classify",
      );
      await publishCheckpoint(hasClassificationTasks ? "classify_collections" : "compile");
    }
    if (semanticPlan === undefined) throw new Error("恢复断点缺少 semantic_plan");

    const declaredPlan = parseSemanticIntakePlan(semanticPlan).plan;
    if (
      !resume ||
      resume.nextAction === "understand" ||
      resume.nextAction === "classify_collections"
    ) {
      for (const task of declaredPlan.tasks) {
        if (task.domain !== "collection" || task.intent !== "classify") continue;
        let result = collectionClassifications.find((candidate) => candidate.taskId === task.id);
        if (!result) {
          result = { taskId: task.id, assignments: [], issues: [] };
          collectionClassifications.push(result);
        }
        await classifyCollectionsInBatches({
          task,
          snapshot,
          runtime,
          preset: options.preset,
          trace,
          signal: options.signal,
          result,
          completedBatchKeys,
          onBatchCompleted: async () => {
            await publishCheckpoint("classify_collections");
          },
          suspend,
        });
      }
      await publishCheckpoint("compile");
    }
    const compilation: IntakeSemanticCompilation = compileSemanticIntakePlan({
      candidate: semanticPlan,
      snapshot,
      collectionClassifications,
    });
    auditModelRelations(compilation.draft, { sourceMaterial: options.sourceMaterial });
    runtime.recordLifecycle("validation", {
      phase: "RESOLVE",
      contract: "archive_record_ref@1",
      resolved: compilation.state.tasks.filter((task) => task.status === "proposed").length,
      needsInput: compilation.state.tasks.filter((task) => task.status === "needs_input").length,
    });
    runtime.recordLifecycle("proposal", {
      phase: "PROPOSE",
      contract: "archive_mutation_plan@1",
      proposalId: compilation.proposal?.id,
      operationCount: compilation.proposal?.operations.length ?? 0,
      issueCount: compilation.issues.length,
    });
    if (compilation.issues.length) {
      trace({
        kind: "check",
        text: `RESOLVE · ${compilation.issues.length} 项需要确认，其余任务已继续形成草稿`,
      });
    }
    trace({ kind: "done", text: "PROPOSE · 已生成可核对草稿与变更提案" });
    const result: IntakeAgentResult = {
      ...compilation.draft,
      ...(compilation.proposal ? { proposal: compilation.proposal } : {}),
      resolutionIssues: compilation.issues,
      intakeState: compilation.state,
    };
    projectRun("completed");
    await publishCheckpoint("complete", result);
    return result;
  } catch (error) {
    if (error instanceof IntakeAgentSuspendedError) {
      runtime.recordLifecycle(
        "validation",
        {
          status: "suspended",
          nextAction: error.checkpoint.nextAction,
          reason: error.reason,
          completedBatches: error.checkpoint.completedBatchKeys.length,
        },
        "blocked",
      );
      trace({ kind: "done", text: "已暂停并保留当前进度，可从断点继续" });
      projectRun("suspended");
      throw error;
    }
    runtime.recorder.record({
      kind: "error",
      status: "failed",
      payload: error instanceof Error ? error : { error },
    });
    projectRun("failed");
    throw error;
  }
}
