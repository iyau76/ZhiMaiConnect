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

/**
 * 用本地锁定的结果渲染回答。写给用户看，不是写给开发者看：
 * 标题说「要办的事」，条目说「为什么是 Ta / 档案里写了什么 / 要注意什么」。
 */
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
  const target = cleanArchiveText(options.targetName, 80) || "指定的人";
  const heading =
    mode === "connection"
      ? `## 想找到${target}，可以先找这几位`
      : mode === "target_side"
        ? `## 还没找到能带你认识${target}的人`
        : "## 从档案里的证据看，这几位比较合适";
  const rows = candidates.map((candidate, index) => {
    const name = cleanArchiveText(candidate.person.name, 80);
    const facts = [
      `**${index + 1}. ${name}** · 匹配度 ${candidate.score}（${candidate.confidence}把握）`,
      `- 为什么是 Ta：${candidate.reasons.map((item) => cleanArchiveText(item, 300)).join("；") || "暂时没有直接理由"}`,
      `- 档案里的依据：${candidate.evidence.map((item) => cleanArchiveText(item, 400)).join("；") || "暂无"}`,
      `- 要注意：${candidate.risks.map((item) => cleanArchiveText(item, 300)).join("；") || "暂时没发现明显问题"}`,
    ];
    if (candidate.mode === "connection" && candidate.path) {
      facts.push(
        `- 你能通过谁找到 Ta：我 → ${candidate.path.personNames.map((name) => cleanArchiveText(name, 80)).join(" → ")}`,
      );
    }
    if (candidate.mode === "target_side") {
      facts.push(
        `- 和你找的人是什么关系：${candidate.targetEntry?.labels.map((label) => cleanArchiveText(label, 80)).join("、") || "关系已记录"}；这只是${target}身边的人，能不能联系上还得你自己确认。`,
      );
    }
    return facts.join("\n");
  });

  const noRows =
    mode === "target_side"
      ? `档案里还没有你和${target}之间说得清的联系路径，${target}那边也没有足够明确的关系记录。`
      : `档案里暂时没有合适的人选。可以先补几条信息：谁做过类似的事、最近和谁联系过、谁的联系方式还在。`;
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
      ? `档案里没有你和${target}之间的直接联系路径。下面是${target}身边的人：`
      : "",
    rows.length ? rows.join("\n\n") : noRows,
    mode === "target_side" && rows.length
      ? "下一步：先确认你能通过谁真正联系到上面的人，别把「和 Ta 有关系」当成「你能请动 Ta」。"
      : "",
    draft && mode !== "target_side"
      ? `## 给${cleanArchiveText(candidates[0]?.person.name, 80)}的第一句话（还没发送，可以改）\n\n> ${draft}`
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
