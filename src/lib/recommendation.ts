import type { LifeEventRecord, PersonRecord } from "./face-db";
import type { Provenance } from "./provenance";

export type RecommendationConfidence = "高" | "中" | "低";

/**
 * A semantic task decomposition authored by the model. The slot describes what
 * the task needs; it never names or ranks people. Stable ids are assigned
 * locally after the model response is parsed.
 */
export interface RecommendationCapabilitySlot {
  id: string;
  label: string;
  deliverable: string;
  searchTerms: string[];
}

export interface RecommendationCapabilityMatch {
  slotId: string;
  label: string;
  deliverable: string;
  matchedTerms: string[];
  evidence: string[];
  discovery: "lexical" | "semantic" | "both";
  /** Position assigned by the local ledger after evidence verification. */
  localRank?: number;
}

/**
 * A model may nominate a person because it understands a stored fact even when
 * the task and that fact share no words. The person id is restored locally from
 * an opaque reference; evidence field values are always read back from the
 * fact ledger instead of accepting model-authored prose.
 */
export interface RecommendationSemanticCandidate {
  personId: string;
  evidenceFields: RecommendationCapabilityEvidenceField[];
  reason?: string;
}

export const RECOMMENDATION_CAPABILITY_EVIDENCE_FIELDS = [
  "relation",
  "title",
  "org",
  "department",
  "tags",
  "projects",
] as const;

export type RecommendationCapabilityEvidenceField =
  (typeof RECOMMENDATION_CAPABILITY_EVIDENCE_FIELDS)[number];

export interface CandidateRecommendation {
  person: PersonRecord;
  score: number;
  reasons: string[];
  evidence: string[];
  risks: string[];
  updatedAt: number;
  confidence: RecommendationConfidence;
  source?: Provenance;
  mode?: "open" | "connection" | "target_side";
  /** 目标引荐模式下由本地算法给出的真实路径；AI 只能解释，不能改写。 */
  path?: {
    targetId: string;
    personIds: string[];
    personNames: string[];
    relationIds: string[];
    labels: string[];
    cost: number;
    direct: boolean;
  };
  /** A target-side lead is not proof that the user can reach this person. */
  targetEntry?: {
    targetId: string;
    relationIds: string[];
    labels: string[];
  };
  /** Open-task assignments verified against local profile facts. */
  capabilityMatches?: RecommendationCapabilityMatch[];
}

const DAY = 86_400_000;

const ALIASES: Array<{ pattern: RegExp; terms: string[] }> = [
  { pattern: /拍照|摄影|照片|相机|视觉/, terms: ["拍照", "摄影", "照片", "相机", "视觉"] },
  { pattern: /活动|聚会|组织|校园/, terms: ["活动", "聚会", "组织", "运营", "社团", "校园"] },
  { pattern: /合同|法律|法务|协议/, terms: ["合同", "法律", "法务", "律师", "协议"] },
  { pattern: /简历|招聘|面试|求职/, terms: ["简历", "招聘", "面试", "求职", "人事", "hr"] },
  { pattern: /设计|海报|界面|品牌/, terms: ["设计", "海报", "界面", "视觉", "品牌"] },
  {
    pattern: /代码|编程|开发|网站|程序/,
    terms: ["代码", "编程", "开发", "网站", "程序", "前端", "后端"],
  },
  { pattern: /写作|文案|宣传|媒体/, terms: ["写作", "文案", "宣传", "媒体", "编辑"] },
  { pattern: /数据|统计|分析|表格/, terms: ["数据", "统计", "分析", "表格", "研究"] },
  {
    pattern: /心脏|胸痛|心悸|心血管|冠心|心内科/,
    terms: ["心脏", "胸痛", "心悸", "心血管", "冠心", "心内科", "心内科医生"],
  },
  {
    pattern: /看病|就医|医生|医院|医疗|健康/,
    terms: ["看病", "就医", "医生", "医师", "医院", "医疗", "健康"],
  },
  {
    pattern: /财务|会计|税务|审计|报税/,
    terms: ["财务", "会计", "税务", "审计", "报税", "注册会计师"],
  },
];

interface TaskDomain {
  id: string;
  task: RegExp;
  strongEvidence: RegExp;
  broadEvidence?: RegExp;
  highStakes?: boolean;
}

/**
 * Skills dominate relationship warmth for professional/high-stakes requests.
 * This is a small, inspectable ontology rather than a bag-of-words-only score.
 */
const TASK_DOMAINS: TaskDomain[] = [
  {
    id: "cardiology",
    task: /心脏|胸痛|心悸|心血管|冠心|心内科/,
    strongEvidence: /心内科|心血管|心脏专科|心脏科|心脏医生/,
    broadEvidence: /医生|医师|医院|医疗|临床/,
    highStakes: true,
  },
  {
    id: "medical",
    task: /看病|就医|医生|医院|医疗|健康|症状|疼痛/,
    strongEvidence: /医生|医师|医院|医疗|临床|护理|药师/,
    highStakes: true,
  },
  {
    id: "legal",
    task: /合同|法律|法务|协议|诉讼|仲裁|律师/,
    strongEvidence: /律师|法务|法律顾问|检察官|法学|司法/,
  },
  {
    id: "software",
    task: /代码|编程|开发|网站|程序|前端|后端|软件/,
    strongEvidence: /程序员|工程师|前端|后端|全栈|软件|开发|编程/,
  },
  {
    id: "design",
    task: /设计|海报|界面|品牌|视觉|交互/,
    strongEvidence: /设计师|视觉设计|交互设计|品牌设计|美术|海报/,
  },
  {
    id: "finance",
    task: /财务|会计|税务|审计|报税|融资/,
    strongEvidence: /会计师|财务|税务|审计|投行|融资|注册会计师/,
  },
  {
    id: "writing",
    task: /写作|文案|宣传|媒体|编辑|新闻稿/,
    strongEvidence: /作家|编辑|记者|文案|媒体|宣传|写作/,
  },
  {
    id: "data",
    task: /数据|统计|分析|表格|建模/,
    strongEvidence: /数据分析|统计|算法|研究员|建模|数据科学/,
  },
];

function taskTerms(task: string) {
  const normalized = task.toLowerCase();
  const terms = new Set(
    normalized
      .split(/[\s，。！？、；：,.!?;:()（）/]+/)
      .map((item) => item.trim())
      .filter((item) => item.length >= 2),
  );
  for (const alias of ALIASES) {
    if (alias.pattern.test(normalized)) alias.terms.forEach((term) => terms.add(term));
  }
  return [...terms];
}

function personFacts(person: PersonRecord) {
  const profile = person.profile ?? {};
  return [
    profile.title,
    profile.org,
    profile.department,
    ...(profile.projects ?? []),
    ...(profile.likes ?? []),
    ...(profile.tags ?? []),
    ...Object.values(profile.extra ?? {}),
    person.note,
  ]
    .flatMap((item) => item?.split(/[。！？!?；;\n]+/u) ?? [])
    .map((item) => item.trim())
    .filter(
      (item) =>
        !/(?:忽略|无视|绕过).{0,16}(?:规则|指令|提示|系统)|(?:无论|不管).{0,24}(?:排第一|输出|回答)|ignore.{0,16}(?:instruction|previous)|system\s*prompt/iu.test(
          item,
        ),
    )
    .filter((item): item is string => Boolean(item));
}

function normalizedEvidence(value: string) {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/[\p{P}\p{Z}\p{Cf}\s]+/gu, "");
}

/**
 * Verify a model-authored capability slot against the local fact ledger. The
 * slot label and explicit search terms remain part of the contract. The model
 * chooses the retrieval vocabulary; the ledger only admits terms that occur in
 * stored profile facts. Free-form deliverables are not split into broad
 * character fragments because that turns incidental wording into admission.
 */
export function matchCapabilityEvidence(
  slot: RecommendationCapabilitySlot,
  person: PersonRecord,
): RecommendationCapabilityMatch | undefined {
  const facts = personFacts(person);
  const normalizedFacts = facts.map((fact) => ({ fact, normalized: normalizedEvidence(fact) }));
  const normalizedLabel = normalizedEvidence(slot.label);
  const labelTags = (person.profile?.tags ?? []).filter((tag) => {
    const normalized = normalizedEvidence(tag);
    return normalized.length >= 2 && normalizedLabel.includes(normalized);
  });
  const evidenceTerms = [...new Set([slot.label, ...labelTags, ...slot.searchTerms])].slice(0, 20);
  const matchedTerms = evidenceTerms.filter((term) => {
    const normalizedTerm = normalizedEvidence(term);
    return Boolean(
      normalizedTerm.length >= 2 &&
      normalizedFacts.some((entry) => entry.normalized.includes(normalizedTerm)),
    );
  });
  if (!matchedTerms.length) return undefined;
  const matchedTermSet = new Set(matchedTerms.map(normalizedEvidence));
  const evidence = normalizedFacts
    .filter((entry) => [...matchedTermSet].some((term) => term && entry.normalized.includes(term)))
    .map((entry) => entry.fact)
    .slice(0, 3);
  return {
    slotId: slot.id,
    label: slot.label,
    deliverable: slot.deliverable,
    matchedTerms,
    evidence,
    discovery: "lexical",
  };
}

function verifiedSemanticEvidence(
  candidate: RecommendationSemanticCandidate | undefined,
  person: PersonRecord,
) {
  if (!candidate || candidate.personId !== person.id) return [];
  const profile = person.profile ?? {};
  const values: Record<RecommendationCapabilityEvidenceField, readonly (string | undefined)[]> = {
    relation: [profile.relation],
    title: [profile.title],
    org: [profile.org],
    department: [profile.department],
    tags: profile.tags ?? [],
    projects: profile.projects ?? [],
  };
  const verified = candidate.evidenceFields.flatMap((field) => {
    return values[field].flatMap((value) => {
      const fact = value?.trim();
      return fact ? [`${field}：${fact}`] : [];
    });
  });
  return [...new Set(verified)].slice(0, 3);
}

function taskDomainMatches(task: string, person: PersonRecord) {
  const text = personFacts(person).join("；");
  // Domains are ordered from specific to broad (for example cardiology before
  // general medicine), so a broad credential cannot masquerade as a specialty.
  const domain = TASK_DOMAINS.find((candidate) => candidate.task.test(task));
  if (!domain) return [];
  return [
    {
      domain,
      strength: domain.strongEvidence.test(text) ? 1 : domain.broadEvidence?.test(text) ? 0.45 : 0,
    },
  ];
}

export function taskSafetyNotice(task: string) {
  if (/胸痛|胸闷.{0,6}(大汗|呼吸困难)|呼吸困难|晕厥|意识不清/.test(task)) {
    return "该描述可能涉及急症：不要等待熟人回复，应立即联系当地急救服务或就近急诊；联系人推荐只能用于陪同和协助。";
  }
  return undefined;
}

function relevantFacts(task: string, person: PersonRecord) {
  const normalized = task.toLowerCase().replace(/\s+/g, "");
  const terms = taskTerms(task);
  return personFacts(person).filter((fact) => {
    const value = fact.toLowerCase().replace(/\s+/g, "");
    return (
      (value.length >= 2 && normalized.includes(value)) ||
      terms.some((term) => value.includes(term) || (term.length >= 3 && term.includes(value)))
    );
  });
}

function dateAt(date: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.slice(0, 10));
  if (!match) return 0;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1900 || year > 9999) return 0;
  const probe = new Date(year, month - 1, day);
  return probe.getFullYear() === year && probe.getMonth() === month - 1 && probe.getDate() === day
    ? probe.getTime()
    : 0;
}

function recentEvents(personId: string, events: LifeEventRecord[]) {
  return events
    .filter((event) => event.personIds?.includes(personId) && dateAt(event.date) > 0)
    .sort((a, b) => b.date.localeCompare(a.date));
}

/**
 * “找谁帮忙”的本地、可解释候选召回。AI 只负责后续比较和润色，不改变这里的排序。
 */
export function rankCandidates(
  task: string,
  persons: PersonRecord[],
  events: LifeEventRecord[],
  now = new Date(),
): CandidateRecommendation[] {
  const nowAt = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

  return persons
    .map((person) => {
      const facts = relevantFacts(task, person);
      const domainMatches = taskDomainMatches(task, person);
      const requestedDomains = domainMatches.length;
      const strongestDomain = domainMatches.reduce(
        (maximum, item) => Math.max(maximum, item.strength),
        0,
      );
      const interactions = recentEvents(person.id, events);
      const latest = interactions[0];
      const latestAt = latest ? dateAt(latest.date) : 0;
      const ageDays = latestAt ? Math.max(0, Math.floor((nowAt - latestAt) / DAY)) : null;
      const rawCloseness = person.profile?.closeness;
      const closeness = Number.isFinite(rawCloseness)
        ? Math.max(1, Math.min(5, rawCloseness as number))
        : 1;
      const hasContact = Boolean(person.profile?.contact?.trim());
      const cooperation = interactions.find(
        (event) => event.kind === "帮忙" || (event.personIds?.length ?? 0) > 1,
      );

      let score = 0;
      // For a recognized professional domain, explicit competence has a larger
      // ceiling than all convenience/social signals combined.
      score += requestedDomains
        ? strongestDomain >= 1
          ? 62
          : strongestDomain > 0
            ? 30
            : -28
        : Math.min(48, facts.length ? 28 + (facts.length - 1) * 7 : 0);
      score += (closeness - 1) * 3;
      if (ageDays !== null)
        score += ageDays <= 30 ? 10 : ageDays <= 180 ? 7 : ageDays <= 365 ? 4 : 0;
      if (cooperation) score += 6;
      score += hasContact ? 8 : 0;

      const reasons: string[] = [];
      const evidence: string[] = [];
      const risks: string[] = [];
      if (facts.length) {
        reasons.push(`任务匹配：${facts.slice(0, 3).join("、")}`);
        evidence.push(`人物档案：${facts.slice(0, 3).join("；")}`);
      } else {
        risks.push("未找到直接的技能匹配证据");
      }
      if (requestedDomains) {
        if (strongestDomain >= 1) {
          const matched = domainMatches
            .filter((item) => item.strength >= 1)
            .map((item) => item.domain.id)
            .join("、");
          reasons.unshift(`专业能力匹配：${matched}`);
          evidence.unshift(`职位/档案命中任务能力域：${matched}`);
        } else if (strongestDomain > 0) {
          risks.unshift("只找到宽泛专业背景，没有对应专科或直接能力证据");
        } else {
          risks.unshift("缺少该专业任务所需的能力证据，不能只因关系近而优先推荐");
        }
      }
      if (closeness > 1) reasons.push(`亲密度 ${closeness}/5`);
      if (latest) {
        reasons.push(`最近互动：${latest.date} ${latest.title}`);
        evidence.push(`共同事件：${latest.date} · ${latest.title}`);
      } else {
        risks.push("没有共同事件记录");
      }
      if (cooperation && cooperation.id !== latest?.id) {
        evidence.push(`合作记录：${cooperation.date} · ${cooperation.title}`);
      }
      if (!hasContact) {
        score -= 5;
        risks.push("缺少可用联系方式");
      }
      if (ageDays !== null && ageDays > 730) {
        score -= 8;
        risks.push(`最近互动已过去约 ${Math.floor(ageDays / 365)} 年，信息可能过期`);
      }
      if (person.source?.kind === "ai" || person.source?.kind === "web") {
        score -= 3;
        risks.push("档案含待人工复核的推断来源");
      }

      const updatedAt = Math.max(
        person.updatedAt ?? person.createdAt,
        person.source?.at ?? person.createdAt,
        latestAt,
      );
      const confidence: RecommendationConfidence = requestedDomains
        ? strongestDomain >= 1 && hasContact
          ? "高"
          : strongestDomain > 0 || strongestDomain >= 1
            ? "中"
            : "低"
        : facts.length >= 2 && hasContact
          ? "高"
          : facts.length >= 1 || closeness >= 4
            ? "中"
            : "低";
      return {
        person,
        score: Math.round(score),
        reasons,
        evidence,
        risks,
        updatedAt,
        confidence,
        source: person.source,
      };
    })
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.updatedAt - a.updatedAt ||
        a.person.name.localeCompare(b.person.name, "zh-CN"),
    );
}

/**
 * Rank one model-authored capability slot over the complete archive. Semantic
 * inclusion comes from explicit lexical terms or a model-nominated local field;
 * legacy task aliases and task-domain regexes never participate in this path.
 */
export function rankCapabilityCandidates(
  slot: RecommendationCapabilitySlot,
  persons: PersonRecord[],
  events: LifeEventRecord[],
  now = new Date(),
  semanticCandidates: readonly RecommendationSemanticCandidate[] = [],
): CandidateRecommendation[] {
  const nowAt = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const semanticByPerson = new Map(
    semanticCandidates.map((candidate) => [candidate.personId, candidate] as const),
  );
  return persons
    .flatMap((person) => {
      const lexicalMatch = matchCapabilityEvidence(slot, person);
      const semanticCandidate = semanticByPerson.get(person.id);
      const semanticEvidence = verifiedSemanticEvidence(semanticCandidate, person);
      if (!lexicalMatch && !semanticEvidence.length) return [];
      const discovery =
        lexicalMatch && semanticEvidence.length
          ? "both"
          : semanticEvidence.length
            ? "semantic"
            : "lexical";
      const evidenceKeys = new Set<string>();
      const evidence = [...semanticEvidence, ...(lexicalMatch?.evidence ?? [])]
        .filter((item) => {
          const key = normalizedEvidence(
            item.replace(/^(?:relation|title|org|department|tags|projects)[：:]/iu, ""),
          );
          if (!key || evidenceKeys.has(key)) return false;
          evidenceKeys.add(key);
          return true;
        })
        .slice(0, 3);
      const match: RecommendationCapabilityMatch = {
        slotId: slot.id,
        label: slot.label,
        deliverable: slot.deliverable,
        matchedTerms: lexicalMatch?.matchedTerms ?? [],
        evidence,
        discovery,
      };
      const interactions = recentEvents(person.id, events);
      const latest = interactions[0];
      const latestAt = latest ? dateAt(latest.date) : 0;
      const ageDays = latestAt ? Math.max(0, Math.floor((nowAt - latestAt) / DAY)) : null;
      const cooperation = interactions.find(
        (event) => event.kind === "帮忙" || (event.personIds?.length ?? 0) > 1,
      );
      const rawCloseness = person.profile?.closeness;
      const closeness = Number.isFinite(rawCloseness)
        ? Math.max(1, Math.min(5, rawCloseness as number))
        : 1;
      const hasContact = Boolean(person.profile?.contact?.trim());
      const labelMatched = match.matchedTerms.some(
        (term) => normalizedEvidence(term) === normalizedEvidence(slot.label),
      );
      let score =
        match.matchedTerms.length * 18 + match.evidence.length * 5 + (labelMatched ? 18 : 0);
      if (semanticEvidence.length) score += 34 + Math.min(12, semanticEvidence.length * 4);
      score += hasContact ? 10 : 0;
      score += (closeness - 1) * 2;
      if (ageDays !== null) score += ageDays <= 30 ? 6 : ageDays <= 180 ? 4 : 2;
      if (cooperation) score += 4;

      const risks: string[] = [];
      if (!hasContact) {
        score -= 5;
        risks.push("缺少可用联系方式");
      }
      if (!Number.isFinite(rawCloseness)) {
        score -= 3;
        risks.push("未记录亲密度，联系把握有限");
      }
      if (!latest) risks.push("没有共同事件记录");
      if (ageDays !== null && ageDays > 730) {
        score -= 6;
        risks.push(`最近互动已过去约 ${Math.floor(ageDays / 365)} 年，信息可能过期`);
      }
      if (person.source?.kind === "ai" || person.source?.kind === "web") {
        score -= 3;
        risks.push("档案含待人工复核的推断来源");
      }

      const updatedAt = Math.max(
        person.updatedAt ?? person.createdAt,
        person.source?.at ?? person.createdAt,
        latestAt,
      );
      const confidence: RecommendationConfidence =
        match.matchedTerms.length >= 2 && hasContact
          ? "高"
          : match.matchedTerms.length >= 2 || hasContact
            ? "中"
            : "低";
      return [
        {
          person,
          score: Math.max(0, Math.min(100, Math.round(score))),
          confidence,
          reasons: [
            `能力槽“${slot.label}”：${slot.deliverable}`,
            ...(semanticEvidence.length
              ? [`模型语义召回，本地已核对档案事实：${semanticEvidence.join("、")}`]
              : []),
            ...(match.matchedTerms.length ? [`词面证据：${match.matchedTerms.join("、")}`] : []),
            ...(closeness > 1 ? [`亲密度 ${closeness}/5`] : []),
            ...(latest ? [`最近互动：${latest.date} ${latest.title}`] : []),
          ],
          evidence: match.evidence.map((item) => `“${slot.label}”档案证据：${item}`),
          risks,
          updatedAt,
          source: person.source,
          mode: "open" as const,
          capabilityMatches: [match],
        },
      ];
    })
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.updatedAt - left.updatedAt ||
        left.person.name.localeCompare(right.person.name, "zh-CN"),
    );
}

export interface StaleContact {
  person: PersonRecord;
  days: number;
  lastDate?: string;
}

/** 本地生成长期未联系提醒；没有互动记录时以建档时间作为保守起点。 */
export function staleContacts(
  persons: PersonRecord[],
  events: LifeEventRecord[],
  thresholdDays = 90,
  now = new Date(),
): StaleContact[] {
  const nowAt = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return persons
    .map((person) => {
      const latest = recentEvents(person.id, events)[0];
      const at = latest ? dateAt(latest.date) : person.createdAt;
      return {
        person,
        days: Math.max(0, Math.floor((nowAt - at) / DAY)),
        lastDate: latest?.date,
      };
    })
    .filter((item) => item.days >= thresholdDays)
    .sort((a, b) => b.days - a.days);
}

export function recommendationPrompt(task: string, candidates: CandidateRecommendation[]) {
  const connectionMode = candidates.some((candidate) => candidate.mode === "connection");
  const targetSideMode = candidates.some((candidate) => candidate.mode === "target_side");
  const rows = candidates
    .slice(0, 3)
    .map((item, index) =>
      [
        `${index + 1}. ${item.person.name}（本地评分 ${item.score}，置信度${item.confidence}）`,
        `理由：${item.reasons.join("；") || "暂无直接理由"}`,
        `证据：${item.evidence.join("；") || "暂无"}`,
        `风险：${item.risks.join("；") || "未发现明显风险"}`,
        item.path ? `固定路径：我 → ${item.path.personNames.join(" → ")}` : "",
        item.targetEntry
          ? `目标侧关系：${item.targetEntry.labels.join("、")}（未验证本人可达）`
          : "",
      ].join("\n"),
    );
  return [
    `任务：${task}`,
    connectionMode
      ? "以下候选、路径及排序由本地确定性路径工具产生。不得添加人物、改写路径、改变排序或声称不存在的关系："
      : targetSideMode
        ? "以下只是目标侧潜在入口；档案没有证明用户能联系到他们。不得把相关分解释成可达概率，也不得虚构本人到候选的路径："
        : "以下候选及排序由本地确定性规则产生，不得添加名单外人物或改变排序：",
    rows.join("\n\n"),
    connectionMode
      ? "请按固定路径比较可联系性、关系证据和风险，明确逐跳应如何开口，再给第一名写一段可编辑的引荐请求。不要省略不确定性，也不要声称自动发送。"
      : targetSideMode
        ? "请比较这些人与目标的关系依据，明确第一步仍是补充本人到候选的联系渠道；不要直接写成已经可以请托的路径。"
        : "请比较前三名各自适合与不适合之处，回答“为什么不是另一个人”，再给第一名写一段可编辑的求助话术。不要声称自动发送。",
  ].join("\n\n");
}
