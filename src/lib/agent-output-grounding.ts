import {
  cleanArchiveText,
  compactArchiveEvent,
  compactArchiveRelation,
  detailedArchivePerson,
  type ArchiveAgentData,
} from "./archive-agent-tools";
import type { ArchiveAgentReferenceSession } from "./archive-agent-reference-session";
import type { ResolvedRecordDomain } from "./archive-record-resolver";
import type { CandidateRecommendation } from "./recommendation";

export type RecommendationDecisionMode = "open" | "connection" | "target_side";

export interface RecommendationDecision {
  mode: RecommendationDecisionMode;
  orderedPersonIds: string[];
  accessVerified: boolean;
}

export interface ArchiveCitation {
  kind: "fact" | "gap";
  sourceRef: string;
  /** Stable field path selected by the model; the displayed value is still read locally. */
  field?: string;
  quote: string;
  /** Canonical archive fact rendered locally; models cannot author this field. */
  claim: string;
  /** Missingness is a locally resolved archive state, never a model-authored assertion. */
  state?: "present" | "missing";
}

interface ArchiveGroundingSource {
  relatedPersonIds: Set<string>;
  identityValues: Set<string>;
  claimPrefix: string;
  structured: unknown;
  /** Relations have one authoritative human-facing label chosen by the ledger. */
  preferredQuote?: string;
  canonicalClaim?: string;
}

export interface AssistantGroundingResult {
  ok: true;
  citations: ArchiveCitation[];
  evidenceText?: string;
}

function normalized(value: string) {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/[\p{P}\p{Z}\p{Cf}\s]+/gu, "");
}

/**
 * The model may explain or draft language, but it is never the authority for
 * identity, order, score, mode, or reachability. Those values must echo the
 * deterministic local decision exactly before any model-authored text is used.
 */
export function validateRecommendationDecision(
  decision: unknown,
  candidates: CandidateRecommendation[],
  expectedMode: RecommendationDecisionMode,
): decision is RecommendationDecision {
  if (!decision || typeof decision !== "object" || Array.isArray(decision)) return false;
  const value = decision as Record<string, unknown>;
  const ids = candidates.map((candidate) => candidate.person.id);
  if (value.mode !== expectedMode) return false;
  if (value.accessVerified !== (value.mode === "connection")) return false;
  if (!Array.isArray(value.orderedPersonIds) || value.orderedPersonIds.length !== ids.length) {
    return false;
  }
  return value.orderedPersonIds.every((id, index) => id === ids[index]);
}

function safeOutreachDraft(options: {
  draft: unknown;
  candidates: CandidateRecommendation[];
  allPersonNames: string[];
  targetName?: string;
}) {
  if (options.candidates[0]?.mode === "target_side") return "";
  const draft = cleanArchiveText(options.draft, 1_200);
  if (!draft) return "";

  const first = options.candidates[0];
  const allowedNames = new Set([
    first?.person.name,
    options.targetName,
    ...(first?.path?.personNames ?? []),
  ]);
  const mentionsUnexpectedPerson = options.allPersonNames.some(
    (name) => name && !allowedNames.has(name) && draft.includes(name),
  );
  const containsDecisionClaim =
    /(?:排名|排在|第一名|首选|最推荐|评分|得分|已验证.{0,6}路径|已经.{0,6}可达|能够直接联系|可以直接联系)/u.test(
      draft,
    );
  return mentionsUnexpectedPerson || containsDecisionClaim ? "" : draft;
}

function fallbackOutreach(task: string, candidate: CandidateRecommendation, targetName?: string) {
  const cleanTask = cleanArchiveText(task, 300) || "这件事";
  if (candidate.mode === "connection" && targetName) {
    return `你好，我最近想处理“${cleanTask}”。档案显示你可能了解 ${cleanArchiveText(targetName, 80)}；如果你觉得合适，能否先帮我判断这件事是否适合请教 Ta？不方便也完全没关系。`;
  }
  return `你好，我最近在处理“${cleanTask}”。想到你可能有相关经验，想先听听你的判断；如果你不方便，直接告诉我就好。`;
}

/** Render the recommendation decision from locked local data, never model prose. */
export function renderGroundedRecommendation(options: {
  task: string;
  candidates: CandidateRecommendation[];
  mode: RecommendationDecisionMode;
  targetName?: string;
  safetyNotice?: string;
  outreachDraft?: unknown;
  allPersonNames: string[];
}) {
  const { candidates } = options;
  const { mode } = options;
  const heading =
    mode === "connection"
      ? `已验证可达路径（目标：${cleanArchiveText(options.targetName, 80) || "指定人物"}）`
      : mode === "target_side"
        ? `目标侧潜在入口（未验证本人可达；目标：${cleanArchiveText(options.targetName, 80) || "指定人物"}）`
        : "本地证据排序";
  const rows = candidates.map((candidate, index) => {
    const facts = [
      `${index + 1}. ${cleanArchiveText(candidate.person.name, 80)} — ${candidate.score} 分（${candidate.confidence}置信度）`,
      `理由：${candidate.reasons.map((item) => cleanArchiveText(item, 300)).join("；") || "暂无直接理由"}`,
      `证据：${candidate.evidence.map((item) => cleanArchiveText(item, 400)).join("；") || "暂无"}`,
      `风险：${candidate.risks.map((item) => cleanArchiveText(item, 300)).join("；") || "未发现明显风险"}`,
    ];
    if (candidate.mode === "connection" && candidate.path) {
      facts.push(
        `已验证路径：我 → ${candidate.path.personNames.map((name) => cleanArchiveText(name, 80)).join(" → ")}`,
      );
    }
    if (candidate.mode === "target_side") {
      facts.push(
        `目标侧关系：${candidate.targetEntry?.labels.map((label) => cleanArchiveText(label, 80)).join("、") || "关系已记录"}；该分数只表示目标侧关联强度，不是可达概率。`,
      );
    }
    return facts.join("\n");
  });

  const noRows =
    mode === "target_side"
      ? `没有发现本人到 ${cleanArchiveText(options.targetName, 80) || "目标"} 的已验证路径，目标侧也没有足够的已确认关系证据。`
      : "现有档案没有形成合格候选；请补充能力、互动或联系方式证据后再试。";
  const draft = candidates[0]
    ? safeOutreachDraft({
        draft: options.outreachDraft,
        candidates,
        allPersonNames: options.allPersonNames,
        targetName: options.targetName,
      }) || fallbackOutreach(options.task, candidates[0], options.targetName)
    : "";

  return [
    cleanArchiveText(options.safetyNotice, 1_000),
    heading,
    mode === "target_side" && rows.length
      ? `未发现本人到 ${cleanArchiveText(options.targetName, 80) || "目标"} 的已验证路径。以下人物仅在目标侧有关系证据。`
      : "",
    rows.length ? rows.join("\n\n") : noRows,
    mode === "target_side" && rows.length
      ? "下一步应先补充你到上述人物的真实联系渠道，不能把目标侧关系当作已经存在的引荐路径。"
      : "",
    draft && mode !== "target_side"
      ? `给第一名 ${cleanArchiveText(candidates[0]?.person.name, 80)} 的可编辑话术（尚未发送）：\n${draft}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function archiveGroundingSources(data: ArchiveAgentData) {
  const names = new Map(data.persons.map((person) => [person.id, person.name]));
  const normalizedNameCounts = new Map<string, number>();
  data.persons.forEach((person) => {
    const key = normalized(person.name);
    normalizedNameCounts.set(key, (normalizedNameCounts.get(key) ?? 0) + 1);
  });
  const sources = new Map<string, ArchiveGroundingSource>();
  for (const person of data.persons) {
    const { id: _personId, ...structured } = detailedArchivePerson(person);
    const duplicateLabelParts = [
      person.profile?.org,
      person.profile?.title,
      person.profile?.relation,
    ]
      .map((item) => cleanArchiveText(item, 80))
      .filter(Boolean);
    sources.set(`person:${person.id}`, {
      relatedPersonIds: new Set([person.id]),
      identityValues: new Set([person.id, person.name]),
      claimPrefix:
        (normalizedNameCounts.get(normalized(person.name)) ?? 0) > 1
          ? `${person.name}${duplicateLabelParts.length ? `（${duplicateLabelParts.join(" · ")}）` : ""}`
          : person.name,
      structured,
    });
  }
  for (const relation of data.relations) {
    const {
      id: _relationId,
      fromId: _fromId,
      toId: _toId,
      supportingAssertionIds: _supportingAssertionIds,
      ...structured
    } = compactArchiveRelation(relation, names);
    const from = names.get(relation.fromId) ?? "未知人物";
    const to = names.get(relation.toId) ?? "未知人物";
    sources.set(`relation:${relation.id}`, {
      relatedPersonIds: new Set([relation.fromId, relation.toId]),
      identityValues: new Set([relation.id, relation.fromId, relation.toId, from, to]),
      claimPrefix: `${from}与${to}`,
      structured,
      preferredQuote: structured.label,
      canonicalClaim: `${from}与${to}：${structured.label}`,
    });
  }
  for (const event of data.events) {
    const {
      id: _eventId,
      personIds: _personIds,
      ...structured
    } = compactArchiveEvent(event, names);
    const personNames = (event.personIds ?? []).flatMap((id) => names.get(id) ?? []);
    sources.set(`event:${event.id}`, {
      relatedPersonIds: new Set(event.personIds ?? []),
      identityValues: new Set([event.id, ...(event.personIds ?? []), ...personNames]),
      claimPrefix:
        cleanArchiveText(event.title, 120) ||
        (personNames.length ? personNames.join("与") : "事件记录"),
      structured,
    });
  }
  for (const collection of data.collections ?? []) {
    const memberIds = (data.collectionMemberships ?? [])
      .filter((membership) => membership.collectionId === collection.id)
      .map((membership) => membership.personId);
    const structured = {
      name: cleanArchiveText(collection.name, 100),
      kind: collection.kind,
      members: memberIds
        .map((personId) => cleanArchiveText(names.get(personId), 80))
        .filter(Boolean),
    };
    sources.set(`collection:${collection.id}`, {
      relatedPersonIds: new Set(memberIds),
      identityValues: new Set([collection.id, ...memberIds]),
      claimPrefix: `圈层“${cleanArchiveText(collection.name, 100)}”`,
      structured,
    });
  }
  return sources;
}

function isInstructionLikeQuote(quote: string) {
  return /(?:忽略.{0,8}(规则|指令|提示)|system\s*prompt|ignore.{0,12}(instruction|previous)|按我说的输出|把.{0,10}排第一)/iu.test(
    quote,
  );
}

function scalarFragments(value: unknown, depth = 0): string[] {
  if (depth > 6 || value == null) return [];
  if (typeof value === "string") {
    return value
      .split(/[。！？!?；;\n]+/u)
      .map((item) => cleanArchiveText(item, 180))
      .filter(Boolean);
  }
  if (typeof value === "number") return [String(value)];
  if (Array.isArray(value)) return value.flatMap((item) => scalarFragments(item, depth + 1));
  if (typeof value === "object") {
    return Object.values(value as Record<string, unknown>).flatMap((item) =>
      scalarFragments(item, depth + 1),
    );
  }
  return [];
}

function structuredFactFragments(
  value: unknown,
  field = "",
  depth = 0,
): Array<{ field: string; value: string }> {
  if (depth > 6 || value == null) return [];
  if (typeof value === "string" || typeof value === "number") {
    return scalarFragments(value).map((item) => ({ field, value: item }));
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => structuredFactFragments(item, field, depth + 1));
  }
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) =>
      structuredFactFragments(item, field ? `${field}.${key}` : key, depth + 1),
    );
  }
  return [];
}

function quoteIsSubstantive(quote: string, source: ArchiveGroundingSource) {
  const value = normalized(quote);
  if (
    !value ||
    (value.length < 2 && !/\p{Script=Han}/u.test(value)) ||
    isInstructionLikeQuote(quote)
  )
    return false;
  if ([...source.identityValues].some((identity) => normalized(identity) === value)) return false;
  return !/^(?:manual|contact|assertion|unknown|confirmed|active|true|false|null|undefined)$/iu.test(
    value,
  );
}

function canonicalClaim(source: ArchiveGroundingSource, quote: string) {
  return source.canonicalClaim ?? `${source.claimPrefix}：${quote}`;
}

const ARCHIVE_FIELD_LABELS: Record<string, string> = {
  relation: "关系身份",
  title: "职位",
  org: "单位",
  department: "部门",
  tags: "标签",
  projects: "项目记录",
  closeness: "亲密度",
  hasContact: "联系方式",
  age: "年龄",
  birthday: "生日",
  gender: "性别",
  address: "地址",
  reportsTo: "汇报对象",
  likes: "喜好",
  dislikes: "反感事项",
  gifts: "礼物记录",
  metAt: "相识时间",
  aliases: "别名或账号",
  note: "备注",
  date: "日期",
  dateEnd: "结束日期",
  place: "地点",
  detail: "详情",
};

function archiveFieldLabel(field: string) {
  return ARCHIVE_FIELD_LABELS[field] ?? ARCHIVE_FIELD_LABELS[field.split(".")[0] ?? ""] ?? field;
}

function readFieldPath(value: unknown, field: string) {
  let current = value;
  for (const segment of field.split(".")) {
    if (
      !current ||
      typeof current !== "object" ||
      Array.isArray(current) ||
      !Object.prototype.hasOwnProperty.call(current, segment)
    ) {
      return { exists: false, value: undefined };
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return { exists: true, value: current };
}

function resolveProjectedFieldPath(value: unknown, requestedField?: string) {
  if (!requestedField) return undefined;
  if (readFieldPath(value, requestedField).exists) return requestedField;
  const segments = requestedField.split(".");
  for (let index = 1; index < segments.length; index += 1) {
    const suffix = segments.slice(index).join(".");
    if (readFieldPath(value, suffix).exists) return suffix;
  }
  return requestedField;
}

function isMissingArchiveValue(field: string, value: unknown) {
  if (value == null) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  if (field === "hasContact" && value === false) return true;
  if (typeof value === "object") return Object.keys(value as Record<string, unknown>).length === 0;
  return false;
}

function renderEvidenceText(citations: ArchiveCitation[]) {
  if (!citations.length) return undefined;
  const renderGroup = (kind: ArchiveCitation["kind"], title: string) => {
    const rows = citations.filter((citation) => citation.kind === kind);
    return rows.length
      ? `${title}\n${rows.map((citation) => `- [${citation.sourceRef}] ${citation.claim}\n  原记录：“${citation.quote}”`).join("\n")}`
      : "";
  };
  return ["档案依据（可回查）", renderGroup("gap", "待补信息"), renderGroup("fact", "已有事实")]
    .filter(Boolean)
    .join("\n");
}

function locallySelectedCitation(
  source: ArchiveGroundingSource,
  requestedQuote: string,
  requestedField?: string,
) {
  if (source.preferredQuote && (!requestedField || requestedField === "label")) {
    return { quote: source.preferredQuote, state: "present" as const };
  }
  if (requestedField) {
    const selected = readFieldPath(source.structured, requestedField);
    if (!selected.exists) return undefined;
    if (isMissingArchiveValue(requestedField, selected.value)) {
      return {
        quote: "（未记录）",
        state: "missing" as const,
        claim: `${source.claimPrefix}：${archiveFieldLabel(requestedField)}未记录`,
      };
    }
  }
  const facts = structuredFactFragments(source.structured).filter((item) =>
    quoteIsSubstantive(item.value, source),
  );
  if (requestedField) {
    const fieldMatches = facts.filter((item) => item.field === requestedField);
    const quote =
      fieldMatches.find((item) => /\p{Script=Han}/u.test(item.value))?.value ??
      fieldMatches[0]?.value ??
      "";
    return quote ? { quote, state: "present" as const } : undefined;
  }
  const canonical = facts.map((item) => item.value);
  const requested = normalized(requestedQuote);
  const matches = canonical.filter(
    (item) => normalized(item) === requested || requested.includes(normalized(item)),
  );
  const quote =
    matches.find((item) => /\p{Script=Han}/u.test(item)) ?? matches[0] ?? canonical[0] ?? "";
  return quote ? { quote, state: "present" as const } : undefined;
}

/**
 * Resolve any usable model-provided source references into local citations.
 * Citations are optional provenance, never permission to show the answer.
 * Invalid references are simply omitted.
 */
export function resolveAssistantArchiveCitations(options: {
  /** Accepted for callers that already have these values; neither gates citation resolution. */
  question?: string;
  answer?: string;
  archiveClaims: unknown;
  archive: ArchiveAgentData;
  includeArchive: boolean;
  /** Model boundary: only opaque refs issued by this exact session are accepted. */
  referenceSession: ArchiveAgentReferenceSession;
  hasStructuredNonArchiveAnswer?: boolean;
}): AssistantGroundingResult {
  if (!options.includeArchive) return { ok: true, citations: [] };
  const sources = archiveGroundingSources(options.archive);
  const rawClaims = Array.isArray(options.archiveClaims) ? options.archiveClaims.slice(0, 80) : [];
  const citations: ArchiveCitation[] = [];
  const citationKeys = new Set<string>();
  for (const raw of rawClaims) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const value = raw as Record<string, unknown>;
    const requestedSourceRef = typeof value.sourceRef === "string" ? value.sourceRef.trim() : "";
    const typed = /^(person|relation|event|collection):(ref_[a-f0-9]{32})$/u.exec(
      requestedSourceRef,
    );
    const bare = /^(ref_[a-f0-9]{32})$/u.exec(requestedSourceRef);
    if (!typed && !bare) continue;
    const handle = typed?.[2] ?? bare?.[1] ?? "";
    const domains: ResolvedRecordDomain[] = typed
      ? [typed[1] as ResolvedRecordDomain]
      : ["person", "relation", "event", "collection"];
    let sourceKey = "";
    let visibleSourceRef = "";
    for (const domain of domains) {
      const resolution = options.referenceSession.restoreHandle(handle, domain);
      if (resolution.status !== "resolved") continue;
      sourceKey = `${domain}:${resolution.stableId}`;
      visibleSourceRef = `${domain}:${handle}`;
      break;
    }
    const rawRequestedField =
      typeof value.field === "string" && /^[A-Za-z][A-Za-z0-9_.]{0,100}$/.test(value.field.trim())
        ? value.field.trim()
        : undefined;
    const requestedQuote = cleanArchiveText(value.quote, 300);
    const source = sources.get(sourceKey);
    if (!source) continue;
    const requestedField = resolveProjectedFieldPath(source.structured, rawRequestedField);
    const selection = locallySelectedCitation(source, requestedQuote, requestedField);
    if (!selection) continue;
    const citationKey = `${sourceKey}\u0000${requestedField ?? ""}\u0000${selection.quote}`;
    if (!citationKeys.has(citationKey)) {
      citationKeys.add(citationKey);
      citations.push({
        kind: selection.state === "missing" ? "gap" : "fact",
        sourceRef: visibleSourceRef,
        ...(requestedField ? { field: requestedField } : {}),
        quote: selection.quote,
        claim: selection.claim ?? canonicalClaim(source, selection.quote),
        state: selection.state,
      });
    }
  }

  return {
    ok: true,
    citations,
    evidenceText: renderEvidenceText(citations),
  };
}
