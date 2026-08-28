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

export type TargetSideEntryOptions = ConnectionPathOptions;

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

interface PathState {
  currentId: string;
  personIds: string[];
  edges: TraversalEdge[];
  cost: number;
}

class MinPathQueue {
  private rows: PathState[] = [];

  private compare(left: PathState, right: PathState) {
    return (
      left.cost - right.cost ||
      left.personIds.length - right.personIds.length ||
      left.personIds.join("\u0000").localeCompare(right.personIds.join("\u0000"), "zh-CN")
    );
  }

  push(value: PathState) {
    this.rows.push(value);
    let index = this.rows.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.compare(this.rows[parent]!, value) <= 0) break;
      this.rows[index] = this.rows[parent]!;
      index = parent;
    }
    this.rows[index] = value;
  }

  pop() {
    const head = this.rows[0];
    const tail = this.rows.pop();
    if (!head || !tail || !this.rows.length) return head;
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      if (left >= this.rows.length) break;
      const child =
        right < this.rows.length && this.compare(this.rows[right]!, this.rows[left]!) < 0
          ? right
          : left;
      if (this.compare(tail, this.rows[child]!) <= 0) break;
      this.rows[index] = this.rows[child]!;
      index = child;
    }
    this.rows[index] = tail;
    return head;
  }

  get size() {
    return this.rows.length;
  }
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
    .filter(Boolean);
}

/** 只把档案中真实出现的人名当目标；多人同时命中时交给用户选择。 */
export function detectTargetIntent(task: string, persons: PersonRecord[]): TargetIntent {
  const compactTask = normalized(task);
  const matches = persons.filter(
    (person) =>
      person.entityRole !== "ego" &&
      !["我", "me"].includes(person.name.trim().toLowerCase()) &&
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
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(event.date.slice(0, 10));
  if (!match) return 0;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1900) return 0;
  const probe = new Date(year, month - 1, day);
  return probe.getFullYear() === year && probe.getMonth() === month - 1 && probe.getDate() === day
    ? probe.getTime()
    : 0;
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
  const rawCloseness = person.profile?.closeness;
  const closeness = Number.isFinite(rawCloseness)
    ? Math.max(1, Math.min(5, rawCloseness as number))
    : undefined;
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
  const egoIds = new Set(
    options.persons
      .filter(
        (person) =>
          person.entityRole === "ego" || ["我", "me"].includes(person.name.trim().toLowerCase()),
      )
      .map((person) => person.id),
  );
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
    if (egoIds.has(relation.fromId) || egoIds.has(relation.toId)) continue;
    const forward = traversalEdge(relation, relation.fromId, relation.toId, options.events, now);
    const backward = traversalEdge(relation, relation.toId, relation.fromId, options.events, now);
    graph.set(relation.fromId, [...(graph.get(relation.fromId) ?? []), forward]);
    graph.set(relation.toId, [...(graph.get(relation.toId) ?? []), backward]);
  }

  const access = options.persons
    .filter((person) => !egoIds.has(person.id))
    .map((person) => {
      const egoRelations = eligible.filter(
        (relation) =>
          (egoIds.has(relation.fromId) && relation.toId === person.id) ||
          (egoIds.has(relation.toId) && relation.fromId === person.id),
      );
      const base = accessEdge(person, options.events, now);
      if (!egoRelations.length) return base;
      const explicit = egoRelations.some(
        (relation) => relationEvidenceMode(relation) !== "inferred",
      );
      const relationStrength = explicit ? 0.76 : 0.5;
      return {
        person,
        strength: Math.max(base?.strength ?? 0, relationStrength),
        cost: -Math.log(Math.max(base?.strength ?? 0, relationStrength)),
        evidence: [
          ...(base?.evidence ?? []),
          ...egoRelations.map((relation) => `与我的已记录关系：${relation.label}`),
        ],
        risks: [...(base?.risks ?? []), ...(explicit ? [] : ["与我的入口关系来自已确认推导"])],
        updatedAt: Math.max(
          base?.updatedAt ?? person.updatedAt ?? person.createdAt,
          ...egoRelations.map((relation) => relation.updatedAt ?? relation.createdAt),
        ),
      } satisfies AccessEdge;
    })
    .filter((item): item is AccessEdge => Boolean(item));
  // Each contact gets an exact bounded-hop Dijkstra search. Unlike simple-path
  // enumeration this has polynomial state growth and no insertion-order cutoff.
  const bestByConnector: FoundPath[] = [];
  for (const start of access) {
    const queue = new MinPathQueue();
    queue.push({
      currentId: start.person.id,
      personIds: [start.person.id],
      edges: [],
      cost: start.cost,
    });
    const bestStateCost = new Map<string, number>();
    let best: FoundPath | undefined;
    while (queue.size) {
      const state = queue.pop()!;
      const stateKey = `${state.currentId}\u0000${state.edges.length}`;
      const previousCost = bestStateCost.get(stateKey);
      if (previousCost !== undefined && previousCost < state.cost - 1e-12) continue;
      bestStateCost.set(stateKey, state.cost);
      if (state.currentId === options.targetId) {
        best = {
          connector: start.person,
          personIds: state.personIds,
          edges: state.edges,
          access: start,
          cost: state.cost,
        };
        break;
      }
      // The virtual “me → first contact” edge counts as one hop.
      if (state.edges.length + 1 >= maxHops) continue;
      const nextEdges = [...(graph.get(state.currentId) ?? [])].sort(
        (left, right) =>
          left.cost - right.cost ||
          left.toId.localeCompare(right.toId, "zh-CN") ||
          left.relation.id.localeCompare(right.relation.id, "zh-CN"),
      );
      for (const edge of nextEdges) {
        const nextCost = state.cost + edge.cost + 0.12;
        const nextKey = `${edge.toId}\u0000${state.edges.length + 1}`;
        const known = bestStateCost.get(nextKey);
        if (known !== undefined && known <= nextCost + 1e-12) continue;
        queue.push({
          currentId: edge.toId,
          personIds: [...state.personIds, edge.toId],
          edges: [...state.edges, edge],
          cost: nextCost,
        });
      }
    }
    if (best) bestByConnector.push(best);
  }

  bestByConnector.sort(
    (left, right) =>
      left.cost - right.cost ||
      left.personIds.length - right.personIds.length ||
      left.connector.name.localeCompare(right.connector.name, "zh-CN") ||
      left.connector.id.localeCompare(right.connector.id),
  );

  return bestByConnector.slice(0, limit).map((path) => {
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

/**
 * When no verified path from the user exists, rank people directly connected
 * to the target. These are leads on the target side, never claims of access.
 */
export function rankTargetSideEntries(options: TargetSideEntryOptions): CandidateRecommendation[] {
  const now = options.now ?? new Date();
  const target = options.persons.find((person) => person.id === options.targetId);
  if (!target) return [];
  const peopleById = new Map(options.persons.map((person) => [person.id, person]));
  const eligible = options.relations.filter(
    (relation) =>
      relation.recommendationPolicy !== "block" &&
      relation.confirmationStatus !== "rejected" &&
      (options.includePending || relation.confirmationStatus !== "pending") &&
      (options.includeInferred || relationEvidenceMode(relation) !== "inferred") &&
      (relation.fromId === target.id || relation.toId === target.id),
  );
  const byPerson = new Map<string, RelationRecord[]>();
  for (const relation of eligible) {
    const candidateId = relation.fromId === target.id ? relation.toId : relation.fromId;
    const candidate = peopleById.get(candidateId);
    if (
      !candidate ||
      candidate.entityRole === "ego" ||
      ["我", "me"].includes(candidate.name.trim().toLowerCase())
    ) {
      continue;
    }
    byPerson.set(candidateId, [...(byPerson.get(candidateId) ?? []), relation]);
  }
  const graphDegree = new Map<string, number>();
  for (const relation of options.relations) {
    if (relation.confirmationStatus === "rejected" || relation.recommendationPolicy === "block")
      continue;
    graphDegree.set(relation.fromId, (graphDegree.get(relation.fromId) ?? 0) + 1);
    graphDegree.set(relation.toId, (graphDegree.get(relation.toId) ?? 0) + 1);
  }
  return [...byPerson.entries()]
    .map(([personId, relationRows]) => {
      const person = peopleById.get(personId)!;
      const strengths = relationRows.map((relation) =>
        traversalEdge(relation, personId, target.id, options.events, now),
      );
      const bestStrength = Math.max(...strengths.map((edge) => edge.strength));
      const explicitCount = relationRows.filter(
        (relation) => relationEvidenceMode(relation) !== "inferred",
      ).length;
      const score = Math.min(
        85,
        Math.round(
          bestStrength * 68 +
            Math.min(10, (graphDegree.get(personId) ?? 0) * 2) +
            Math.min(7, (relationRows.length - 1) * 3),
        ),
      );
      return {
        person,
        score,
        confidence: explicitCount ? ("中" as const) : ("低" as const),
        mode: "target_side" as const,
        reasons: [
          `与目标 ${target.name} 有 ${relationRows.length} 条已记录关系`,
          `目标侧关系：${relationRows.map((relation) => relation.label).join("、")}`,
        ],
        evidence: strengths.map((edge) => edge.evidence),
        risks: [
          "这只是目标侧潜在入口；档案尚未证明你能联系此人",
          ...strengths.flatMap((edge) => edge.risks),
        ],
        updatedAt: Math.max(
          person.updatedAt ?? person.createdAt,
          ...relationRows.map((relation) => relation.updatedAt ?? relation.createdAt),
        ),
        source: person.source,
        targetEntry: {
          targetId: target.id,
          relationIds: relationRows.map((relation) => relation.id),
          labels: relationRows.map((relation) => relation.label),
        },
      } satisfies CandidateRecommendation;
    })
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.person.name.localeCompare(right.person.name, "zh-CN") ||
        left.person.id.localeCompare(right.person.id),
    )
    .slice(0, Math.max(1, Math.min(20, Math.floor(options.limit ?? 5))));
}
