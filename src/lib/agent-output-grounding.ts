import {
  cleanArchiveText,
  compactArchiveEvent,
  compactArchiveRelation,
  detailedArchivePerson,
  type ArchiveAgentData,
} from "./archive-agent-tools";
import type { CandidateRecommendation } from "./recommendation";

export type RecommendationDecisionMode = "open" | "connection" | "target_side";

export interface RecommendationDecision {
  mode: RecommendationDecisionMode;
  orderedPersonIds: string[];
  accessVerified: boolean;
}

export interface ArchiveCitation {
  sourceRef: string;
  /** Stable field path selected by the model; the displayed value is still read locally. */
  field?: string;
  quote: string;
  /** Canonical archive fact rendered locally; models cannot author this field. */
  claim: string;
}

export type ArchiveCitationCandidate = ArchiveCitation;

interface ArchiveGroundingSource {
  ref: string;
  relatedPersonIds: Set<string>;
  identityValues: Set<string>;
  claimPrefix: string;
  structured: unknown;
  /** Relations have one authoritative human-facing label chosen by the ledger. */
  preferredQuote?: string;
  canonicalClaim?: string;
}

export interface AssistantGroundingResult {
  ok: boolean;
  error?: string;
  citations: ArchiveCitation[];
  evidenceText?: string;
  /**
   * Whether model-authored prose may be rendered after the canonical facts.
   * A valid citation remains usable even when the prose mixes facts into the
   * advice channel; callers discard that prose without asking the model to try
   * the same answer again.
   */
  includeModelAnswer?: boolean;
  discardedCommentaryReason?: string;
  /** Canonical, safe snippets the model may copy when repairing a citation. */
  repairCitations?: ArchiveCitationCandidate[];
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
    const structured = detailedArchivePerson(person);
    sources.set(`person:${person.id}`, {
      ref: `person:${person.id}`,
      relatedPersonIds: new Set([person.id]),
      identityValues: new Set([person.id, person.name]),
      claimPrefix:
        (normalizedNameCounts.get(normalized(person.name)) ?? 0) > 1
          ? `${person.name}（person:${person.id}）`
          : person.name,
      structured,
    });
  }
  for (const relation of data.relations) {
    const structured = compactArchiveRelation(relation, names);
    const from = names.get(relation.fromId) ?? "未知人物";
    const to = names.get(relation.toId) ?? "未知人物";
    sources.set(`relation:${relation.id}`, {
      ref: `relation:${relation.id}`,
      relatedPersonIds: new Set([relation.fromId, relation.toId]),
      identityValues: new Set([relation.id, relation.fromId, relation.toId, from, to]),
      claimPrefix: `${from}与${to}`,
      structured,
      preferredQuote: structured.label,
      canonicalClaim: `${from}与${to}：${structured.label}`,
    });
  }
  for (const event of data.events) {
    const structured = compactArchiveEvent(event, names);
    const personNames = (event.personIds ?? []).flatMap((id) => names.get(id) ?? []);
    sources.set(`event:${event.id}`, {
      ref: `event:${event.id}`,
      relatedPersonIds: new Set(event.personIds ?? []),
      identityValues: new Set([event.id, ...(event.personIds ?? []), ...personNames]),
      claimPrefix: personNames.length ? personNames.join("与") : "事件记录",
      structured,
    });
  }
  for (const collection of data.collections ?? []) {
    const memberIds = (data.collectionMemberships ?? [])
      .filter((membership) => membership.collectionId === collection.id)
      .map((membership) => membership.personId);
    const structured = {
      id: collection.id,
      name: cleanArchiveText(collection.name, 100),
      kind: collection.kind,
      memberIds,
    };
    sources.set(`collection:${collection.id}`, {
      ref: `collection:${collection.id}`,
      relatedPersonIds: new Set(memberIds),
      identityValues: new Set([collection.id, ...memberIds]),
      claimPrefix: "圈层记录",
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

function claimsArchiveEvidence(value: string) {
  return /(?:根据|查阅|本机|当前|人物)?(?:档案|人物库|资料库|记录).{0,24}(?:显示|记载|写有|包含|存在|没有|未找到|不存在|相关|关联)/u.test(
    value,
  );
}

function answerUnits(value: string) {
  return value
    .split(/[。！？!?；;\n]+/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

function mentionedPersonGroups(value: string, people: ArchiveAgentData["persons"]) {
  const text = normalized(value);
  const grouped = new Map<string, ArchiveAgentData["persons"]>();
  for (const person of people) {
    // The ego record is a point of view, not a proper-name mention. Treating
    // the Chinese pronoun "我" as a person name makes ordinary phrases such as
    // "请告诉我" look like unsupported archive claims.
    if (person.entityRole === "ego") continue;
    const name = normalized(person.name);
    if (!name || !text.includes(name)) continue;
    grouped.set(name, [...(grouped.get(name) ?? []), person]);
  }
  const occupied = Array.from({ length: text.length }, () => false);
  const selected = new Set<string>();
  for (const name of [...grouped.keys()].sort((left, right) => right.length - left.length)) {
    let cursor = 0;
    while (cursor <= text.length - name.length) {
      const at = text.indexOf(name, cursor);
      if (at < 0) break;
      const end = at + name.length;
      if (!occupied.slice(at, end).some(Boolean)) {
        selected.add(name);
        for (let index = at; index < end; index += 1) occupied[index] = true;
      }
      cursor = at + Math.max(1, name.length);
    }
  }
  return [...selected].map((name) => grouped.get(name)!);
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

function renderEvidenceText(citations: ArchiveCitation[]) {
  return citations.length
    ? `档案依据（可回查）\n${citations.map((citation) => `- [${citation.sourceRef}] ${citation.claim}\n  原记录：“${citation.quote}”`).join("\n")}`
    : undefined;
}

function locallySelectedQuote(
  source: ArchiveGroundingSource,
  requestedQuote: string,
  requestedField?: string,
) {
  if (source.preferredQuote && (!requestedField || requestedField === "label")) {
    return source.preferredQuote;
  }
  const facts = structuredFactFragments(source.structured).filter((item) =>
    quoteIsSubstantive(item.value, source),
  );
  if (requestedField) {
    const fieldMatches = facts.filter((item) => item.field === requestedField);
    return (
      fieldMatches.find((item) => /\p{Script=Han}/u.test(item.value))?.value ??
      fieldMatches[0]?.value ??
      ""
    );
  }
  const canonical = facts.map((item) => item.value);
  const requested = normalized(requestedQuote);
  const matches = canonical.filter(
    (item) => normalized(item) === requested || requested.includes(normalized(item)),
  );
  return matches.find((item) => /\p{Script=Han}/u.test(item)) ?? matches[0] ?? canonical[0] ?? "";
}

function repairCitationCandidates(
  sources: Map<string, ArchiveGroundingSource>,
  mentionedGroups: ArchiveAgentData["persons"][],
): ArchiveCitationCandidate[] {
  const mentionedIds = new Set(
    mentionedGroups.flatMap((group) => group.map((person) => person.id)),
  );
  const candidates: ArchiveCitationCandidate[] = [];
  for (const source of sources.values()) {
    if (
      mentionedIds.size > 0 &&
      ![...source.relatedPersonIds].some((personId) => mentionedIds.has(personId))
    ) {
      continue;
    }
    for (const fact of structuredFactFragments(source.structured).filter((item) =>
      quoteIsSubstantive(item.value, source),
    )) {
      candidates.push({
        sourceRef: source.ref,
        field: fact.field,
        quote: fact.value,
        claim: canonicalClaim(source, fact.value),
      });
      if (candidates.length >= 8) return candidates;
    }
  }
  return candidates;
}

function safeArchiveCommentary(value: string) {
  if (!value.trim()) return true;
  return answerUnits(value).every((unit) => {
    const assertsPersonFact =
      /(?:他|她|ta|其|该人物|此人|对方).{0,8}(?:还是|也是|就是|是|有|任职|担任|住在|毕业于|喜欢|擅长|认识|属于)|(?:^|[：:,，])(?:还是|也是|就是|是|有|任职|担任|住在|毕业于|喜欢|擅长|认识|属于)/iu.test(
        unit,
      );
    return !assertsPersonFact;
  });
}

/**
 * The model selects sourceRef + field (legacy quote is still accepted). Archive facts are rendered from
 * canonical local sources; free-form model prose is a separate advice channel.
 */
export function validateAssistantArchiveGrounding(options: {
  question: string;
  answer: string;
  archiveClaims: unknown;
  archive: ArchiveAgentData;
  includeArchive: boolean;
  hasStructuredNonArchiveAnswer?: boolean;
}): AssistantGroundingResult {
  if (!options.includeArchive) return { ok: true, citations: [] };
  const sources = archiveGroundingSources(options.archive);
  const questionGroups = mentionedPersonGroups(options.question, options.archive.persons);
  const answerGroups = mentionedPersonGroups(options.answer, options.archive.persons);
  const archiveAnswerClaimsEvidence =
    options.archive.persons.length > 0 && claimsArchiveEvidence(options.answer);
  const repairCitations = repairCitationCandidates(sources, questionGroups);
  const rawClaims = Array.isArray(options.archiveClaims) ? options.archiveClaims.slice(0, 12) : [];
  const archiveSeparationRequired =
    questionGroups.length > 0 ||
    answerGroups.length > 0 ||
    archiveAnswerClaimsEvidence ||
    rawClaims.length > 0;
  const citations: ArchiveCitation[] = [];
  const citationKeys = new Set<string>();
  for (const raw of rawClaims) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { ok: false, error: "档案引用格式无效", citations: [], repairCitations };
    }
    const value = raw as Record<string, unknown>;
    const sourceRef = typeof value.sourceRef === "string" ? value.sourceRef.trim() : "";
    const requestedField =
      typeof value.field === "string" && /^[A-Za-z][A-Za-z0-9_.]{0,100}$/.test(value.field.trim())
        ? value.field.trim()
        : undefined;
    const requestedQuote = cleanArchiveText(value.quote, 300);
    const source = sources.get(sourceRef);
    if (!source) {
      return {
        ok: false,
        error: `档案引用 ${sourceRef || "(空)"} 无法在本地原记录中核验`,
        citations: [],
        repairCitations,
      };
    }
    const quote = locallySelectedQuote(source, requestedQuote, requestedField);
    if (!quote) {
      return {
        ok: false,
        error: `档案引用 ${sourceRef} 没有可展示的本地事实`,
        citations: [],
        repairCitations,
      };
    }
    if (
      questionGroups.length > 0 &&
      !questionGroups.some((group) =>
        group.some((person) => source.relatedPersonIds.has(person.id)),
      )
    ) {
      return {
        ok: false,
        error: `档案引用 ${sourceRef} 与问题中的目标人物不一致`,
        citations: [],
        repairCitations,
      };
    }
    const citationKey = `${sourceRef}\u0000${quote}`;
    if (!citationKeys.has(citationKey)) {
      citationKeys.add(citationKey);
      citations.push({
        sourceRef,
        ...(requestedField ? { field: requestedField } : {}),
        quote,
        claim: canonicalClaim(source, quote),
      });
    }
  }

  // Facts come from locally resolved citations. Once at least one citation is
  // valid, model prose is optional decoration: unsafe prose is discarded in
  // this pass instead of wasting more model rounds trying to make it rephrase
  // an answer the ledger can already render deterministically.
  const answerText = normalized(options.answer);
  const repeatsCanonicalFact = citations.some((citation) => {
    const quote = normalized(citation.quote);
    const claim = normalized(citation.claim);
    return (
      (quote.length >= 2 && answerText.includes(quote)) ||
      (claim.length >= 2 && answerText.includes(claim))
    );
  });
  const commentaryError =
    answerGroups.length || archiveAnswerClaimsEvidence || repeatsCanonicalFact
      ? "自由分析区混入了本机人物或档案事实"
      : archiveSeparationRequired && !safeArchiveCommentary(options.answer)
        ? "自由分析区混入了未由本地账本渲染的人物断言"
        : undefined;
  if (commentaryError) {
    if (citations.length) {
      return {
        ok: true,
        citations,
        evidenceText: renderEvidenceText(citations),
        includeModelAnswer: false,
        discardedCommentaryReason: commentaryError,
      };
    }
    return {
      ok: false,
      error: `${commentaryError}；请先提供可核验的 archiveClaims`,
      citations: [],
      repairCitations,
    };
  }

  if (
    questionGroups.length &&
    !citations.length &&
    !options.answer.trim() &&
    !options.hasStructuredNonArchiveAnswer
  ) {
    return {
      ok: false,
      error: "档案人物问题既没有选择可核验的 archiveClaims，也没有给出下一步建议",
      citations: [],
      repairCitations,
    };
  }

  return {
    ok: true,
    citations,
    evidenceText: renderEvidenceText(citations),
    includeModelAnswer: true,
  };
}
