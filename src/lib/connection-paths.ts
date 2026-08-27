import type { LifeEventRecord, PersonRecord, RelationRecord } from "./face-db";
import type { CandidateRecommendation, RecommendationConfidence } from "./recommendation";
import { relationEvidenceMode } from "./relation-graph";

const DAY = 86_400_000;

export interface TargetIntent {
  mode: "open" | "target" | "ambiguous";
  matches: PersonRecord[];
  target?: PersonRecord;
}

export interface ConnectionPathOptions {
  persons: PersonRecord[];
  relations: RelationRecord[];
  events: LifeEventRecord[];
  targetId: string;
  task?: string;
  maxHops?: number;
  limit?: number;
  includeInferred?: boolean;
  includePending?: boolean;
  now?: Date;
}

interface AccessEdge {
  person: PersonRecord;
  strength: number;
  cost: number;
  evidence: string[];
  risks: string[];
  updatedAt: number;
}

interface TraversalEdge {
  relation: RelationRecord;
  fromId: string;
  toId: string;
  strength: number;
  cost: number;
  evidence: string;
  risks: string[];
}

interface FoundPath {
  connector: PersonRecord;
  personIds: string[];
  edges: TraversalEdge[];
  access: AccessEdge;
  cost: number;
}

function normalized(value: string) {
  return value.toLowerCase().replace(/[\s·•._-]+/g, "");
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function aliases(person: PersonRecord) {
  return [person.name, ...(person.profile?.identities ?? []).map((identity) => identity.alias)]
    .map((item) => item.trim())
    .filter((item) => item.length >= 2);
}

/** 只把档案中真实出现的人名当目标；多人同时命中时交给用户选择。 */
export function detectTargetIntent(task: string, persons: PersonRecord[]): TargetIntent {
  const compactTask = normalized(task);
  const matches = persons.filter((person) =>
    aliases(person).some((alias) => compactTask.includes(normalized(alias))),
  );
  if (!matches.length) return { mode: "open", matches: [] };

  const targetTerms = /找|联系|接触|拜访|请教|引荐|介绍|通过谁|办事|约到|牵线/;
  const targeted = matches.filter((person) =>
    aliases(person).some((alias) => {
      const escaped = escapeRegExp(normalized(alias));
      return new RegExp(
        `(?:找|联系|接触|拜访|请教|引荐|介绍|约到|牵线).{0,12}${escaped}|${escaped}.{0,12}(?:联系|办事|引荐|介绍|牵线)`,
      ).test(compactTask);
    }),
  );
  const candidates = targeted.length ? targeted : targetTerms.test(compactTask) ? matches : [];
  if (candidates.length === 1)
    return { mode: "target", matches: candidates, target: candidates[0] };
  if (candidates.length > 1) return { mode: "ambiguous", matches: candidates };
  return { mode: "open", matches };
}

function eventAt(event?: LifeEventRecord) {
  if (!event?.date) return 0;
  const at = new Date(`${event.date.slice(0, 10)}T00:00:00`).getTime();
  return Number.isFinite(at) ? at : 0;
}

function recencyFactor(at: number, now: Date) {
  if (!at) return 0;
  const days = Math.max(0, Math.floor((now.getTime() - at) / DAY));
  return days <= 30 ? 1 : days <= 180 ? 0.7 : days <= 365 ? 0.45 : days <= 730 ? 0.2 : 0.08;
}

/** 虚拟“我”节点只连接到确有联系方式、亲密度或互动证据的人。 */
function accessEdge(person: PersonRecord, events: LifeEventRecord[], now: Date): AccessEdge | null {
  const interactions = events
    .filter((event) => event.personIds?.includes(person.id))
    .sort((a, b) => eventAt(b) - eventAt(a));
  const hasContact = Boolean(person.profile?.contact?.trim());
  const closeness = person.profile?.closeness;
  if (!hasContact && closeness === undefined && !interactions.length) return null;

  const contact = hasContact ? 0.32 : 0;
  const closenessScore =
    closeness === undefined ? 0 : 0.36 * ((Math.min(5, Math.max(1, closeness)) - 1) / 4);
  const recent = 0.22 * recencyFactor(eventAt(interactions[0]), now);
  const frequency = 0.1 * Math.min(1, interactions.length / 4);
  const strength = Math.min(0.98, Math.max(0.12, contact + closenessScore + recent + frequency));
  const evidence = [
    hasContact ? "档案中有可用联系方式" : "",
    closeness === undefined ? "" : `与我的亲密度 ${closeness}/5`,
    interactions[0] ? `最近互动：${interactions[0].date} · ${interactions[0].title}` : "",
  ].filter(Boolean);
  const risks = [!hasContact ? "没有联系方式原文，需要先确认接触渠道" : ""].filter(Boolean);
  return {
    person,
    strength,
    cost: -Math.log(strength),
    evidence,
    risks,
    updatedAt: Math.max(person.updatedAt ?? person.createdAt, eventAt(interactions[0])),
  };
}

function sharedRelationEvents(relation: RelationRecord, events: LifeEventRecord[]) {
  return events.filter(
    (event) =>
      event.personIds?.includes(relation.fromId) && event.personIds.includes(relation.toId),
  );
}

function traversalEdge(
  relation: RelationRecord,
  fromId: string,
  toId: string,
  events: LifeEventRecord[],
  now: Date,
): TraversalEdge {
  const evidenceMode = relationEvidenceMode(relation);
  const base = evidenceMode === "explicit" ? 0.72 : evidenceMode === "inferred" ? 0.48 : 0.58;
  const confidence =
    relation.confidence === undefined ? 0.5 : Math.min(1, Math.max(0, relation.confidence));
  const shared = sharedRelationEvents(relation, events).sort((a, b) => eventAt(b) - eventAt(a));
  const eventBonus = 0.12 * recencyFactor(eventAt(shared[0]), now);
  const sourceBonus =
    relation.source?.kind === "manual" ? 0.06 : relation.source?.kind === "ai" ? 0.02 : 0.04;
  const strength = Math.min(
    0.98,
    Math.max(0.08, base * 0.68 + confidence * 0.22 + eventBonus + sourceBonus),
  );
  const avoidPenalty = relation.recommendationPolicy === "avoid" ? 0.75 : 0;
  const risks = [
    evidenceMode === "inferred" ? "路径包含推导关系" : "",
    evidenceMode === "unknown" ? "路径包含证据模式未知的旧关系" : "",
    relation.recommendationPolicy === "avoid" ? "该关系被标记为尽量避免用于引荐" : "",
  ].filter(Boolean);
  return {
    relation,
    fromId,
    toId,
    strength,
    cost: -Math.log(strength) + avoidPenalty,
    evidence: `${relation.label}：${relation.basis?.trim() || relation.note?.trim() || "档案中已记录该关系"}`,
    risks,
  };
}

function confidenceOf(path: FoundPath): RecommendationConfidence {
  const minimum = Math.min(path.access.strength, ...path.edges.map((edge) => edge.strength));
  return minimum >= 0.72 ? "高" : minimum >= 0.48 ? "中" : "低";
}

function displayPath(path: FoundPath, names: Map<string, string>) {
  return ["我", ...path.personIds.map((id) => names.get(id) ?? "未知人物")].join(" → ");
}

/**
 * 目标人物引荐：先从虚拟“我”连接到真正可接触的人，再搜索有证据的简单路径。
 * 关系箭头表达语义而非引荐可达性，因此默认按无向边遍历；block 策略才会禁止经过。
 */
export function rankConnectionPaths(options: ConnectionPathOptions): CandidateRecommendation[] {
  const now = options.now ?? new Date();
  const maxHops = Math.max(1, Math.min(5, Math.floor(options.maxHops ?? 3)));
  const limit = Math.max(1, Math.min(20, Math.floor(options.limit ?? 5)));
  const target = options.persons.find((person) => person.id === options.targetId);
  if (!target) return [];
  const names = new Map(options.persons.map((person) => [person.id, person.name]));
  const personsById = new Map(options.persons.map((person) => [person.id, person]));
  const eligible = options.relations.filter((relation) => {
    if (!personsById.has(relation.fromId) || !personsById.has(relation.toId)) return false;
    if (relation.recommendationPolicy === "block") return false;
    if (!options.includePending && relation.confirmationStatus === "pending") return false;
    if (relation.confirmationStatus === "rejected") return false;
    if (!options.includeInferred && relationEvidenceMode(relation) === "inferred") return false;
    return true;
  });
  const graph = new Map<string, TraversalEdge[]>();
  for (const relation of eligible) {
    const forward = traversalEdge(relation, relation.fromId, relation.toId, options.events, now);
    const backward = traversalEdge(relation, relation.toId, relation.fromId, options.events, now);
    graph.set(relation.fromId, [...(graph.get(relation.fromId) ?? []), forward]);
    graph.set(relation.toId, [...(graph.get(relation.toId) ?? []), backward]);
  }

  const access = options.persons
    .map((person) => accessEdge(person, options.events, now))
    .filter((item): item is AccessEdge => Boolean(item));
  const found: FoundPath[] = [];

  const walk = (
    accessStart: AccessEdge,
    currentId: string,
    personIds: string[],
    edges: TraversalEdge[],
    visited: Set<string>,
    cost: number,
  ) => {
    if (currentId === options.targetId) {
      found.push({
        connector: accessStart.person,
        personIds,
        edges,
        access: accessStart,
        cost,
      });
      return;
    }
    // 加上虚拟“我”到首位联系人的边，总跳数不能超过 maxHops。
    if (edges.length + 1 >= maxHops) return;
    for (const edge of graph.get(currentId) ?? []) {
      if (visited.has(edge.toId)) continue;
      visited.add(edge.toId);
      walk(
        accessStart,
        edge.toId,
        [...personIds, edge.toId],
        [...edges, edge],
        visited,
        cost + edge.cost + 0.12,
      );
      visited.delete(edge.toId);
    }
  };

  for (const start of access) {
    walk(start, start.person.id, [start.person.id], [], new Set([start.person.id]), start.cost);
  }

  found.sort(
    (a, b) =>
      a.cost - b.cost ||
      a.personIds.length - b.personIds.length ||
      a.connector.name.localeCompare(b.connector.name, "zh-CN"),
  );
  const bestByConnector = new Map<string, FoundPath>();
  for (const path of found)
    if (!bestByConnector.has(path.connector.id)) bestByConnector.set(path.connector.id, path);

  return [...bestByConnector.values()].slice(0, limit).map((path) => {
    const summary = displayPath(path, names);
    const relationEvidence = path.edges.map((edge) => edge.evidence);
    const risks = [...new Set([...path.access.risks, ...path.edges.flatMap((edge) => edge.risks)])];
    const score = Math.max(0, Math.min(100, Math.round(100 * Math.exp(-path.cost / maxHops))));
    return {
      person: path.connector,
      score,
      confidence: confidenceOf(path),
      mode: "connection" as const,
      reasons: [
        path.edges.length === 0 ? `可以直接联系 ${target.name}` : `存在可核验路径：${summary}`,
        `总跳数 ${path.edges.length + 1}`,
      ],
      evidence: [...path.access.evidence, ...relationEvidence],
      risks,
      updatedAt: Math.max(
        path.access.updatedAt,
        ...path.edges.map((edge) => edge.relation.updatedAt ?? edge.relation.createdAt),
      ),
      source: path.connector.source,
      path: {
        targetId: target.id,
        personIds: path.personIds,
        personNames: path.personIds.map((id) => names.get(id) ?? "未知人物"),
        relationIds: path.edges.map((edge) => edge.relation.id),
        labels: path.edges.map((edge) => edge.relation.label),
        cost: Number(path.cost.toFixed(4)),
        direct: path.edges.length === 0,
      },
    };
  });
}
