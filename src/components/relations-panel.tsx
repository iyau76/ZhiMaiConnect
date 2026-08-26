import {
  ArrowLeftRight,
  ArrowRight,
  Loader2,
  Network,
  Search,
  Sparkles,
  Tag,
  Trash2,
  UserPlus,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { DepartmentDialog } from "@/components/department-dialog";
import { ExportMenu } from "@/components/export-menu";
import { PageGuide } from "@/components/page-guide";


import { PersonProfileDialog } from "@/components/person-profile-dialog";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { makeSource } from "@/lib/provenance";
import { PRESET_TAGS, presetTagLabels, primaryTagOf, tagsOf } from "@/lib/circle-tags";
import { inferMutual, isMutualRelation } from "@/lib/relation-kind";
import { facesDb, type PersonRecord, type RelationRecord } from "@/lib/face-db";
import { getLang, t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { askModel } from "@/lib/vision-client";
import type { ProviderPreset } from "@/lib/vision-providers";

interface Props {
  preset: ProviderPreset;
}

const EXTRACT_PROMPT = `你是一个人际关系整理助手。用户会给你一段自由描述（可能提到多个人和他们之间的关系）。
只输出 JSON，不要解释、不要代码块标记，结构如下：
{"people":[{"name":"姓名","note":"这个人的简要信息"}],"relations":[{"from":"姓名A","to":"姓名B","label":"关系，如同事/室友/母子"}]}
没有把握的不要编造；关系里出现的人必须也在 people 里。`;

const EXTRACT_PROMPT_EN = `You organise personal relationships. The user gives a free-form description that may mention several people and how they relate.
Output JSON only, no explanation and no code fences, with this shape:
{"people":[{"name":"name","note":"short info about this person"}],"relations":[{"from":"name A","to":"name B","label":"relation, e.g. colleague/roommate/mother-son"}]}
Do not invent facts; every person mentioned in relations must also appear in people. Write all values in English.`;

function parseJson(text: string) {
  const cleaned = text.replace(/^\s*```(?:json)?/i, "").replace(/```\s*$/, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error(t("AI 没有返回可解析的内容"));
  return JSON.parse(cleaned.slice(start, end + 1)) as {
    people?: Array<{ name?: string; note?: string }>;
    relations?: Array<{ from?: string; to?: string; label?: string }>;
  };
}

export function RelationsPanel({ preset }: Props) {
  const [people, setPeople] = useState<PersonRecord[]>([]);
  const [relations, setRelations] = useState<RelationRecord[]>([]);
  const [newName, setNewName] = useState("");
  const [newNote, setNewNote] = useState("");
  const [editing, setEditing] = useState<PersonRecord | null>(null);
  const [fromId, setFromId] = useState("");
  const [toId, setToId] = useState("");
  const [label, setLabel] = useState("");
  /** auto = 按关系词推断方向；mutual = 双箭头；directed = 单箭头 */
  const [dirMode, setDirMode] = useState<"auto" | "mutual" | "directed">("auto");
  /** 关系网布局：按标签分圈 / 按部门分簇 / 不分组 */
  const [groupBy, setGroupBy] = useState<"none" | "tag">("tag");
  /** 档案页：搜索词、标签筛选、批量选中 */
  const [query, setQuery] = useState("");
  const [filterTags, setFilterTags] = useState<string[]>([]);
  const [checkedIds, setCheckedIds] = useState<string[]>([]);
  const [batchTag, setBatchTag] = useState("");
  const [raw, setRaw] = useState("");
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState("");
  const [summarizing, setSummarizing] = useState(false);
  const [deptOpen, setDeptOpen] = useState<string | null>(null);
  /** 手动拖拽后的节点位置（覆盖自动布局） */
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>({});
  /** 当前选中的节点：高亮它的关系 */
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** 钻取层级：区块总览 → 某个区块里的人 → 某个人和ta的关联人 */
  const [drill, setDrill] = useState<{ mode: "blocks" | "group" | "person"; key?: string }>({
    mode: "blocks",
  });
  /** 画布缩放 / 平移 */
  const [viewport, setViewport] = useState({ scale: 1, tx: 0, ty: 0 });
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<{ id: string; x: number; y: number; ox: number; oy: number; moved: number } | null>(null);
  const panRef = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);



  const refresh = useCallback(async () => {
    await facesDb.pruneOrphanRelations();
    const [p, r] = await Promise.all([facesDb.listPersons(), facesDb.listRelations()]);
    setPeople(p);
    setRelations(r);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const nameOf = useCallback(
    (id: string) => people.find((person) => person.id === id)?.name ?? t("已删除"),
    [people],
  );

  const createPerson = async () => {
    const name = newName.trim();
    if (!name) {
      toast.error(t("请输入名字"));
      return;
    }
    if (people.some((person) => person.name === name)) {
      toast.error(t("已有同名档案"));
      return;
    }
    const record: PersonRecord = {
      id: crypto.randomUUID(),
      name,
      note: newNote.trim(),
      rawProfileText: newNote.trim(),
      descriptors: [],
      thumb: "",
      createdAt: Date.now(),
      source: makeSource("manual"),
    };
    await facesDb.putPerson(record);
    setNewName("");
    setNewNote("");
    await refresh();
    toast.success(`${t("已建档")}「${name}」`);
  };

  const removePerson = async (person: PersonRecord) => {
    await facesDb.deletePerson(person.id);
    for (const relation of relations) {
      if (relation.fromId === person.id || relation.toId === person.id)
        await facesDb.deleteRelation(relation.id);
    }
    await refresh();
  };

  const membersOf = (department: string) =>
    people.filter(
      (person) => (person.profile?.department?.trim() || t("未分部门")) === department,
    );

  /** 部门弹窗里改名 → 批量把这个部门下所有人换到新部门 */
  const renameDepartment = async (current: string, next: string) => {
    const value = next.trim();
    const members = membersOf(current);
    for (const person of members) {
      await facesDb.putPerson({
        ...person,
        profile: { ...(person.profile ?? {}), department: value || undefined },
      });
    }
    await refresh();
    toast.success(`${members.length} ${t("人已归入")}「${value || t("未分部门")}」`);
  };

  /** 把某个人调入 / 移出部门 */
  const setPersonDepartment = async (personId: string, department?: string) => {
    const person = people.find((item) => item.id === personId);
    if (!person) return;
    await facesDb.putPerson({
      ...person,
      profile: { ...(person.profile ?? {}), department: department?.trim() || undefined },
    });
    await refresh();
    toast.success(
      department ? `${person.name} → ${department}` : `${person.name} ${t("已移出部门")}`,
    );
  };


  const addRelation = async () => {
    if (!fromId || !toId || fromId === toId) {
      toast.error(t("请选择两个不同的人"));
      return;
    }
    await facesDb.putRelation({
      id: crypto.randomUUID(),
      fromId,
      toId,
      label: label.trim() || t("认识"),
      mutual:
        dirMode === "auto" ? inferMutual(label.trim() || t("认识")) : dirMode === "mutual",
      createdAt: Date.now(),
      source: makeSource("manual"),
    });
    setLabel("");
    await refresh();
  };

  /** 一段话 → 自动建档 + 建立关系 */
  const organize = async () => {
    const text = raw.trim();
    if (!text) {
      toast.error(t("先写点关于这些人的描述"));
      return;
    }
    setBusy(true);
    let answer = "";
    try {
      await askModel(
        preset,
        getLang() === "en"
          ? `${EXTRACT_PROMPT_EN}\n\nKnown people: ${people.map((p) => p.name).join(", ") || "none"}\n\nDescription:\n${text}`
          : `${EXTRACT_PROMPT}\n\n已有的人：${people.map((p) => p.name).join("、") || t("无")}\n\n描述：\n${text}`,
        null,
        [],
        (chunk) => {
          answer += chunk;
        },
        new AbortController().signal,
      );
      const parsed = parseJson(answer);
      const current = await facesDb.listPersons();
      const byName = new Map(current.map((person) => [person.name, person]));
      let created = 0;
      for (const item of parsed.people ?? []) {
        const name = (item.name ?? "").trim();
        if (!name) continue;
        const exist = byName.get(name);
        if (exist) {
          if (item.note) {
            const merged = [exist.note, item.note].filter(Boolean).join("；");
            await facesDb.putPerson({ ...exist, note: merged });
          }
          continue;
        }
        const record: PersonRecord = {
          id: crypto.randomUUID(),
          name,
          note: item.note ?? "",
          rawProfileText: item.note ?? "",
          descriptors: [],
          thumb: "",
          createdAt: Date.now(),
          source: makeSource("ai", "关系整理"),
        };
        await facesDb.putPerson(record);
        byName.set(name, record);
        created += 1;
      }
      let links = 0;
      for (const item of parsed.relations ?? []) {
        const a = byName.get((item.from ?? "").trim());
        const b = byName.get((item.to ?? "").trim());
        if (!a || !b || a.id === b.id) continue;
        await facesDb.putRelation({
          id: crypto.randomUUID(),
          fromId: a.id,
          toId: b.id,
          label: (item.label ?? "").trim() || t("认识"),
          mutual: inferMutual((item.label ?? "").trim()),
          createdAt: Date.now(),
          source: makeSource("ai", "关系整理"),
        });
        links += 1;
      }
      await refresh();
      setRaw("");
      toast.success(`${t("新建档案")} ${created} · ${t("新增关系")} ${links}`);
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const analyse = async () => {
    if (!people.length) {
      toast.error(t("还没有任何人物档案"));
      return;
    }
    setSummarizing(true);
    setSummary("");
    const roster = people
      .map((person) => `${person.name}：${person.note || t("暂无备注")}`)
      .join("\n");
    const links = relations.map((r) => `${nameOf(r.fromId)} —${r.label}→ ${nameOf(r.toId)}`).join("\n");
    try {
      await askModel(
        preset,
        getLang() === "en"
          ? `Here are my people profiles and relationship data. Answer in English: what circles/groups exist, key tags for each person, who bridges different circles, and what information is clearly missing.\n\n[People]\n${roster}\n\n[Relations]\n${links || "none"}`
          : `下面是我的人物档案和人际关系数据。请用中文整理：有哪些圈子/群体、每个人的关键标签、谁是连接不同圈子的关键人物、还有哪些信息明显缺失需要补充。\n\n【人物】\n${roster}\n\n【关系】\n${links || t("暂无")}`,
        null,
        [],
        (chunk) => setSummary((prev) => prev + chunk),
        new AbortController().signal,
      );
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setSummarizing(false);
    }
  };

  /** 档案页：可用标签（预设 + 数据里已经出现过的） */
  const allTags = useMemo(() => {
    const set = new Set<string>(presetTagLabels());
    for (const person of people) for (const tag of tagsOf(person)) set.add(tag);
    return [...set];
  }, [people]);

  const tagOptions = useMemo(() => {
    const set = new Set<string>([...presetTagLabels(), ...PRESET_TAGS.map((tag) => t(tag))]);
    for (const person of people) for (const tag of tagsOf(person)) set.add(tag);
    return [...set];
  }, [people]);

  /** 搜索 + 标签筛选后的档案 */
  const filteredPeople = useMemo(() => {
    const q = query.trim().toLowerCase();
    return people.filter((person) => {
      const tags = tagsOf(person);
      if (filterTags.length && !filterTags.every((tag) => tags.includes(tag))) return false;
      if (!q) return true;
      const profile = person.profile ?? {};
      const haystack = [
        person.name,
        person.note,
        person.rawProfileText ?? "",
        profile.title ?? "",
        profile.department ?? "",
        profile.org ?? "",
        profile.contact ?? "",
        ...tags,
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [people, query, filterTags]);

  const allChecked =
    filteredPeople.length > 0 && filteredPeople.every((person) => checkedIds.includes(person.id));

  /** 批量给选中的人加 / 去掉一个标签 */
  const applyBatchTag = async (add: boolean) => {
    const tag = batchTag.trim();
    if (!tag) {
      toast.error(t("请先选择标签"));
      return;
    }
    const targets = people.filter((person) => checkedIds.includes(person.id));
    for (const person of targets) {
      const current = new Set(person.profile?.tags ?? []);
      if (add) current.add(tag);
      else current.delete(tag);
      const circle = person.profile?.circle?.trim();
      await facesDb.putPerson({
        ...person,
        profile: {
          ...(person.profile ?? {}),
          tags: [...current],
          circle: !add && circle === tag ? undefined : person.profile?.circle,
        },
      });
    }
    await refresh();
    toast.success(
      `${targets.length} ${t("人")} ${add ? t("已加上标签") : t("已移除标签")}「${tag}」`,
    );
  };

  /** 批量删除（连同关系一起删） */
  const removeChecked = async () => {
    const targets = people.filter((person) => checkedIds.includes(person.id));
    for (const person of targets) await removePerson(person);
    setCheckedIds([]);
    toast.success(`${t("已删除")} ${targets.length} ${t("人")}`);
  };

  /** 一个人属于哪些圈子（可以同时属于多个标签圈） */
  const groupsOf = useCallback((person: PersonRecord): string[] => {
    const list = tagsOf(person);
    return list.length ? list : [t("未分组")];
  }, []);

  /** 落位用的主圈子（一个人只画在一个地方） */
  const groupOf = useCallback((person: PersonRecord) => primaryTagOf(person), []);


  /** 当前钻取层级下要画哪些人 */
  const visiblePeople = useMemo(() => {
    // 聚焦某个人：只留 ta 和「直接相连的那一层」人（不分组时也生效）
    if (drill.mode === "person") {
      const ids = new Set<string>([drill.key ?? ""]);
      for (const relation of relations) {
        if (relation.fromId === drill.key) ids.add(relation.toId);
        if (relation.toId === drill.key) ids.add(relation.fromId);
      }
      return people.filter((person) => ids.has(person.id));
    }
    if (groupBy === "none") return people;
    if (drill.mode === "group")
      return people.filter((person) => groupsOf(person).includes(drill.key ?? ""));
    return people;
  }, [people, relations, groupBy, drill, groupsOf]);



  /** 关系网布局：默认一个大圆；按部门分组时每个部门自成一簇。连线长度有下限，避免标签挤在一起 */
  const graph = useMemo(() => {
    const people = visiblePeople;
    /** 两个人之间的最短距离（保证关系词写得下） */
    const MIN_EDGE = 150;
    type Node = { id: string; x: number; y: number; name: string; group: string };
    const nodes: Node[] = [];
    const clusters: { name: string; x: number; y: number; r: number }[] = [];

    /** 环形排布时，为了让相邻两点至少隔开 MIN_EDGE 所需的半径 */
    const ringFor = (count: number) =>
      count <= 1 ? 0 : Math.max(90, MIN_EDGE / (2 * Math.sin(Math.PI / count)));

    let size = 640;

    if (groupBy !== "none") {
      const buckets = new Map<string, PersonRecord[]>();
      for (const person of people) {
        const key = groupOf(person);
        const list = buckets.get(key);
        if (list) list.push(person);
        else buckets.set(key, [person]);
      }
      const groups = [...buckets.entries()].map(([name, members]) => ({
        name,
        members,
        inner: ringFor(members.length),
      }));
      const maxR = Math.max(...groups.map((group) => group.inner + 52), 120);
      // 多个部门时，各簇均匀分布在一个更大的环上，彼此不重叠
      const ringRadius =
        groups.length > 1
          ? Math.max(maxR * 1.6, (maxR + 30) / Math.sin(Math.PI / groups.length))
          : 0;
      size = 2 * (ringRadius + maxR + 56);
      const center = size / 2;

      groups.forEach((group, groupIndex) => {
        const angle = (groupIndex / groups.length) * Math.PI * 2 - Math.PI / 2;
        const cx = center + ringRadius * Math.cos(angle);
        const cy = center + ringRadius * Math.sin(angle);
        clusters.push({ name: group.name, x: cx, y: cy, r: group.inner + 52 });
        group.members.forEach((person, index) => {
          const a = (index / Math.max(group.members.length, 1)) * Math.PI * 2 - Math.PI / 2;
          nodes.push({
            id: person.id,
            name: person.name,
            group: group.name,
            x: group.members.length === 1 ? cx : cx + group.inner * Math.cos(a),
            y: group.members.length === 1 ? cy : cy + group.inner * Math.sin(a),
          });
        });
      });
    } else {
      const radius = ringFor(people.length);
      size = 2 * (radius + 74);
      const center = size / 2;
      people.forEach((person, index) => {
        const angle = (index / Math.max(people.length, 1)) * Math.PI * 2 - Math.PI / 2;
        nodes.push({
          id: person.id,
          name: person.name,
          group: person.profile?.department?.trim() || "",
          x: center + radius * Math.cos(angle),
          y: center + radius * Math.sin(angle),
        });
      });
    }

    // 手动拖过的点，用拖拽后的位置（并保证还在画布里）
    for (const node of nodes) {
      const moved = positions[node.id];
      if (!moved) continue;
      node.x = Math.max(28, Math.min(size - 28, moved.x));
      node.y = Math.max(28, Math.min(size - 40, moved.y));
    }

    const map = new Map(nodes.map((node) => [node.id, node]));

    // 部门圈跟着点走：用该部门所有点的实际位置重新算圆心和半径
    for (const cluster of clusters) {
      const members = nodes.filter((node) => node.group === cluster.name);
      if (!members.length) continue;
      const cx = members.reduce((sum, node) => sum + node.x, 0) / members.length;
      const cy = members.reduce((sum, node) => sum + node.y, 0) / members.length;
      cluster.x = cx;
      cluster.y = cy;
      cluster.r = Math.max(
        86,
        ...members.map((node) => Math.hypot(node.x - cx, node.y - cy) + 52),
      );
    }

    // 互为对向的同一段关系只画一次（例如 A—同事→B 和 B—同事→A）
    const seen = new Set<string>();
    // 聚焦某个人时，只画「和 ta 直接相连」的那一层关系，邻居之间的线不画
    const focusId = drill.mode === "person" ? drill.key : null;
    const edges = relations
      .filter((relation) =>
        focusId ? relation.fromId === focusId || relation.toId === focusId : true,
      )

      .filter((relation) => {
        const pair = [relation.fromId, relation.toId].sort().join("|");
        const key = `${pair}::${relation.label.trim()}`;
        const mutualKey = `${pair}::mutual`;
        if (seen.has(key)) return false;
        if (isMutualRelation(relation) && seen.has(mutualKey)) return false;
        seen.add(key);
        if (isMutualRelation(relation)) seen.add(mutualKey);
        return true;
      })
      .map((relation) => {
        const a = map.get(relation.fromId);
        const b = map.get(relation.toId);
        return {
          id: relation.id,
          label: relation.label,
          mutual: isMutualRelation(relation),
          /** 跨部门的连线用虚线标出来 */
          cross: !!a && !!b && !!a.group && !!b.group && a.group !== b.group,
          pair: [relation.fromId, relation.toId].sort().join("|"),
          a,
          b,
        };
      })
      .filter((edge) => edge.a && edge.b);

    // 同一对人之间的多条关系分别弯成不同弧度，避免线和标签重叠
    const pairTotal = new Map<string, number>();
    for (const edge of edges) pairTotal.set(edge.pair, (pairTotal.get(edge.pair) ?? 0) + 1);
    const pairSeen = new Map<string, number>();
    const curved = edges.map((edge) => {
      const total = pairTotal.get(edge.pair) ?? 1;
      const index = pairSeen.get(edge.pair) ?? 0;
      pairSeen.set(edge.pair, index + 1);
      const step = index - (total - 1) / 2;
      // 方向相反的两条关系，几何法线也会翻转 —— 统一到同一个基准方向再分弧度，
      // 否则两条弧会重叠成一条线
      const flip = edge.a!.id === edge.pair.split("|")[0] ? 1 : -1;
      return { ...edge, curve: total === 1 ? 0 : step * 48 * flip };
    });


    // 标签贴在（可能弯曲的）连线中点附近，必要时沿线微调
    const placed: { x: number; y: number; w: number }[] = [];
    const labelled = curved.map((edge) => {
      const ax = edge.a!.x;
      const ay = edge.a!.y;
      const bx = edge.b!.x;
      const by = edge.b!.y;
      const dx = bx - ax;
      const dy = by - ay;
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len;
      const uy = dy / len;
      const px = -uy;
      const py = ux;
      const w = Math.max(edge.label.length * 6.4 + 12, 22);
      // 标签只能落在连线中段（避开两端的圆点和名字）
      const half = Math.max(len / 2 - 34, 0);
      const at = (along: number, perp: number) => ({
        x: ax + ux * (len / 2 + Math.max(-half, Math.min(half, along))) + px * (perp + edge.curve),
        y: ay + uy * (len / 2 + Math.max(-half, Math.min(half, along))) + py * (perp + edge.curve),
      });

      let best = at(0, 0);
      let bestScore = Number.POSITIVE_INFINITY;
      const offsets: Array<[number, number]> = [];
      for (const along of [0, 26, -26, 52, -52, 78, -78]) {
        for (const perp of [0, 11, -11, 22, -22]) offsets.push([along, perp]);
      }
      for (const [along, perp] of offsets) {
        const cand = at(along, perp);
        // 和已放好的标签重叠 → 重罚；压到圆点或名字 → 重罚；偏离连线中点 → 轻罚
        const overlap = placed.filter(
          (item) =>
            Math.abs(item.x - cand.x) < (item.w + item.w) / 2 + 6 &&
            Math.abs(item.y - cand.y) < 18,
        ).length;
        const onNode = nodes.filter(
          (node) => Math.abs(node.x - cand.x) < w / 2 + 18 && Math.abs(node.y - cand.y) < 34,
        ).length;
        const score = overlap * 100 + onNode * 100 + Math.abs(along) * 0.05 + Math.abs(perp) * 0.08;
        if (score < bestScore) {
          bestScore = score;
          best = cand;
        }
        if (overlap === 0 && onNode === 0 && along === 0 && perp === 0) break;
      }
      placed.push({ x: best.x, y: best.y, w });
      return { ...edge, lx: best.x, ly: best.y, lw: w };
    });


    // 部门范围画成不规则的平滑外形，形状跟着该部门成员的实际位置流动变形
    const blob = (
      cx: number,
      cy: number,
      r: number,
      seedText: string,
      members: { x: number; y: number }[],
    ) => {
      let seed = 0;
      for (const ch of seedText) seed = (seed * 31 + ch.charCodeAt(0)) % 100000;
      const steps = 14;
      const pts: Array<[number, number]> = [];
      const offsets = members.map((m) => {
        const dx = m.x - cx;
        const dy = m.y - cy;
        return { dist: Math.hypot(dx, dy), angle: Math.atan2(dy, dx) };
      });
      for (let i = 0; i < steps; i += 1) {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        const wobble = 0.88 + (seed / 2147483648) * 0.2;
        const angle = (i / steps) * Math.PI * 2;
        // 该方向上离得最远的成员把边界"顶"出去，形成随节点流动的形状
        let reach = r * 0.62;
        for (const off of offsets) {
          let diff = Math.abs(angle - off.angle) % (Math.PI * 2);
          if (diff > Math.PI) diff = Math.PI * 2 - diff;
          const pull = Math.exp(-((diff / 0.95) ** 2));
          reach = Math.max(reach, (off.dist + 56) * pull + r * 0.5 * (1 - pull));
        }
        const rad = reach * wobble;
        pts.push([cx + rad * Math.cos(angle), cy + rad * Math.sin(angle)]);
      }
      // Catmull-Rom → 三次贝塞尔，得到闭合的平滑曲线
      let d = `M ${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
      for (let i = 0; i < steps; i += 1) {
        const p0 = pts[(i - 1 + steps) % steps];
        const p1 = pts[i];
        const p2 = pts[(i + 1) % steps];
        const p3 = pts[(i + 2) % steps];
        const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
        const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
        d += ` C ${c1[0].toFixed(1)} ${c1[1].toFixed(1)}, ${c2[0].toFixed(1)} ${c2[1].toFixed(1)}, ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
      }
      return `${d} Z`;
    };

    const shaped = clusters.map((cluster) => ({
      ...cluster,
      path: blob(
        cluster.x,
        cluster.y,
        cluster.r * 1.08,
        cluster.name,
        nodes.filter((node) => node.group === cluster.name),
      ),
    }));


    return { size, nodes, edges: labelled, clusters: shaped };

  }, [visiblePeople, relations, groupBy, groupOf, positions, drill, t]);

  /** 选中的人 + 他/她的所有关系 */
  const selected = useMemo(() => {
    if (!selectedId) return null;
    const person = people.find((item) => item.id === selectedId);
    if (!person) return null;
    const links = relations
      .filter((relation) => relation.fromId === person.id || relation.toId === person.id)
      .map((relation) => {
        const outgoing = relation.fromId === person.id;
        return {
          id: relation.id,
          other: nameOf(outgoing ? relation.toId : relation.fromId),
          label: relation.label,
          mutual: isMutualRelation(relation),
          outgoing,
        };
      });
    return { person, links };
  }, [selectedId, people, relations, nameOf]);

  const viewSize = graph.size;


  /** 屏幕坐标 → SVG 画布坐标的比例（含缩放） */
  const svgScale = () => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || !rect.width) return 1;
    return viewSize / rect.width / viewport.scale;
  };

  const zoomBy = (factor: number) =>
    setViewport((prev) => {
      const scale = Math.min(4, Math.max(0.4, prev.scale * factor));
      const c = viewSize / 2;
      // 以画布中心为锚点缩放
      return {
        scale,
        tx: c - (c - prev.tx) * (scale / prev.scale),
        ty: c - (c - prev.ty) * (scale / prev.scale),
      };
    });

  const resetView = () => setViewport({ scale: 1, tx: 0, ty: 0 });

  const onWheel = (event: React.WheelEvent<SVGSVGElement>) => {
    event.preventDefault();
    zoomBy(event.deltaY < 0 ? 1.12 : 1 / 1.12);
  };

  const focusPerson = (id: string) => {
    setDrill({ mode: "person", key: id });
    setSelectedId(id);
    setViewport({ scale: 1.15, tx: 0, ty: 0 });
  };

  /** 返回：从某个人退回全部圈子总览 */
  const goBack = useCallback(() => {
    setSelectedId(null);
    resetView();
    setDrill({ mode: "blocks" });
  }, []);


  /** Esc 退回上一层 */
  useEffect(() => {
    if (drill.mode === "blocks") return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") goBack();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drill.mode, goBack]);



  const onPanPointerDown = (event: React.PointerEvent<SVGSVGElement>) => {
    if (dragRef.current) return;
    panRef.current = { x: event.clientX, y: event.clientY, tx: viewport.tx, ty: viewport.ty };
  };
  const onPanPointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    const pan = panRef.current;
    if (!pan || dragRef.current) return;
    const rect = svgRef.current?.getBoundingClientRect();
    const ratio = rect && rect.width ? viewSize / rect.width : 1;
    setViewport((prev) => ({
      ...prev,
      tx: pan.tx + (event.clientX - pan.x) * ratio,
      ty: pan.ty + (event.clientY - pan.y) * ratio,
    }));
  };
  const onPanPointerUp = () => {
    panRef.current = null;
  };

  const onNodePointerDown = (
    event: React.PointerEvent<SVGGElement>,
    node: { id: string; x: number; y: number },
  ) => {
    event.preventDefault();
    event.stopPropagation();
    (event.target as Element).setPointerCapture?.(event.pointerId);
    dragRef.current = {
      id: node.id,
      x: event.clientX,
      y: event.clientY,
      ox: node.x,
      oy: node.y,
      moved: 0,
    };
  };

  const onNodePointerMove = (event: React.PointerEvent<SVGGElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const scale = svgScale();
    const dx = (event.clientX - drag.x) * scale;
    const dy = (event.clientY - drag.y) * scale;
    drag.moved = Math.max(drag.moved, Math.hypot(dx, dy));
    if (drag.moved < 3) return;
    setPositions((prev) => ({ ...prev, [drag.id]: { x: drag.ox + dx, y: drag.oy + dy } }));
  };

  const onNodePointerUp = (event: React.PointerEvent<SVGGElement>) => {
    const drag = dragRef.current;
    dragRef.current = null;
    panRef.current = null;
    if (!drag) return;
    (event.target as Element).releasePointerCapture?.(event.pointerId);
    // 没怎么动 = 点击：聚焦这个人，只看 ta 和相关联的人
    if (drag.moved < 4) {
      if (drill.mode === "person" && drill.key === drag.id) {
        setSelectedId((prev) => (prev === drag.id ? null : drag.id));
      } else {
        focusPerson(drag.id);
      }
    }
  };




  return (
    <section className="flex min-w-0 flex-col gap-5 rounded-2xl border border-border bg-card/60 p-5">
      <header className="flex items-center justify-between gap-3">
        <h2 className="flex items-baseline gap-2.5">
          <span className="font-display text-xl leading-none tracking-tight">{t("人物档案")}</span>
          <span className="text-[10px] uppercase tracking-[0.24em] text-muted-foreground">Agent</span>
        </h2>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-muted-foreground">
            {people.length} {t("人")} · {relations.length} {t("条关系")}
          </span>
          <ExportMenu scope="people" />
        </div>

      </header>

      <Tabs defaultValue="roster">
        <TabsList>
          <TabsTrigger value="roster">{t("档案")}</TabsTrigger>
          <TabsTrigger value="graph">{t("关系网")}</TabsTrigger>
          
        </TabsList>

        <TabsContent value="roster" className="space-y-4 pt-4">
          <PageGuide
            id="relations-roster"
            title="档案页"
            points={["填名字就能建人，先建人再连关系。", "点一行可以打开人物卡补职位、部门等资料。"]}
          />


          <div className="space-y-2 rounded-xl border border-border p-3">
            <Label className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
              {t("不用人脸也能建档")}
            </Label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                value={newName}
                onChange={(event) => setNewName(event.target.value)}
                placeholder={t("名字")}
                className="sm:max-w-[12rem]"
              />
              <Input
                value={newNote}
                onChange={(event) => setNewNote(event.target.value)}
                onKeyDown={(event) => event.key === "Enter" && void createPerson()}
                placeholder={t("一句话描述，之后可以让 AI 整理")}
              />
              <Button onClick={() => void createPerson()} className="shrink-0 rounded-full px-4">
                <UserPlus className="size-3.5" aria-hidden="true" />
                {t("建档")}
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground">
              {t("之后摄像头识别到新面孔时，可以在「人物」里选这个人补上人脸样本。")}
            </p>
          </div>

          <div className="space-y-2.5 rounded-xl border border-border p-3">
            <div className="relative">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t("搜索名字、备注、标签…")}
                className="pl-9"
              />
            </div>
            <div className="flex flex-wrap gap-1.5">
              {allTags.map((tag) => {
                const on = filterTags.includes(tag);
                return (
                  <button
                    key={tag}
                    type="button"
                    onClick={() =>
                      setFilterTags((prev) =>
                        prev.includes(tag) ? prev.filter((item) => item !== tag) : [...prev, tag],
                      )
                    }
                    className={cn(
                      "rounded-full border px-2.5 py-1 text-[11px] transition-colors",
                      on
                        ? "border-primary bg-primary/15 text-foreground"
                        : "border-border text-muted-foreground hover:bg-muted",
                    )}
                  >
                    {tag}
                  </button>
                );
              })}
              {filterTags.length > 0 && (
                <button
                  type="button"
                  onClick={() => setFilterTags([])}
                  className="rounded-full px-2 py-1 text-[11px] text-muted-foreground hover:underline"
                >
                  <X className="mr-0.5 inline size-3" aria-hidden="true" />
                  {t("清除筛选")}
                </button>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
              <span>
                {filteredPeople.length} / {people.length} {t("人")}
              </span>
              <button
                type="button"
                className="text-primary hover:underline"
                onClick={() =>
                  setCheckedIds(
                    allChecked ? [] : filteredPeople.map((person) => person.id),
                  )
                }
              >
                {allChecked ? t("取消全选") : t("全选本页")}
              </button>
              {checkedIds.length > 0 && (
                <>
                  <span>· {t("已选")} {checkedIds.length}</span>
                  <select
                    value={batchTag}
                    onChange={(event) => setBatchTag(event.target.value)}
                    className="h-7 rounded-md border border-border bg-background px-1.5 text-[11px]"
                  >
                    <option value="">{t("选择标签")}</option>
                    {tagOptions.map((tag) => (
                      <option key={tag} value={tag}>
                        {tag}
                      </option>
                    ))}
                  </select>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 rounded-full px-2.5 text-[11px]"
                    onClick={() => void applyBatchTag(true)}
                  >
                    <Tag className="size-3" aria-hidden="true" />
                    {t("打标签")}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 rounded-full px-2.5 text-[11px]"
                    onClick={() => void applyBatchTag(false)}
                  >
                    {t("移除标签")}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 rounded-full px-2.5 text-[11px] text-destructive"
                    onClick={() => void removeChecked()}
                  >
                    <Trash2 className="size-3" aria-hidden="true" />
                    {t("批量删除")}
                  </Button>
                </>
              )}
            </div>
          </div>

          {filteredPeople.length === 0 ? (
            <p className="py-10 text-center text-xs text-muted-foreground">
              {people.length === 0 ? t("还没有任何人物档案") : t("没有匹配的档案")}
            </p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {filteredPeople.map((person) => (
                <div key={person.id} className="flex items-start gap-2.5 rounded-xl border border-border p-2.5">
                  <Checkbox
                    checked={checkedIds.includes(person.id)}
                    onCheckedChange={(value) =>
                      setCheckedIds((prev) =>
                        value ? [...prev, person.id] : prev.filter((id) => id !== person.id),
                      )
                    }
                    aria-label={person.name}
                    className="mt-1"
                  />
                  {person.thumb ? (
                    <img src={person.thumb} alt={person.name} className="size-12 rounded-lg object-cover" />
                  ) : (
                    <div className="flex size-12 shrink-0 items-center justify-center rounded-lg bg-muted text-sm text-muted-foreground">
                      {person.name.slice(0, 1)}
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{person.name}</p>
                    <p className="line-clamp-2 text-[11px] leading-relaxed text-muted-foreground">
                      {person.note || t("暂无备注")}
                    </p>
                    {tagsOf(person).length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {tagsOf(person).map((tag) => (
                          <span
                            key={tag}
                            className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] text-foreground"
                          >
                            {tag}
                          </span>
                        ))}
                      </div>
                    )}
                    <div className="mt-1.5 flex gap-1">
                      <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px]" onClick={() => setEditing(person)}>
                        {t("编辑")}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-[11px] text-destructive"
                        onClick={() => void removePerson(person)}
                      >
                        <Trash2 className="size-3.5" aria-hidden="true" />
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="graph" className="space-y-4 pt-4">
          <div className="space-y-2 rounded-xl border border-border p-3">
            <Label className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
              {t("说说这些人和他们的关系")}
            </Label>
            <Textarea
              value={raw}
              onChange={(event) => setRaw(event.target.value)}
              rows={3}
              placeholder={t("例如：老王是我同事，他太太李姐在附近开花店，他们的儿子小王和我弟弟同班。")}
            />
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => void organize()} disabled={busy} className="rounded-full px-4">
                {busy ? (
                  <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <Sparkles className="size-3.5" aria-hidden="true" />
                )}
                {t("AI 建档并连线")}
              </Button>
              <Button
                variant="outline"
                onClick={() => void analyse()}
                disabled={summarizing}
                className="rounded-full px-4"
              >
                {summarizing ? (
                  <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <Network className="size-3.5" aria-hidden="true" />
                )}
                {t("AI 梳理人际关系")}
              </Button>
            </div>
            {summary && (
              <div className="whitespace-pre-wrap rounded-xl border border-border bg-muted/30 p-3 text-xs leading-relaxed">
                {summary}
              </div>
            )}
          </div>

          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <select
              value={fromId}
              onChange={(event) => setFromId(event.target.value)}
              className="h-9 rounded-md border border-border bg-background px-2 text-sm"
            >
              <option value="">{t("选择 A")}</option>
              {people.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.name}
                </option>
              ))}
            </select>
            <Input
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder={t("关系，如同事")}
              className="sm:max-w-[10rem]"
            />
            <select
              value={toId}
              onChange={(event) => setToId(event.target.value)}
              className="h-9 rounded-md border border-border bg-background px-2 text-sm"
            >
              <option value="">{t("选择 B")}</option>
              {people.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.name}
                </option>
              ))}
            </select>
            <select
              value={dirMode}
              onChange={(event) => setDirMode(event.target.value as typeof dirMode)}
              className="h-9 rounded-md border border-border bg-background px-2 text-sm"
              title={t("关系方向")}
            >
              <option value="auto">{t("方向：自动")}</option>
              <option value="mutual">{t("双向 ⇄")}</option>
              <option value="directed">{t("单向 →")}</option>
            </select>
            <Button onClick={() => void addRelation()} className="shrink-0 rounded-full px-4">
              <Network className="size-3.5" aria-hidden="true" />
              {t("建立关系")}
            </Button>
            <select
              value={groupBy}
              onChange={(event) => setGroupBy(event.target.value as typeof groupBy)}
              className="h-9 rounded-md border border-border bg-background px-2 text-sm"
              title={t("布局")}
            >
              <option value="tag">{t("按标签分圈")}</option>
              <option value="none">{t("不分组")}</option>

            </select>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
            {drill.mode === "person" && (
              <>
                <button
                  type="button"
                  className="rounded-full border border-border bg-background px-2.5 py-1 font-medium text-foreground hover:bg-accent"
                  onClick={goBack}
                >
                  ← {t("返回")}
                </button>
                <span className="rounded-full bg-primary/10 px-2 py-0.5 text-foreground">
                  {nameOf(drill.key!)}
                </span>
              </>
            )}
            <span>{t("点圆点聚焦这个人和ta的关联人，按住可拖动")}</span>

            <span className="ml-auto flex items-center gap-1">
              <button
                type="button"
                className="rounded-full border border-border px-2 py-0.5 hover:bg-accent"
                onClick={() => zoomBy(1 / 1.2)}
                aria-label={t("缩小")}
              >
                −
              </button>
              <span className="w-10 text-center tabular-nums">{Math.round(viewport.scale * 100)}%</span>
              <button
                type="button"
                className="rounded-full border border-border px-2 py-0.5 hover:bg-accent"
                onClick={() => zoomBy(1.2)}
                aria-label={t("放大")}
              >
                +
              </button>
              <button
                type="button"
                className="rounded-full border border-border px-2 py-0.5 hover:bg-accent"
                onClick={resetView}
              >
                {t("适应")}
              </button>
            </span>
            {Object.keys(positions).length > 0 && (
              <button
                type="button"
                className="text-primary underline-offset-2 hover:underline"
                onClick={() => setPositions({})}
              >
                {t("复位布局")}
              </button>
            )}
            {selected && (
              <button
                type="button"
                className="text-primary underline-offset-2 hover:underline"
                onClick={() => setSelectedId(null)}
              >
                {t("取消选中")}
              </button>
            )}
          </div>

          {selected && (
            <div className="space-y-2 rounded-xl border border-primary/30 bg-primary/5 p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-medium">
                  {selected.person.name}
                  <span className="ml-2 text-[11px] text-muted-foreground">
                    {selected.person.profile?.department || t("未分部门")}
                    {selected.person.profile?.title ? ` · ${selected.person.profile.title}` : ""}
                  </span>
                </p>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-[11px]"
                  onClick={() => setEditing(selected.person)}
                >
                  {t("打开人物卡")}
                </Button>
              </div>
              {selected.links.length === 0 ? (
                <p className="text-[11px] text-muted-foreground">{t("这个人还没有任何关系")}</p>
              ) : (
                <ul className="flex flex-wrap gap-1.5">
                  {selected.links.map((link) => (
                    <li
                      key={link.id}
                      className="rounded-full border border-border bg-background px-2.5 py-1 text-[11px]"
                    >
                      <span className="text-primary">{link.label}</span>
                      <span className="mx-1 text-muted-foreground">
                        {link.mutual ? "⇄" : link.outgoing ? "→" : "←"}
                      </span>
                      {link.other}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <div className="overflow-hidden rounded-xl border border-border bg-muted/20">
            <svg
              ref={svgRef}
              viewBox={`0 0 ${viewSize} ${viewSize}`}
              className="h-auto w-full cursor-grab touch-none select-none active:cursor-grabbing"
              onWheel={onWheel}
              onPointerDown={onPanPointerDown}
              onPointerMove={onPanPointerMove}
              onPointerUp={onPanPointerUp}
              onPointerLeave={onPanPointerUp}
            >

              <defs>
                {/* 单箭头：从 A 指向 B；对等关系两端都加箭头 */}
                <marker
                  id="relation-arrow"
                  viewBox="0 0 10 10"
                  refX="9"
                  refY="5"
                  markerWidth="6"
                  markerHeight="6"
                  orient="auto-start-reverse"
                >
                  <path d="M 0 0 L 10 5 L 0 10 z" className="fill-primary" />
                </marker>
                <marker
                  id="relation-arrow-start"
                  viewBox="0 0 10 10"
                  refX="9"
                  refY="5"
                  markerWidth="6"
                  markerHeight="6"
                  orient="auto-start-reverse"
                >
                  <path d="M 0 0 L 10 5 L 0 10 z" className="fill-primary" />
                </marker>
              </defs>
              <g transform={`translate(${viewport.tx} ${viewport.ty}) scale(${viewport.scale})`}>



              {graph.clusters.map((cluster) => (
                <g key={cluster.name}>
                  <path
                    d={cluster.path}
                    className="fill-primary/5 stroke-primary/25"
                    strokeWidth={1}
                    strokeDasharray="4 4"
                    style={{ transition: "d 260ms ease-out" }}
                  />


                  <text
                    x={cluster.x}
                    y={cluster.y - cluster.r - 8}
                    textAnchor="middle"
                    role="button"
                    tabIndex={0}
                    className="cursor-pointer fill-primary text-[11px] font-medium underline-offset-2 hover:underline"
                    onClick={() => setDeptOpen(cluster.name)}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" && event.key !== " ") return;
                      event.preventDefault();
                      setDeptOpen(cluster.name);
                    }}
                  >
                    <title>{t("点击查看／编辑部门介绍")}</title>

                    {cluster.name}
                  </text>
                </g>
              ))}

              {graph.edges.map((edge) => {
                const dx = edge.b!.x - edge.a!.x;
                const dy = edge.b!.y - edge.a!.y;
                const len = Math.hypot(dx, dy) || 1;
                const gap = 20;
                const ux = dx / len;
                const uy = dy / len;
                const x1 = edge.a!.x + ux * gap;
                const y1 = edge.a!.y + uy * gap;
                const x2 = edge.b!.x - ux * gap;
                const y2 = edge.b!.y - uy * gap;
                // 同一对人的多条关系画成不同弧度的曲线
                const cx = (x1 + x2) / 2 + -uy * edge.curve * 2;
                const cy = (y1 + y2) / 2 + ux * edge.curve * 2;
                const active =
                  !selectedId || edge.a!.id === selectedId || edge.b!.id === selectedId;
                return (
                <g key={edge.id} opacity={active ? 1 : 0.12}>
                  <path
                    d={`M ${x1} ${y1} Q ${cx} ${cy} ${x2} ${y2}`}
                    fill="none"
                    className={
                      selectedId && active
                        ? "stroke-primary"
                        : edge.mutual
                          ? "stroke-primary/45"
                          : "stroke-border"
                    }
                    strokeWidth={selectedId && active ? 2 : 1.5}
                    strokeDasharray={edge.cross ? "5 4" : undefined}
                    markerEnd="url(#relation-arrow)"
                    markerStart={edge.mutual ? "url(#relation-arrow-start)" : undefined}
                  />

                  <rect
                    x={edge.lx - edge.lw / 2}
                    y={edge.ly - 9}
                    width={edge.lw}
                    height={17}
                    rx={5}
                    className="fill-background/90"
                  />
                  <text
                    x={edge.lx}
                    y={edge.ly + 3}
                    textAnchor="middle"
                    className="fill-muted-foreground text-[11px]"
                  >
                    {edge.label}
                  </text>
                </g>
                );
              })}
              {graph.nodes.map((node) => {
                const linked =
                  !selectedId ||
                  node.id === selectedId ||
                  relations.some(
                    (relation) =>
                      (relation.fromId === selectedId && relation.toId === node.id) ||
                      (relation.toId === selectedId && relation.fromId === node.id),
                  );
                return (
                <g
                  key={node.id}
                  role="button"
                  tabIndex={0}
                  opacity={linked ? 1 : 0.25}
                  className="group cursor-grab outline-none active:cursor-grabbing"
                  onPointerDown={(event) => onNodePointerDown(event, node)}
                  onPointerMove={onNodePointerMove}
                  onPointerUp={onNodePointerUp}
                  onPointerCancel={() => {
                    dragRef.current = null;
                  }}
                  onDoubleClick={() => {
                    const person = people.find((item) => item.id === node.id);
                    if (person) setEditing(person);
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    setSelectedId((prev) => (prev === node.id ? null : node.id));
                  }}
                >
                  <title>{`${node.name} · ${t("点选看关系，拖动可移动，双击开人物卡")}`}</title>
                  <circle cx={node.x} cy={node.y} r={22} className="fill-transparent" />
                  <circle
                    cx={node.x}
                    cy={node.y}
                    r={node.id === selectedId ? 19 : 16}
                    className={cn(
                      "transition-opacity group-hover:opacity-80 group-focus-visible:stroke-foreground",
                      node.id === selectedId ? "fill-primary stroke-foreground" : "fill-primary",
                    )}
                    strokeWidth={node.id === selectedId ? 2.5 : 2}
                  />

                  <text
                    x={node.x}
                    y={node.y + 34}
                    textAnchor="middle"
                    className="fill-foreground text-[12px]"
                  >
                    {node.name}
                  </text>

                </g>
                );
              })}

              {!graph.nodes.length && (
                <text x={viewSize / 2} y={viewSize / 2} textAnchor="middle" className="fill-muted-foreground text-xs">
                  {t("还没有任何人物档案")}
                </text>
              )}
              </g>
            </svg>
          </div>

          {relations.length > 0 && (
            <ul className="space-y-1.5">
              {relations.map((relation) => (
                <li
                  key={relation.id}
                  className="flex items-center justify-between gap-2 rounded-lg border border-border px-3 py-2 text-xs"
                >
                  <span className="flex min-w-0 items-center gap-1.5 truncate">
                    <span className="truncate">{nameOf(relation.fromId)}</span>
                    <button
                      type="button"
                      title={isMutualRelation(relation) ? t("双向关系，点击改为单向") : t("单向关系，点击改为双向")}
                      className="shrink-0 text-primary transition-opacity hover:opacity-70"
                      onClick={async () => {
                        await facesDb.putRelation({
                          ...relation,
                          mutual: !isMutualRelation(relation),
                        });
                        await refresh();
                      }}
                    >
                      {isMutualRelation(relation) ? (
                        <ArrowLeftRight className="size-3.5" aria-hidden="true" />
                      ) : (
                        <ArrowRight className="size-3.5" aria-hidden="true" />
                      )}
                    </button>
                    <span className="shrink-0 text-primary">{relation.label}</span>
                    {isMutualRelation(relation) ? (
                      <ArrowLeftRight className="size-3.5 shrink-0 text-primary" aria-hidden="true" />
                    ) : (
                      <ArrowRight className="size-3.5 shrink-0 text-primary" aria-hidden="true" />
                    )}
                    <span className="truncate">{nameOf(relation.toId)}</span>
                  </span>
                  <button
                    type="button"
                    className="shrink-0 text-muted-foreground transition-colors hover:text-destructive"
                    onClick={async () => {
                      await facesDb.deleteRelation(relation.id);
                      await refresh();
                    }}
                  >
                    <Trash2 className="size-3.5" aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </TabsContent>
      </Tabs>

      <PersonProfileDialog
        person={editing}
        preset={preset}
        onClose={() => setEditing(null)}
        onSaved={refresh}
      />

      <DepartmentDialog
        department={deptOpen}
        members={deptOpen ? membersOf(deptOpen) : []}
        candidates={
          deptOpen
            ? people.filter(
                (person) => (person.profile?.department?.trim() || t("未分部门")) !== deptOpen,
              )
            : []
        }
        onOpenChange={(open) => setDeptOpen(open ? deptOpen : null)}
        onRename={renameDepartment}
        onAddMember={(personId, department) => setPersonDepartment(personId, department)}
        onRemoveMember={(personId) => setPersonDepartment(personId, undefined)}
        onOpenPerson={(person) => {
          setDeptOpen(null);
          setEditing(person);
        }}
      />


    </section>
  );
}
