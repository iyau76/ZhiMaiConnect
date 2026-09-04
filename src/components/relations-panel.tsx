import {
  ArrowLeftRight,
  ArrowRight,
  Check,
  Loader2,
  Maximize2,
  Minimize2,
  MousePointer2,
  Network,
  Plus,
  Search,
  Sparkles,
  Tag,
  Trash2,
  UserPlus,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { ExportMenu } from "@/components/export-menu";
import { PageGuide } from "@/components/page-guide";
import { PersonProfileDialog } from "@/components/person-profile-dialog";
import { SourceBadge } from "@/components/source-badge";
import { TagGroupDialog } from "@/components/tag-group-dialog";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { runAssistantAgent } from "@/lib/assistant-agent";
import { makeSource } from "@/lib/provenance";
import {
  applyPersonDeletionPlan,
  peopleDeletionImpactText,
  personDeletionImpactText,
  previewPeopleDeletion,
  previewPersonDeletion,
} from "@/lib/person-deletion";
import { PRESET_TAGS, presetTagLabels, tagsOf } from "@/lib/circle-tags";
import { inferMutual, isMutualRelation } from "@/lib/relation-kind";
import {
  buildRelationCommunityOverview,
  detectRelationCommunities,
  relationCommunityMap,
} from "@/lib/relation-community";
import {
  buildCircleLayoutProjection,
  DEFAULT_RELATION_GRAPH_GROUPING,
  loadRelationGraphGrouping,
  saveRelationGraphGrouping,
  type RelationGraphGroupingMode,
} from "@/lib/relation-graph-grouping";
import {
  relationCategory,
  relationEvidenceMode,
  selectVisibleRelations,
  type GraphViewMode,
  type RelationCategory,
} from "@/lib/relation-graph";
import { inferRelationSemantics } from "@/lib/relation-ontology";
import {
  assertValidPersonName,
  facesDb,
  type CollectionMembershipRecord,
  type CollectionRecord,
  type EvidenceRecord,
  type LifeEventRecord,
  type PersonRecord,
  type RelationRecord,
  type ReminderRecord,
} from "@/lib/face-db";
import { getLang, t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { ProviderPreset } from "@/lib/vision-providers";

interface Props {
  preset: ProviderPreset;
  onOpenIntake: () => void;
  onOpenEvent?: (eventId: string) => void;
  onOpenReminder?: (reminderId: string) => void;
  onPrepareMeeting?: (personId: string) => void;
  focusPersonId?: string;
  focusRelationId?: string;
  focusRelationPersonId?: string;
  focusNonce?: number;
}

type GraphDrill =
  | { mode: "blocks" }
  | { mode: "group"; key: string }
  | { mode: "members"; key: string; memberIds: string[] };

const DEFAULT_RELATION_LABELS = ["朋友", "同事", "同学", "亲属", "夫妻", "合作伙伴"];

function graphColor(key: string) {
  let hash = 0;
  for (const char of key) hash = (hash * 31 + char.charCodeAt(0)) % 360;
  return {
    node: `hsl(${hash} 62% 48%)`,
    fill: `hsl(${hash} 62% 48% / 0.09)`,
    stroke: `hsl(${hash} 62% 48% / 0.42)`,
  };
}

export function RelationsPanel({
  preset,
  onOpenIntake,
  onOpenEvent,
  onOpenReminder,
  onPrepareMeeting,
  focusPersonId,
  focusRelationId,
  focusRelationPersonId,
  focusNonce,
}: Props) {
  const [people, setPeople] = useState<PersonRecord[]>([]);
  const [relations, setRelations] = useState<RelationRecord[]>([]);
  const [evidence, setEvidence] = useState<EvidenceRecord[]>([]);
  const [lifeEvents, setLifeEvents] = useState<LifeEventRecord[]>([]);
  const [reminders, setReminders] = useState<ReminderRecord[]>([]);
  const [collections, setCollections] = useState<CollectionRecord[]>([]);
  const [collectionMemberships, setCollectionMemberships] = useState<CollectionMembershipRecord[]>(
    [],
  );
  const [collectionFilterId, setCollectionFilterId] = useState<string | null>(null);
  const [newCollectionName, setNewCollectionName] = useState("");
  const [newName, setNewName] = useState("");
  const [newNote, setNewNote] = useState("");
  const [editing, setEditing] = useState<PersonRecord | null>(null);
  const handledPersonFocus = useRef("");
  const handledRelationFocus = useRef("");
  const [fromId, setFromId] = useState("");
  const [toId, setToId] = useState("");
  const [label, setLabel] = useState("");
  const [relationComposerOpen, setRelationComposerOpen] = useState(false);
  const [relationPick, setRelationPick] = useState<"from" | "to">("from");
  const relationLabelRef = useRef<HTMLInputElement | null>(null);
  /** auto = 按关系词推断方向；mutual = 双箭头；directed = 单箭头 */
  const [dirMode, setDirMode] = useState<"auto" | "mutual" | "directed">("auto");
  /** 关系网布局：用户圈层 / 拓扑社区 / 不分组。 */
  const [groupBy, setGroupBy] = useState<RelationGraphGroupingMode>(() =>
    typeof localStorage === "undefined"
      ? DEFAULT_RELATION_GRAPH_GROUPING
      : loadRelationGraphGrouping(localStorage),
  );
  const [relationFilter, setRelationFilter] = useState("all");
  const [relationCategoryFilter, setRelationCategoryFilter] = useState<RelationCategory | "all">(
    "all",
  );
  const [relationEvidenceFilter, setRelationEvidenceFilter] = useState<
    "all" | "explicit" | "inferred" | "unknown"
  >("all");
  const [relationConfirmationFilter, setRelationConfirmationFilter] = useState<
    "all" | "confirmed" | "pending"
  >("all");
  const [graphViewMode, setGraphViewMode] = useState<GraphViewMode>("overview");
  const [focusDepth, setFocusDepth] = useState<1 | 2>(1);
  const [showEdgeLabels, setShowEdgeLabels] = useState(false);
  /** 档案页：搜索词、标签筛选、批量选中 */
  const [query, setQuery] = useState("");
  const [filterTags, setFilterTags] = useState<string[]>([]);
  const [checkedIds, setCheckedIds] = useState<string[]>([]);
  const [batchTag, setBatchTag] = useState("");
  const [summary, setSummary] = useState("");
  const [summarizing, setSummarizing] = useState(false);
  const [tagOpen, setTagOpen] = useState<string | null>(null);
  /** 手动拖拽后的节点位置（覆盖自动布局） */
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>({});
  /** 当前选中的节点：高亮它的关系 */
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** 当前选中的关系边：在图与无障碍列表中共享同一详情面板。 */
  const [selectedRelationId, setSelectedRelationId] = useState<string | null>(null);
  /** 只有点击圈层图例中的“只看”才缩小范围；普通节点选择不会改变图的数据范围。 */
  const [drill, setDrill] = useState<GraphDrill>({ mode: "blocks" });
  /** 画布缩放 / 平移 */
  const [viewport, setViewport] = useState({ scale: 1, tx: 0, ty: 0 });
  const [graphFullscreen, setGraphFullscreen] = useState(false);
  const graphFrameRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const wheelListenerRef = useRef<((event: WheelEvent) => void) | null>(null);
  const dragRef = useRef<{
    id: string;
    x: number;
    y: number;
    ox: number;
    oy: number;
    moved: number;
  } | null>(null);
  const panRef = useRef<{
    x: number;
    y: number;
    tx: number;
    ty: number;
    moved: number;
  } | null>(null);
  const pendingNodeClickRef = useRef<{ id: string; timer: number } | null>(null);

  const refresh = useCallback(async () => {
    await facesDb.pruneOrphanRelations();
    const [p, r, events, reminderRows, evidenceRows, collectionRows, membershipRows] =
      await Promise.all([
        facesDb.listPersons(),
        facesDb.listRelations(),
        facesDb.listLifeEvents(),
        facesDb.listReminders(),
        facesDb.listEvidence(),
        facesDb.listCollections(),
        facesDb.listCollectionMemberships(),
      ]);
    setPeople(p);
    setRelations(r);
    setLifeEvents(events);
    setReminders(reminderRows);
    setEvidence(evidenceRows);
    setCollections(collectionRows);
    setCollectionMemberships(membershipRows);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!focusPersonId) return;
    const focusKey = `${focusPersonId}:${focusNonce ?? 0}`;
    if (handledPersonFocus.current === focusKey) return;
    const person = people.find((record) => record.id === focusPersonId);
    if (!person) return;
    handledPersonFocus.current = focusKey;
    setEditing(person);
  }, [focusNonce, focusPersonId, people]);

  useEffect(() => {
    if (!focusRelationId) return;
    const focusKey = `${focusRelationId}:${focusNonce ?? 0}`;
    if (handledRelationFocus.current === focusKey) return;
    const relation = relations.find((record) => record.id === focusRelationId);
    if (!relation) return;
    handledRelationFocus.current = focusKey;
    setSelectedRelationId(relation.id);
    setSelectedId(
      focusRelationPersonId === relation.fromId || focusRelationPersonId === relation.toId
        ? focusRelationPersonId
        : relation.fromId,
    );
  }, [focusNonce, focusRelationId, focusRelationPersonId, relations]);

  useEffect(() => {
    if (typeof localStorage !== "undefined") saveRelationGraphGrouping(localStorage, groupBy);
  }, [groupBy]);

  const nameOf = useCallback(
    (id: string) => people.find((person) => person.id === id)?.name ?? t("已删除"),
    [people],
  );

  const createPerson = async () => {
    const name = newName.trim();
    try {
      assertValidPersonName(name);
    } catch (error) {
      toast.error(t((error as Error).message));
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
    try {
      const preview = await previewPersonDeletion(person.id);
      if (!window.confirm(`${personDeletionImpactText(preview.impact)}\n\n确认执行吗？`)) return;
      await applyPersonDeletionPlan(preview.plan);
      await refresh();
      toast.success(`${t("已删除")}：${person.name}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("删除失败"));
    }
  };

  const addRelation = async () => {
    if (!fromId || !toId || fromId === toId) {
      toast.error(t("请选择两个不同的人"));
      return;
    }
    const now = Date.now();
    const relationId = crypto.randomUUID();
    const relationLabel = label.trim() || t("认识");
    const semantics = inferRelationSemantics(relationLabel);
    const mutual = dirMode === "auto" ? inferMutual(relationLabel) : dirMode === "mutual";
    await facesDb.putRelationshipBatch({
      assertions: [
        {
          id: relationId,
          recordType: "assertion",
          fromId,
          toId,
          predicate: semantics.predicate,
          qualifiers: semantics.qualifiers,
          label: relationLabel,
          direction:
            semantics.predicate === "custom" ? (mutual ? "symmetric" : "directed") : "ontology",
          evidence: { mode: "manual", sourceIds: [] },
          validity: {
            status:
              semantics.qualifiers.temporalStatus === "former"
                ? "ended"
                : semantics.qualifiers.temporalStatus === "current"
                  ? "active"
                  : "unknown",
            validFrom: semantics.qualifiers.validFrom,
            validTo: semantics.qualifiers.validTo,
          },
          confidence: 1,
          confirmationStatus: "confirmed",
          createdAt: now,
          updatedAt: now,
          source: makeSource("manual"),
        },
      ],
      viewPreferences: [
        { id: relationId, subjectId: relationId, visibility: "auto", updatedAt: now },
      ],
      referralPolicies: [
        {
          id: relationId,
          subjectId: relationId,
          policy: "allow",
          direction: "both",
          contexts: [],
          updatedAt: now,
        },
      ],
    });
    const fromName = nameOf(fromId);
    const toName = nameOf(toId);
    setSelectedId(fromId);
    setSelectedRelationId(relationId);
    setRelationComposerOpen(false);
    setFromId("");
    setToId("");
    setLabel("");
    setRelationPick("from");
    await refresh();
    toast.success(`${t("已建立关系")}：${fromName} ${t("与")} ${toName}`);
  };

  const openRelationComposer = () => {
    const source =
      selectedId && people.some((person) => person.id === selectedId) ? selectedId : "";
    setFromId(source);
    setToId("");
    setLabel("");
    setDirMode("auto");
    setRelationPick(source ? "to" : "from");
    setSelectedRelationId(null);
    // A large overview contains aggregate community nodes rather than people.
    // Relationship composition always switches to the person-level graph.
    setGraphViewMode("standard");
    setRelationComposerOpen(true);
  };

  const closeRelationComposer = useCallback(() => {
    setRelationComposerOpen(false);
    setFromId("");
    setToId("");
    setLabel("");
    setRelationPick("from");
  }, []);

  const analyse = async () => {
    if (!people.length) {
      toast.error(t("还没有任何人物档案"));
      return;
    }
    setSummarizing(true);
    setSummary("");
    try {
      const result = await runAssistantAgent({
        preset,
        question:
          getLang() === "en"
            ? "Review the complete local archive. Summarise evidence-backed groups and key tags, identify people who bridge topology communities, and list genuinely missing information worth collecting. Do not persist computed topology communities as factual circles. Answer in English."
            : "请梳理当前完整人物档案：概括可证实的群体结构和每个人的关键标签，指出连接不同拓扑社区的桥接人物，并列出确实缺失、值得后续补充的信息。不要把拓扑社区写回为事实圈层。",
        persons: people,
        relations,
        events: lifeEvents,
        collections,
        collectionMemberships,
        includeArchive: true,
      });
      setSummary(result.answer);
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
    const updates = targets.map((person) => {
      const current = new Set(person.profile?.tags ?? []);
      if (add) current.add(tag);
      else current.delete(tag);
      return {
        ...person,
        profile: {
          ...(person.profile ?? {}),
          tags: [...current],
        },
      };
    });
    await facesDb.putBatch({ persons: updates });
    await refresh();
    toast.success(
      `${targets.length} ${t("人")} ${add ? t("已加上标签") : t("已移除标签")}「${tag}」`,
    );
  };

  /** 批量删除（连同关系一起删） */
  const removeChecked = async () => {
    const targets = people.filter((person) => checkedIds.includes(person.id));
    if (!targets.length) return;
    try {
      const preview = await previewPeopleDeletion(targets.map((person) => person.id));
      if (!window.confirm(`${peopleDeletionImpactText(preview.impact)}\n\n确认批量执行吗？`))
        return;
      await applyPersonDeletionPlan(preview.plan);
      setCheckedIds([]);
      await refresh();
      toast.success(`${t("已删除")} ${targets.length} ${t("人")}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("批量删除失败"));
      await refresh();
    }
  };

  /**
   * Layout communities are a disposable graph projection. User collections
   * are independent, overlapping filters and never become spatial truth.
   */
  const relationCommunities = useMemo(
    () => detectRelationCommunities(people, relations),
    [people, relations],
  );
  const communityByPersonId = useMemo(
    () => relationCommunityMap(relationCommunities),
    [relationCommunities],
  );
  const communityNames = useMemo(
    () =>
      new Map(
        relationCommunities.map((community, index) => {
          const names = community.memberIds
            .map((id) => people.find((person) => person.id === id)?.name)
            .filter((name): name is string => Boolean(name));
          return [
            community.id,
            names.length <= 2 ? names.join("、") || `${t("社区")} ${index + 1}` : `${names[0]}等`,
          ] as const;
        }),
      ),
    [people, relationCommunities],
  );
  const circleLayout = useMemo(
    () => buildCircleLayoutProjection(people, collections, collectionMemberships, t("未分圈层")),
    [people, collections, collectionMemberships],
  );
  const layoutGroupOf = useCallback(
    (person: PersonRecord) => {
      if (groupBy === "circles") {
        const circle = circleLayout.groupByPersonId.get(person.id);
        return circle
          ? { key: circle.key, label: circle.label }
          : { key: "circles:none", label: t("未分圈层") };
      }
      if (groupBy === "communities") {
        const communityId = communityByPersonId.get(person.id) ?? `community:person:${person.id}`;
        return {
          key: communityId,
          label: communityNames.get(communityId) ?? t("未连接"),
        };
      }
      return { key: "", label: "" };
    },
    [circleLayout, communityByPersonId, communityNames, groupBy],
  );

  const openCollection = collections.find((collection) => collection.id === tagOpen) ?? null;
  const openCollectionMemberIds = new Set(
    collectionMemberships
      .filter((membership) => membership.collectionId === tagOpen)
      .map((membership) => membership.personId),
  );
  const tagMembers = tagOpen
    ? people.filter((person) => openCollectionMemberIds.has(person.id))
    : [];
  const tagCandidates = tagOpen
    ? people.filter((person) => !openCollectionMemberIds.has(person.id))
    : [];

  const createCollection = async () => {
    const name = newCollectionName.trim();
    if (!name) return;
    if (collections.some((collection) => collection.name === name)) {
      toast.error(t("已有同名圈层"));
      return;
    }
    const now = Date.now();
    const id = `collection:${crypto.randomUUID()}`;
    await facesDb.putCollection({ id, name, kind: "context", createdAt: now, updatedAt: now });
    setNewCollectionName("");
    setTagOpen(id);
    await refresh();
  };

  const renameTagGroup = async (_current: string, next: string) => {
    if (!openCollection) return;
    const value = next.trim();
    if (!value) return;
    await facesDb.putCollection({ ...openCollection, name: value, updatedAt: Date.now() });
    await refresh();
  };

  const addPersonToTag = async (personId: string) => {
    if (!openCollection || !people.some((person) => person.id === personId)) return;
    await facesDb.putCollectionMembership({
      id: `${openCollection.id}\u0000${personId}`,
      collectionId: openCollection.id,
      personId,
      source: "manual",
      createdAt: Date.now(),
    });
    await refresh();
  };

  const removePersonFromTag = async (personId: string) => {
    if (!openCollection) return;
    await facesDb.deleteCollectionMembership(`${openCollection.id}\u0000${personId}`);
    await refresh();
  };

  /** 当前钻取层级下要画哪些人 */
  const visiblePeople = useMemo(() => {
    const collectionMemberIds = collectionFilterId
      ? new Set(
          collectionMemberships
            .filter((membership) => membership.collectionId === collectionFilterId)
            .map((membership) => membership.personId),
        )
      : null;
    const collectionPeople = collectionMemberIds
      ? people.filter((person) => collectionMemberIds.has(person.id))
      : people;
    if (drill.mode === "members") {
      const memberIds = new Set(drill.memberIds);
      return collectionPeople.filter((person) => memberIds.has(person.id));
    }
    if (groupBy === "none") return collectionPeople;
    if (drill.mode === "group")
      return collectionPeople.filter((person) => layoutGroupOf(person).key === drill.key);
    return collectionPeople;
  }, [people, groupBy, drill, layoutGroupOf, collectionFilterId, collectionMemberships]);

  const policyFilteredRelations = useMemo(
    () =>
      relations.filter(
        (relation) =>
          (relationFilter === "all" || relation.label === relationFilter) &&
          (relationCategoryFilter === "all" ||
            relationCategory(relation) === relationCategoryFilter) &&
          (relationEvidenceFilter === "all" ||
            relationEvidenceMode(relation) === relationEvidenceFilter) &&
          (relationConfirmationFilter === "all" ||
            (relation.confirmationStatus ?? "confirmed") === relationConfirmationFilter),
      ),
    [
      relations,
      relationFilter,
      relationCategoryFilter,
      relationEvidenceFilter,
      relationConfirmationFilter,
    ],
  );

  const graphVisibility = useMemo(
    () =>
      selectVisibleRelations({
        relations: policyFilteredRelations,
        events: lifeEvents,
        mode: graphViewMode,
        selectedId,
        focusDepth,
      }),
    [policyFilteredRelations, lifeEvents, graphViewMode, selectedId, focusDepth],
  );

  /**
   * Above this size, overview is a community map. It is a reversible visual
   * projection: clicking a community drills into the exact member ids.
   */
  const aggregateOverview =
    graphViewMode === "overview" &&
    groupBy === "communities" &&
    drill.mode === "blocks" &&
    visiblePeople.length > 60;
  const communityOverview = useMemo(
    () =>
      buildRelationCommunityOverview(visiblePeople, graphVisibility.visible, relationCommunities),
    [visiblePeople, graphVisibility.visible, relationCommunities],
  );
  const overviewGraph = useMemo(() => {
    const count = communityOverview.nodes.length;
    const ringRadius = count <= 1 ? 0 : Math.max(190, count * 42);
    const size = Math.max(520, 2 * (ringRadius + 100));
    const center = size / 2;
    const names = new Map(people.map((person) => [person.id, person.name]));
    const nodes = communityOverview.nodes.map((node, index) => {
      const angle = (index / Math.max(count, 1)) * Math.PI * 2 - Math.PI / 2;
      const memberNames = node.memberIds
        .map((id) => names.get(id))
        .filter((name): name is string => Boolean(name));
      const label = node.isolated
        ? `${t("未连接人物")} · ${node.memberIds.length}`
        : node.memberIds.length <= 2
          ? memberNames.join("、")
          : `${memberNames[0] ?? t("社区")}等 · ${node.memberIds.length}`;
      return {
        ...node,
        label,
        x: center + ringRadius * Math.cos(angle),
        y: center + ringRadius * Math.sin(angle),
        r: Math.min(72, 28 + Math.sqrt(node.memberIds.length) * 6),
        color: graphColor(node.id),
      };
    });
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const edges = communityOverview.edges
      .map((edge) => ({ ...edge, a: nodeById.get(edge.fromId), b: nodeById.get(edge.toId) }))
      .filter((edge) => edge.a && edge.b);
    return { size, nodes, edges };
  }, [communityOverview, people]);

  /** 关系网布局：默认一个大圆；按标签分组时每个圈层自成一簇。 */
  const graph = useMemo(() => {
    // In aggregate overview mode the community projection below is the only
    // graph we need. Avoid the quadratic edge-label placement work for a dense
    // 200-person graph that will not be rendered.
    const people = aggregateOverview ? [] : visiblePeople;
    /** 两个人之间的最短距离（保证关系词写得下） */
    const MIN_EDGE = 150;
    type Node = {
      id: string;
      x: number;
      y: number;
      name: string;
      group: string;
      color: ReturnType<typeof graphColor>;
    };
    const nodes: Node[] = [];
    const clusters: { key: string; name: string; x: number; y: number; r: number }[] = [];

    /** 环形排布时，为了让相邻两点至少隔开 MIN_EDGE 所需的半径 */
    const ringFor = (count: number) =>
      count <= 1 ? 0 : Math.max(90, MIN_EDGE / (2 * Math.sin(Math.PI / count)));

    /** Large sets use concentric rings instead of one ever-growing circumference. */
    const layeredRing = (count: number) => {
      if (count <= 24) {
        const radius = ringFor(count);
        return {
          radius,
          points: Array.from({ length: count }, (_, index) => {
            const angle = (index / Math.max(count, 1)) * Math.PI * 2 - Math.PI / 2;
            return count === 1
              ? { x: 0, y: 0 }
              : { x: radius * Math.cos(angle), y: radius * Math.sin(angle) };
          }),
        };
      }
      const points: Array<{ x: number; y: number }> = [];
      let ring = 1;
      while (points.length < count) {
        const radius = ring * 170;
        const capacity = Math.max(8, Math.floor((Math.PI * 2 * radius) / MIN_EDGE));
        const take = Math.min(capacity, count - points.length);
        for (let index = 0; index < take; index += 1) {
          const angle =
            (index / take) * Math.PI * 2 - Math.PI / 2 + (ring % 2 ? 0 : Math.PI / take);
          points.push({ x: radius * Math.cos(angle), y: radius * Math.sin(angle) });
        }
        ring += 1;
      }
      return { radius: (ring - 1) * 170, points };
    };

    let size = 640;

    if (groupBy !== "none") {
      const buckets = new Map<string, { name: string; members: PersonRecord[] }>();
      for (const person of people) {
        const group = layoutGroupOf(person);
        const bucket = buckets.get(group.key);
        if (bucket) bucket.members.push(person);
        else buckets.set(group.key, { name: group.label, members: [person] });
      }
      const groups = [...buckets.entries()].map(([key, bucket]) => {
        const layout = layeredRing(bucket.members.length);
        return { key, ...bucket, inner: layout.radius, points: layout.points };
      });
      const maxR = Math.max(...groups.map((group) => group.inner + 52), 120);
      // 多个圈层时，各簇均匀分布在一个更大的环上，彼此不重叠
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
        clusters.push({ key: group.key, name: group.name, x: cx, y: cy, r: group.inner + 52 });
        group.members.forEach((person, index) => {
          const point = group.points[index] ?? { x: 0, y: 0 };
          nodes.push({
            id: person.id,
            name: person.name,
            group: group.key,
            color: graphColor(group.key),
            x: cx + point.x,
            y: cy + point.y,
          });
        });
      });
    } else {
      const layout = layeredRing(people.length);
      const radius = layout.radius;
      size = 2 * (radius + 74);
      const center = size / 2;
      people.forEach((person, index) => {
        const point = layout.points[index] ?? { x: 0, y: 0 };
        nodes.push({
          id: person.id,
          name: person.name,
          group: "",
          color: graphColor("all"),
          x: center + point.x,
          y: center + point.y,
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

    // 圈层跟着点走：用该圈层所有点的实际位置重新算圆心和半径
    for (const cluster of clusters) {
      const members = nodes.filter((node) => node.group === cluster.key);
      if (!members.length) continue;
      const cx = members.reduce((sum, node) => sum + node.x, 0) / members.length;
      const cy = members.reduce((sum, node) => sum + node.y, 0) / members.length;
      cluster.x = cx;
      cluster.y = cy;
      cluster.r = Math.max(86, ...members.map((node) => Math.hypot(node.x - cx, node.y - cy) + 52));
    }

    // 只折叠完全相同方向、标签与方向性的重复记录；不同标签必须分别保留。
    const seen = new Set<string>();
    const edges = (aggregateOverview ? [] : graphVisibility.visible)
      .filter((relation) => {
        const key = `${relation.fromId}>${relation.toId}::${relation.label.trim()}::${
          isMutualRelation(relation) ? "mutual" : "directed"
        }`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((relation) => {
        const a = map.get(relation.fromId);
        const b = map.get(relation.toId);
        return {
          id: relation.id,
          label: relation.label,
          mutual: isMutualRelation(relation),
          evidenceMode: relationEvidenceMode(relation),
          supportingRelationIds:
            relation.supportingRelationIds ?? relation.derivedFromRelationIds ?? [],
          confirmationStatus: relation.confirmationStatus ?? "confirmed",
          visibility: relation.visibility ?? "auto",
          /** 跨圈层的连线用虚线标出来 */
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
            Math.abs(item.x - cand.x) < (item.w + item.w) / 2 + 6 && Math.abs(item.y - cand.y) < 18,
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

    // 圈层范围画成不规则的平滑外形，形状跟着圈层成员的实际位置流动变形
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
      color: graphColor(cluster.key),
      path: blob(
        cluster.x,
        cluster.y,
        cluster.r * 1.08,
        cluster.key,
        nodes.filter((node) => node.group === cluster.key),
      ),
    }));

    return { size, nodes, edges: labelled, clusters: shaped };
  }, [
    aggregateOverview,
    visiblePeople,
    graphVisibility.visible,
    groupBy,
    layoutGroupOf,
    positions,
  ]);

  const relationLabels = useMemo(
    () => [...new Set(relations.map((relation) => relation.label).filter(Boolean))].sort(),
    [relations],
  );

  const relationSuggestions = useMemo(
    () => [...new Set([...DEFAULT_RELATION_LABELS.map((item) => t(item)), ...relationLabels])],
    [relationLabels],
  );

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
    const events = lifeEvents
      .filter((event) => event.personIds?.includes(person.id))
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 3);
    const relatedReminders = reminders
      .filter((reminder) => reminder.personIds?.includes(person.id))
      .sort((a, b) => (a.due ?? "9999-99-99").localeCompare(b.due ?? "9999-99-99"))
      .slice(0, 3);
    const commitments = Object.entries(person.profile?.extra ?? {}).filter(([key]) =>
      /承诺|约定|promise|commitment/i.test(key),
    );
    return { person, links, events, reminders: relatedReminders, commitments };
  }, [selectedId, people, relations, lifeEvents, reminders, nameOf]);

  const selectedRelation = useMemo(
    () => relations.find((relation) => relation.id === selectedRelationId) ?? null,
    [relations, selectedRelationId],
  );
  const selectedEvidence = useMemo(
    () => evidence.find((item) => item.id === selectedRelation?.sourceId) ?? null,
    [evidence, selectedRelation?.sourceId],
  );

  const viewSize = aggregateOverview ? overviewGraph.size : graph.size;
  const viewSizeRef = useRef(viewSize);
  viewSizeRef.current = viewSize;

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

  /**
   * React 在根节点注册的 wheel 监听器可能是 passive，单靠 onWheel.preventDefault()
   * 无法稳定阻止页面滚动。这里直接给实际 SVG 绑定 non-passive 监听器，确保图内滚轮
   * 只改变画布缩放，不再把同一滚轮动作传给页面。
   */
  const bindSvgRef = useCallback((node: SVGSVGElement | null) => {
    const previous = svgRef.current;
    const previousListener = wheelListenerRef.current;
    if (previous && previousListener) previous.removeEventListener("wheel", previousListener);

    svgRef.current = node;
    wheelListenerRef.current = null;
    if (!node) return;

    const listener = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
      setViewport((prev) => {
        const scale = Math.min(4, Math.max(0.4, prev.scale * factor));
        const center = viewSizeRef.current / 2;
        return {
          scale,
          tx: center - (center - prev.tx) * (scale / prev.scale),
          ty: center - (center - prev.ty) * (scale / prev.scale),
        };
      });
    };
    node.addEventListener("wheel", listener, { passive: false });
    wheelListenerRef.current = listener;
  }, []);

  useEffect(() => {
    const syncFullscreenState = () => {
      setGraphFullscreen(document.fullscreenElement === graphFrameRef.current);
    };
    document.addEventListener("fullscreenchange", syncFullscreenState);
    return () => document.removeEventListener("fullscreenchange", syncFullscreenState);
  }, []);

  const toggleGraphFullscreen = async () => {
    try {
      if (document.fullscreenElement === graphFrameRef.current) {
        await document.exitFullscreen();
      } else {
        await graphFrameRef.current?.requestFullscreen();
      }
    } catch {
      toast.error(t("无法切换全屏"));
    }
  };

  const focusPerson = (id: string) => {
    setSelectedId(id);
    setSelectedRelationId(null);
  };

  /** 返回：从某个人退回全部圈子总览 */
  const goBack = useCallback(() => {
    setSelectedId(null);
    resetView();
    setDrill({ mode: "blocks" });
  }, []);

  /** Esc 依次退出建关系、人物聚焦或圈层钻取。 */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (relationComposerOpen) {
        closeRelationComposer();
      } else if (selectedId) {
        setSelectedId(null);
      } else if (drill.mode !== "blocks") {
        goBack();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeRelationComposer, drill.mode, goBack, relationComposerOpen, selectedId]);

  const activateNode = (id: string) => {
    if (!relationComposerOpen) {
      focusPerson(id);
      return;
    }
    if (relationPick === "from") {
      setFromId(id);
      if (toId === id) setToId("");
      setRelationPick("to");
      return;
    }
    if (id === fromId) {
      toast.error(t("起点和终点不能是同一个人"));
      return;
    }
    setToId(id);
    setRelationPick("to");
    window.setTimeout(() => relationLabelRef.current?.focus(), 0);
  };

  const onPanPointerDown = (event: React.PointerEvent<SVGSVGElement>) => {
    // 只有真正的画布空白启动平移。节点和关系边拥有自己的选择语义，不能在
    // pointerup 时被误判为“点击空白”。圈层底色禁用了 pointer events，仍算空白。
    const target = event.target as Element;
    const isBackground =
      target === event.currentTarget || target.getAttribute("data-graph-background") === "true";
    if (dragRef.current || !isBackground) return;
    panRef.current = {
      x: event.clientX,
      y: event.clientY,
      tx: viewport.tx,
      ty: viewport.ty,
      moved: 0,
    };
  };
  const onPanPointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    const pan = panRef.current;
    if (!pan || dragRef.current) return;
    const rect = svgRef.current?.getBoundingClientRect();
    const ratio = rect && rect.width ? viewSize / rect.width : 1;
    pan.moved = Math.max(pan.moved, Math.hypot(event.clientX - pan.x, event.clientY - pan.y));
    setViewport((prev) => ({
      ...prev,
      tx: pan.tx + (event.clientX - pan.x) * ratio,
      ty: pan.ty + (event.clientY - pan.y) * ratio,
    }));
  };
  const onPanPointerUp = () => {
    const pan = panRef.current;
    panRef.current = null;
    if (!pan || pan.moved >= 4 || relationComposerOpen) return;
    if (pendingNodeClickRef.current) {
      window.clearTimeout(pendingNodeClickRef.current.timer);
      pendingNodeClickRef.current = null;
    }
    setSelectedId(null);
    setSelectedRelationId(null);
  };

  const onNodePointerDown = (
    event: React.PointerEvent<SVGGElement>,
    node: { id: string; x: number; y: number },
  ) => {
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
    // 没怎么动 = 点击：普通模式只高亮，建关系模式则依次选择起点和终点。
    if (drag.moved < 4) {
      if (relationComposerOpen) {
        activateNode(drag.id);
        return;
      }
      const pending = pendingNodeClickRef.current;
      if (pending?.id === drag.id) {
        window.clearTimeout(pending.timer);
        pendingNodeClickRef.current = null;
        const person = people.find((item) => item.id === drag.id);
        if (person) setEditing(person);
        return;
      }
      if (pending) {
        window.clearTimeout(pending.timer);
        focusPerson(pending.id);
      }
      const timer = window.setTimeout(() => {
        focusPerson(drag.id);
        pendingNodeClickRef.current = null;
      }, 320);
      pendingNodeClickRef.current = { id: drag.id, timer };
    }
  };

  useEffect(
    () => () => {
      if (pendingNodeClickRef.current) window.clearTimeout(pendingNodeClickRef.current.timer);
    },
    [],
  );

  return (
    <section className="flex min-w-0 flex-col gap-5 rounded-2xl border border-border bg-card/60 p-5">
      <header className="flex items-center justify-between gap-3">
        <h2 className="flex items-baseline gap-2.5">
          <span className="font-display text-xl leading-none tracking-tight">{t("人物档案")}</span>
          <span className="text-[10px] uppercase tracking-[0.24em] text-muted-foreground">
            Agent
          </span>
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
            title={t("档案页")}
            points={[
              t("填名字就能建人，先建人再连关系。"),
              t("点一行可以打开人物卡补职位、部门等资料。"),
            ]}
          />

          <div className="space-y-2 rounded-xl border border-border p-3">
            <Label className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
              {t("不用人脸也能建档")}
            </Label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                value={newName}
                maxLength={80}
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
              {t("建档后可继续补充昵称、联系方式、关系与共同经历。")}
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
                  setCheckedIds(allChecked ? [] : filteredPeople.map((person) => person.id))
                }
              >
                {allChecked ? t("取消全选") : t("全选本页")}
              </button>
              {checkedIds.length > 0 && (
                <>
                  <span>
                    · {t("已选")} {checkedIds.length}
                  </span>
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
                <div
                  key={person.id}
                  className="flex items-start gap-2.5 rounded-xl border border-border p-2.5"
                >
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
                    <img
                      src={person.thumb}
                      alt={person.name}
                      className="size-12 rounded-lg object-cover"
                    />
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
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-[11px]"
                        onClick={() => setEditing(person)}
                      >
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
            <div className="flex flex-wrap gap-2">
              <div className="min-w-0 flex-1 text-xs leading-relaxed text-muted-foreground">
                {t(
                  "自然语言、文件、截图和语音请走统一录入草稿；确认身份、字段 Diff 与来源后才会写入。",
                )}
              </div>
              <Button variant="outline" onClick={onOpenIntake} className="rounded-full px-4">
                <Sparkles className="size-3.5" aria-hidden="true" />
                {t("前往安全录入")}
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

          <div className="space-y-2 rounded-xl border border-border bg-muted/15 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium">{t("我的集合")}</span>
              <span className="text-[11px] text-muted-foreground">
                {t("集合可以重叠，只用于筛选和整理，不决定图上的空间位置。")}
              </span>
              {collectionFilterId && (
                <button
                  type="button"
                  className="ml-auto text-[11px] text-primary hover:underline"
                  onClick={() => setCollectionFilterId(null)}
                >
                  {t("显示全部人物")}
                </button>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {collections
                .filter((collection) => collection.kind !== "computed_community")
                .map((collection) => {
                  const count = collectionMemberships.filter(
                    (membership) => membership.collectionId === collection.id,
                  ).length;
                  return (
                    <div
                      key={collection.id}
                      className={cn(
                        "inline-flex overflow-hidden rounded-full border bg-background text-[11px]",
                        collectionFilterId === collection.id ? "border-primary" : "border-border",
                      )}
                    >
                      <button
                        type="button"
                        className="px-2.5 py-1 hover:bg-accent"
                        onClick={() =>
                          setCollectionFilterId((current) =>
                            current === collection.id ? null : collection.id,
                          )
                        }
                      >
                        {collection.name} · {count}
                      </button>
                      <button
                        type="button"
                        className="border-l border-border px-2 py-1 text-primary hover:bg-accent"
                        aria-label={`${t("管理圈层")}：${collection.name}`}
                        onClick={() => setTagOpen(collection.id)}
                      >
                        {t("管理")}
                      </button>
                    </div>
                  );
                })}
              <Input
                value={newCollectionName}
                onChange={(event) => setNewCollectionName(event.target.value)}
                onKeyDown={(event) => event.key === "Enter" && void createCollection()}
                placeholder={t("新集合名称")}
                className="h-8 w-36 rounded-full text-xs"
              />
              <Button
                size="sm"
                variant="outline"
                className="h-8 rounded-full px-2.5 text-[11px]"
                disabled={!newCollectionName.trim()}
                onClick={() => void createCollection()}
              >
                <Plus className="size-3" aria-hidden="true" />
                {t("新建集合")}
              </Button>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              onClick={openRelationComposer}
              disabled={people.length < 2}
              className="shrink-0 rounded-full px-4"
            >
              <Plus className="size-3.5" aria-hidden="true" />
              {t("新建关系")}
            </Button>
            <select
              value={groupBy}
              onChange={(event) => {
                setGroupBy(event.target.value as RelationGraphGroupingMode);
                setDrill({ mode: "blocks" });
                setPositions({});
                resetView();
              }}
              className="h-9 rounded-md border border-border bg-background px-2 text-sm"
              aria-label={t("分组布局")}
              title={t("布局")}
            >
              <option value="none">{t("不分组")}</option>
              <option value="circles">{t("按圈层布局")}</option>
              <option value="communities">{t("按拓扑社区布局")}</option>
            </select>
            <select
              value={graphViewMode}
              onChange={(event) => setGraphViewMode(event.target.value as GraphViewMode)}
              className="h-9 rounded-md border border-primary/35 bg-primary/5 px-2 text-sm"
              aria-label={t("关系网视图")}
              title={t("关系网视图")}
            >
              <option value="overview">{t("概览：结构骨架")}</option>
              <option value="standard">{t("标准：事实与有效推导")}</option>
              <option value="all">{t("全部：包含常隐")}</option>
            </select>
            <select
              value={focusDepth}
              onChange={(event) => setFocusDepth(Number(event.target.value) as 1 | 2)}
              disabled={!selectedId}
              className="h-9 rounded-md border border-border bg-background px-2 text-sm"
              aria-label={t("聚焦范围")}
              title={selectedId ? t("聚焦范围") : t("先单击一个人物节点")}
            >
              <option value={1}>{t("高亮：一跳")}</option>
              <option value={2}>{t("高亮：两跳")}</option>
            </select>
            <select
              value={relationFilter}
              onChange={(event) => setRelationFilter(event.target.value)}
              className="h-9 rounded-md border border-border bg-background px-2 text-sm"
              aria-label={t("关系类型筛选")}
            >
              <option value="all">{t("全部关系")}</option>
              {relationLabels.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
            <select
              value={relationCategoryFilter}
              onChange={(event) =>
                setRelationCategoryFilter(event.target.value as RelationCategory | "all")
              }
              className="h-9 rounded-md border border-border bg-background px-2 text-sm"
              aria-label={t("关系类别筛选")}
            >
              <option value="all">{t("全部类别")}</option>
              <option value="family">{t("血亲关系")}</option>
              <option value="in_law">{t("姻亲关系")}</option>
              <option value="work">{t("工作关系")}</option>
              <option value="school">{t("同学关系")}</option>
              <option value="friend">{t("朋友关系")}</option>
              <option value="other">{t("其它关系")}</option>
            </select>
            <select
              value={relationEvidenceFilter}
              onChange={(event) =>
                setRelationEvidenceFilter(event.target.value as typeof relationEvidenceFilter)
              }
              className="h-9 rounded-md border border-border bg-background px-2 text-sm"
              aria-label={t("关系证据筛选")}
            >
              <option value="all">{t("全部证据模式")}</option>
              <option value="explicit">{t("材料明确")}</option>
              <option value="inferred">{t("推导关系")}</option>
              <option value="unknown">{t("旧数据待识别")}</option>
            </select>
            <select
              value={relationConfirmationFilter}
              onChange={(event) =>
                setRelationConfirmationFilter(
                  event.target.value as typeof relationConfirmationFilter,
                )
              }
              className="h-9 rounded-md border border-border bg-background px-2 text-sm"
              aria-label={t("确认状态筛选")}
            >
              <option value="all">{t("全部确认状态")}</option>
              <option value="confirmed">{t("已确认")}</option>
              <option value="pending">{t("待确认")}</option>
            </select>
            <label className="flex h-9 items-center gap-1.5 rounded-md border border-border px-2 text-xs">
              <Checkbox
                checked={showEdgeLabels}
                onCheckedChange={(value) => setShowEdgeLabels(value === true)}
              />
              {t("显示边标签")}
            </label>
          </div>

          {graphVisibility.hidden.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/25 px-3 py-2 text-[11px] text-muted-foreground">
              <span>
                {t("当前视图显示")} {graphVisibility.visible.length} {t("条关系，隐藏")}{" "}
                {graphVisibility.hidden.length} {t("条")}
              </span>
              <button
                type="button"
                className="font-medium text-primary underline-offset-2 hover:underline"
                onClick={() => setGraphViewMode("all")}
              >
                {t("临时查看全部")}
              </button>
              <span>{t("常隐只影响画面，不会删除关系。")}</span>
            </div>
          )}

          {relationComposerOpen && (
            <div
              className="space-y-3 rounded-xl border border-primary/35 bg-primary/5 p-3 shadow-sm"
              role="region"
              aria-label={t("新建关系")}
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="flex items-center gap-2 text-sm font-medium">
                    <Network className="size-4 text-primary" aria-hidden="true" />
                    {t("在图上连接两个人")}
                  </p>
                  <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                    {t("依次点击图中的起点和终点，再输入任意关系名称；候选标签只是快捷建议。")}
                  </p>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={closeRelationComposer}
                  aria-label={t("取消新建关系")}
                >
                  <X className="size-3.5" aria-hidden="true" />
                  {t("取消")}
                </Button>
              </div>

              <div className="grid items-stretch gap-2 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
                <button
                  type="button"
                  aria-pressed={relationPick === "from"}
                  className={cn(
                    "min-h-16 rounded-lg border bg-background px-3 py-2 text-left transition-colors",
                    relationPick === "from"
                      ? "border-primary ring-1 ring-primary/30"
                      : "border-border hover:border-primary/50",
                  )}
                  onClick={() => setRelationPick("from")}
                >
                  <span className="block text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                    1 · {t("起点")}
                  </span>
                  <span className="mt-1 block truncate text-sm font-medium">
                    {fromId ? nameOf(fromId) : t("点击图中一个人物")}
                  </span>
                </button>
                <button
                  type="button"
                  className="mx-auto flex size-9 self-center items-center justify-center rounded-full border border-border bg-background text-primary transition-colors hover:bg-accent disabled:opacity-40"
                  disabled={!fromId && !toId}
                  aria-label={t("交换关系方向")}
                  onClick={() => {
                    const previousFrom = fromId;
                    setFromId(toId);
                    setToId(previousFrom);
                    setRelationPick(toId ? "to" : "from");
                  }}
                >
                  <ArrowLeftRight className="size-4" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  aria-pressed={relationPick === "to"}
                  className={cn(
                    "min-h-16 rounded-lg border bg-background px-3 py-2 text-left transition-colors",
                    relationPick === "to"
                      ? "border-primary ring-1 ring-primary/30"
                      : "border-border hover:border-primary/50",
                  )}
                  onClick={() => setRelationPick("to")}
                >
                  <span className="block text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                    2 · {t("终点")}
                  </span>
                  <span className="mt-1 block truncate text-sm font-medium">
                    {toId ? nameOf(toId) : t("再点击另一个人物")}
                  </span>
                </button>
              </div>

              <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
                <div className="space-y-2">
                  <Label htmlFor="new-relation-label" className="text-xs">
                    {t("关系名称")}
                    <span className="ml-1 font-normal text-muted-foreground">
                      · {t("可自由输入新关系")}
                    </span>
                  </Label>
                  <Input
                    ref={relationLabelRef}
                    id="new-relation-label"
                    list="relation-label-suggestions"
                    value={label}
                    onChange={(event) => setLabel(event.target.value)}
                    placeholder={t("例如：共同创业、表姐弟、摄影搭档")}
                    autoComplete="off"
                  />
                  <datalist id="relation-label-suggestions">
                    {relationSuggestions.map((item) => (
                      <option key={item} value={item} />
                    ))}
                  </datalist>
                  <div className="flex flex-wrap gap-1.5" aria-label={t("关系标签建议")}>
                    {relationSuggestions.slice(0, 8).map((item) => (
                      <button
                        key={item}
                        type="button"
                        className={cn(
                          "rounded-full border px-2.5 py-1 text-[11px] transition-colors",
                          label === item
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-border bg-background hover:border-primary/60",
                        )}
                        onClick={() => {
                          setLabel(item);
                          relationLabelRef.current?.focus();
                        }}
                      >
                        {item}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <select
                    value={dirMode}
                    onChange={(event) => setDirMode(event.target.value as typeof dirMode)}
                    className="h-9 rounded-md border border-border bg-background px-2 text-sm"
                    aria-label={t("关系方向")}
                  >
                    <option value="auto">{t("方向：自动")}</option>
                    <option value="mutual">{t("双向 ⇄")}</option>
                    <option value="directed">{t("单向 →")}</option>
                  </select>
                  <Button
                    onClick={() => void addRelation()}
                    disabled={!fromId || !toId || fromId === toId || !label.trim()}
                    className="rounded-full px-4"
                  >
                    <Check className="size-3.5" aria-hidden="true" />
                    {t("确认建立")}
                  </Button>
                </div>
              </div>
            </div>
          )}

          {groupBy !== "none" && graph.clusters.length > 0 && (
            <div
              className="flex flex-wrap items-center gap-2"
              aria-label={t(groupBy === "circles" ? "圈层图例" : "拓扑社区图例")}
            >
              <span className="text-[11px] text-muted-foreground">
                {t(
                  groupBy === "circles"
                    ? "圈层布局（仅使用已确认关系圈；标签与场景集合不参与）"
                    : "拓扑社区（Louvain 自动计算，不写入档案）",
                )}
                ：
              </span>
              {graph.clusters.map((cluster) => (
                <div
                  key={cluster.key}
                  className="inline-flex overflow-hidden rounded-full border border-border bg-background text-[11px]"
                >
                  <span className="flex min-h-8 items-center gap-1.5 px-2.5">
                    <span
                      className="size-2.5 rounded-full"
                      style={{ backgroundColor: cluster.color.node }}
                      aria-hidden="true"
                    />
                    <span>{cluster.name}</span>
                  </span>
                  <button
                    type="button"
                    className="min-h-8 border-l border-border px-2.5 text-primary hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                    aria-label={`${t(
                      groupBy === "circles" ? "只看圈层" : "只看拓扑社区",
                    )}：${cluster.name}`}
                    onClick={() => {
                      setSelectedId(null);
                      setGraphViewMode("overview");
                      setDrill({
                        mode: "members",
                        key: cluster.name,
                        memberIds: graph.nodes
                          .filter((node) => node.group === cluster.key)
                          .map((node) => node.id),
                      });
                    }}
                  >
                    {t("只看")}
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
            {drill.mode !== "blocks" && (
              <>
                <button
                  type="button"
                  className="rounded-full border border-border bg-background px-2.5 py-1 font-medium text-foreground hover:bg-accent"
                  onClick={goBack}
                >
                  ← {t("返回")}
                </button>
                <span className="rounded-full bg-primary/10 px-2 py-0.5 text-foreground">
                  {drill.key}
                </span>
              </>
            )}
            <span>
              {aggregateOverview
                ? t("大图概览已合并为拓扑社区；点击社区即可查看其中人物")
                : relationComposerOpen
                  ? t("连线模式：依次点击两个节点，按住节点仍可拖动")
                  : t("单击节点聚焦并淡化无关人物，双击打开人物卡，按住可拖动")}
            </span>

            <span className="ml-auto flex items-center gap-1">
              <button
                type="button"
                className="rounded-full border border-border px-2 py-0.5 hover:bg-accent"
                onClick={() => zoomBy(1 / 1.2)}
                aria-label={t("缩小")}
              >
                −
              </button>
              <span className="w-10 text-center tabular-nums">
                {Math.round(viewport.scale * 100)}%
              </span>
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
            <section
              aria-label={t("关系人物摘要")}
              className="space-y-2 rounded-xl border border-primary/30 bg-primary/5 p-3"
            >
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-medium">
                  {selected.person.name}
                  <span className="ml-2 text-[11px] text-muted-foreground">
                    {selected.person.profile?.department || t("未分部门")}
                    {selected.person.profile?.title ? ` · ${selected.person.profile.title}` : ""}
                  </span>
                </p>
                <div className="flex items-center gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-[11px]"
                    onClick={() => onPrepareMeeting?.(selected.person.id)}
                  >
                    {t("准备见面")}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-[11px]"
                    onClick={() => setEditing(selected.person)}
                  >
                    {t("打开人物卡")}
                  </Button>
                </div>
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
              {selected.events.length > 0 && (
                <div className="border-t border-primary/20 pt-2">
                  <p className="text-[11px] font-medium">{t("最近共同事件")}</p>
                  <ul className="mt-1 space-y-1 text-[11px] text-muted-foreground">
                    {selected.events.map((event) => (
                      <li key={event.id}>
                        <button
                          type="button"
                          className="text-left transition-colors hover:text-primary"
                          onClick={() => onOpenEvent?.(event.id)}
                        >
                          <span className="tabular-nums">{event.date}</span> · {event.title}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {(selected.person.profile?.gifts?.length ?? 0) > 0 && (
                <div className="border-t border-primary/20 pt-2">
                  <p className="text-[11px] font-medium">{t("送礼记录")}</p>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {selected.person.profile?.gifts?.join("、")}
                  </p>
                </div>
              )}
              {selected.commitments.length > 0 && (
                <div className="border-t border-primary/20 pt-2">
                  <p className="text-[11px] font-medium">{t("承诺与约定")}</p>
                  <ul className="mt-1 space-y-1 text-[11px] text-muted-foreground">
                    {selected.commitments.map(([key, value]) => (
                      <li key={key}>
                        {key} · {value}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {selected.reminders.length > 0 && (
                <div className="border-t border-primary/20 pt-2">
                  <p className="text-[11px] font-medium">{t("相关提醒")}</p>
                  <ul className="mt-1 space-y-1 text-[11px] text-muted-foreground">
                    {selected.reminders.map((reminder) => (
                      <li key={reminder.id}>
                        <button
                          type="button"
                          className="text-left transition-colors hover:text-primary"
                          onClick={() => onOpenReminder?.(reminder.id)}
                        >
                          {reminder.due ? `${reminder.due} · ` : ""}
                          {reminder.title}
                          {reminder.done ? ` · ${t("已完成")}` : ""}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </section>
          )}

          {selectedRelation && (
            <div
              className="space-y-2 rounded-xl border border-primary/30 bg-background p-3 text-xs"
              role="region"
              aria-label={t("关系详情")}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-medium">
                  {nameOf(selectedRelation.fromId)} {isMutualRelation(selectedRelation) ? "⇄" : "→"}{" "}
                  {nameOf(selectedRelation.toId)}
                </p>
                <button
                  type="button"
                  className="text-muted-foreground underline-offset-2 hover:underline"
                  onClick={() => setSelectedRelationId(null)}
                >
                  {t("关闭详情")}
                </button>
              </div>
              <dl className="grid gap-x-4 gap-y-1 text-[11px] sm:grid-cols-[auto_1fr_auto_1fr]">
                <dt className="text-muted-foreground">{t("关系标签")}</dt>
                <dd>{selectedRelation.label}</dd>
                <dt className="text-muted-foreground">{t("关系依据")}</dt>
                <dd className="break-words">{selectedRelation.basis || t("未记录")}</dd>
                <dt className="text-muted-foreground">{t("方向语义")}</dt>
                <dd className="space-y-1">
                  {isMutualRelation(selectedRelation) ? (
                    <>
                      <span className="block">
                        {nameOf(selectedRelation.fromId)} → {nameOf(selectedRelation.toId)}：
                        {t("已记录该方向的关系语义")}
                      </span>
                      <span className="block">
                        {nameOf(selectedRelation.toId)} → {nameOf(selectedRelation.fromId)}：
                        {t("同一条双向关系同时记录反向语义")}
                      </span>
                    </>
                  ) : (
                    <>
                      <span className="block">
                        {nameOf(selectedRelation.fromId)} → {nameOf(selectedRelation.toId)}：
                        {t("仅记录这一方向")}
                      </span>
                      <span className="block">
                        {nameOf(selectedRelation.toId)} → {nameOf(selectedRelation.fromId)}：
                        {t("未记录反向关系")}
                      </span>
                    </>
                  )}
                </dd>
                <dt className="text-muted-foreground">{t("创建于")}</dt>
                <dd>{new Date(selectedRelation.createdAt).toLocaleString()}</dd>
                <dt className="text-muted-foreground">{t("更新于")}</dt>
                <dd>
                  {new Date(
                    selectedRelation.updatedAt ?? selectedRelation.createdAt,
                  ).toLocaleString()}
                </dd>
                <dt className="text-muted-foreground">{t("确认状态")}</dt>
                <dd>
                  {selectedRelation.confirmationStatus === "pending" ? t("待确认") : t("已确认")}
                </dd>
                <dt className="text-muted-foreground">{t("证据模式")}</dt>
                <dd>
                  {relationEvidenceMode(selectedRelation) === "inferred"
                    ? t("推导关系")
                    : relationEvidenceMode(selectedRelation) === "explicit"
                      ? t("材料明确")
                      : t("旧数据待识别")}
                  {selectedRelation.confidence === undefined
                    ? ` · ${t("置信度未知")}`
                    : ` · ${Math.round(selectedRelation.confidence * 100)}%`}
                </dd>
                <dt className="text-muted-foreground">{t("证据引用")}</dt>
                <dd className="min-w-0">
                  {selectedEvidence ? (
                    <span className="block space-y-1">
                      <span className="block font-medium text-foreground">
                        {selectedEvidence.title}
                      </span>
                      {selectedEvidence.origin && (
                        <span className="block text-muted-foreground">
                          {t("来源")}：{selectedEvidence.origin}
                        </span>
                      )}
                      <span className="block break-words text-muted-foreground">
                        {selectedEvidence.text.slice(0, 240)}
                        {selectedEvidence.text.length > 240 ? "…" : ""}
                      </span>
                      <span className="block font-mono text-[9px] text-muted-foreground">
                        {selectedEvidence.id}
                      </span>
                    </span>
                  ) : (
                    selectedRelation.sourceId || t("未关联单独证据记录")
                  )}
                </dd>
              </dl>
              <div className="grid gap-2 border-t border-border pt-2 sm:grid-cols-2">
                <label className="space-y-1 text-[11px]">
                  <span className="text-muted-foreground">{t("关系图展示")}</span>
                  <select
                    value={selectedRelation.visibility ?? "auto"}
                    onChange={async (event) => {
                      await facesDb.putRelationViewPreference({
                        id: selectedRelation.id,
                        subjectId: selectedRelation.id,
                        visibility: event.target.value as NonNullable<RelationRecord["visibility"]>,
                        updatedAt: Date.now(),
                      });
                      await refresh();
                    }}
                    className="h-8 w-full rounded-md border border-border bg-background px-2"
                  >
                    <option value="always">{t("常显")}</option>
                    <option value="auto">{t("自动")}</option>
                    <option value="hidden">{t("常隐")}</option>
                  </select>
                </label>
                <label className="space-y-1 text-[11px]">
                  <span className="text-muted-foreground">{t("引荐推荐策略")}</span>
                  <select
                    value={selectedRelation.recommendationPolicy ?? "allow"}
                    onChange={async (event) => {
                      await facesDb.putReferralPolicy({
                        id: selectedRelation.id,
                        subjectId: selectedRelation.id,
                        policy: event.target.value as "allow" | "avoid" | "block",
                        direction: "both",
                        contexts: [],
                        updatedAt: Date.now(),
                      });
                      await refresh();
                    }}
                    className="h-8 w-full rounded-md border border-border bg-background px-2"
                  >
                    <option value="allow">{t("允许用于推荐")}</option>
                    <option value="avoid">{t("尽量避免")}</option>
                    <option value="block">{t("禁止用于推荐")}</option>
                  </select>
                </label>
              </div>
              {selectedRelation.note && (
                <p className="text-muted-foreground">{selectedRelation.note}</p>
              )}
              <SourceBadge source={selectedRelation.source} detailed />
            </div>
          )}

          <div
            ref={graphFrameRef}
            data-relation-graph-frame="true"
            className={cn(
              "relative overflow-hidden rounded-xl border border-border bg-muted/20",
              graphFullscreen
                ? "flex h-screen w-screen items-center rounded-none border-0 bg-background p-4"
                : "h-[clamp(20rem,46vh,32rem)]",
            )}
          >
            {relationComposerOpen && (
              <div className="pointer-events-none absolute left-3 top-3 z-20 flex max-w-[calc(100%-8rem)] items-center gap-2 rounded-full border border-primary/30 bg-background/90 px-3 py-1.5 text-[11px] shadow-sm backdrop-blur">
                <MousePointer2 className="size-3.5 shrink-0 text-primary" aria-hidden="true" />
                <span className="truncate">
                  {relationPick === "from"
                    ? t("请选择关系起点")
                    : fromId
                      ? `${t("起点")}：${nameOf(fromId)} · ${t("请选择关系终点")}`
                      : t("请选择关系终点")}
                </span>
              </div>
            )}
            <Button
              type="button"
              size="icon"
              variant="outline"
              className="absolute right-3 top-3 z-20 size-9 bg-background/90 shadow-sm backdrop-blur"
              onClick={() => void toggleGraphFullscreen()}
              aria-label={t(graphFullscreen ? "退出全屏" : "全屏查看关系图")}
              title={t(graphFullscreen ? "退出全屏" : "全屏查看关系图")}
            >
              {graphFullscreen ? (
                <Minimize2 className="size-4" aria-hidden="true" />
              ) : (
                <Maximize2 className="size-4" aria-hidden="true" />
              )}
            </Button>
            <svg
              ref={bindSvgRef}
              viewBox={`0 0 ${viewSize} ${viewSize}`}
              preserveAspectRatio="xMidYMid meet"
              className={cn(
                "h-full w-full touch-none select-none",
                relationComposerOpen ? "cursor-crosshair" : "cursor-grab active:cursor-grabbing",
                graphFullscreen && "max-h-[calc(100vh-2rem)]",
              )}
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
              <rect
                data-graph-background="true"
                x="0"
                y="0"
                width={viewSize}
                height={viewSize}
                fill="transparent"
                pointerEvents="all"
              />
              <g transform={`translate(${viewport.tx} ${viewport.ty}) scale(${viewport.scale})`}>
                {aggregateOverview &&
                  overviewGraph.edges.map((edge) => (
                    <g key={edge.id} pointerEvents="none">
                      <line
                        x1={edge.a!.x}
                        y1={edge.a!.y}
                        x2={edge.b!.x}
                        y2={edge.b!.y}
                        className="stroke-primary/40"
                        strokeWidth={Math.min(8, 1.5 + Math.log2(edge.relationCount + 1))}
                        strokeDasharray={edge.explicitCount === 0 ? "5 5" : undefined}
                      />
                      <text
                        x={(edge.a!.x + edge.b!.x) / 2}
                        y={(edge.a!.y + edge.b!.y) / 2 - 7}
                        textAnchor="middle"
                        className="fill-muted-foreground text-[11px]"
                      >
                        {edge.relationCount} {t("条跨社区关系")}
                      </text>
                    </g>
                  ))}

                {aggregateOverview &&
                  overviewGraph.nodes.map((node) => (
                    <g
                      key={node.id}
                      role="button"
                      tabIndex={0}
                      className="group cursor-pointer outline-none"
                      aria-label={`${node.label} · ${t("点击展开社区人物")}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        setDrill({
                          mode: "members",
                          key: node.label,
                          memberIds: node.memberIds,
                        });
                        resetView();
                      }}
                      onKeyDown={(event) => {
                        if (event.key !== "Enter" && event.key !== " ") return;
                        event.preventDefault();
                        setDrill({
                          mode: "members",
                          key: node.label,
                          memberIds: node.memberIds,
                        });
                        resetView();
                      }}
                    >
                      <title>{`${node.memberIds.length} ${t("人")} · ${node.internalRelationCount} ${t("条内部关系")} · ${t("点击展开")}`}</title>
                      <circle
                        cx={node.x}
                        cy={node.y}
                        r={node.r + 7}
                        style={{ fill: node.color.fill, stroke: node.color.stroke }}
                        strokeWidth={2}
                        strokeDasharray={node.isolated ? "5 5" : undefined}
                      />
                      <circle
                        cx={node.x}
                        cy={node.y}
                        r={node.r}
                        style={{ fill: node.color.node }}
                        className="transition-opacity group-hover:opacity-80 group-focus-visible:stroke-foreground"
                      />
                      <text
                        x={node.x}
                        y={node.y + 4}
                        textAnchor="middle"
                        className="fill-white text-[13px] font-semibold"
                      >
                        {node.memberIds.length}
                      </text>
                      <text
                        x={node.x}
                        y={node.y + node.r + 22}
                        textAnchor="middle"
                        className="fill-foreground text-[12px]"
                      >
                        {node.label}
                      </text>
                    </g>
                  ))}

                {!aggregateOverview &&
                  graph.clusters.map((cluster) => (
                    <g key={cluster.key}>
                      <path
                        d={cluster.path}
                        pointerEvents="none"
                        strokeWidth={1}
                        strokeDasharray="4 4"
                        style={{
                          fill: cluster.color.fill,
                          stroke: cluster.color.stroke,
                          transition: "d 260ms ease-out",
                        }}
                      />

                      <text
                        x={cluster.x}
                        y={cluster.y - cluster.r - 8}
                        textAnchor="middle"
                        role="button"
                        tabIndex={0}
                        className="cursor-pointer fill-primary text-[11px] font-medium underline-offset-2 hover:underline"
                        aria-label={`${t(
                          groupBy === "circles" ? "只看圈层" : "只看拓扑社区",
                        )}：${cluster.name}`}
                        onClick={() =>
                          setDrill({
                            mode: "members",
                            key: cluster.name,
                            memberIds: graph.nodes
                              .filter((node) => node.group === cluster.key)
                              .map((node) => node.id),
                          })
                        }
                        onKeyDown={(event) => {
                          if (event.key !== "Enter" && event.key !== " ") return;
                          event.preventDefault();
                          setDrill({
                            mode: "members",
                            key: cluster.name,
                            memberIds: graph.nodes
                              .filter((node) => node.group === cluster.key)
                              .map((node) => node.id),
                          });
                        }}
                      >
                        <title>
                          {t(groupBy === "circles" ? "点击只看这个圈层" : "点击只看这个拓扑社区")}
                        </title>

                        {cluster.name}
                      </text>
                    </g>
                  ))}

                {!aggregateOverview &&
                  relationComposerOpen &&
                  fromId &&
                  toId &&
                  (() => {
                    const from = graph.nodes.find((node) => node.id === fromId);
                    const to = graph.nodes.find((node) => node.id === toId);
                    if (!from || !to) return null;
                    return (
                      <g aria-hidden="true" className="pointer-events-none">
                        <line
                          x1={from.x}
                          y1={from.y}
                          x2={to.x}
                          y2={to.y}
                          className="stroke-primary"
                          strokeWidth={3}
                          strokeDasharray="8 6"
                          markerEnd="url(#relation-arrow)"
                          markerStart={
                            dirMode === "mutual" ||
                            (dirMode === "auto" && inferMutual(label.trim()))
                              ? "url(#relation-arrow-start)"
                              : undefined
                          }
                        />
                      </g>
                    );
                  })()}

                {!aggregateOverview &&
                  graph.edges.map((edge) => {
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
                      !selectedId ||
                      (graphVisibility.focusNodeIds.has(edge.a!.id) &&
                        graphVisibility.focusNodeIds.has(edge.b!.id));
                    return (
                      <g
                        key={edge.id}
                        role="button"
                        tabIndex={0}
                        data-relation-id={edge.id}
                        data-evidence-mode={edge.evidenceMode}
                        data-supporting-relation-ids={edge.supportingRelationIds.join(",")}
                        opacity={relationComposerOpen ? 0.18 : active ? 1 : 0.12}
                        className="cursor-pointer outline-none"
                        aria-label={`${t("查看关系详情")}：${edge.a!.name} ${edge.mutual ? "⇄" : "→"} ${edge.b!.name} · ${edge.label}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          setSelectedRelationId(edge.id);
                        }}
                        onKeyDown={(event) => {
                          if (event.key !== "Enter" && event.key !== " ") return;
                          event.preventDefault();
                          event.stopPropagation();
                          setSelectedRelationId(edge.id);
                        }}
                      >
                        <title>{`${edge.label} · ${t("点击查看来源、时间与确认状态")}`}</title>
                        <path
                          d={`M ${x1} ${y1} Q ${cx} ${cy} ${x2} ${y2}`}
                          fill="none"
                          stroke="transparent"
                          strokeWidth={20}
                          pointerEvents="stroke"
                          aria-hidden="true"
                        />
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
                          strokeWidth={
                            selectedRelationId === edge.id ? 3 : selectedId && active ? 2 : 1.5
                          }
                          strokeDasharray={
                            edge.evidenceMode === "inferred" ||
                            edge.confirmationStatus === "pending"
                              ? "3 4"
                              : edge.cross
                                ? "5 4"
                                : undefined
                          }
                          markerEnd="url(#relation-arrow)"
                          markerStart={edge.mutual ? "url(#relation-arrow-start)" : undefined}
                        />

                        {(showEdgeLabels ||
                          selectedRelationId === edge.id ||
                          (selectedId && active)) && (
                          <>
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
                          </>
                        )}
                      </g>
                    );
                  })}
                {!aggregateOverview &&
                  graph.nodes.map((node) => {
                    const linked =
                      relationComposerOpen ||
                      !selectedId ||
                      graphVisibility.focusNodeIds.has(node.id);
                    const isRelationFrom = relationComposerOpen && node.id === fromId;
                    const isRelationTo = relationComposerOpen && node.id === toId;
                    const visuallySelected =
                      node.id === selectedId || isRelationFrom || isRelationTo;
                    return (
                      <g
                        key={node.id}
                        role="button"
                        tabIndex={0}
                        data-person-id={node.id}
                        data-person-name={node.name}
                        aria-label={`${node.name} · ${t(
                          relationComposerOpen
                            ? "点击选择为关系起点或终点"
                            : "单击聚焦，拖动可移动，双击开人物卡",
                        )}`}
                        opacity={linked ? 1 : 0.25}
                        className={cn(
                          "group outline-none",
                          relationComposerOpen
                            ? "cursor-crosshair"
                            : "cursor-grab active:cursor-grabbing",
                        )}
                        onPointerDown={(event) => onNodePointerDown(event, node)}
                        onPointerMove={onNodePointerMove}
                        onPointerUp={onNodePointerUp}
                        onPointerCancel={() => {
                          dragRef.current = null;
                        }}
                        onKeyDown={(event) => {
                          if (event.key !== "Enter" && event.key !== " ") return;
                          event.preventDefault();
                          activateNode(node.id);
                        }}
                      >
                        <title>{`${node.name} · ${t(
                          relationComposerOpen
                            ? "点击选择为关系起点或终点"
                            : "单击聚焦，拖动可移动，双击开人物卡",
                        )}`}</title>
                        <circle cx={node.x} cy={node.y} r={22} className="fill-transparent" />
                        {(isRelationFrom || isRelationTo) && (
                          <circle
                            cx={node.x}
                            cy={node.y}
                            r={24}
                            fill="none"
                            className="stroke-primary"
                            strokeWidth={2.5}
                            strokeDasharray={isRelationFrom ? undefined : "4 3"}
                          />
                        )}
                        <circle
                          cx={node.x}
                          cy={node.y}
                          r={visuallySelected ? 19 : 16}
                          className={cn(
                            "transition-opacity group-hover:opacity-80 group-focus-visible:stroke-foreground",
                            visuallySelected && "stroke-foreground",
                          )}
                          style={{ fill: node.color.node }}
                          strokeWidth={visuallySelected ? 2.5 : 2}
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

                {!aggregateOverview && !graph.nodes.length && (
                  <text
                    x={viewSize / 2}
                    y={viewSize / 2}
                    textAnchor="middle"
                    className="fill-muted-foreground text-xs"
                  >
                    {t("还没有任何人物档案")}
                  </text>
                )}
              </g>
            </svg>
          </div>

          {relations.length > 0 && (
            <details className="rounded-xl border border-border bg-muted/10">
              <summary className="cursor-pointer px-3 py-2 text-xs font-medium">
                {t("完整关系列表")} · {relations.length}
              </summary>
              <ul className="max-h-80 space-y-1.5 overflow-y-auto border-t border-border p-2">
                {relations.map((relation) => (
                  <li
                    key={relation.id}
                    className="flex items-center justify-between gap-2 rounded-lg border border-border px-3 py-2 text-xs"
                  >
                    <span className="flex min-w-0 items-center gap-1.5 truncate">
                      <span className="truncate">{nameOf(relation.fromId)}</span>
                      <span
                        title={t("方向由关系本体决定；修改关系语义会生成新的事实版本")}
                        className="shrink-0 text-primary"
                      >
                        {isMutualRelation(relation) ? (
                          <ArrowLeftRight className="size-3.5" aria-hidden="true" />
                        ) : (
                          <ArrowRight className="size-3.5" aria-hidden="true" />
                        )}
                      </span>
                      <span className="shrink-0 text-primary">{relation.label}</span>
                      {isMutualRelation(relation) ? (
                        <ArrowLeftRight
                          className="size-3.5 shrink-0 text-primary"
                          aria-hidden="true"
                        />
                      ) : (
                        <ArrowRight className="size-3.5 shrink-0 text-primary" aria-hidden="true" />
                      )}
                      <span className="truncate">{nameOf(relation.toId)}</span>
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      <SourceBadge source={relation.source} />
                      <span
                        className={cn(
                          "rounded-full px-2 py-0.5 text-[10px]",
                          relation.confirmationStatus === "pending"
                            ? "bg-amber-500/10 text-amber-700 dark:text-amber-300"
                            : "bg-primary/10 text-primary",
                        )}
                        title={`${t("创建于")} ${new Date(relation.createdAt).toLocaleString()} · ${t("更新于")} ${new Date(relation.updatedAt ?? relation.createdAt).toLocaleString()}`}
                      >
                        {relation.confirmationStatus === "pending" ? t("待确认") : t("已确认")}
                      </span>
                      {relation.confirmationStatus === "pending" && (
                        <button
                          type="button"
                          className="text-primary underline-offset-2 hover:underline"
                          onClick={async () => {
                            const assertion = (await facesDb.listRelationAssertions()).find(
                              (item) => item.id === relation.id,
                            );
                            if (!assertion) {
                              toast.error(t("只能确认事实关系；推导关系由规则自动重算"));
                              return;
                            }
                            await facesDb.putRelationAssertion({
                              ...assertion,
                              confirmationStatus: "confirmed",
                              updatedAt: Date.now(),
                            });
                            await refresh();
                          }}
                        >
                          {t("确认")}
                        </button>
                      )}
                      <button
                        type="button"
                        className="text-primary underline-offset-2 hover:underline"
                        onClick={() => setSelectedRelationId(relation.id)}
                      >
                        {t("详情")}
                      </button>
                      {relation.recordType === "derived" ? (
                        <button
                          type="button"
                          className="text-muted-foreground hover:text-primary"
                          title={t("推导关系不能删除；可隐藏投影或修改支持事实")}
                          onClick={async () => {
                            await facesDb.putRelationViewPreference({
                              id: relation.id,
                              subjectId: relation.id,
                              visibility: "hidden",
                              updatedAt: Date.now(),
                            });
                            await refresh();
                          }}
                        >
                          {t("隐藏")}
                        </button>
                      ) : (
                        <button
                          type="button"
                          aria-label={t("删除事实关系")}
                          className="text-muted-foreground transition-colors hover:text-destructive"
                          onClick={async () => {
                            if (
                              !window.confirm(
                                t("删除这条事实关系后，相关推导关系会自动重算。继续吗？"),
                              )
                            )
                              return;
                            await facesDb.deleteRelationAssertion(relation.id);
                            if (selectedRelationId === relation.id) setSelectedRelationId(null);
                            await refresh();
                          }}
                        >
                          <Trash2 className="size-3.5" aria-hidden="true" />
                        </button>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </TabsContent>
      </Tabs>

      <PersonProfileDialog
        person={editing}
        preset={preset}
        collections={collections}
        collectionMemberships={collectionMemberships}
        onClose={() => setEditing(null)}
        onSaved={refresh}
      />

      <TagGroupDialog
        tag={openCollection?.name ?? null}
        members={tagMembers}
        candidates={tagCandidates}
        onOpenChange={(open) => setTagOpen(open ? tagOpen : null)}
        onRename={renameTagGroup}
        onAddMember={addPersonToTag}
        onRemoveMember={removePersonFromTag}
        onOpenPerson={(person) => {
          setTagOpen(null);
          setEditing(person);
        }}
      />
    </section>
  );
}
