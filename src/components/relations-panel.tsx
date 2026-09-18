import {
  ArrowLeftRight,
  ArrowRight,
  Check,
  CircleHelp,
  Loader2,
  Maximize2,
  Minimize2,
  MousePointer2,
  Network,
  Plus,
  Search,
  Tag,
  Trash2,
  UserPlus,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import peopleEmptyArt from "@/assets/art/web/people-empty.webp";

import { ExportMenu } from "@/components/export-menu";
import { HelpHint } from "@/components/help-hint";
import { MarkdownView } from "@/components/markdown-view";
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
  DEFAULT_RELATION_GRAPH_GROUPING,
  loadRelationGraphGrouping,
  saveRelationGraphGrouping,
  type RelationGraphGroupingMode,
} from "@/lib/relation-graph-grouping";
import { buildCircleMembershipProjection } from "@/lib/circle-membership-projection";
import {
  DEFAULT_GRAPH_LAYOUT_VERSION,
  loadGraphLayoutVersion,
  saveGraphLayoutVersion,
  type GraphLayoutVersion,
} from "@/lib/graph-layout-version";
import {
  blobPathFor,
  buildCircleLayoutProjection,
  layoutRingGraph,
} from "@/lib/relation-graph-legacy";
import { buildSetContours, CONTOUR_PADDING } from "@/lib/set-contours";
import {
  GRAPH_ASPECT_BY_CLASS,
  applyGraphPins,
  graphAspectClass,
  layoutRelationGraph,
  type GraphAspectClass,
} from "@/lib/relation-graph-layout";
import {
  DEFAULT_FIT_PADDING,
  absoluteZoomLimits,
  boundsOfPoints,
  fitCamera,
  panCamera,
  screenPoint,
  screenToWorldLength,
  unionBounds,
  worldPoint,
  zoomCamera,
  type GraphBounds,
  type GraphCamera,
} from "@/lib/graph-camera";
import { createTextMeasurer, placeScreenLabels, type ScreenRect } from "@/lib/graph-labels";
import {
  buildFamilyTreeLayout,
  familyTreeEdgeKind,
  isFamilyTreeRelation,
} from "@/lib/family-tree-layout";
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
import { getLang, t, tFormat } from "@/lib/i18n";
import { PersonAvatar } from "@/components/person-avatar";
import { AskForHelpPanel } from "@/components/ask-for-help-panel";
import { cn } from "@/lib/utils";
import type { ProviderPreset } from "@/lib/vision-providers";

interface Props {
  preset: ProviderPreset;
  active?: boolean;
  onOpenEvent?: (eventId: string) => void;
  onOpenReminder?: (reminderId: string) => void;
  onPrepareMeeting?: (personId: string) => void;
  focusPersonId?: string;
  focusRelationId?: string;
  focusRelationPersonId?: string;
  /** 「找人办事」里最近一次 AI 分析运行的定位。 */
  focusRunId?: string;
  focusNonce?: number;
}

type GraphDrill =
  | { mode: "blocks" }
  | { mode: "group"; key: string }
  | { mode: "members"; key: string; memberIds: string[] };

type GraphLayoutMode = "auto" | "network" | "family";

/**
 * 用户看到一个「布局」下拉框，背后仍是两个互斥状态：
 * 自动/不分组/家族树管整体画法，圈层和拓扑社区是分组方式。
 * 单独保留它们是为了让「自动布局」在纯亲属数据上还能自己切家族树。
 */
type GraphLayoutChoice = "auto" | "none" | "circles" | "communities" | "family";

const DEFAULT_RELATION_LABELS = ["朋友", "同事", "同学", "亲属", "夫妻", "合作伙伴"];

/** 图上要画的一个成员集合（圈层或拓扑社区） */
interface GraphGroupShape {
  id: string;
  name: string;
  color: ReturnType<typeof graphColor>;
  memberIds: string[];
  fragments: Array<{ path: string; kind: string; memberIds: string[] }>;
  /** 包络是否通过「成员在内、非成员在外」的校验 */
  valid: boolean;
  /** 集合标题的落点（成员里最靠上的那个） */
  labelX: number;
  labelY: number;
  /** 轮廓顶端的编号徽标位置：标题放不下时，靠它和「真实交集」列表对照 */
  badgeX: number;
  badgeY: number;
  /** 图例里的编号 */
  index: number;
  /** legacy = 原版的流动外形；contour = 新版校验过的成员包络 */
  variant: "legacy" | "contour";
}

/** 屏幕标签的字体栈，和画布本身的字体保持一致，测量才准。 */
const GRAPH_LABEL_FONT =
  'system-ui, -apple-system, "Segoe UI", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif';

/** 节点圆的屏幕半径范围：缩得再小也留有可点面积，放得再大也不会压过名字。 */
const NODE_SCREEN_RADIUS_RANGE = { min: 7, max: 26 } as const;
const NODE_WORLD_RADIUS = 16;
/** 包络的扩张半径：等于「去掉成员符号后留出的余量」 */
const CONTOUR_STROKE_PADDING = NODE_WORLD_RADIUS + CONTOUR_PADDING;

function graphColor(key: string) {
  let hash = 0;
  for (const char of key) hash = (hash * 31 + char.charCodeAt(0)) % 360;
  return colorForHue(hash);
}

function colorForHue(hue: number) {
  return {
    node: `hsl(${hue} 62% 48%)`,
    fill: `hsl(${hue} 62% 48% / 0.09)`,
    stroke: `hsl(${hue} 62% 48% / 0.42)`,
  };
}

/** 家族树按世代换色。相邻世代至少差 40° 色相，看颜色就知道谁跟谁同辈。 */
const GENERATION_HUES = [212, 268, 152, 32, 318, 96, 186, 6];

/**
 * 圈层配色按稳定顺序取色相。用 ID 哈希会在相邻 ID 上撞成一色，
 * 而圈层正是最需要一眼分开的一组。
 */
const GROUP_HUES = [28, 208, 168, 340, 262, 88, 12, 190, 310];

function groupColor(index: number) {
  return colorForHue(GROUP_HUES[index % GROUP_HUES.length]);
}

function generationColor(generation: number) {
  const index =
    ((generation % GENERATION_HUES.length) + GENERATION_HUES.length) % GENERATION_HUES.length;
  return colorForHue(GENERATION_HUES[index]);
}

/** 助手把档案依据、待确认项和正文拼在一条回答里；界面只留正文，其余折进「展开」。 */
function splitAssistantAnswer(text: string) {
  const marker = "AI 生成内容（请注意辨别）";
  const index = text.lastIndexOf(marker);
  if (index < 0) return { main: text, detail: "" };
  return {
    detail: text.slice(0, index).trim(),
    main: text.slice(index + marker.length).trim(),
  };
}

export function RelationsPanel({
  preset,
  active = true,
  onOpenEvent,
  onOpenReminder,
  onPrepareMeeting,
  focusPersonId,
  focusRelationId,
  focusRelationPersonId,
  focusRunId,
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
  const [graphLayoutMode, setGraphLayoutMode] = useState<GraphLayoutMode>("auto");
  const [layoutHelpOpen, setLayoutHelpOpen] = useState(false);
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
  /**
   * 画布相机：世界坐标 → 屏幕坐标。viewBox 直接用容器的 CSS 像素尺寸，
   * 于是画布单位就是屏幕单位，文字用固定 CSS px 绘制，不再跟着世界缩放变小。
   */
  const [viewport, setViewport] = useState<GraphCamera>({ scale: 1, x: 0, y: 0 });
  /** 容器尺寸（CSS px），由 ResizeObserver 维护 */
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const viewportSizeRef = useRef(viewportSize);
  viewportSizeRef.current = viewportSize;
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;
  /** 上一次「适应内容」的倍率，用于把缩放显示成相对百分比并约束 0.4×–4× */
  const fitScaleRef = useRef(1);
  /** 上一次每个名字命中的候选位置，用于平移缩放时的位置延续 */
  const labelCandidatesRef = useRef<Record<string, number>>({});
  const [labelScale, setLabelScale] = useState(() => {
    try {
      const stored = Number(window.localStorage.getItem("zhimai:graph-label-scale"));
      return Number.isFinite(stored) ? Math.min(1.6, Math.max(0.8, stored)) : 1;
    } catch {
      return 1;
    }
  });
  const [graphFullscreen, setGraphFullscreen] = useState(false);
  /**
   * 布局版本：默认原版（组合簇 + 环套环），新版还在验证阶段，开关放在图工具栏里。
   */
  const [layoutVersion, setLayoutVersion] = useState<GraphLayoutVersion>(() => {
    try {
      return loadGraphLayoutVersion(window.localStorage);
    } catch {
      return DEFAULT_GRAPH_LAYOUT_VERSION;
    }
  });
  useEffect(() => {
    try {
      saveGraphLayoutVersion(window.localStorage, layoutVersion);
    } catch {
      // 无痕模式下不记忆选择，本次会话照常生效。
    }
  }, [layoutVersion]);
  /**
   * 横屏 / 竖屏是两套确定的布局类别：首次测量时定下来，之后旋转窗口只调整镜头，
   * 由用户主动「重新布局」才切换几何。
   */
  const [layoutAspectClass, setLayoutAspectClass] = useState<GraphAspectClass>("wide");
  const layoutAspectClassRef = useRef<GraphAspectClass | null>(null);
  const layoutAspect = GRAPH_ASPECT_BY_CLASS[layoutAspectClass];
  const graphFrameRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const wheelListenerRef = useRef<((event: WheelEvent) => void) | null>(null);
  const pinchRef = useRef<{
    pointers: Map<number, { x: number; y: number }>;
    startDistance: number;
    startScale: number;
    startTx: number;
    startTy: number;
  } | null>(null);
  const lastPrimaryPointerRef = useRef<{ x: number; y: number } | null>(null);
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
  const measureTextWidth = useRef(createTextMeasurer(GRAPH_LABEL_FONT)).current;

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
    if (active) void refresh();
  }, [active, refresh]);

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
            : "请通读本机全部档案，用普通人看得懂的话写一份关系概览。用 Markdown 输出：用「### 」小标题分四段（整体结构 / 每个人值得记住的信息 / 谁把小圈子连起来 / 还缺什么），每段用「- 」列条目，不要把所有内容挤成一段。只依据档案里已有的内容作答，不要下没有依据的结论，也不要使用「拓扑社区」这类术语。",
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

  /** Only offer tags actually present; circle membership has its own shared filter. */
  const allTags = useMemo(() => {
    const set = new Set<string>();
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
      if (
        collectionFilterId &&
        !collectionMemberships.some(
          (membership) =>
            membership.collectionId === collectionFilterId && membership.personId === person.id,
        )
      )
        return false;
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
  }, [people, query, filterTags, collectionFilterId, collectionMemberships]);

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
  /**
   * 圈层成员投影：一个人可以属于多个圈层，交集直接查成员表。
   * 这是关系网布局、包络和图例的唯一事实入口，不写回档案。
   */
  const circleProjection = useMemo(
    () => buildCircleMembershipProjection(people, collections, collectionMemberships),
    [people, collections, collectionMemberships],
  );
  /** 原版显示链路用的组合簇投影（一个人多归属时合成一个稳定组合） */
  const legacyCircleProjection = useMemo(
    () => buildCircleLayoutProjection(people, collections, collectionMemberships, t("未分圈层")),
    [people, collections, collectionMemberships],
  );
  /** 拓扑社区是互斥分区，只在“按拓扑社区”这一档里当成员集合用 */
  const layoutGroupOf = useCallback(
    (person: PersonRecord) => {
      if (groupBy === "communities") {
        const communityId = communityByPersonId.get(person.id) ?? `community:person:${person.id}`;
        return {
          key: communityId,
          label: communityNames.get(communityId) ?? t("未连接"),
        };
      }
      return { key: "", label: "" };
    },
    [communityByPersonId, communityNames, groupBy],
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

  const familyTreeRelations = useMemo(
    () => graphVisibility.visible.filter(isFamilyTreeRelation),
    [graphVisibility.visible],
  );
  const familyOnly =
    graphVisibility.visible.length > 0 &&
    familyTreeRelations.length === graphVisibility.visible.length;
  const showFamilyTree =
    graphLayoutMode === "family" ||
    (graphLayoutMode === "auto" &&
      familyOnly &&
      familyTreeRelations.some((relation) =>
        ["parent", "spouse"].includes(familyTreeEdgeKind(relation) ?? ""),
      ));
  const familyTree = useMemo(
    () =>
      buildFamilyTreeLayout({
        people: visiblePeople,
        relations: familyTreeRelations,
      }),
    [familyTreeRelations, visiblePeople],
  );

  /**
   * Above this size, overview is a community map. It is a reversible visual
   * projection: clicking a community drills into the exact member ids.
   */
  const aggregateOverview =
    graphViewMode === "overview" &&
    groupBy === "communities" &&
    drill.mode === "blocks" &&
    visiblePeople.length > 60 &&
    !showFamilyTree;
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
    const bounds = unionBounds(
      nodes.map((node) => ({
        x: node.x - node.r,
        y: node.y - node.r,
        width: node.r * 2,
        height: node.r * 2,
      })),
    );
    return { size, nodes, edges, bounds };
  }, [communityOverview, people]);

  /**
   * 当前要画的成员集合：圈层用真实的多重成员，拓扑社区是互斥分区，不分组时为空。
   * 一个人可以同时出现在多个集合里，但永远只有一个节点。
   */
  const graphPeople = useMemo(
    () => (aggregateOverview ? [] : visiblePeople),
    [aggregateOverview, visiblePeople],
  );
  const graphGroups = useMemo(() => {
    const visibleIds = new Set(graphPeople.map((person) => person.id));
    return (
      groupBy === "circles"
        ? circleProjection.circles.map((circle) => ({
            id: circle.id,
            name: circle.name,
            memberIds: circle.memberIds,
          }))
        : groupBy === "communities"
          ? relationCommunities.map((community) => ({
              id: community.id,
              name: communityNames.get(community.id) ?? t("未连接"),
              memberIds: community.memberIds,
            }))
          : []
    )
      .map((group) => ({
        ...group,
        memberIds: group.memberIds.filter((personId) => visibleIds.has(personId)),
      }))
      .filter((group) => group.memberIds.length > 0)
      .map((group, index) => ({ ...group, color: groupColor(index) }));
  }, [circleProjection.circles, communityNames, graphPeople, groupBy, relationCommunities]);

  /**
   * 几何弹簧用的连接：用过滤后的关系，不用「当前可见」的关系。
   * 否则点一个节点就会改变可见集合，整个图跟着重排。
   */
  const graphSprings = useMemo(
    () =>
      policyFilteredRelations.map(
        (relation) => [relation.fromId, relation.toId] as [string, string],
      ),
    [policyFilteredRelations],
  );

  /** 自动几何：只在数据、成员集合、关系和布局类别变化时重算；拖动不走这里。 */
  const baseLayout = useMemo(
    () =>
      layoutRelationGraph(
        graphPeople.map((person) => ({ id: person.id })),
        {
          groups: graphGroups.map((group) => ({ id: group.id, memberIds: group.memberIds })),
          links: graphSprings,
          aspect: layoutAspect,
        },
      ),
    [graphGroups, graphPeople, graphSprings, layoutAspect],
  );

  /** 关系网布局：默认一个大圆；按标签分组时每个圈层自成一簇。 */
  const graph = useMemo(() => {
    if (showFamilyTree && familyTree.nodes.length > 0) {
      const nodes = familyTree.nodes.map((node) => ({
        ...node,
        ...(positions[node.id] ?? {}),
        group: "",
        groupIds: [] as string[],
        ringColors: [] as string[],
        color: generationColor(node.generation),
        variant: "legacy" as const,
      }));
      // Nodes, edges and labels must all use the same final drag coordinates.
      const nodeById = new Map(nodes.map((node) => [node.id, node]));
      const relationById = new Map(familyTreeRelations.map((relation) => [relation.id, relation]));
      const edges = familyTree.edges
        .map((edge) => {
          const relation = relationById.get(edge.relationId);
          const a = nodeById.get(edge.fromId);
          const b = nodeById.get(edge.toId);
          if (!relation || !a || !b) return null;
          return {
            id: relation.id,
            label: relation.label,
            mutual: isMutualRelation(relation),
            evidenceMode: relationEvidenceMode(relation),
            supportingRelationIds:
              relation.supportingRelationIds ?? relation.derivedFromRelationIds ?? [],
            confirmationStatus: relation.confirmationStatus ?? "confirmed",
            visibility: relation.visibility ?? "auto",
            cross: false,
            pair: [relation.fromId, relation.toId].sort().join("|"),
            familyKind: edge.kind,
            a,
            b,
            lx: (a.x + b.x) / 2,
            ly: (a.y + b.y) / 2 - 8,
            lw: Math.max(relation.label.length * 6.4 + 12, 22),
          };
        })
        .filter((edge): edge is NonNullable<typeof edge> => Boolean(edge));
      return {
        size: familyTree.size,
        nodes,
        edges,
        groups: [] as GraphGroupShape[],
        bounds: boundsOfPoints(nodes, 46),
      };
    }

    // In aggregate overview mode the community projection below is the only
    // graph we need. Avoid the quadratic edge-label placement work for a dense
    // 200-person graph that will not be rendered.
    const people = graphPeople;
    const activeGroups = graphGroups;
    const colorByGroupId = new Map(activeGroups.map((group) => [group.id, group]));
    const personById = new Map(people.map((person) => [person.id, person]));

    type Node = {
      id: string;
      x: number;
      y: number;
      name: string;
      /** 第一个所属集合，用于连线判断与降级配色 */
      group: string;
      /** 这个人所属的全部集合；圈层可以重叠，所以这里是一个数组 */
      groupIds: string[];
      color: ReturnType<typeof graphColor>;
      /** 多归属时按所属集合画出的环形色段 */
      ringColors: string[];
      /** legacy = 原版的实心点；contour = 新版的多归属色环 + 校验过的包络 */
      variant: "legacy" | "contour";
    };

    /** 新版：多重成员 + 确定性紧凑布局 + 校验过的包络 */
    const buildCompactGeometry = () => {
      const groupIdsByPersonId = new Map(
        people.map((person) => [
          person.id,
          activeGroups
            .filter((group) => group.memberIds.includes(person.id))
            .map((group) => group.id),
        ]),
      );

      // 拖动只覆盖坐标：自动几何在 baseLayout 里已经算完，不必重跑迭代。
      const layout = applyGraphPins(baseLayout, positions);

      const compactNodes: Node[] = [];
      for (const placement of layout.nodes) {
        const person = personById.get(placement.id);
        if (!person) continue;
        const groupIds = groupIdsByPersonId.get(placement.id) ?? [];
        compactNodes.push({
          id: person.id,
          name: person.name,
          x: placement.x,
          y: placement.y,
          group: groupIds[0] ?? "",
          groupIds,
          color: colorByGroupId.get(groupIds[0])?.color ?? graphColor("all"),
          ringColors: groupIds
            .map((groupId) => colorByGroupId.get(groupId)?.color.node)
            .filter((color): color is string => Boolean(color)),
          variant: "contour",
        });
      }

      // 包络只由「成员是谁」和「当前坐标」决定；拖动任何一个人都会重新校验。
      const contourById = new Map(
        buildSetContours(
          activeGroups.map((group) => ({ id: group.id, memberIds: group.memberIds })),
          compactNodes.map((node) => ({ id: node.id, x: node.x, y: node.y })),
          { nodeRadius: NODE_WORLD_RADIUS },
        ).map((contour) => [contour.id, contour]),
      );
      const compactNodeById = new Map(compactNodes.map((node) => [node.id, node]));
      const compactGroups: GraphGroupShape[] = activeGroups.map((group, index) => {
        const members = group.memberIds
          .map((personId) => compactNodeById.get(personId))
          .filter((node): node is Node => Boolean(node));
        const top = members.reduce<Node | null>(
          (highest, node) => (!highest || node.y < highest.y ? node : highest),
          null,
        );
        return {
          id: group.id,
          name: group.name,
          color: group.color,
          memberIds: group.memberIds,
          fragments: contourById.get(group.id)?.fragments ?? [],
          valid: contourById.get(group.id)?.valid ?? true,
          labelX: top?.x ?? 0,
          labelY: (top?.y ?? 0) - NODE_WORLD_RADIUS - 10,
          badgeX: top?.x ?? 0,
          badgeY: (top?.y ?? 0) - CONTOUR_STROKE_PADDING - 4,
          index: index + 1,
          variant: "contour",
        };
      });
      return { nodes: compactNodes, groups: compactGroups, bounds: baseLayout.bounds };
    };

    /** 原版：成员组合分区 + 环套环 + 跟着成员流动的不规则外形 */
    const buildLegacyGeometry = () => {
      const groupOf = (person: PersonRecord) => {
        if (groupBy === "circles") {
          const group = legacyCircleProjection.groupByPersonId.get(person.id);
          return group ?? { key: "circles:none", label: t("未分圈层") };
        }
        return layoutGroupOf(person);
      };
      const groupBuckets =
        groupBy === "none"
          ? []
          : [
              ...new Map(
                people.map((person) => {
                  const group = groupOf(person);
                  return [group.key, { key: group.key, label: group.label }] as const;
                }),
              ).values(),
            ];
      const ring = layoutRingGraph(
        people.map((person) => ({
          id: person.id,
          groupKey: groupBy === "none" ? "" : groupOf(person).key,
        })),
        groupBuckets,
      );

      const legacyNodes: Node[] = [];
      for (const placement of ring.nodes) {
        const person = personById.get(placement.id);
        if (!person) continue;
        const moved = positions[placement.id];
        legacyNodes.push({
          id: person.id,
          name: person.name,
          x: moved?.x ?? placement.x,
          y: moved?.y ?? placement.y,
          group: placement.groupKey,
          groupIds: placement.groupKey ? [placement.groupKey] : [],
          color: graphColor(placement.groupKey || "all"),
          ringColors: [],
          variant: "legacy",
        });
      }

      // 原版把簇心重新按成员实际落点算过，拖动之后外形跟着走。
      const legacyNodeById = new Map(legacyNodes.map((node) => [node.id, node]));
      const legacyGroups: GraphGroupShape[] = ring.clusters.map((cluster, index) => {
        const members = legacyNodes.filter((node) => node.group === cluster.key);
        const cx = members.reduce((sum, node) => sum + node.x, 0) / Math.max(1, members.length);
        const cy = members.reduce((sum, node) => sum + node.y, 0) / Math.max(1, members.length);
        const radius = Math.max(
          86,
          ...members.map((node) => Math.hypot(node.x - cx, node.y - cy) + 52),
        );
        const top = members.reduce<Node | null>(
          (highest, node) => (!highest || node.y < highest.y ? node : highest),
          null,
        );
        const memberIds = members.map((node) => node.id);
        return {
          id: cluster.key,
          name: cluster.label,
          color: graphColor(cluster.key),
          memberIds,
          fragments: [
            {
              path: blobPathFor(cx, cy, radius * 1.08, cluster.key, members),
              kind: "hull" as const,
              memberIds,
              points: members.map((node) => ({ x: node.x, y: node.y })),
            },
          ],
          valid: true,
          labelX: top?.x ?? cx,
          labelY: (top?.y ?? cy) - NODE_WORLD_RADIUS - 10,
          badgeX: top?.x ?? cx,
          badgeY: (top?.y ?? cy) - CONTOUR_STROKE_PADDING - 4,
          index: index + 1,
          variant: "legacy",
        };
      });
      return {
        nodes: legacyNodes,
        groups: legacyGroups,
        bounds: boundsOfPoints(legacyNodes, 74),
      };
    };

    const geometry = layoutVersion === "legacy" ? buildLegacyGeometry() : buildCompactGeometry();
    const nodes = geometry.nodes;
    const groups = geometry.groups;

    const map = new Map(nodes.map((node) => [node.id, node]));

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
          /** 跨集合的连线用虚线标出来：两端没有共同归属才算跨 */
          cross:
            !!a &&
            !!b &&
            !!a.groupIds.length &&
            !!b.groupIds.length &&
            !a.groupIds.some((groupId) => b.groupIds.includes(groupId)),
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

    return { size: 0, nodes, edges: labelled, groups, bounds: geometry.bounds };
  }, [
    aggregateOverview,
    baseLayout,
    familyTree,
    familyTreeRelations,
    graphGroups,
    graphPeople,
    graphVisibility.visible,
    groupBy,
    layoutGroupOf,
    layoutVersion,
    legacyCircleProjection,
    positions,
    showFamilyTree,
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

  /** 当前要显示的内容边界：自动适应用；概览图有自己的矩形。 */
  const contentBounds = aggregateOverview ? overviewGraph.bounds : graph.bounds;

  /** 容器尺寸变化时重新测量；viewBox 用 CSS 像素，画布单位就等于屏幕单位。
   * 用回调 ref 而不是 useEffect：关系网所在的页签是按下才挂载的，effect 的依赖不会变。 */
  const frameObserverRef = useRef<ResizeObserver | null>(null);
  const bindGraphFrameRef = useCallback((node: HTMLDivElement | null) => {
    graphFrameRef.current = node;
    frameObserverRef.current?.disconnect();
    frameObserverRef.current = null;
    if (!node) return;
    const measure = () => {
      const width = node.clientWidth;
      const height = node.clientHeight;
      if (width <= 0 || height <= 0) return;
      setViewportSize((prev) =>
        prev.width === width && prev.height === height ? prev : { width, height },
      );
      // 只在第一次测量时决定布局类别，避免拉一下窗口就全体重排。
      if (layoutAspectClassRef.current === null) {
        const next = graphAspectClass(width, height);
        layoutAspectClassRef.current = next;
        setLayoutAspectClass(next);
      }
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    frameObserverRef.current = observer;
  }, []);

  const fitToContent = useCallback(
    (bounds: GraphBounds = contentBounds) => {
      const { width, height } = viewportSizeRef.current;
      const camera = fitCamera(bounds, width, height, DEFAULT_FIT_PADDING);
      if (!camera) return;
      fitScaleRef.current = camera.scale;
      setViewport(camera);
    },
    [contentBounds],
  );

  // 布局（数据、筛选、布局模式）变化后自动适应内容，与旧版“viewBox 就是整张世界”的行为对齐。
  const layoutBoundsKey = `${Math.round(contentBounds.x)}:${Math.round(contentBounds.y)}:${Math.round(
    contentBounds.width,
  )}:${Math.round(contentBounds.height)}`;
  useEffect(() => {
    if (!viewportSize.width || !viewportSize.height) return;
    fitToContent();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutBoundsKey, viewportSize.width, viewportSize.height]);

  const zoomBy = (factor: number, anchor?: { x: number; y: number }) => {
    const { width, height } = viewportSizeRef.current;
    const limits = absoluteZoomLimits(fitScaleRef.current);
    setViewport((prev) =>
      zoomCamera(prev, factor, anchor ?? { x: width / 2, y: height / 2 }, limits),
    );
  };

  /** 相机逆变换：屏幕增量 → 世界增量 */
  const toWorldLength = (screenLength: number) =>
    screenToWorldLength(screenLength, viewportRef.current);

  const resetView = useCallback(() => fitToContent(), [fitToContent]);

  /**
   * 节点圆的屏幕半径被限制在一个区间里：缩得太小会点不中，放得太大就会压住名字。
   * 世界半径随之反推，几何仍然只有一个权威来源。
   */
  const nodeScreenRadius = Math.min(
    NODE_SCREEN_RADIUS_RANGE.max,
    Math.max(NODE_SCREEN_RADIUS_RANGE.min, NODE_WORLD_RADIUS * viewport.scale),
  );
  const nodeWorldRadius = nodeScreenRadius / viewport.scale;

  /**
   * 文字层：世界层只画几何（包络、连线、节点圆），名字与标题在屏幕空间绘制。
   * 因此缩放改变的是名字之间的距离，而不是名字本身的大小。
   */
  const screenLabels = useMemo(() => {
    const { width, height } = viewportSize;
    const nodeFontSize = 12 * labelScale;
    const clusterFontSize = 11 * labelScale;
    const placesLabel = (fontSize: number) => (text: string) => measureTextWidth(text, fontSize);
    if (!width || !height) {
      return {
        nodeLabels: [],
        clusterLabels: [],
        countLabels: [],
        badges: [],
        hiddenNodeLabels: 0,
      };
    }

    if (aggregateOverview) {
      const obstacles: ScreenRect[] = [];
      const countLabels: Array<{ id: string; x: number; y: number; text: string }> = [];
      const items = overviewGraph.nodes.map((node) => {
        const point = screenPoint(node, viewport);
        const radius = Math.max(9, node.r * viewport.scale);
        obstacles.push({
          x: point.x - radius,
          y: point.y - radius,
          width: radius * 2,
          height: radius * 2,
        });
        countLabels.push({
          id: node.id,
          x: point.x,
          y: point.y,
          text: String(node.memberIds.length),
        });
        return {
          id: node.id,
          x: point.x,
          y: point.y,
          text: node.label,
          offset: radius + 6,
        };
      });
      const placed = placeScreenLabels({
        items,
        width,
        height,
        fontSize: nodeFontSize,
        measure: placesLabel(nodeFontSize),
        obstacles,
        previous: labelCandidatesRef.current,
      });
      labelCandidatesRef.current = placed.candidates;
      return {
        nodeLabels: placed.placed,
        clusterLabels: [],
        countLabels,
        badges: [],
        hiddenNodeLabels: 0,
      };
    }

    const nodeItems = graph.nodes.map((node) => {
      const point = screenPoint(node, viewport);
      return {
        id: node.id,
        x: point.x,
        y: point.y,
        text: node.name,
        offset: nodeScreenRadius + 5,
        priority: node.id === selectedId ? -100 : 0,
        groupKey: node.group,
      };
    });

    /**
     * 屏幕上的邻居间距太小时，名字按圈层隔一个显示一个：密的地方自动留白，
     * 放大以后间距变大，采样关闭，全部名字回来。采样只看位置，不看重要程度。
     */
    const nearestDistances = nodeItems
      .map((item, index) =>
        Math.min(
          ...nodeItems
            .filter((_, other) => other !== index)
            .map((other) => Math.hypot(other.x - item.x, other.y - item.y)),
        ),
      )
      .sort((left, right) => left - right);
    const medianNearest = nearestDistances.length
      ? nearestDistances[Math.floor(nearestDistances.length / 2)]
      : Number.POSITIVE_INFINITY;
    const thinLabels = nodeItems.length > 30 && medianNearest < 68;
    const visibleNodeItems = thinLabels
      ? (() => {
          const byGroup = new Map<string, typeof nodeItems>();
          for (const item of nodeItems) {
            const key = item.groupKey || `solo:${item.id}`;
            byGroup.set(key, [...(byGroup.get(key) ?? []), item]);
          }
          const keep = new Set<string>();
          for (const items of byGroup.values()) {
            if (items.length < 3) {
              for (const item of items) keep.add(item.id);
              continue;
            }
            [...items]
              .sort(
                (left, right) =>
                  left.y - right.y || left.x - right.x || (left.id < right.id ? -1 : 1),
              )
              .forEach((item, index) => {
                if (index % 2 === 0) keep.add(item.id);
              });
          }
          return nodeItems.filter((item) => keep.has(item.id) || item.priority < 0);
        })()
      : nodeItems;
    const nodeObstacles: ScreenRect[] = graph.nodes.map((node) => {
      const point = screenPoint(node, viewport);
      return {
        x: point.x - nodeScreenRadius,
        y: point.y - nodeScreenRadius,
        width: nodeScreenRadius * 2,
        height: nodeScreenRadius * 2,
      };
    });
    const nodeLabels = placeScreenLabels({
      items: visibleNodeItems,
      width,
      height,
      fontSize: nodeFontSize,
      measure: placesLabel(nodeFontSize),
      obstacles: nodeObstacles,
      previous: labelCandidatesRef.current,
      // 人多时只接受紧挨着节点的位置：名字宁可少显示，也不甩到离人很远的地方。
      maxCandidateIndex: graph.nodes.length > 30 ? 3 : 7,
    });

    const clusterItems = graph.groups.map((group) => {
      const point = screenPoint({ x: group.labelX, y: group.labelY }, viewport);
      return {
        id: group.id,
        x: point.x,
        y: Math.max(point.y - 10, 12),
        text: group.name,
        offset: clusterFontSize + 4,
        // 圈层标题先占位：一张没有圈层名字的图等于没画
        priority: -50,
      };
    });
    const clusterLabels = placeScreenLabels({
      items: clusterItems,
      width,
      height,
      fontSize: clusterFontSize,
      measure: placesLabel(clusterFontSize),
      obstacles: [...nodeObstacles, ...nodeLabels.placed],
      previous: labelCandidatesRef.current,
    });
    labelCandidatesRef.current = { ...nodeLabels.candidates, ...clusterLabels.candidates };

    // 编号徽标始终画：圈层标题放不下时，至少还能和图例、交集列表对上号。
    const badges = graph.groups.map((group) => {
      const point = screenPoint({ x: group.badgeX, y: group.badgeY }, viewport);
      return {
        id: group.id,
        x: point.x,
        y: point.y,
        index: group.index,
        color: group.color.node,
      };
    });

    return {
      nodeLabels: nodeLabels.placed,
      clusterLabels: clusterLabels.placed,
      countLabels: [],
      badges,
      // 概览时被抽掉的名字数量：界面上要说明白，不能让人以为漏了人
      hiddenNodeLabels: nodeItems.length - visibleNodeItems.length,
    };
  }, [
    aggregateOverview,
    graph.nodes,
    graph.groups,
    overviewGraph.nodes,
    viewport,
    viewportSize,
    labelScale,
    selectedId,
    nodeScreenRadius,
    measureTextWidth,
  ]);

  const graphEdgePath = (edge: (typeof graph.edges)[number]) => {
    if (showFamilyTree && "familyKind" in edge) {
      const a = edge.a!;
      const b = edge.b!;
      if (edge.familyKind === "sibling") {
        const lift = Math.min(a.y, b.y) + 38;
        return `M ${a.x} ${a.y + nodeWorldRadius + 2} C ${a.x} ${lift}, ${b.x} ${lift}, ${b.x} ${b.y + nodeWorldRadius + 2}`;
      }
      if (edge.familyKind === "parent") {
        const midY = a.y + (b.y - a.y) * 0.52;
        return `M ${a.x} ${a.y + nodeWorldRadius + 4} V ${midY} H ${b.x} V ${b.y - nodeWorldRadius - 8}`;
      }
      // Other kinship and spouse edges use the common endpoint-aware path below.
      // In particular, a dragged spouse may no longer share the other node's y.
    }
    const ax = edge.a!.x;
    const ay = edge.a!.y;
    const bx = edge.b!.x;
    const by = edge.b!.y;
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy) || 1;
    const gap = nodeWorldRadius + 4;
    const ux = dx / len;
    const uy = dy / len;
    const x1 = ax + ux * gap;
    const y1 = ay + uy * gap;
    const x2 = bx - ux * gap;
    const y2 = by - uy * gap;
    const curve = "curve" in edge ? edge.curve : 0;
    const cx = (x1 + x2) / 2 + -uy * curve * 2;
    const cy = (y1 + y2) / 2 + ux * curve * 2;
    return `M ${x1} ${y1} Q ${cx} ${cy} ${x2} ${y2}`;
  };

  const layoutChoice: GraphLayoutChoice =
    graphLayoutMode === "family"
      ? "family"
      : groupBy === "circles" || groupBy === "communities"
        ? groupBy
        : graphLayoutMode === "auto"
          ? "auto"
          : "none";

  const applyLayoutChoice = (choice: GraphLayoutChoice) => {
    setGraphLayoutMode(choice === "family" ? "family" : choice === "auto" ? "auto" : "network");
    setGroupBy(choice === "circles" || choice === "communities" ? choice : ("none" as const));
    setDrill({ mode: "blocks" });
    setPositions({});
    resetView();
  };

  const changeLabelScale = (factor: number) =>
    setLabelScale((prev) => {
      const next = Math.min(1.6, Math.max(0.8, Math.round(prev * factor * 20) / 20));
      try {
        window.localStorage.setItem("zhimai:graph-label-scale", String(next));
      } catch {
        // 无痕模式等场景下保存失败不影响本次会话。
      }
      return next;
    });

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
      const rect = node.getBoundingClientRect();
      const anchor = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      setViewport((prev) =>
        zoomCamera(prev, factor, anchor, absoluteZoomLimits(fitScaleRef.current)),
      );
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
  }, [resetView]);

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
    // 第二根手指落下即进入双指缩放，单指平移立即让位。
    const pinch = pinchRef.current;
    if (pinch) {
      pinch.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      panRef.current = null;
      return;
    }
    if (event.isPrimary === false) {
      const pointers = new Map<number, { x: number; y: number }>();
      if (lastPrimaryPointerRef.current) pointers.set(-1, lastPrimaryPointerRef.current);
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      pinchRef.current = {
        pointers,
        startDistance: 0,
        startScale: viewport.scale,
        startTx: viewport.x,
        startTy: viewport.y,
      };
      panRef.current = null;
      return;
    }
    // 只有真正的画布空白启动平移。节点和关系边拥有自己的选择语义，不能在
    // pointerup 时被误判为“点击空白”。圈层底色禁用了 pointer events，仍算空白。
    const target = event.target as Element;
    const isBackground =
      target === event.currentTarget || target.getAttribute("data-graph-background") === "true";
    if (dragRef.current || !isBackground) return;
    lastPrimaryPointerRef.current = { x: event.clientX, y: event.clientY };
    panRef.current = {
      x: event.clientX,
      y: event.clientY,
      tx: viewport.x,
      ty: viewport.y,
      moved: 0,
    };
  };
  const onPanPointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    if (event.isPrimary) lastPrimaryPointerRef.current = { x: event.clientX, y: event.clientY };
    const pinch = pinchRef.current;
    if (pinch?.pointers.has(event.pointerId)) {
      pinch.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const [first, second] = [...pinch.pointers.values()];
      if (!second) return;
      const rect = svgRef.current?.getBoundingClientRect();
      if (!rect?.width) return;
      const distance = Math.hypot(second.x - first.x, second.y - first.y);
      if (!pinch.startDistance) {
        pinch.startDistance = distance || 1;
        return;
      }
      const limits = absoluteZoomLimits(fitScaleRef.current);
      const scale = Math.min(
        limits.maxScale,
        Math.max(limits.minScale, (pinch.startScale * distance) / pinch.startDistance),
      );
      // 以双指中点为锚缩放；viewBox 用 CSS 像素，屏幕坐标可以直接当画布坐标。
      const midX = (first.x + second.x) / 2 - rect.left;
      const midY = (first.y + second.y) / 2 - rect.top;
      setViewport({
        scale,
        x: midX - ((midX - pinch.startTx) / pinch.startScale) * scale,
        y: midY - ((midY - pinch.startTy) / pinch.startScale) * scale,
      });
      return;
    }
    const pan = panRef.current;
    if (!pan || dragRef.current) return;
    pan.moved = Math.max(pan.moved, Math.hypot(event.clientX - pan.x, event.clientY - pan.y));
    setViewport((prev) => ({
      scale: prev.scale,
      x: pan.tx + (event.clientX - pan.x),
      y: pan.ty + (event.clientY - pan.y),
    }));
  };
  const onPanPointerUp = (event?: React.PointerEvent<SVGSVGElement>) => {
    const pinch = pinchRef.current;
    if (pinch && event) {
      pinch.pointers.delete(event.pointerId);
      if (pinch.pointers.size < 2) pinchRef.current = null;
      return;
    }
    pinchRef.current = null;
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
    const dx = toWorldLength(event.clientX - drag.x);
    const dy = toWorldLength(event.clientY - drag.y);
    drag.moved = Math.max(drag.moved, Math.hypot(event.clientX - drag.x, event.clientY - drag.y));
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
          <TabsTrigger value="help">{t("找人办事")}</TabsTrigger>
        </TabsList>

        <TabsContent value="roster" className="space-y-4 pt-4">
          <div className="space-y-2 rounded-xl border border-border p-3">
            <Label className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
              {t("手动建档新人物")}
              <HelpHint
                label={t("手动建档新人物")}
                text={t(
                  "手动建档后，可以在下方具体人物卡中补充昵称、联系方式、关系与共同经历。也可以让 AI 根据备注帮你整理。",
                )}
              />
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
                placeholder={t("备注")}
              />
              <Button onClick={() => void createPerson()} className="shrink-0 rounded-full px-4">
                <UserPlus className="size-3.5" aria-hidden="true" />
                {t("建档")}
              </Button>
            </div>
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
            <label className="flex items-center gap-2 text-xs">
              {t("圈层 / 集合")}
              <select
                aria-label={t("按圈层筛选档案")}
                className="h-8 rounded-md border border-border bg-background px-2"
                value={collectionFilterId ?? ""}
                onChange={(event) => setCollectionFilterId(event.target.value || null)}
              >
                <option value="">{t("全部人物")}</option>
                {collections
                  .filter((collection) => collection.kind !== "computed_community")
                  .map((collection) => (
                    <option key={collection.id} value={collection.id}>
                      {collection.name}
                    </option>
                  ))}
              </select>
            </label>
            <div className="flex flex-wrap gap-1.5">
              {allTags.length > 0 && (
                <span className="py-1 text-[11px] text-muted-foreground">{t("标签")}</span>
              )}
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
              {(filterTags.length > 0 || collectionFilterId) && (
                <button
                  type="button"
                  onClick={() => {
                    setFilterTags([]);
                    setCollectionFilterId(null);
                  }}
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
            <div className="flex flex-col items-center gap-4 py-8 text-center text-xs text-muted-foreground">
              {people.length === 0 && (
                <img
                  src={peopleEmptyArt}
                  alt=""
                  width={400}
                  height={400}
                  loading="lazy"
                  decoding="async"
                  data-testid="people-empty-art"
                  className="size-36 rounded-2xl object-cover sm:size-44"
                />
              )}
              <p>{people.length === 0 ? t("还没有任何人物档案") : t("没有匹配的档案")}</p>
            </div>
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
                  <PersonAvatar
                    name={person.name}
                    id={person.id}
                    thumb={person.thumb}
                    className="size-12"
                  />
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
            <div className="flex flex-wrap items-center gap-2">
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
              <HelpHint
                label={t("AI 梳理人际关系")}
                text={t(
                  "通读本机档案后，用大白话讲清：整体结构、每个人的关键标签、谁把不同群体连起来、还缺哪些信息。",
                )}
              />
            </div>
            {summary && (
              <div className="space-y-2">
                <div className="rounded-xl border border-border bg-muted/30 p-3">
                  <p className="text-[11px] text-muted-foreground">
                    {t("AI 生成内容（请注意辨别）")}
                  </p>
                  <MarkdownView text={splitAssistantAnswer(summary).main} className="mt-1.5" />
                </div>
                {splitAssistantAnswer(summary).detail && (
                  <details className="rounded-xl border border-border px-3 py-2">
                    <summary className="cursor-pointer select-none text-[11px] text-muted-foreground">
                      {t("档案依据与待确认项（展开查看）")}
                    </summary>
                    <p className="mt-2 whitespace-pre-wrap text-[10px] leading-relaxed text-muted-foreground">
                      {splitAssistantAnswer(summary).detail}
                    </p>
                  </details>
                )}
              </div>
            )}
          </div>

          <div className="space-y-2 rounded-xl border border-border bg-muted/15 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium">{t("我的集合")}</span>
              <HelpHint
                label={t("圈层与集合")}
                text={t("一个人可以属于多个圈层；关系圈层参与圈层布局，场景集合用于筛选。")}
              />
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
              value={layoutChoice}
              onChange={(event) => applyLayoutChoice(event.target.value as GraphLayoutChoice)}
              className="h-9 rounded-md border border-border bg-background px-2 text-sm"
              aria-label={t("图形布局")}
              title={t("图形布局")}
            >
              <option value="auto">{t("自动布局")}</option>
              <option value="none">{t("不分组")}</option>
              <option value="circles">{t("按圈层布局")}</option>
              <option value="communities">{t("按拓扑社区布局")}</option>
              <option value="family">{t("家族树")}</option>
            </select>
            <button
              type="button"
              aria-label={t("布局说明")}
              aria-expanded={layoutHelpOpen}
              data-testid="graph-layout-help"
              className="flex size-9 shrink-0 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:text-foreground"
              onClick={() => setLayoutHelpOpen((value) => !value)}
            >
              <CircleHelp className="size-4" aria-hidden="true" />
            </button>
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

          {layoutHelpOpen && (
            <div
              data-testid="graph-layout-help-panel"
              className="space-y-1.5 rounded-lg border border-primary/25 bg-primary/5 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground"
            >
              <p>
                <span className="font-medium text-foreground">{t("自动布局")}</span>：
                {t("关系全是亲属时自动按家族树画，其余情况画成一张关系网，省得你自己挑。")}
              </p>
              <p>
                <span className="font-medium text-foreground">{t("按圈层布局")}</span>：
                {t("同一个圈层的人聚成一簇，只使用你已经确认的关系圈，标签和场景集合不参与。")}
              </p>
              <p data-testid="graph-layout-help-communities">
                <span className="font-medium text-foreground">{t("按拓扑社区布局")}</span>：
                {t(
                  "拓扑社区是算法自己算出来的「谁和谁来往更密」，不需要你事先分组；同一个社区的人会聚成一簇，跨社区的连线用虚线标出。它只是看一眼的结构，不会写回档案，也不会变成圈层。",
                )}
              </p>
              <p>
                <span className="font-medium text-foreground">{t("家族树")}</span>：
                {t("按世代分层排列，配偶同层、子女在父母下一层，同一代人用同一种颜色。")}
              </p>
            </div>
          )}

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

          {showFamilyTree && (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-primary/25 bg-primary/5 px-3 py-2 text-[11px] text-muted-foreground">
              <span>{t("家族树按世代排列；配偶同层，子女位于父母下一层。")}</span>
              {familyTree.generationCount > 1 && (
                <span
                  data-testid="family-generation-legend"
                  className="flex flex-wrap items-center gap-2"
                >
                  {Array.from({ length: familyTree.generationCount }, (_, generation) => (
                    <span key={generation} className="flex items-center gap-1">
                      <span
                        className="size-2.5 rounded-full"
                        style={{ background: generationColor(generation).node }}
                        aria-hidden="true"
                      />
                      {tFormat("第 {n} 代", { n: generation + 1 })}
                    </span>
                  ))}
                </span>
              )}
              {graphVisibility.visible.length > familyTreeRelations.length && (
                <span>
                  {t("当前仅显示")} {familyTreeRelations.length} {t("条亲属关系，隐藏")}{" "}
                  {graphVisibility.visible.length - familyTreeRelations.length} {t("条非亲属关系")}
                </span>
              )}
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

          {groupBy !== "none" && graph.groups.length > 0 && (
            <div
              className="flex flex-wrap items-center gap-2"
              aria-label={t(groupBy === "circles" ? "圈层图例" : "拓扑社区图例")}
            >
              <span className="text-[11px] text-muted-foreground">
                {t(groupBy === "circles" ? "圈层布局" : "拓扑社区（Louvain 自动计算，不写入档案）")}
                ：
              </span>
              {graph.groups.map((group) => (
                <div
                  key={group.id}
                  className="inline-flex overflow-hidden rounded-full border border-border bg-background text-[11px]"
                >
                  <span className="flex min-h-8 items-center gap-1.5 px-2.5">
                    <span
                      className="size-2.5 rounded-full"
                      style={{ backgroundColor: group.color.node }}
                      aria-hidden="true"
                    />
                    <span>{group.name}</span>
                    <span className="text-muted-foreground">{group.memberIds.length}</span>
                  </span>
                  <button
                    type="button"
                    className="min-h-8 border-l border-border px-2.5 text-primary hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                    aria-label={`${t(
                      groupBy === "circles" ? "只看圈层" : "只看拓扑社区",
                    )}：${group.name}`}
                    onClick={() => {
                      setSelectedId(null);
                      setGraphViewMode("overview");
                      setDrill({
                        mode: "members",
                        key: group.name,
                        memberIds: group.memberIds,
                      });
                    }}
                  >
                    {t("只看")}
                  </button>
                </div>
              ))}
            </div>
          )}

          {groupBy === "circles" && circleProjection.intersections.length > 0 && (
            <div className="flex flex-wrap items-center gap-2" aria-label={t("圈层交集")}>
              <span className="text-[11px] text-muted-foreground">{t("真实交集")}：</span>
              {circleProjection.intersections.map((intersection) => {
                const names = intersection.circleIds.map(
                  (id) => circleProjection.circles.find((circle) => circle.id === id)?.name ?? id,
                );
                const memberNames = intersection.memberIds
                  .map((id) => people.find((person) => person.id === id)?.name)
                  .filter((name): name is string => Boolean(name));
                return (
                  <button
                    key={intersection.circleIds.join("|")}
                    type="button"
                    className="min-h-8 rounded-full border border-border bg-background px-2.5 text-[11px] hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                    aria-label={`${t("只看交集")}：${names.join(" ∩ ")}`}
                    onClick={() => {
                      setSelectedId(null);
                      setGraphViewMode("overview");
                      setDrill({
                        mode: "members",
                        key: names.join(" ∩ "),
                        memberIds: intersection.memberIds,
                      });
                    }}
                  >
                    {names.join(" ∩ ")}
                    <span className="ml-1 text-muted-foreground">{memberNames.join("、")}</span>
                  </button>
                );
              })}
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
              <span className="w-10 text-center tabular-nums" data-graph-zoom-label="true">
                {Math.round((viewport.scale / Math.max(fitScaleRef.current, 1e-6)) * 100)}%
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
              <span className="ml-1 flex items-center gap-1" aria-label={t("标签字号")}>
                <button
                  type="button"
                  className="rounded-full border border-border px-2 py-0.5 text-[11px] hover:bg-accent"
                  onClick={() => changeLabelScale(1 / 1.15)}
                  aria-label={t("减小标签字号")}
                >
                  A−
                </button>
                <button
                  type="button"
                  className="rounded-full border border-border px-2 py-0.5 hover:bg-accent"
                  onClick={() => changeLabelScale(1.15)}
                  aria-label={t("增大标签字号")}
                >
                  A+
                </button>
              </span>
            </span>
            <span
              className="ml-1 flex items-center gap-1 rounded-full border border-border p-0.5"
              role="group"
              aria-label={t("关系网布局版本")}
              data-testid="graph-layout-version"
            >
              {(
                [
                  ["legacy", t("原版")],
                  ["compact", t("新版（测试）")],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={layoutVersion === value}
                  className={cn(
                    "rounded-full px-2 py-0.5 text-[11px]",
                    layoutVersion === value ? "bg-accent font-medium" : "hover:bg-accent/60",
                  )}
                  onClick={() => {
                    setLayoutVersion(value);
                    setPositions({});
                  }}
                >
                  {label}
                </button>
              ))}
            </span>
            {screenLabels.hiddenNodeLabels > 0 && (
              <button
                type="button"
                className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-accent"
                aria-label={t("名字没有全部显示，放大后会自动出现；点这里放大一级")}
                onClick={() => zoomBy(1.5)}
              >
                {tFormat("名字 {shown}/{total} · 点这里放大", {
                  shown: screenLabels.nodeLabels.length,
                  total: screenLabels.nodeLabels.length + screenLabels.hiddenNodeLabels,
                })}
              </button>
            )}
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
            ref={bindGraphFrameRef}
            data-relation-graph-frame="true"
            data-graph-layout={showFamilyTree ? "family" : "network"}
            className={cn(
              "relative overflow-hidden rounded-xl border border-border bg-muted/20",
              graphFullscreen
                ? "flex h-screen w-screen items-center rounded-none border-0 bg-background p-4"
                : "h-[clamp(22rem,54vh,38rem)]",
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
              data-relation-graph-svg="true"
              viewBox={`0 0 ${Math.max(1, viewportSize.width)} ${Math.max(1, viewportSize.height)}`}
              preserveAspectRatio="xMidYMid meet"
              className={cn(
                "h-full w-full touch-none select-none",
                relationComposerOpen ? "cursor-crosshair" : "cursor-grab active:cursor-grabbing",
                graphFullscreen && "max-h-[calc(100vh-2rem)]",
              )}
              onPointerDown={onPanPointerDown}
              onPointerMove={onPanPointerMove}
              onPointerUp={onPanPointerUp}
              onPointerCancel={onPanPointerUp}
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
                width={Math.max(1, viewportSize.width)}
                height={Math.max(1, viewportSize.height)}
                fill="transparent"
                pointerEvents="all"
              />
              <g
                data-graph-layer="world"
                transform={`translate(${viewport.x} ${viewport.y}) scale(${viewport.scale})`}
              >
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
                    </g>
                  ))}

                {!aggregateOverview &&
                  graph.groups.map((group) => {
                    // 钻取到某个交集时，只高亮仍包含这批人的圈层
                    const highlighted = selectedId
                      ? group.memberIds.includes(selectedId)
                      : drill.mode !== "members" ||
                        drill.memberIds.every((id) => group.memberIds.includes(id));
                    return (
                      <g key={group.id} data-graph-group={group.id} pointerEvents="none">
                        <title>
                          {`${group.index}. ${group.name} · ${group.memberIds.length} ${t("人")}`}
                        </title>
                        {group.fragments.map((fragment, index) =>
                          group.variant === "legacy" ? (
                            <path
                              key={`${group.id}-${index}`}
                              d={fragment.path}
                              style={{
                                fill: group.color.fill,
                                stroke: group.color.stroke,
                                transition: "d 260ms ease-out",
                              }}
                              strokeWidth={1}
                              strokeDasharray="4 4"
                            />
                          ) : (
                            <path
                              key={`${group.id}-${index}`}
                              d={fragment.path}
                              fill={group.color.node}
                              fillOpacity={highlighted ? 0.1 : 0.035}
                              stroke={group.color.node}
                              strokeOpacity={highlighted ? 0.34 : 0.1}
                              strokeWidth={CONTOUR_STROKE_PADDING * 2}
                              strokeLinejoin="round"
                              strokeLinecap="round"
                              strokeDasharray={group.valid ? undefined : "5 4"}
                            />
                          ),
                        )}
                      </g>
                    );
                  })}

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
                    const path = graphEdgePath(edge);
                    // 同一对人的多条关系画成不同弧度的曲线
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
                          d={path}
                          fill="none"
                          stroke="transparent"
                          strokeWidth={20}
                          pointerEvents="stroke"
                          aria-hidden="true"
                        />
                        <path
                          d={path}
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
                          // 方向仍然可读：只在选中或聚焦时才画箭头，避免上百个箭头把图糊满。
                          markerEnd={
                            selectedRelationId === edge.id || (selectedId && active)
                              ? "url(#relation-arrow)"
                              : undefined
                          }
                          markerStart={
                            edge.mutual &&
                            (selectedRelationId === edge.id || (selectedId && active))
                              ? "url(#relation-arrow-start)"
                              : undefined
                          }
                        />
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
                        <circle
                          cx={node.x}
                          cy={node.y}
                          r={nodeWorldRadius + 6}
                          className="fill-transparent"
                        />
                        {(isRelationFrom || isRelationTo) && (
                          <circle
                            cx={node.x}
                            cy={node.y}
                            r={nodeWorldRadius + 8}
                            fill="none"
                            className="stroke-primary"
                            strokeWidth={2.5}
                            strokeDasharray={isRelationFrom ? undefined : "4 3"}
                          />
                        )}
                        <circle
                          cx={node.x}
                          cy={node.y}
                          r={visuallySelected ? nodeWorldRadius * 1.2 : nodeWorldRadius}
                          className={cn(
                            "transition-opacity group-hover:opacity-80 group-focus-visible:stroke-foreground",
                            visuallySelected && "stroke-foreground",
                          )}
                          fill={node.variant === "legacy" ? node.color.node : "white"}
                          stroke={node.variant === "legacy" ? "white" : node.color.node}
                          strokeWidth={visuallySelected ? 2.5 : 1.5}
                        />
                        {node.variant === "contour" && node.ringColors.length === 1 && (
                          <circle
                            cx={node.x}
                            cy={node.y}
                            r={nodeWorldRadius * 0.62}
                            style={{ fill: node.ringColors[0] }}
                          />
                        )}
                        {node.variant === "contour" &&
                          node.ringColors.length > 1 &&
                          node.ringColors.map((color, index) => {
                            const total = node.ringColors.length;
                            const start = -Math.PI / 2 + (2 * Math.PI * index) / total;
                            const end = -Math.PI / 2 + (2 * Math.PI * (index + 1)) / total;
                            const inner = nodeWorldRadius * 0.62;
                            const x1 = node.x + inner * Math.cos(start);
                            const y1 = node.y + inner * Math.sin(start);
                            const x2 = node.x + inner * Math.cos(end);
                            const y2 = node.y + inner * Math.sin(end);
                            return (
                              <path
                                key={`${node.id}-ring-${index}`}
                                d={`M ${node.x} ${node.y} L ${x1} ${y1} A ${inner} ${inner} 0 ${
                                  end - start > Math.PI ? 1 : 0
                                } 1 ${x2} ${y2} Z`}
                                fill={color}
                                stroke="white"
                                strokeWidth={0.8}
                              />
                            );
                          })}
                      </g>
                    );
                  })}
              </g>
              <g pointerEvents="none">
                {!aggregateOverview && !graph.nodes.length && !contentBounds.height && (
                  <text
                    x={Math.max(1, viewportSize.width) / 2}
                    y={Math.max(1, viewportSize.height) / 2}
                    textAnchor="middle"
                    className="fill-muted-foreground text-xs"
                  >
                    {t("还没有任何人物档案")}
                  </text>
                )}
              </g>
              {/* 屏幕空间的文字层：字号是 CSS px，不随世界缩放变小 */}
              <g data-graph-labels="true">
                {screenLabels.countLabels.map((label) => (
                  <text
                    key={label.id}
                    x={label.x}
                    y={label.y + 4}
                    textAnchor="middle"
                    fontSize={13}
                    className="pointer-events-none fill-white font-semibold"
                  >
                    {label.text}
                  </text>
                ))}
                {layoutVersion === "compact" &&
                  screenLabels.badges.map((badge) => (
                    <g
                      key={badge.id}
                      className="pointer-events-none"
                      transform={`translate(${badge.x} ${badge.y})`}
                    >
                      <circle r={9} fill={badge.color} />
                      <text
                        y={4}
                        textAnchor="middle"
                        fontSize={11}
                        className="fill-white font-semibold"
                      >
                        {badge.index}
                      </text>
                    </g>
                  ))}{" "}
                {screenLabels.nodeLabels.map((label) => (
                  <g
                    key={label.id}
                    className="pointer-events-none"
                    data-person-label={label.id}
                    transform={`translate(${label.x} ${label.y})`}
                  >
                    <rect
                      width={label.width}
                      height={label.height}
                      rx={4}
                      className="fill-background/85"
                    />
                    <text
                      x={label.width / 2}
                      y={label.height / 2 + 12 * labelScale * 0.35}
                      textAnchor="middle"
                      fontSize={12 * labelScale}
                      className="fill-foreground"
                    >
                      {label.text}
                    </text>
                  </g>
                ))}
                {screenLabels.clusterLabels.map((label) => (
                  <text
                    key={label.id}
                    x={label.x + label.width / 2}
                    y={label.y + label.height / 2 + 11 * labelScale * 0.35}
                    textAnchor="middle"
                    role="button"
                    tabIndex={0}
                    fontSize={11 * labelScale}
                    data-cluster-label={label.id}
                    className="cursor-pointer fill-primary font-medium underline-offset-2 hover:underline"
                    aria-label={`${t(
                      groupBy === "circles" ? "只看圈层" : "只看拓扑社区",
                    )}：${label.text}`}
                    pointerEvents="auto"
                    onClick={() => {
                      const group = graph.groups.find((item) => item.id === label.id);
                      if (!group) return;
                      setDrill({
                        mode: "members",
                        key: group.name,
                        memberIds: group.memberIds,
                      });
                    }}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" && event.key !== " ") return;
                      event.preventDefault();
                      const group = graph.groups.find((item) => item.id === label.id);
                      if (!group) return;
                      setDrill({
                        mode: "members",
                        key: group.name,
                        memberIds: group.memberIds,
                      });
                    }}
                  >
                    <title>
                      {t(groupBy === "circles" ? "点击只看这个圈层" : "点击只看这个拓扑社区")}
                    </title>
                    {label.text}
                  </text>
                ))}
                {aggregateOverview &&
                  overviewGraph.edges.map((edge) => {
                    const mid = screenPoint(
                      {
                        x: (edge.a!.x + edge.b!.x) / 2,
                        y: (edge.a!.y + edge.b!.y) / 2,
                      },
                      viewport,
                    );
                    return (
                      <text
                        key={edge.id}
                        x={mid.x}
                        y={mid.y - 7}
                        textAnchor="middle"
                        fontSize={11 * labelScale}
                        className="pointer-events-none fill-muted-foreground"
                      >
                        {edge.relationCount} {t("条跨社区关系")}
                      </text>
                    );
                  })}
                {!aggregateOverview &&
                  graph.edges.map((edge) => {
                    const active =
                      !selectedId ||
                      (graphVisibility.focusNodeIds.has(edge.a!.id) &&
                        graphVisibility.focusNodeIds.has(edge.b!.id));
                    if (
                      !showEdgeLabels &&
                      selectedRelationId !== edge.id &&
                      !(selectedId && active)
                    ) {
                      return null;
                    }
                    const point = screenPoint({ x: edge.lx, y: edge.ly }, viewport);
                    const fontSize = 11 * labelScale;
                    const boxWidth = measureTextWidth(edge.label, fontSize) + 10;
                    const boxHeight = fontSize + 6;
                    return (
                      <g
                        key={edge.id}
                        className="pointer-events-none"
                        transform={`translate(${point.x - boxWidth / 2} ${point.y - boxHeight / 2})`}
                      >
                        <rect
                          width={boxWidth}
                          height={boxHeight}
                          rx={5}
                          className="fill-background/90"
                        />
                        <text
                          x={boxWidth / 2}
                          y={boxHeight / 2 + fontSize * 0.35}
                          textAnchor="middle"
                          fontSize={fontSize}
                          className="fill-muted-foreground"
                        >
                          {edge.label}
                        </text>
                      </g>
                    );
                  })}
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
                            // 就地更新这一行，列表滚动位置不动；其余数据等下次进入页面再同步。
                            setRelations((rows) =>
                              rows.map((row) =>
                                row.id === relation.id
                                  ? { ...row, confirmationStatus: "confirmed" }
                                  : row,
                              ),
                            );
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

        {/* 找 AI 办事可能跑好几分钟，切页签不能把它卸载掉。 */}
        <TabsContent
          value="help"
          forceMount
          className="space-y-4 pt-4 data-[state=inactive]:hidden"
        >
          <AskForHelpPanel
            preset={preset}
            active={active}
            focusRunId={focusRunId}
            focusNonce={focusNonce}
          />
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
