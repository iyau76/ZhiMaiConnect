/** AI 整理结果的实时关系网预览：可点点连线、改关系词、加人，并与已有档案前后对照。 */

import { Maximize2, Minimize2, Minus, Plus, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { HelpHint } from "@/components/help-hint";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { t } from "@/lib/i18n";
import {
  resolveDraftRelationEndpoints,
  type DraftGraphEdge,
  type DraftGraphNode,
  type DraftGraphProjection,
} from "@/lib/draft-graph-projection";
import { buildSetContours, CONTOUR_PADDING } from "@/lib/set-contours";
import {
  DEFAULT_FIT_PADDING,
  absoluteZoomLimits,
  boundsOfPoints,
  fitCamera,
  screenToWorldLength,
  zoomCamera,
  type GraphCamera,
} from "@/lib/graph-camera";
import { blobPathFor, layoutRingGraph } from "@/lib/relation-graph-legacy";
import {
  DEFAULT_GRAPH_LAYOUT_VERSION,
  loadGraphLayoutVersion,
  type GraphLayoutVersion,
} from "@/lib/graph-layout-version";
import { createTextMeasurer, placeScreenLabels, type ScreenRect } from "@/lib/graph-labels";
import {
  GRAPH_ASPECT_BY_CLASS,
  graphAspectClass,
  layoutRelationGraph,
} from "@/lib/relation-graph-layout";
import { inferMutual } from "@/lib/relation-kind";
import { cn } from "@/lib/utils";

export interface GraphPerson {
  name?: string;
  department?: string;
  _draftId?: string;
  targetPersonId?: string;
}

export interface GraphRelation {
  from: string;
  to: string;
  label: string;
  fromDraftId?: string;
  toDraftId?: string;
  fromPersonId?: string;
  toPersonId?: string;
}

type DraftGraphViewMode = "all" | "new" | "archive";
type DraftGraphLayoutMode = "circles" | "none";

interface Props {
  people: GraphPerson[];
  relations: GraphRelation[];
  /** 调用方用 buildDraftGraphProjection 算好的整张图：档案 + 这次录入的草稿。 */
  archive: DraftGraphProjection;
  /** false 时只看不编辑，缩放、全屏和字号仍然可用。 */
  canEdit?: boolean;
  onAddPerson: (name: string) => void;
  onAddRelation: (from: string, to: string, label: string) => void;
  onPatchRelation: (index: number, label: string) => void;
  onRemoveRelation: (index: number) => void;
}

const MIN_LABEL_SCALE = 0.8;
const MAX_LABEL_SCALE = 1.6;
const LABEL_SCALE_STEP = 1.15;
const LABEL_SCALE_STORAGE_KEY = "zhimai:draft-graph-label-scale";
/** 预览里的节点世界半径，和正式关系网保持一致 */
const NODE_WORLD_RADIUS = 16;
const GRAPH_LABEL_FONT =
  'system-ui, -apple-system, "Segoe UI", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif';

const toolbarButtonClass =
  "rounded-full border border-border bg-background px-2 py-1 text-[11px] hover:bg-accent";

function pairKeyOf(from: string, to: string) {
  return from < to ? `${from}\u0000${to}` : `${to}\u0000${from}`;
}

function edgeKeyOf(edge: Pick<DraftGraphEdge, "from" | "to" | "label">) {
  return `${edge.from}\u0000${edge.to}\u0000${edge.label}`;
}

function loadLabelScale() {
  try {
    const stored = window.localStorage.getItem(LABEL_SCALE_STORAGE_KEY);
    const value = stored === null ? 1 : Number(stored);
    return Number.isFinite(value) ? Math.min(MAX_LABEL_SCALE, Math.max(MIN_LABEL_SCALE, value)) : 1;
  } catch {
    return 1;
  }
}

export function DraftGraph({
  people,
  relations,
  archive,
  canEdit = true,
  onAddPerson,
  onAddRelation,
  onPatchRelation,
  onRemoveRelation,
}: Props) {
  const [linkFromId, setLinkFromId] = useState<string | null>(null);
  const [linkToId, setLinkToId] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [newName, setNewName] = useState("");
  const [viewMode, setViewMode] = useState<DraftGraphViewMode>("all");
  const [layoutChoice, setLayoutChoice] = useState<DraftGraphLayoutMode | null>(null);
  /** 相机：世界坐标 → 屏幕 CSS 像素 */
  const [viewport, setViewport] = useState<GraphCamera>({ scale: 1, x: 0, y: 0 });
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const viewportSizeRef = useRef(viewportSize);
  viewportSizeRef.current = viewportSize;
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;
  const fitScaleRef = useRef(1);
  const labelCandidatesRef = useRef<Record<string, number>>({});
  const [layoutAspectClass, setLayoutAspectClass] = useState<"wide" | "tall">("wide");
  const layoutAspectClassRef = useRef<"wide" | "tall" | null>(null);
  /** 预览跟着关系网页的版本开关走，开关本身只在关系网页里出现。 */
  const [layoutVersion] = useState<GraphLayoutVersion>(() => {
    try {
      return loadGraphLayoutVersion(window.localStorage);
    } catch {
      return DEFAULT_GRAPH_LAYOUT_VERSION;
    }
  });
  const [labelScale, setLabelScale] = useState(loadLabelScale);
  const [graphFullscreen, setGraphFullscreen] = useState(false);

  const frameRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const measureText = useRef(createTextMeasurer(GRAPH_LABEL_FONT)).current;
  const wheelListenerRef = useRef<((event: WheelEvent) => void) | null>(null);
  const pinchRef = useRef<{
    pointers: Map<number, { x: number; y: number }>;
    startDistance: number;
    startScale: number;
    startTx: number;
    startTy: number;
  } | null>(null);
  const lastPrimaryPointerRef = useRef<{ x: number; y: number } | null>(null);
  const panRef = useRef<{
    x: number;
    y: number;
    tx: number;
    ty: number;
    moved: number;
  } | null>(null);

  const viewModes: Array<{ value: DraftGraphViewMode; label: string }> = [
    { value: "all", label: t("和已有档案一起看") },
    { value: "new", label: t("只看这次新增") },
    { value: "archive", label: t("已有档案") },
  ];

  const nodeById = useMemo(
    () => new Map(archive.nodes.map((node) => [node.id, node])),
    [archive.nodes],
  );

  const circleKeysByNodeId = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const circle of archive.circles) {
      for (const memberId of circle.memberIds) {
        const current = map.get(memberId) ?? [];
        if (!current.includes(circle.key)) current.push(circle.key);
        map.set(memberId, current);
      }
    }
    for (const keys of map.values()) keys.sort();
    return map;
  }, [archive.circles]);

  const { visibleNodes, visibleEdges } = useMemo(() => {
    if (viewMode === "archive") {
      return {
        visibleNodes: archive.nodes.filter((node) => !node.isNew),
        visibleEdges: archive.edges.filter((edge) => !edge.isNew),
      };
    }
    if (viewMode === "new") {
      const edges = archive.edges.filter((edge) => edge.isNew);
      const keepIds = new Set<string>();
      for (const node of archive.nodes) {
        if (node.isNew) keepIds.add(node.id);
      }
      for (const edge of edges) {
        keepIds.add(edge.from);
        keepIds.add(edge.to);
      }
      return {
        visibleNodes: archive.nodes.filter((node) => keepIds.has(node.id)),
        visibleEdges: edges,
      };
    }
    return { visibleNodes: archive.nodes, visibleEdges: archive.edges };
  }, [archive, viewMode]);

  const layoutMode: DraftGraphLayoutMode =
    layoutChoice ?? (archive.circles.length > 0 ? "circles" : "none");
  const hasCircleGroups = layoutMode === "circles" && archive.circles.length > 0;

  const groups = useMemo(
    () =>
      hasCircleGroups
        ? archive.circles.map((circle) => ({
            id: circle.key,
            name: circle.label,
            memberIds: circle.memberIds,
          }))
        : [],
    [archive.circles, hasCircleGroups],
  );

  /**
   * 原版布局把「成员组合」当成一个簇，所以要先按每个人的圈层组合分组。
   * 预览跟着关系网页的版本开关走：预览承诺和入库后看到的是同一张图。
   */
  const compositeGroups = useMemo(() => {
    if (layoutVersion !== "legacy" || !hasCircleGroups) return [];
    const labelByKey = new Map(archive.circles.map((circle) => [circle.key, circle.label]));
    const byKey = new Map<string, { id: string; name: string; memberIds: string[] }>();
    for (const node of visibleNodes) {
      const keys = [...new Set(circleKeysByNodeId.get(node.id) ?? [])].sort();
      const id = keys.length ? `circles:${keys.join("\u0000")}` : "circles:none";
      const group = byKey.get(id) ?? {
        id,
        name: keys.length
          ? keys.map((key) => labelByKey.get(key) ?? key).join(" / ")
          : t("未分圈层"),
        memberIds: [],
      };
      group.memberIds.push(node.id);
      byKey.set(id, group);
    }
    return [...byKey.values()];
  }, [archive.circles, circleKeysByNodeId, hasCircleGroups, layoutVersion, visibleNodes]);

  const geometry = useMemo(() => {
    if (layoutVersion === "legacy") {
      const groupKeyByNodeId = new Map<string, string>();
      for (const group of compositeGroups) {
        for (const memberId of group.memberIds) groupKeyByNodeId.set(memberId, group.id);
      }
      const ring = layoutRingGraph(
        visibleNodes.map((node) => ({
          id: node.id,
          groupKey: hasCircleGroups ? (groupKeyByNodeId.get(node.id) ?? "circles:none") : "",
        })),
        hasCircleGroups
          ? compositeGroups.map((group) => ({ key: group.id, label: group.name }))
          : [],
      );
      const nodes = ring.nodes.map((node) => ({ ...node, groupKey: node.groupKey }));
      const shapes = ring.clusters.map((cluster) => {
        const members = ring.nodes
          .filter((node) => node.groupKey === cluster.key)
          .map((node) => ({ id: node.id, x: node.x, y: node.y }));
        const top = members.reduce<(typeof members)[number] | null>(
          (highest, node) => (!highest || node.y < highest.y ? node : highest),
          null,
        );
        return {
          id: cluster.key,
          name: cluster.label,
          valid: true,
          fragments: [
            {
              path: blobPathFor(cluster.x, cluster.y, cluster.r * 1.08, cluster.key, members),
              kind: "hull",
              memberIds: members.map((member) => member.id),
            },
          ],
          labelX: top?.x ?? cluster.x,
          labelY: (top?.y ?? cluster.y) - NODE_WORLD_RADIUS - 10,
        };
      });
      return {
        nodes: nodes.map((node) => ({ id: node.id, x: node.x, y: node.y })),
        groups: shapes,
        bounds: boundsOfPoints(nodes, 74),
        variant: "legacy" as const,
      };
    }
    const compact = layoutRelationGraph(
      visibleNodes.map((node) => ({ id: node.id })),
      {
        groups: groups.map((group) => ({ id: group.id, memberIds: group.memberIds })),
        links: visibleEdges.map((edge) => [edge.from, edge.to] as [string, string]),
        aspect: GRAPH_ASPECT_BY_CLASS[layoutAspectClass],
      },
    );
    return { ...compact, variant: "contour" as const };
  }, [
    compositeGroups,
    groups,
    hasCircleGroups,
    layoutAspectClass,
    layoutVersion,
    visibleEdges,
    visibleNodes,
  ]);

  const placements = useMemo(
    () => new Map(geometry.nodes.map((node) => [node.id, node])),
    [geometry.nodes],
  );

  /** 圈层形状：新版是校验过的成员包络，原版是跟着成员流动的不规则外形。 */
  const groupShapes = useMemo(() => {
    if (geometry.variant === "legacy") return geometry.groups;
    return buildSetContours(
      groups.map((group) => ({ id: group.id, memberIds: group.memberIds })),
      geometry.nodes,
      { nodeRadius: NODE_WORLD_RADIUS },
    ).map((contour) => {
      const group = groups.find((item) => item.id === contour.id);
      const members = (group?.memberIds ?? [])
        .map((id) => geometry.nodes.find((node) => node.id === id))
        .filter((node): node is { id: string; x: number; y: number } => Boolean(node));
      const top = members.reduce<(typeof members)[number] | null>(
        (highest, node) => (!highest || node.y < highest.y ? node : highest),
        null,
      );
      return {
        id: contour.id,
        name: group?.name ?? contour.id,
        fragments: contour.fragments,
        valid: contour.valid,
        labelX: top?.x ?? 0,
        labelY: (top?.y ?? 0) - NODE_WORLD_RADIUS - 10,
      };
    });
  }, [geometry, groups]);

  /** 同一对人之间的多条关系分别弯成不同弧度，避免线和字重合。 */
  const edgeShapes = useMemo(() => {
    const totalByPair = new Map<string, number>();
    for (const edge of visibleEdges) {
      const key = pairKeyOf(edge.from, edge.to);
      totalByPair.set(key, (totalByPair.get(key) ?? 0) + 1);
    }
    const seenByPair = new Map<string, number>();
    return visibleEdges.map((edge) => {
      const key = pairKeyOf(edge.from, edge.to);
      const order = seenByPair.get(key) ?? 0;
      seenByPair.set(key, order + 1);
      return { order, total: totalByPair.get(key) ?? 1 };
    });
  }, [visibleEdges]);

  /** 草稿边回到 relations 数组的下标，改词、删词仍然走原来的回调。 */
  const editableRelationIndexByEdge = useMemo(() => {
    const map = new Map<string, number>();
    relations.forEach((relation, index) => {
      const endpoints = resolveDraftRelationEndpoints(
        { ...relation, label: relation.label ?? "" },
        people,
        archive.nodes,
      );
      if (!endpoints) return;
      const key = `${endpoints.from}\u0000${endpoints.to}\u0000${relation.label ?? ""}`;
      if (!map.has(key)) map.set(key, index);
    });
    return map;
  }, [archive.nodes, people, relations]);

  const zoomBy = (factor: number, anchor?: { x: number; y: number }) => {
    const { width, height } = viewportSizeRef.current;
    const limits = absoluteZoomLimits(fitScaleRef.current);
    setViewport((prev) =>
      zoomCamera(prev, factor, anchor ?? { x: width / 2, y: height / 2 }, limits),
    );
  };

  const fitToContent = useCallback(() => {
    const { width, height } = viewportSizeRef.current;
    const camera = fitCamera(geometry.bounds, width, height, DEFAULT_FIT_PADDING);
    if (!camera) return;
    fitScaleRef.current = camera.scale;
    setViewport(camera);
  }, [geometry.bounds]);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const measure = () => {
      const width = frame.clientWidth;
      const height = frame.clientHeight;
      if (width <= 0 || height <= 0) return;
      setViewportSize((prev) =>
        prev.width === width && prev.height === height ? prev : { width, height },
      );
      if (layoutAspectClassRef.current === null) {
        const next = graphAspectClass(width, height);
        layoutAspectClassRef.current = next;
        setLayoutAspectClass(next);
      }
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(frame);
    return () => observer.disconnect();
  }, [graphFullscreen]);

  const boundsKey = `${Math.round(geometry.bounds.width)}:${Math.round(geometry.bounds.height)}`;
  useEffect(() => {
    if (!viewportSize.width || !viewportSize.height) return;
    fitToContent();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boundsKey, viewportSize.width, viewportSize.height]);

  /** 预览里的名字与圈层标题同样画在屏幕层，字号固定成 CSS px。 */
  const draftLabels = useMemo(() => {
    const { width, height } = viewportSize;
    if (!width || !height) return { nodeLabels: [], groupLabels: [] };
    const fontSize = 11 * labelScale;
    const measure = (text: string) => measureText(text, fontSize);
    const nodeScreenRadius = Math.min(26, Math.max(7, NODE_WORLD_RADIUS * viewport.scale));
    const obstacles: ScreenRect[] = geometry.nodes.map((node) => {
      const point = {
        x: node.x * viewport.scale + viewport.x,
        y: node.y * viewport.scale + viewport.y,
      };
      return {
        x: point.x - nodeScreenRadius,
        y: point.y - nodeScreenRadius,
        width: nodeScreenRadius * 2,
        height: nodeScreenRadius * 2,
      };
    });
    const nodeLabels = placeScreenLabels({
      items: visibleNodes.map((node) => {
        const point = geometry.nodes.find((item) => item.id === node.id);
        return {
          id: node.id,
          x: (point?.x ?? 0) * viewport.scale + viewport.x,
          y: (point?.y ?? 0) * viewport.scale + viewport.y,
          text: node.name,
          offset: nodeScreenRadius + 5,
          priority: node.id === linkFromId || node.id === linkToId ? -10 : 0,
        };
      }),
      width,
      height,
      fontSize,
      measure,
      obstacles,
      previous: labelCandidatesRef.current,
    });
    const groupLabels = placeScreenLabels({
      items: groupShapes.map((group) => ({
        id: group.id,
        x: group.labelX * viewport.scale + viewport.x,
        y: Math.max(group.labelY * viewport.scale + viewport.y, 12),
        text: group.name,
        offset: fontSize + 4,
        priority: -1,
      })),
      width,
      height,
      fontSize,
      measure,
      obstacles: [...obstacles, ...nodeLabels.placed],
      previous: labelCandidatesRef.current,
    });
    labelCandidatesRef.current = { ...nodeLabels.candidates, ...groupLabels.candidates };
    return { nodeLabels: nodeLabels.placed, groupLabels: groupLabels.placed };
  }, [
    groupShapes,
    geometry.nodes,
    labelScale,
    linkFromId,
    linkToId,
    measureText,
    viewport,
    viewportSize,
    visibleNodes,
  ]);

  const resetView = useCallback(() => fitToContent(), [fitToContent]);

  const changeLabelScale = (factor: number) =>
    setLabelScale((prev) => {
      const next = Math.min(
        MAX_LABEL_SCALE,
        Math.max(MIN_LABEL_SCALE, Math.round(prev * factor * 20) / 20),
      );
      try {
        window.localStorage.setItem(LABEL_SCALE_STORAGE_KEY, String(next));
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
      setGraphFullscreen(document.fullscreenElement === frameRef.current);
    };
    document.addEventListener("fullscreenchange", syncFullscreenState);
    return () => document.removeEventListener("fullscreenchange", syncFullscreenState);
  }, []);

  const closeFullscreen = useCallback(async () => {
    if (document.fullscreenElement) {
      try {
        await document.exitFullscreen();
      } catch {
        // 浏览器拒绝退出时，页面内全屏的状态下面统一收掉。
      }
    }
    setGraphFullscreen(false);
  }, []);

  /** 全屏时锁住页面滚动，Esc 退出；原生全屏由浏览器负责，这里兜住页面内全屏。 */
  useEffect(() => {
    if (!graphFullscreen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") void closeFullscreen();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [closeFullscreen, graphFullscreen]);

  const toggleGraphFullscreen = async () => {
    if (graphFullscreen) {
      await closeFullscreen();
      return;
    }
    setGraphFullscreen(true);
    try {
      await frameRef.current?.requestFullscreen?.();
    } catch {
      // 请求被拒绝时保持页面内全屏，交互不受影响。
    }
  };

  const onPanPointerDown = (event: React.PointerEvent<SVGSVGElement>) => {
    if (event.isPrimary) lastPrimaryPointerRef.current = { x: event.clientX, y: event.clientY };
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
    // 只有真正的画布空白启动平移；节点和关系边有自己的点击语义。
    const target = event.target as Element;
    const isBackground =
      target === event.currentTarget || target.getAttribute("data-graph-background") === "true";
    if (!isBackground) return;
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
    // 先落下的那根手指存在 -1 键里，它移动时也要跟着更新，否则双指距离会僵住。
    if (pinch && event.isPrimary && pinch.pointers.has(-1)) {
      pinch.pointers.set(-1, { x: event.clientX, y: event.clientY });
    }
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
    if (!pan) return;
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
      if (event.isPrimary) {
        // 先落下的手指抬起后，剩下的一根不再继续当双指缩放用。
        pinchRef.current = null;
      } else {
        pinch.pointers.delete(event.pointerId);
        if (pinch.pointers.size < 2) pinchRef.current = null;
      }
      return;
    }
    pinchRef.current = null;
    const pan = panRef.current;
    panRef.current = null;
    // 点空白 = 取消正在连的那条线；拖着画布平移不算点击。
    if (!pan || pan.moved >= 4) return;
    setLinkFromId(null);
    setLinkToId(null);
  };

  const clearLink = () => {
    setLinkFromId(null);
    setLinkToId(null);
  };

  const clickNode = (node: DraftGraphNode) => {
    if (!canEdit) return;
    if (!linkFromId) {
      setLinkFromId(node.id);
      setLinkToId(null);
      return;
    }
    if (linkFromId === node.id) {
      clearLink();
      return;
    }
    setLinkToId(node.id);
  };

  const confirmLink = () => {
    if (!linkFromId || !linkToId) return;
    const from = (nodeById.get(linkFromId)?.name ?? "").trim();
    const to = (nodeById.get(linkToId)?.name ?? "").trim();
    if (!from || !to) return;
    onAddRelation(from, to, label.trim() || t("认识"));
    clearLink();
    setLabel("");
  };

  const editEdgeRelation = (edge: DraftGraphEdge) => {
    if (!canEdit || !edge.isNew) return;
    const index = editableRelationIndexByEdge.get(edgeKeyOf(edge));
    if (index === undefined) return;
    const next = window.prompt(t("改关系词（留空则删除这条关系）"), edge.label ?? "");
    if (next === null) return;
    if (!next.trim()) onRemoveRelation(index);
    else onPatchRelation(index, next.trim());
  };

  const linkFromName = linkFromId ? (nodeById.get(linkFromId)?.name ?? "") : "";
  const linkToName = linkToId ? (nodeById.get(linkToId)?.name ?? "") : "";

  return (
    <div className="space-y-3 rounded-xl border border-border bg-background/50 p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <p className="text-xs font-medium">{t("关系网预览")}</p>
          <HelpHint
            label={t("关系网预览")}
            text={t(
              "预览是这次录入可能长成的样子，点人连线、改关系词都会实时反映在上面。新关系画实线，档案里已有的关系画成灰虚线；这次要更新的人会带上淡色底圈。预览里的圈层来自你已经确认的关系圈，以及这次录入的圈层草稿；它们都还没入库。",
            )}
          />
        </div>
        <div
          className="flex flex-wrap items-center gap-1"
          role="group"
          aria-label={t("关系网预览")}
        >
          {viewModes.map((mode) => (
            <button
              key={mode.value}
              type="button"
              aria-pressed={viewMode === mode.value}
              className={cn(
                "rounded-full border px-2.5 py-1 text-[11px] transition-colors",
                viewMode === mode.value
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border bg-background hover:bg-accent",
              )}
              onClick={() => {
                setViewMode(mode.value);
                resetView();
              }}
            >
              {mode.label}
            </button>
          ))}
        </div>
      </div>

      <div
        ref={frameRef}
        data-draft-graph-frame="true"
        className={cn(
          "relative overflow-hidden rounded-xl border border-border bg-muted/20 p-2",
          graphFullscreen &&
            "fixed inset-0 z-50 flex h-screen w-screen flex-col rounded-none border-0 bg-background p-4",
        )}
      >
        <div className="flex flex-wrap items-center gap-1.5 pb-2 text-[11px] text-muted-foreground">
          <select
            value={layoutMode}
            onChange={(event) => {
              setLayoutChoice(event.target.value as DraftGraphLayoutMode);
              resetView();
            }}
            className="h-8 rounded-md border border-border bg-background px-2 text-[11px] text-foreground"
            aria-label={t("图形布局")}
          >
            <option value="circles">{t("按圈层布局")}</option>
            <option value="none">{t("不分组")}</option>
          </select>
          <span className="hidden sm:inline">{t("拖动画布，滚轮或双指缩放")}</span>
          <span className="ml-auto flex items-center gap-1">
            <button
              type="button"
              className={toolbarButtonClass}
              onClick={() => zoomBy(1 / 1.2)}
              aria-label={t("缩小")}
              title={t("缩小")}
            >
              <Minus className="size-3.5" aria-hidden="true" />
            </button>
            <span className="w-10 text-center tabular-nums">
              {Math.round(viewport.scale * 100)}%
            </span>
            <button
              type="button"
              className={toolbarButtonClass}
              onClick={() => zoomBy(1.2)}
              aria-label={t("放大")}
              title={t("放大")}
            >
              <Plus className="size-3.5" aria-hidden="true" />
            </button>
            <button type="button" className={toolbarButtonClass} onClick={resetView}>
              {t("复位布局")}
            </button>
            <span className="ml-1 flex items-center gap-1" aria-label={t("标签字号")}>
              <button
                type="button"
                className={toolbarButtonClass}
                onClick={() => changeLabelScale(1 / LABEL_SCALE_STEP)}
                aria-label={t("减小标签字号")}
                title={t("减小标签字号")}
              >
                A−
              </button>
              <button
                type="button"
                className={toolbarButtonClass}
                onClick={() => changeLabelScale(LABEL_SCALE_STEP)}
                aria-label={t("增大标签字号")}
                title={t("增大标签字号")}
              >
                A+
              </button>
            </span>
          </span>
        </div>

        <div
          className={cn(
            "relative",
            graphFullscreen ? "min-h-0 flex-1" : "h-[clamp(17rem,42vh,27rem)]",
          )}
        >
          {visibleNodes.length === 0 ? (
            <p className="flex h-full items-center justify-center text-xs text-muted-foreground">
              {t("还没有人物")}
            </p>
          ) : (
            <svg
              ref={bindSvgRef}
              data-draft-graph-svg="true"
              viewBox={`0 0 ${Math.max(1, viewportSize.width)} ${Math.max(1, viewportSize.height)}`}
              preserveAspectRatio="xMidYMid meet"
              role="img"
              aria-label={t("关系网预览")}
              className="h-full w-full cursor-grab touch-none select-none active:cursor-grabbing"
              onPointerDown={onPanPointerDown}
              onPointerMove={onPanPointerMove}
              onPointerUp={onPanPointerUp}
              onPointerCancel={onPanPointerUp}
              onPointerLeave={onPanPointerUp}
            >
              <title>{t("拖动画布，滚轮或双指缩放")}</title>
              <defs>
                <marker
                  id="draft-graph-arrow-new"
                  viewBox="0 0 10 10"
                  refX="9"
                  refY="5"
                  markerWidth="5"
                  markerHeight="5"
                  orient="auto-start-reverse"
                >
                  <path d="M0,0 L10,5 L0,10 z" className="fill-primary" />
                </marker>
                <marker
                  id="draft-graph-arrow-archive"
                  viewBox="0 0 10 10"
                  refX="9"
                  refY="5"
                  markerWidth="5"
                  markerHeight="5"
                  orient="auto-start-reverse"
                >
                  <path d="M0,0 L10,5 L0,10 z" className="fill-muted-foreground" />
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
                {groupShapes.map((group) => (
                  <g key={group.id} pointerEvents="none">
                    <title>{group.name}</title>
                    {group.fragments.map((fragment, index) => (
                      <path
                        key={`${group.id}-${index}`}
                        d={fragment.path}
                        fill="currentColor"
                        fillOpacity={0.1}
                        stroke="currentColor"
                        strokeOpacity={0.35}
                        strokeWidth={(NODE_WORLD_RADIUS + CONTOUR_PADDING) * 2}
                        strokeLinejoin="round"
                        strokeLinecap="round"
                        strokeDasharray={group.valid ? undefined : "5 4"}
                        className="text-primary"
                      />
                    ))}
                  </g>
                ))}

                {visibleEdges.map((edge, index) => {
                  const a = placements.get(edge.from);
                  const b = placements.get(edge.to);
                  if (!a || !b) return null;
                  const shape = edgeShapes[index];
                  const dx = b.x - a.x;
                  const dy = b.y - a.y;
                  const len = Math.hypot(dx, dy) || 1;
                  const ux = dx / len;
                  const uy = dy / len;
                  const gap = 16;
                  const x1 = a.x + ux * gap;
                  const y1 = a.y + uy * gap;
                  const x2 = b.x - ux * gap;
                  const y2 = b.y - uy * gap;
                  const flip = edge.from < edge.to ? 1 : -1;
                  const curve =
                    shape.total <= 1 ? 0 : (shape.order - (shape.total - 1) / 2) * 26 * flip;
                  const cx = (x1 + x2) / 2 + -uy * curve * 2;
                  const cy = (y1 + y2) / 2 + ux * curve * 2;
                  const mx = (x1 + x2) / 2 + -uy * curve;
                  const my = (y1 + y2) / 2 + ux * curve + (curve === 0 ? -8 : 4);
                  const mutual = inferMutual(edge.label ?? "");
                  const shownLabel = edge.label || t("认识");
                  // 边标签要在缩放时保持屏幕字号，所以整组尺寸都按相机倍率反算。
                  const fontSize = (10 * labelScale) / viewport.scale;
                  const labelWidth = Math.max(26, shownLabel.length * fontSize * 0.62 + 10);
                  const labelHeight = Math.max(17, fontSize * 1.6);
                  const editable =
                    canEdit && edge.isNew && editableRelationIndexByEdge.has(edgeKeyOf(edge));
                  const markerEnd = edge.isNew
                    ? "url(#draft-graph-arrow-new)"
                    : "url(#draft-graph-arrow-archive)";
                  return (
                    <g key={edge.id}>
                      <path
                        d={`M ${x1} ${y1} Q ${cx} ${cy} ${x2} ${y2}`}
                        fill="none"
                        className={edge.isNew ? "stroke-primary/70" : "stroke-muted-foreground/50"}
                        strokeWidth={edge.isNew ? 1.8 : 1.4}
                        strokeDasharray={edge.isNew ? undefined : "6 5"}
                        markerEnd={markerEnd}
                        markerStart={mutual ? markerEnd : undefined}
                        pointerEvents="none"
                      />
                      <g
                        className={editable ? "cursor-pointer" : undefined}
                        pointerEvents={editable ? undefined : "none"}
                        onClick={editable ? () => editEdgeRelation(edge) : undefined}
                      >
                        <rect
                          x={mx - labelWidth / 2}
                          y={my - labelHeight / 2}
                          width={labelWidth}
                          height={labelHeight}
                          rx={5}
                          className={edge.isNew ? "fill-background/90" : "fill-background/80"}
                        />
                        <text
                          x={mx}
                          y={my + fontSize * 0.35}
                          textAnchor="middle"
                          className={cn(
                            "font-medium",
                            edge.isNew ? "fill-foreground" : "fill-muted-foreground",
                          )}
                          style={{ fontSize: `${fontSize}px` }}
                        >
                          {shownLabel}
                        </text>
                      </g>
                    </g>
                  );
                })}

                {visibleNodes.map((node) => {
                  const point = placements.get(node.id);
                  if (!point) return null;
                  const active = node.id === linkFromId || node.id === linkToId;
                  const showHalo = node.haloed && viewMode !== "archive";
                  return (
                    <g
                      key={node.id}
                      className={canEdit ? "cursor-pointer" : undefined}
                      onClick={canEdit ? () => clickNode(node) : undefined}
                    >
                      {showHalo && (
                        <circle
                          cx={point.x}
                          cy={point.y}
                          r={18}
                          className="fill-primary/15"
                          pointerEvents="none"
                        />
                      )}
                      {/* 手机上要够大：节点本身很小，点击热区单独画一个透明的圆。 */}
                      <circle
                        cx={point.x}
                        cy={point.y}
                        r={24}
                        fill="transparent"
                        pointerEvents="all"
                      />
                      <circle
                        cx={point.x}
                        cy={point.y}
                        r={active ? 13 : 10}
                        className={
                          active
                            ? "fill-primary stroke-primary"
                            : node.isNew
                              ? "fill-primary"
                              : "fill-primary/20 stroke-primary"
                        }
                        strokeWidth={1.4}
                        pointerEvents="none"
                      />
                    </g>
                  );
                })}
              </g>
              {/* 屏幕空间的文字层：字号是 CSS px，不随世界缩放变小 */}
              <g data-draft-graph-labels="true">
                {draftLabels.groupLabels.map((label) => (
                  <text
                    key={label.id}
                    x={label.x + label.width / 2}
                    y={label.y + label.height / 2 + 11 * labelScale * 0.35}
                    textAnchor="middle"
                    fontSize={11 * labelScale}
                    className="pointer-events-none fill-muted-foreground font-medium"
                  >
                    {label.text}
                  </text>
                ))}
                {draftLabels.nodeLabels.map((label) => (
                  <g
                    key={label.id}
                    className="pointer-events-none"
                    data-draft-node-label={label.id}
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
                      y={label.height / 2 + 11 * labelScale * 0.35}
                      textAnchor="middle"
                      fontSize={11 * labelScale}
                      className="fill-foreground font-medium"
                    >
                      {label.text}
                    </text>
                  </g>
                ))}
              </g>
            </svg>
          )}
          <Button
            type="button"
            size="icon"
            variant="outline"
            className="absolute right-3 top-3 z-20 size-9 bg-background/90 shadow-sm backdrop-blur"
            onClick={() => void toggleGraphFullscreen()}
            aria-label={t(graphFullscreen ? "退出全屏" : "把预览放大到全屏")}
            title={t(graphFullscreen ? "退出全屏" : "把预览放大到全屏")}
          >
            {graphFullscreen ? (
              <Minimize2 className="size-4" aria-hidden="true" />
            ) : (
              <Maximize2 className="size-4" aria-hidden="true" />
            )}
          </Button>
        </div>

        {linkFromId && (
          <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-primary/40 bg-primary/5 p-2">
            <span className="text-xs">
              {linkFromName || linkFromId} → {linkToName || t("再点一个人")}
            </span>
            {linkToId && (
              <>
                <Input
                  value={label}
                  onChange={(event) => setLabel(event.target.value)}
                  onKeyDown={(event) => event.key === "Enter" && confirmLink()}
                  className="h-8 w-32 text-xs"
                  placeholder={t("关系，如 同事")}
                />
                <Button className="h-8 rounded-full px-3 text-xs" onClick={confirmLink}>
                  {t("连上")}
                </Button>
              </>
            )}
            <button
              type="button"
              className="ml-auto text-muted-foreground hover:text-foreground"
              onClick={clearLink}
              aria-label={t("取消")}
            >
              <X className="size-3.5" aria-hidden="true" />
            </button>
          </div>
        )}

        {canEdit && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Input
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || !newName.trim()) return;
                onAddPerson(newName.trim());
                setNewName("");
              }}
              className="h-8 w-40 text-xs"
              placeholder={t("加个人，输名字回车")}
              aria-label={t("加个人，输名字回车")}
            />
            <Button
              variant="outline"
              className="h-8 rounded-full px-3 text-xs"
              disabled={!newName.trim()}
              onClick={() => {
                onAddPerson(newName.trim());
                setNewName("");
              }}
            >
              <Plus className="size-3.5" aria-hidden="true" />
              {t("加人物")}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
