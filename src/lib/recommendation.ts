import type { LifeEventRecord, PersonRecord } from "./face-db";
import type { Provenance } from "./provenance";

export type RecommendationConfidence = "高" | "中" | "低";

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
    .map((item) => item?.trim())
    .filter((item): item is string => Boolean(item));
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
