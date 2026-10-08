import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  AgentProviderId,
  AppSettings,
  BrowserCanvasState,
  BrowserSnapshot,
  CameraState,
  CanvasOverlayPlacement,
  CanvasRegion,
  HomeGridSize,
  HomeWidgetPlacement,
  InstalledPlugin,
  LimitsSnapshot,
  Point,
  ProviderId,
  RadialLauncherItemId,
  SessionBounds,
  SessionSnapshot,
  StickyNote
} from "../../../../shared/contracts";
import { UiIcon } from "../../components/UiIcon";
import { t } from "../../lib/i18n";
import { displayCanvasNavigationBinding, matchesPhysicalOrLayoutKey, matchesShortcut } from "../../lib/shortcuts";
import { BrowserCard } from "../browser/BrowserCard";
import type { LimitsLoadState } from "../home/homeModel";
import { homeGridPixelSize, homeLayoutFitsGrid } from "../home/homeLayout";
import { HomeZone } from "../home/HomeZone";
import { RadialLauncher } from "../launcher/QuickRadialMenu";
import { StickyNoteCard } from "../notes/StickyNoteCard";
import { stickyNoteAtPoint } from "../notes/stickyNoteBounds";
import { AgentScene } from "../orchestration/AgentScene";
import { BOARD_SIZE, BoardCard } from "../orchestration/BoardCard";
import { useBoard } from "../orchestration/useBoard";
import { OrchestrationOverlays } from "../orchestration/OrchestrationDialogs";
import { activityRuns } from "../orchestration/runStatus";
import { useAgentCanvasUi } from "../orchestration/useAgentCanvasUi";
import { useOrchestration } from "../orchestration/useOrchestration";
import { NotifyBanner, useRunNotifications } from "../orchestration/useRunNotifications";
import { PluginCanvasCard } from "../plugins/PluginCanvasCard";
import { TerminalCard } from "../terminal/TerminalCard";
import { CanvasCommandPalette } from "./CanvasCommandPalette";
import { CanvasContextMenu } from "./CanvasContextMenu";
import { CanvasMinimap } from "./CanvasMinimap";
import { CanvasRegionCard } from "./CanvasRegionCard";
import { CanvasRegionMenu } from "./CanvasRegionMenu";
import {
  clampCanvasMenuPosition,
  routeCanvasContextMenu,
  type CanvasContextHit,
  type CanvasContextMenuKind
} from "./canvasContextRouting";
import {
  CANVAS_REGION_COLORS,
  boundsInsideRegion,
  canvasRegionAtPoint,
  translateBounds
} from "./canvasRegions";
import {
  boundsEqual,
  boundsOverlap,
  bringCanvasLayerToFront,
  canvasLayerIsOccluded,
  canvasLayerZIndex,
  canvasScreenRect,
  reconcileCanvasLayerOrder
} from "./canvasStacking";
import {
  browserCanvasWidgetId,
  canvasWidgetTarget,
  pluginCanvasWidgetId,
  terminalCanvasWidgetId
} from "./canvasWidgetFocus";
import { boundsIntersect } from "./minimapGeometry";
import {
  agentLayerId,
  boardLayerId,
  browserLayerId,
  noteLayerId,
  parseCanvasLayerId,
  pluginLayerId,
  terminalLayerId
} from "./canvasSelectionGesture";
import { snapMove } from "./snap";
import { useCanvasPointerNavigation } from "./useCanvasPointerNavigation";
import { useCanvasWheelNavigation } from "./useCanvasWheelNavigation";
import { useCanvasWidgetFocus } from "./useCanvasWidgetFocus";
import { closeHasWork, closeRunStatus, folderHolderOf, knownWorkspaces, runOwners, workspaceCounts, workspaceOf } from "../workspaces/workspaceModel";
import {
  BrowserElsewhereDialog, WorkspaceBar, WorkspaceDialogs, workspaceTitle,
  type WorkspaceControls, type WorkspaceDialog
} from "../workspaces/WorkspaceUi";

const CANVAS_OVERLAY_PLACEMENTS: CanvasOverlayPlacement[] = [
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right"
];

const EMPTY_MARQUEE_SELECTION: ReadonlySet<string> = new Set<string>();

/** A group drag's commit basis, frozen once when the press activates: the pressed layer's start
 * bounds plus every member's, so nothing the gesture itself previews can feed back into it. */
type GroupDragBasis = {
  layerId: string;
  anchor: SessionBounds;
  members: ReadonlyMap<string, SessionBounds>;
};
type CanvasMenuState = {
  kind: CanvasContextMenuKind;
  position: Point;
  worldPoint: Point;
  targetId?: string;
};

type RegionEditorState = {
  mode: "create";
  focus: "title" | "color";
  position: Point;
  worldPoint: Point;
} | {
  mode: "edit";
  focus: "title" | "color";
  position: Point;
  regionId: string;
};

type RegionMovePreview = {
  regionId: string;
  startBounds: SessionBounds;
  currentBounds: SessionBounds;
  sessionBounds: ReadonlyMap<string, SessionBounds>;
  pluginBounds: ReadonlyMap<string, SessionBounds>;
  browserBounds: SessionBounds | null;
  noteBounds: ReadonlyMap<string, SessionBounds>;
};

interface WorkspaceCanvasProps {
  settings: AppSettings; // the active workspace's items only
  workspace: WorkspaceControls;
  mediaData: string | null;
  sessions: SessionSnapshot[];
  sessionsLoadState: LimitsLoadState;
  onRetrySessions(): void;
  limits: LimitsSnapshot | null;
  limitsLoadState: LimitsLoadState;
  plugins: InstalledPlugin[];
  browser: BrowserSnapshot;
  browserViewVisible: boolean;
  homeEditing: boolean;
  camera: CameraState;
  // workspaceId: the workspace shown when the change was made; the application drops it once another is shown.
  onCameraChange(camera: CameraState, workspaceId: string): void;
  onGoHome(): void;
  onOpenSettings(): void;
  onOpenAgent(provider: AgentProviderId, position?: Point): void;
  onOpenTerminal(position?: Point): void;
  onOpenBrowser(position?: Point): void;
  onOpenTerminalUrl(url: string): void;
  onFocusSession(session: SessionSnapshot): void;
  activeSessionId: string | null;
  browserSelected: boolean;
  renamingSessionId: string | null;
  onSelectSession(id: string): void;
  onSelectBrowser(): void;
  onClearCanvasSelection(): void;
  onRenameSession(id: string, title: string): Promise<void>;
  onRenameEnd(): void;
  onRequestMedia(): Promise<void>;
  onRemoveMedia(): Promise<void>;
  onHomeLayoutChange(layout: HomeWidgetPlacement[]): void;
  onHomeGridSizeChange(gridSize: HomeGridSize): void;
  onFinishHomeEdit(): void;
  onResetHomeLayout(): void;
  onPluginError(message: string): void;
  onPluginCanvasBoundsChange(id: string, bounds: SessionBounds): void;
  onDisposePluginCanvas(id: string): void;
  onFocusPluginCanvas(id: string): void;
  onSessionBoundsChange(id: string, bounds: SessionBounds): void;
  onRestartSession(id: string): Promise<void>;
  onDisposeSession(id: string): void;
  onBrowserBoundsChange(bounds: BrowserCanvasState): void;
  onFocusBrowser(): void;
  onCloseBrowser(): void;
  onCreateCanvasRegion(region: CanvasRegion): void;
  onChangeCanvasRegion(region: CanvasRegion): void;
  onCanvasRegionBoundsChange(id: string, bounds: SessionBounds, interaction: "move" | "resize"): void;
  onDeleteCanvasRegion(id: string): void;
  onCreateStickyNote(note: StickyNote): void;
  onStickyNoteBoundsChange(id: string, bounds: SessionBounds): void;
  onStickyNoteTextChange(id: string, text: string): void;
  onDeleteStickyNote(id: string): void;
}

export function WorkspaceCanvas(props: WorkspaceCanvasProps): React.JSX.Element {
  const {
    settings, workspace, mediaData, sessions, sessionsLoadState, onRetrySessions, limits, limitsLoadState, plugins, browser,
    browserViewVisible, homeEditing, camera, onCameraChange, onGoHome,
    onOpenSettings, onOpenAgent, onOpenTerminal, onOpenBrowser, onOpenTerminalUrl, onFocusSession,
    activeSessionId, browserSelected, renamingSessionId, onSelectSession,
    onSelectBrowser, onClearCanvasSelection, onRenameSession, onRenameEnd,
    onRequestMedia, onRemoveMedia, onHomeLayoutChange, onHomeGridSizeChange,
    onFinishHomeEdit, onResetHomeLayout, onPluginError, onPluginCanvasBoundsChange,
    onDisposePluginCanvas, onFocusPluginCanvas, onSessionBoundsChange,
    onRestartSession, onDisposeSession, onBrowserBoundsChange, onFocusBrowser,
    onCloseBrowser, onCreateCanvasRegion, onChangeCanvasRegion,
    onCanvasRegionBoundsChange, onDeleteCanvasRegion, onCreateStickyNote,
    onStickyNoteBoundsChange, onStickyNoteTextChange, onDeleteStickyNote
  } = props;
  const viewport = useRef<HTMLDivElement>(null);
  // Orchestration agent cards live in main (stage-8-contract.md §2), not in settings.
  const orch = useOrchestration();
  const agentUi = useAgentCanvasUi(orch, settings.locale, workspace.activeId);
  // B2: the task board; its place on this workspace's canvas is kept in board.json (absent: not shown)
  const board = useBoard(orch);
  const boardPlace = board.view?.board.places?.[workspace.activeId] ?? null;
  // Project workspaces (workspaces-spec.md §5–§6): this canvas draws the active workspace's agents; the widget, the
  // switcher's counts and the history read every workspace from the same state.
  const knownWorkspace = useMemo(() => knownWorkspaces(workspace.state), [workspace.state]);
  const ownerOfRun = useMemo(() => runOwners(orch.canvas, knownWorkspace), [knownWorkspace, orch.canvas]);
  const visibleAgents = useMemo(() => orch.canvas.agents.filter((a) => workspaceOf(a, knownWorkspace) === workspace.activeId),
    [knownWorkspace, orch.canvas.agents, workspace.activeId]);
  const sceneOrch = useMemo(() => {
    const ids = new Set(visibleAgents.map((a) => a.agentId));
    return { ...orch, canvas: { ...orch.canvas, agents: visibleAgents, links: orch.canvas.links.filter((l) => ids.has(l.fromAgentId)) } };
  }, [orch, visibleAgents]);
  const manyWorkspaces = workspace.state.workspaces.length > 1;
  const placeName = useCallback((id: string) => workspaceTitle(settings.locale, workspace.state.workspaces.find((w) => w.id === id)), [settings.locale, workspace.state.workspaces]);
  // The home widget's runs: every link's latest run from the application's own state, in any project and workspace.
  const orchestrationActivity = useMemo(() => ({
    status: orch.canvasStatus,
    rows: (now: number) => {
      const rows = activityRuns(settings.locale, {
        links: orch.canvas.links, agents: orch.canvas.agents, runs: orch.runs,
        entries: (runId) => orch.activity[runId]?.entries ?? [],
        lastRecordAt: (runId) => orch.journals[runId]?.records.at(-1)?.ts ?? null,
        runErrors: orch.runErrors, stageTitles: orch.stageTitles, now
      });
      if (!manyWorkspaces) return rows;
      const named = (r: typeof rows.active[number]) => ({ ...r, project: `${placeName(ownerOfRun(r.runId))} · ${r.project}` });
      return { active: rows.active.map(named), recent: rows.recent.map(named) };
    }
  }), [manyWorkspaces, orch.activity, orch.canvas, orch.canvasStatus, orch.journals, orch.runErrors, orch.runs, orch.stageTitles, ownerOfRun, placeName, settings.locale]);
  const widgetSessions = useMemo(() => (manyWorkspaces
    ? workspace.allSessions.map((s) => ({ ...s, title: `${placeName(workspaceOf(s, knownWorkspace))} · ${s.title}` }))
    : workspace.allSessions), [knownWorkspace, manyWorkspaces, placeName, workspace.allSessions]);
  const counts = workspaceCounts({
    sessions: workspace.allSessions,
    runs: orchestrationActivity.rows(Date.now()).active.map((r) => ({ runId: r.runId, state: r.line?.state ?? null })),
    owner: ownerOfRun, known: knownWorkspace
  });
  const [wsDialog, setWsDialog] = useState<WorkspaceDialog | null>(null);
  // From the widget or the history: the run's own workspace, its lead card in view, its panel.
  const openRunInWorkspace = useCallback((runId: string, tab?: "summary", target = ownerOfRun(runId)): void => {
    workspace.switchTo(target);
    const link = orch.canvas.links.find((l) => l.runIds.at(-1) === runId);
    const lead = link ? orch.canvas.agents.find((a) => a.agentId === link.fromAgentId) : undefined;
    if (lead && workspaceOf(lead, knownWorkspace) === target) workspace.focusBounds(lead.bounds);
    if (link && !tab) agentUi.openRun(link.linkId);
    else if (link) agentUi.openPanel(link.linkId, { tab });
    else agentUi.openRunById(runId, tab);
  }, [agentUi, knownWorkspace, orch.canvas, ownerOfRun, workspace]);
  // UX audit PR 3: a notification names the project (and its workspace where there are several), never a path
  const noteTitle = useCallback((runId: string): string => {
    const link = orch.canvas.links.find((l) => l.runIds.includes(runId));
    const lead = link ? orch.canvas.agents.find((a) => a.agentId === link.fromAgentId) : undefined;
    const project = lead?.project.split("/").filter(Boolean).at(-1) ?? "Raoden Loom";
    return manyWorkspaces ? `${placeName(ownerOfRun(runId))} · ${project}` : project;
  }, [manyWorkspaces, orch.canvas, ownerOfRun, placeName]);
  const notes = useRunNotifications({ locale: settings.locale, prefs: settings.notifications, runs: orch.runs, activity: orch.activity, title: noteTitle, open: openRunInWorkspace });
  // The run holding the folder and its workspace are main's answer, not rebuilt here from snapshots.
  const folderBusy = useCallback((held: unknown) => {
    const h = folderHolderOf(held, knownWorkspace);
    return h && { name: placeName(h.workspaceId), runReadable: h.runReadable,
      open: () => { agentUi.closeGoal(); openRunInWorkspace(h.runId, undefined, h.workspaceId); } };
  }, [agentUi, knownWorkspace, openRunInWorkspace, placeName]);
  // Where cards stand in each workspace, for placing a moved card where it covers nothing (HOME is in every one).
  const workspaceLayout = useMemo(() => {
    const home = { position: { x: 0, y: 0 }, size: homeGridPixelSize(settings.homeGridSize) };
    const all = workspace.allSettings;
    const items = [...workspace.allSessions, ...all.stickyNotes, ...all.pluginCanvas, ...(all.browserCanvas ? [all.browserCanvas] : [])];
    return {
      occupiedIn: (ws: string) => [home, ...items.filter((x) => workspaceOf(x, knownWorkspace) === ws),
        ...orch.canvas.agents.filter((a) => workspaceOf(a, knownWorkspace) === ws).map((a) => a.bounds)],
      boxesOf: (item: string, ids: string[]) => item === "agents"
        ? orch.canvas.agents.filter((a) => ids.includes(a.agentId)).map((a) => a.bounds)
        : item === "terminal" ? workspace.allSessions.filter((x) => ids.includes(x.id))
          : item === "region" ? all.canvasRegions.filter((x) => ids.includes(x.id))
            : item === "note" ? all.stickyNotes.filter((x) => ids.includes(x.id))
              : item === "plugin" ? all.pluginCanvas.filter((x) => ids.includes(x.id))
                : all.browserCanvas ? [all.browserCanvas] : []
    };
  }, [knownWorkspace, orch.canvas.agents, settings.homeGridSize, workspace.allSessions, workspace.allSettings]);
  const openWsDialog = useCallback((d: WorkspaceDialog): void => {
    // Hiding a workspace with no work in it asks nothing; an open shell is not work (§6).
    if (d.kind === "close" && !closeHasWork({ workspaceId: d.id, sessions: workspace.allSessions, links: orch.canvas.links, owner: ownerOfRun,
      runStatus: (r) => closeRunStatus(orch.runs[r]?.view), known: knownWorkspace })) {
      void workspace.close(d.id).then((text) => text && workspace.notify(text));
      return;
    }
    setWsDialog(d);
  }, [knownWorkspace, orch.canvas.links, orch.runs, ownerOfRun, workspace]);
  const [contextMenu, setContextMenu] = useState<CanvasMenuState | null>(null);
  const [regionEditor, setRegionEditor] = useState<RegionEditorState | null>(null);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [radialLauncher, setRadialLauncher] = useState<{
    anchor: Point;
    pointerAnchor: Point;
    canvasPosition: Point;
    pointerId: number;
  } | null>(null);
  const suppressNextContextMenu = useRef(false);
  const pendingRadialContextMenu = useRef<CanvasMenuState | null>(null);
  const [noteEditRequest, setNoteEditRequest] = useState<{ id: string; version: number } | null>(null);
  const [regionMovePreview, setRegionMovePreview] = useState<RegionMovePreview | null>(null);
  const [marqueeSelection, setMarqueeSelection] = useState<ReadonlySet<string>>(EMPTY_MARQUEE_SELECTION);
  const overlays = useRef<HTMLDivElement>(null);
  const [overlayRects, setOverlayRects] = useState<SessionBounds[]>([]);
  const cameraRef = useRef(camera);
  cameraRef.current = camera;
  const shownWorkspace = useRef(workspace.activeId);
  shownWorkspace.current = workspace.activeId;
  const commitCamera = useCallback((next: CameraState): void => {
    cameraRef.current = next;
    onCameraChange(next, shownWorkspace.current);
  }, [onCameraChange]);

  const updateRegionMovePreview = useCallback((regionId: string, bounds: SessionBounds | null): void => {
    setRegionMovePreview((current) => {
      if (bounds === null) return current?.regionId === regionId ? null : current;
      if (current?.regionId === regionId) return { ...current, currentBounds: copyBounds(bounds) };
      const region = settings.canvasRegions.find((candidate) => candidate.id === regionId);
      if (!region) return null;
      const startRegion = { ...region, ...copyBounds(bounds) };
      return {
        regionId,
        startBounds: copyBounds(bounds),
        currentBounds: copyBounds(bounds),
        sessionBounds: containedBounds(sessions, startRegion),
        pluginBounds: containedBounds(settings.pluginCanvas, startRegion),
        browserBounds: settings.browserCanvas && boundsInsideRegion(settings.browserCanvas, startRegion)
          ? copyBounds(settings.browserCanvas)
          : null,
        noteBounds: containedBounds(settings.stickyNotes, startRegion)
      };
    });
  }, [sessions, settings.browserCanvas, settings.canvasRegions, settings.pluginCanvas, settings.stickyNotes]);

  // A press can lose its pointer (window blur, leaving Edit HOME) before it reaches a
  // pointer-up, so the scene drops any live preview instead of leaving it stuck.
  const clearRegionMovePreview = useCallback((): void => {
    setRegionMovePreview(null);
  }, []);

  useEffect(() => {
    window.addEventListener("blur", clearRegionMovePreview);
    return () => window.removeEventListener("blur", clearRegionMovePreview);
  }, [clearRegionMovePreview]);

  useEffect(() => {
    if (homeEditing) clearRegionMovePreview();
  }, [clearRegionMovePreview, homeEditing]);

  const previewDelta = regionMovePreview ? {
    x: regionMovePreview.currentBounds.position.x - regionMovePreview.startBounds.position.x,
    y: regionMovePreview.currentBounds.position.y - regionMovePreview.startBounds.position.y
  } : null;
  const renderedCanvasRegions = useMemo(() => settings.canvasRegions.map((region) => (
    regionMovePreview?.regionId === region.id
      ? { ...region, ...copyBounds(regionMovePreview.currentBounds) }
      : region
  )), [regionMovePreview, settings.canvasRegions]);
  const renderedSessions = useMemo(() => sessions.map((session) => {
    const start = regionMovePreview?.sessionBounds.get(session.id);
    return start && previewDelta ? { ...session, ...translateBounds(start, previewDelta) } : session;
  }), [previewDelta, regionMovePreview, sessions]);
  const renderedPluginCanvas = useMemo(() => settings.pluginCanvas.map((instance) => {
    const start = regionMovePreview?.pluginBounds.get(instance.id);
    return start && previewDelta ? { ...instance, ...translateBounds(start, previewDelta) } : instance;
  }), [previewDelta, regionMovePreview, settings.pluginCanvas]);
  const renderedBrowserCanvas = useMemo(() => (
    settings.browserCanvas && regionMovePreview?.browserBounds && previewDelta
      ? { ...settings.browserCanvas, ...translateBounds(regionMovePreview.browserBounds, previewDelta) }
      : settings.browserCanvas
  ), [previewDelta, regionMovePreview, settings.browserCanvas]);
  const renderedStickyNotes = useMemo(() => settings.stickyNotes.map((note) => {
    const start = regionMovePreview?.noteBounds.get(note.id);
    return start && previewDelta ? { ...note, ...translateBounds(start, previewDelta) } : note;
  }), [previewDelta, regionMovePreview, settings.stickyNotes]);

  const renderablePluginIds = useMemo(() => new Set(settings.pluginCanvas.filter((instance) => {
    const plugin = plugins.find((candidate) => candidate.manifest.id === instance.pluginId && candidate.enabled);
    return plugin?.manifest.contributions.some((candidate) => (
      candidate.id === instance.contributionId && candidate.kind === "canvas-app"
    ));
  }).map((instance) => instance.id)), [plugins, settings.pluginCanvas]);
  const activeLayerIds = useMemo(() => [
    ...renderedSessions.map((session) => terminalLayerId(session.id)),
    ...renderedPluginCanvas.filter((instance) => renderablePluginIds.has(instance.id)).map((instance) => pluginLayerId(instance.id)),
    ...(renderedBrowserCanvas ? [browserLayerId] : []),
    ...renderedStickyNotes.map((note) => noteLayerId(note.id)),
    ...visibleAgents.map((card) => agentLayerId(card.agentId)),
    ...(boardPlace ? [boardLayerId(workspace.activeId)] : [])
  ], [boardPlace, workspace.activeId, visibleAgents, renderablePluginIds, renderedBrowserCanvas, renderedPluginCanvas, renderedSessions, renderedStickyNotes]);
  const [layerOrder, setLayerOrder] = useState<string[]>(activeLayerIds);
  useEffect(() => {
    setLayerOrder((current) => reconcileCanvasLayerOrder(current, activeLayerIds));
  }, [activeLayerIds]);
  const raiseLayer = useCallback((id: string): void => {
    setLayerOrder((current) => bringCanvasLayerToFront(current, id));
  }, []);
  const boundsByLayer = useMemo(() => {
    const result = new Map<string, SessionBounds>();
    for (const session of renderedSessions) result.set(terminalLayerId(session.id), session);
    for (const instance of renderedPluginCanvas) {
      if (renderablePluginIds.has(instance.id)) result.set(pluginLayerId(instance.id), instance);
    }
    if (renderedBrowserCanvas) result.set(browserLayerId, renderedBrowserCanvas);
    for (const note of renderedStickyNotes) result.set(noteLayerId(note.id), note);
    for (const card of visibleAgents) result.set(agentLayerId(card.agentId), card.bounds);
    if (boardPlace) result.set(boardLayerId(workspace.activeId), boardPlace);
    return result;
  }, [boardPlace, workspace.activeId, visibleAgents, renderablePluginIds, renderedBrowserCanvas, renderedPluginCanvas, renderedSessions, renderedStickyNotes]);
  const browserOccluded = renderedBrowserCanvas !== null
    && canvasLayerIsOccluded(browserLayerId, layerOrder, boundsByLayer);
  // Every window on the canvas, in the order they are rendered: terminals, plugin canvases, browser, notes, agents.
  const allWindowBounds: SessionBounds[] = [
    ...renderedSessions,
    ...renderedPluginCanvas.filter((instance) => renderablePluginIds.has(instance.id)),
    ...(renderedBrowserCanvas ? [renderedBrowserCanvas] : []),
    ...renderedStickyNotes,
    ...visibleAgents.map((card) => card.bounds),
    ...(boardPlace ? [boardPlace] : [])
  ];

  const homeBounds: SessionBounds = {
    position: { x: 0, y: 0 },
    size: homeGridPixelSize(settings.homeGridSize)
  };

  const selectMarquee = useCallback((bounds: SessionBounds | null): void => {
    if (bounds === null) {
      setMarqueeSelection(EMPTY_MARQUEE_SELECTION);
      return;
    }
    // Every rendered layer, not just terminals: the selection holds `data-canvas-layer-id` values.
    const ids = [...boundsByLayer]
      .filter(([, layerBounds]) => boundsIntersect(bounds, layerBounds))
      .map(([layerId]) => layerId);
    // Presentation-only: the marquee never moves logical input focus or the active
    // session, and a group drag is read from the selection alone.
    setMarqueeSelection(ids.length === 0 ? EMPTY_MARQUEE_SELECTION : new Set(ids));
  }, [boundsByLayer]);

  const groupDragBasis = useRef<GroupDragBasis | null>(null);

  const beginGroupDrag = useCallback((layerId: string): void => {
    const anchor = boundsByLayer.get(layerId);
    if (!anchor) return;
    // Frozen here, once: the preview moves the rendered bounds, so the commit must not
    // read them back, and a layer that appears mid-gesture is not part of this drag.
    const members = new Map<string, SessionBounds>();
    for (const memberLayerId of [layerId, ...marqueeSelection]) {
      const memberBounds = boundsByLayer.get(memberLayerId);
      if (memberBounds) members.set(memberLayerId, memberBounds);
    }
    groupDragBasis.current = { layerId, anchor, members };
  }, [boundsByLayer, marqueeSelection]);

  const commitGroupDrag = useCallback((layerId: string, delta: Point): void => {
    const basis = groupDragBasis.current;
    groupDragBasis.current = null;
    if (!basis || basis.layerId !== layerId) return;
    const { anchor, members } = basis;
    // The pressed card is the only one that snaps: one `snapMove` call yields a rigid
    // world delta applied to every member, so relative offsets survive. Members are
    // excluded from the targets, otherwise a card would snap onto its own neighbours.
    const targets = [
      homeBounds,
      ...renderedCanvasRegions.map((candidate) => ({ position: candidate.position, size: candidate.size })),
      ...[...boundsByLayer]
        .filter(([candidateLayerId]) => !members.has(candidateLayerId))
        .map(([, candidateBounds]) => candidateBounds)
    ];
    const movedAnchor = translateBounds(anchor, delta);
    const anchorPosition = settings.snapToGrid
      ? snapMove(movedAnchor.position, anchor.size, targets)
      : movedAnchor.position;
    const rigid = {
      x: anchorPosition.x - anchor.position.x,
      y: anchorPosition.y - anchor.position.y
    };
    for (const [memberLayerId, memberBounds] of members) {
      const moved = translateBounds(memberBounds, rigid);
      const ref = parseCanvasLayerId(memberLayerId);
      if (!ref) continue;
      // Each card kind owns its commit callback; the browser's takes the whole state.
      if (ref.kind === "terminal" && ref.targetId !== null) onSessionBoundsChange(ref.targetId, moved);
      else if (ref.kind === "plugin" && ref.targetId !== null) onPluginCanvasBoundsChange(ref.targetId, moved);
      else if (ref.kind === "note" && ref.targetId !== null) onStickyNoteBoundsChange(ref.targetId, moved);
      else if (ref.kind === "agent" && ref.targetId !== null) orch.moveAgent(ref.targetId, moved);
      else if (ref.kind === "board" && ref.targetId !== null) void board.place(ref.targetId, moved);
      else if (ref.kind === "browser") onBrowserBoundsChange({ ...settings.browserCanvas, ...moved });
    }
  }, [board.place, boundsByLayer, homeBounds, onBrowserBoundsChange, onPluginCanvasBoundsChange, orch.moveAgent,
    onSessionBoundsChange, onStickyNoteBoundsChange, renderedCanvasRegions, settings.browserCanvas, settings.snapToGrid]);

  const focusController = useCanvasWidgetFocus({
    viewport,
    settings,
    activeSessionId,
    browserSelected,
    widgetTreeVersion: [
      browserViewVisible ? "browser-visible" : "browser-hidden",
      settings.browserCanvas ? "browser-card" : "no-browser-card",
      sessions.map((session) => session.id).join(","),
      plugins.map((plugin) => [
        plugin.manifest.id,
        plugin.enabled ? "enabled" : "disabled",
        plugin.manifest.contributions.map((contribution) => contribution.id).join(",")
      ].join(":")).join(";"),
      settings.pluginCanvas.map((instance) => instance.id).join(","),
      settings.stickyNotes.map((note) => note.id).join(","),
      settings.homeLayout.map((placement) => placement.widgetId).join(",")
    ].join("|")
  });
  // The page area is a native child view, so it composites above every DOM layer including this
  // HUD; the page can only yield by hiding. Slot boxes are measured instead of their children:
  // they are content-sized, which keeps this effect keyed to what can move or resize a slot and
  // not to every row inside the dynamic panels.
  useEffect(() => {
    const root = overlays.current;
    if (!root) return;
    const slots = [...root.querySelectorAll<HTMLElement>(".canvas-overlay-slot")];
    const measure = (): void => {
      const rootRect = root.getBoundingClientRect();
      const next = slots.map((slot) => {
        const rect = slot.getBoundingClientRect();
        return {
          position: { x: rect.left - rootRect.left, y: rect.top - rootRect.top },
          size: { width: rect.width, height: rect.height }
        };
      });
      // Compared by value: a re-render that leaves the layout alone must not publish new state,
      // otherwise the observer and the state update could ping-pong forever.
      setOverlayRects((current) => (
        next.length === current.length && next.every((rect, index) => boundsEqual(rect, current[index]))
          ? current
          : next
      ));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    for (const slot of slots) observer.observe(slot);
    return () => observer.disconnect();
  }, [
    settings.canvasControlsPlacement,
    settings.minimapPlacement,
    settings.shortcutHintsPlacement,
    settings.showShortcutHints,
    settings.uiScale
  ]);
  const browserScreenRect = renderedBrowserCanvas === null
    ? null
    : canvasScreenRect(renderedBrowserCanvas, camera);
  // Both sides are screen-relative to this viewport: the camera translation is measured from the
  // scene origin, and the overlay rects are measured from the overlay root, which shares it.
  const browserUnderOverlay = browserScreenRect !== null
    && overlayRects.some((rect) => boundsOverlap(browserScreenRect, rect));
  const wheelNavigation = useCanvasWheelNavigation({
    viewport,
    settings,
    cameraRef,
    widgetFocusRef: focusController.stateRef,
    commitCamera
  });
  const pointerNavigation = useCanvasPointerNavigation({
    viewport,
    settings,
    cameraRef,
    canvasOverrideActiveRef: wheelNavigation.canvasOverrideActiveRef,
    commitCamera,
    selectedLayerIds: marqueeSelection,
    onMarqueeSelection: selectMarquee,
    onGroupDragStart: beginGroupDrag,
    onGroupDrag: commitGroupDrag
  });
  // A gesture begun in one workspace ends there: a wheel pan waiting for its frame and a pointer pan, marquee or group
  // drag are dropped before the next frame, so they cannot move the camera of the workspace now shown.
  const { cancelPendingPan } = wheelNavigation;
  const { handlePointerCancel } = pointerNavigation;
  const firstWorkspace = useRef(true);
  useLayoutEffect(() => {
    if (firstWorkspace.current) { firstWorkspace.current = false; return; }
    cancelPendingPan();
    handlePointerCancel();
    setRegionMovePreview(null); // a region move carries its cards: a group move too
  }, [workspace.activeId, cancelPendingPan, handlePointerCancel]);
  // Live preview of a travelled group drag: every selected layer of every kind moves together.
  const withGroupNudge = <T extends SessionBounds>(layerId: string, item: T): T => (
    marqueeSelection.has(layerId) && pointerNavigation.groupNudge
      ? { ...item, ...translateBounds(item, pointerNavigation.groupNudge) }
      : item
  );
  const widgetFocus = focusController.state;
  const routeWidgetWheelToCanvas = wheelNavigation.routeWidgetWheelToCanvas;
  const canvasOverrideActive = wheelNavigation.canvasOverrideActive;
  const homeLayoutValid = homeLayoutFitsGrid(settings.homeLayout, settings.homeGridSize);
  const editedRegion = regionEditor?.mode === "edit"
    ? settings.canvasRegions.find((region) => region.id === regionEditor.regionId) ?? null
    : null;
  const contextRegion = contextMenu?.kind === "region"
    ? settings.canvasRegions.find((region) => region.id === contextMenu.targetId) ?? null
    : null;

  const viewportPoint = useCallback((clientX: number, clientY: number): Point => {
    const bounds = viewport.current?.getBoundingClientRect();
    return { x: clientX - (bounds?.left ?? 0), y: clientY - (bounds?.top ?? 0) };
  }, []);
  const menuPosition = useCallback((clientX: number, clientY: number): Point => {
    const bounds = viewport.current?.getBoundingClientRect();
    if (!bounds) return { x: 12, y: 12 };
    return clampCanvasMenuPosition(
      viewportPoint(clientX, clientY),
      { width: bounds.width, height: bounds.height },
      { width: 300 * settings.uiScale, height: 470 * settings.uiScale }
    );
  }, [settings.uiScale, viewportPoint]);
  const worldPoint = useCallback((clientX: number, clientY: number): Point => {
    const point = viewportPoint(clientX, clientY);
    return {
      x: (point.x - camera.x) / camera.zoom,
      y: (point.y - camera.y) / camera.zoom
    };
  }, [camera.x, camera.y, camera.zoom, viewportPoint]);
  const viewportCenterWorldPoint = useCallback((): Point => {
    const bounds = viewport.current?.getBoundingClientRect();
    return {
      x: ((bounds?.width ?? 1) / 2 - camera.x) / camera.zoom,
      y: ((bounds?.height ?? 1) / 2 - camera.y) / camera.zoom
    };
  }, [camera.x, camera.y, camera.zoom]);
  const centerMenuPosition = useCallback((): Point => {
    const bounds = viewport.current?.getBoundingClientRect();
    return {
      x: Math.max(12, (bounds?.width ?? 320) / 2 - 150 * settings.uiScale),
      y: Math.max(12, (bounds?.height ?? 420) / 2 - 120 * settings.uiScale)
    };
  }, [settings.uiScale]);
  const createNote = useCallback((point: Point): void => {
    const note = stickyNoteAtPoint(point, crypto.randomUUID());
    onCreateStickyNote(note);
    setNoteEditRequest((current) => ({ id: note.id, version: (current?.version ?? 0) + 1 }));
    setContextMenu(null);
    setCommandPaletteOpen(false);
  }, [onCreateStickyNote]);
  const launchAt = useCallback((provider: ProviderId, point?: Point): void => {
    if (provider === "terminal") onOpenTerminal(point);
    else onOpenAgent(provider, point);
    setContextMenu(null);
    setCommandPaletteOpen(false);
  }, [onOpenAgent, onOpenTerminal]);

  const activateRadialItem = useCallback((item: RadialLauncherItemId, fromPointerRelease = false): void => {
    const launcher = radialLauncher;
    if (!launcher) return;
    suppressNextContextMenu.current = fromPointerRelease;
    if (fromPointerRelease) {
      window.setTimeout(() => {
        suppressNextContextMenu.current = false;
      }, 0);
    }
    pendingRadialContextMenu.current = null;
    setRadialLauncher(null);
    if (item === "note") createNote(launcher.canvasPosition);
    else if (item === "browser") onOpenBrowser(launcher.canvasPosition);
    else if (item === "settings") onOpenSettings();
    else launchAt(item, launcher.canvasPosition);
  }, [createNote, launchAt, onOpenBrowser, onOpenSettings, radialLauncher]);

  const closeRadialLauncher = useCallback((reason: "release" | "cancel" = "cancel"): void => {
    setRadialLauncher(null);
    if (reason === "release" && pendingRadialContextMenu.current) {
      setContextMenu(pendingRadialContextMenu.current);
    }
    pendingRadialContextMenu.current = null;
  }, []);

  const openRadialLauncher = useCallback((event: React.PointerEvent<HTMLDivElement>): boolean => {
    if (!settings.radialLauncherEnabled || event.button !== 2 || shouldKeepCanvasContextMenu(event.target)) return false;
    const anchor = viewportPoint(event.clientX, event.clientY);
    pendingRadialContextMenu.current = null;
    setContextMenu(null);
    setRegionEditor(null);
    setCommandPaletteOpen(false);
    setRadialLauncher({
      anchor,
      pointerAnchor: { x: event.clientX, y: event.clientY },
      canvasPosition: worldPoint(event.clientX, event.clientY),
      pointerId: event.pointerId
    });
    event.stopPropagation();
    return true;
  }, [settings.radialLauncherEnabled, viewportPoint, worldPoint]);

  useEffect(() => {
    if (!settings.radialLauncherEnabled) closeRadialLauncher();
  }, [closeRadialLauncher, settings.radialLauncherEnabled]);

  useEffect(() => {
    if (homeEditing || !browserViewVisible) {
      setContextMenu(null);
      setRegionEditor(null);
      setCommandPaletteOpen(false);
      setRadialLauncher(null);
      return;
    }
    const handleShortcut = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      // ⌘1…⌘9 switch workspaces on macOS only: xterm sends no ⌘ chord to the terminal there, while Ctrl+digit is a
      // control code of the terminal and Ctrl+Alt is AltGr on other systems (workspaces-spec.md §5).
      // A chord the person bound to Home or Rename in the settings keeps that meaning.
      if (window.canvasTTY.window.isMacOS && event.metaKey && !event.ctrlKey && !event.shiftKey && /^Digit[1-9]$/.test(event.code)
        && !matchesShortcut(event, settings.shortcuts.home) && !matchesShortcut(event, settings.shortcuts.renameWindow)) {
        const target = workspace.state.workspaces.filter((w) => !w.closed)[Number(event.code.slice(5)) - 1];
        if (target) {
          event.preventDefault();
          workspace.switchTo(target.id);
        }
        return;
      }
      // Matched on the physical key: these chords must work on a non-Latin layout, where
      // the K key reports `key: "л"` and `event.key` alone would never match.
      if (matchesPhysicalOrLayoutKey(event, "KeyK", "k")) {
        event.preventDefault();
        setContextMenu(null);
        setRegionEditor(null);
        setCommandPaletteOpen((current) => !current);
      } else if (matchesPhysicalOrLayoutKey(event, "Comma", ",")) {
        event.preventDefault();
        setContextMenu(null);
        setRegionEditor(null);
        setCommandPaletteOpen(false);
        onOpenSettings();
      }
    };
    window.addEventListener("keydown", handleShortcut, true);
    return () => window.removeEventListener("keydown", handleShortcut, true);
  }, [browserViewVisible, homeEditing, onOpenSettings, workspace]);

  return (
    <div
      ref={viewport}
      className={`workspace pattern-${settings.pattern} ${pointerNavigation.panning ? "workspace--panning" : ""} ${wheelNavigation.zooming ? "workspace--zooming" : ""} ${canvasOverrideActive ? "workspace--canvas-override" : ""}`}
      onPointerDownCapture={(event) => {
        if (openRadialLauncher(event)) return;
        const element = event.target as HTMLElement;
        if (event.button === 0) {
          const layerId = element.closest<HTMLElement>("[data-canvas-layer-id]")?.dataset.canvasLayerId;
          if (layerId) raiseLayer(layerId);
        }
        if (contextMenu && !element.closest(".canvas-menu")) setContextMenu(null);
        if (regionEditor && !element.closest(".canvas-region-editor")) setRegionEditor(null);
        if (pointerNavigation.handlePointerDownCapture(event)) return;
        const target = canvasWidgetTarget(event.target);
        if (target.focusableWidgetId !== null) {
          focusController.cancelHover();
          focusController.focus(target.focusableWidgetId, "explicit");
        }
        if (!element.closest(".terminal-card, .browser-card")) onClearCanvasSelection();
      }}
      onClickCapture={(event) => {
        if (!pointerNavigation.handleClickCapture(event)) focusController.handleClick(event);
      }}
      onAuxClickCapture={pointerNavigation.handleAuxClickCapture}
      onPointerOverCapture={focusController.handlePointerOver}
      onPointerOutCapture={focusController.handlePointerOut}
      onPointerDown={pointerNavigation.handlePointerDown}
      onPointerMove={pointerNavigation.handlePointerMove}
      onPointerMoveCapture={pointerNavigation.handlePointerMoveCapture}
      onPointerUp={pointerNavigation.handlePointerEnd}
      onPointerUpCapture={pointerNavigation.handlePointerEndCapture}
      onPointerCancel={pointerNavigation.handlePointerCancel}
      onPointerCancelCapture={pointerNavigation.handlePointerCancel}
      onPointerLeave={pointerNavigation.handlePointerLeave}
      onContextMenu={(event) => {
        if (suppressNextContextMenu.current) {
          suppressNextContextMenu.current = false;
          event.preventDefault();
          return;
        }
        const element = event.target as HTMLElement;
        const regionId = element.closest<HTMLElement>("[data-canvas-region-id]")?.dataset.canvasRegionId;
        const noteId = element.closest<HTMLElement>("[data-sticky-note-id]")?.dataset.stickyNoteId;
        // A card's header offers "Move to workspace…"; its body and fields keep their own menu.
        const cardLayerId = !element.closest("textarea, input, [contenteditable='true'], button")
          && element.closest(".terminal-card__header, .agent-card__header, .browser-card__header, .plugin-canvas-card__header")
          ? element.closest<HTMLElement>("[data-canvas-layer-id]")?.dataset.canvasLayerId
          : undefined;
        const hit: CanvasContextHit = cardLayerId ? "card" : element.closest("textarea, input, [contenteditable='true'], .terminal-card, .plugin-canvas-card, .browser-card")
          ? "native"
          : noteId
            ? "note"
            : regionId
              ? "region"
              // The home zone's box is larger than its tiles: its bare background is empty canvas to the user.
              : element.classList.contains("home-zone") && !homeEditing
                ? "empty"
                : element.closest(".home-zone, .canvas-overlays, .canvas-menu, .canvas-region-editor, [data-interactive='true']")
                ? "blocked"
                : "empty";
        const kind = routeCanvasContextMenu(hit, homeEditing);
        if (!kind) return;
        event.preventDefault();
        setRegionEditor(null);
        setCommandPaletteOpen(false);
        const nextContextMenu: CanvasMenuState = {
          kind,
          position: menuPosition(event.clientX, event.clientY),
          worldPoint: worldPoint(event.clientX, event.clientY),
          targetId: kind === "region" ? regionId : kind === "note" ? noteId : kind === "card" ? cardLayerId : undefined
        };
        if (radialLauncher) {
          pendingRadialContextMenu.current = nextContextMenu;
          return;
        }
        setContextMenu(nextContextMenu);
      }}
    >
      <div className="workspace__scene" style={{ transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.zoom})` }}>
        <div className={`workspace__regions ${homeEditing ? "workspace__windows--hidden" : ""}`} aria-hidden={homeEditing}>
          {renderedCanvasRegions.map((region) => (
            <CanvasRegionCard
              key={region.id}
              region={region}
              zoom={camera.zoom}
              snapEnabled={settings.snapToGrid}
              snapTargets={[
                homeBounds,
                ...renderedCanvasRegions
                  .filter((candidate) => candidate.id !== region.id)
                  .map((candidate) => ({ position: candidate.position, size: candidate.size }))
              ]}
              onBoundsChange={onCanvasRegionBoundsChange}
              onMovePreview={updateRegionMovePreview}
            />
          ))}
        </div>
        <HomeZone
          settings={settings}
          mediaData={mediaData}
          sessions={widgetSessions}
          sessionsLoadState={sessionsLoadState}
          orchestration={orchestrationActivity}
          onRetryActivity={() => { if (sessionsLoadState === "error") onRetrySessions(); orch.retry(); }}
          onOpenRun={(linkId) => { const r = orch.canvas.links.find((l) => l.linkId === linkId)?.runIds.at(-1); if (r) openRunInWorkspace(r); }}
          onOpenRunSummary={(linkId) => { const r = orch.canvas.links.find((l) => l.linkId === linkId)?.runIds.at(-1); if (r) openRunInWorkspace(r, "summary"); }}
          limits={limits}
          limitsLoadState={limitsLoadState}
          plugins={plugins}
          editing={homeEditing}
          onOpenSettings={onOpenSettings}
          onOpenAgent={onOpenAgent}
          onOpenTerminal={onOpenTerminal}
          onOpenBrowser={() => {
            if (settings.browserCanvas) {
              raiseLayer(browserLayerId);
              focusController.focusBrowser();
            }
            onOpenBrowser();
          }}
          onFocusSession={(session) => {
            raiseLayer(terminalLayerId(session.id));
            focusController.focus(terminalCanvasWidgetId(session.id), "explicit");
            onFocusSession(session);
          }}
          onRequestMedia={onRequestMedia}
          onRemoveMedia={onRemoveMedia}
          onLayoutChange={onHomeLayoutChange}
          onGridSizeChange={onHomeGridSizeChange}
          onPluginError={onPluginError}
          captureCanvasWheelOverWidgets={routeWidgetWheelToCanvas}
          focusedWidgetId={widgetFocus.id}
          onWidgetFocus={(id) => {
            focusController.cancelHover();
            focusController.focus(id, "explicit");
          }}
          onWidgetHoverChange={(id, active) => {
            if (active) focusController.scheduleHover(id);
            else focusController.cancelHover(id);
          }}
          onPluginCanvasWheel={wheelNavigation.applyCanvasWheel}
        />
        <div className={`workspace__windows ${homeEditing ? "workspace__windows--hidden" : ""}`} aria-hidden={homeEditing}>
          {renderedSessions.map((session) => (
            <TerminalCard
              key={session.id}
              session={withGroupNudge(terminalLayerId(session.id), session)}
              locale={settings.locale}
              palette={settings.palette}
              zoom={camera.zoom}
              stackIndex={canvasLayerZIndex(layerOrder, terminalLayerId(session.id))}
              snapEnabled={settings.snapToGrid}
              focusActivation={settings.focusActivation}
              invertTerminalWheel={settings.invertTerminalWheel}
              captureCanvasWheelOverWidgets={routeWidgetWheelToCanvas || widgetFocus.id !== terminalCanvasWidgetId(session.id)}
              focused={widgetFocus.id === terminalCanvasWidgetId(session.id)}
              focusChangeSource={widgetFocus.source}
              selected={activeSessionId === session.id}
              groupSelected={marqueeSelection.has(terminalLayerId(session.id))}
              renaming={renamingSessionId === session.id}
              snapTargets={[
                homeBounds,
                ...renderedCanvasRegions.map((candidate) => ({ position: candidate.position, size: candidate.size })),
                ...allWindowBounds.filter((candidate) => candidate !== session)
              ]}
              onActivate={(selectedSession) => {
                raiseLayer(terminalLayerId(selectedSession.id));
                focusController.focus(terminalCanvasWidgetId(selectedSession.id), "explicit");
                onFocusSession(selectedSession);
              }}
              onSelect={(id) => {
                raiseLayer(terminalLayerId(id));
                focusController.cancelHover();
                focusController.focus(terminalCanvasWidgetId(id), "explicit");
                onSelectSession(id);
              }}
              onRename={onRenameSession}
              onRenameEnd={onRenameEnd}
              onBoundsChange={onSessionBoundsChange}
              onRestart={onRestartSession}
              onDispose={onDisposeSession}
              onOpenUrl={onOpenTerminalUrl}
            />
          ))}
          {renderedPluginCanvas.map((instance) => {
            const plugin = plugins.find((candidate) => candidate.manifest.id === instance.pluginId && candidate.enabled);
            const contribution = plugin?.manifest.contributions.find((candidate) => candidate.id === instance.contributionId);
            if (!plugin || !contribution || contribution.kind !== "canvas-app") return null;
            return (
              <PluginCanvasCard
                key={instance.id}
                instance={withGroupNudge(pluginLayerId(instance.id), instance)}
                plugin={plugin}
                contribution={contribution}
                locale={settings.locale}
                palette={settings.palette}
                zoom={camera.zoom}
                stackIndex={canvasLayerZIndex(layerOrder, pluginLayerId(instance.id))}
                snapEnabled={settings.snapToGrid}
                sessions={sessions}
                limits={limits}
                snapTargets={[
                  homeBounds,
                  ...renderedCanvasRegions.map((candidate) => ({ position: candidate.position, size: candidate.size })),
                  ...allWindowBounds.filter((candidate) => candidate !== instance)
                ]}
                onActivate={() => {
                  raiseLayer(pluginLayerId(instance.id));
                  focusController.focus(pluginCanvasWidgetId(instance.id), "explicit");
                  onFocusPluginCanvas(instance.id);
                }}
                onBoundsChange={onPluginCanvasBoundsChange}
                onDispose={onDisposePluginCanvas}
                onOpenLauncher={(provider) => launchAt(provider)}
                onError={onPluginError}
                captureCanvasWheelOverWidgets={routeWidgetWheelToCanvas || widgetFocus.id !== pluginCanvasWidgetId(instance.id)}
                onWidgetFocus={() => {
                  raiseLayer(pluginLayerId(instance.id));
                  focusController.cancelHover();
                  focusController.focus(pluginCanvasWidgetId(instance.id), "explicit");
                }}
                onWidgetHoverChange={(active) => {
                  if (active) focusController.scheduleHover(pluginCanvasWidgetId(instance.id));
                  else focusController.cancelHover(pluginCanvasWidgetId(instance.id));
                }}
                onCanvasWheel={wheelNavigation.applyCanvasWheel}
                groupSelected={marqueeSelection.has(pluginLayerId(instance.id))}
              />
            );
          })}
          {renderedBrowserCanvas && (
            <BrowserCard
              browser={browser}
              bounds={withGroupNudge(browserLayerId, renderedBrowserCanvas)}
              locale={settings.locale}
              zoom={camera.zoom}
              camera={camera}
              visible={browserViewVisible && !homeEditing && contextMenu === null
                && regionEditor === null && !commandPaletteOpen && radialLauncher === null && !agentUi.overlayOpen
                && wsDialog === null && workspace.browserElsewhere === null
                && !browserOccluded && !browserUnderOverlay}
              stackIndex={canvasLayerZIndex(layerOrder, browserLayerId)}
              uiScale={settings.uiScale}
              snapEnabled={settings.snapToGrid}
              focusActivation={settings.focusActivation}
              focused={widgetFocus.id === browserCanvasWidgetId}
              selected={browserSelected}
              showAgentPresence={settings.browserShowAgentPresence}
              snapTargets={[
                homeBounds,
                ...renderedCanvasRegions.map((candidate) => ({ position: candidate.position, size: candidate.size })),
                ...allWindowBounds.filter((candidate) => candidate !== renderedBrowserCanvas)
              ]}
              onBoundsChange={onBrowserBoundsChange}
              onActivate={() => {
                raiseLayer(browserLayerId);
                focusController.focusBrowser();
                onFocusBrowser();
              }}
              onSelect={() => {
                raiseLayer(browserLayerId);
                onSelectBrowser();
              }}
              onWidgetFocus={() => {
                raiseLayer(browserLayerId);
                focusController.focusBrowser();
              }}
              onWidgetHoverChange={focusController.hoverBrowser}
              onClose={onCloseBrowser}
              onError={onPluginError}
              groupSelected={marqueeSelection.has(browserLayerId)}
            />
          )}
          {renderedStickyNotes.map((note) => (
            <StickyNoteCard
              key={note.id}
              note={withGroupNudge(noteLayerId(note.id), note)}
              locale={settings.locale}
              zoom={camera.zoom}
              stackIndex={canvasLayerZIndex(layerOrder, noteLayerId(note.id))}
              editRequest={noteEditRequest?.id === note.id ? noteEditRequest.version : 0}
              snapEnabled={settings.snapToGrid}
              snapTargets={[
                homeBounds,
                ...renderedCanvasRegions.map((candidate) => ({ position: candidate.position, size: candidate.size })),
                ...allWindowBounds.filter((candidate) => candidate !== note)
              ]}
              onBoundsChange={onStickyNoteBoundsChange}
              onTextChange={onStickyNoteTextChange}
              onClose={onDeleteStickyNote}
              groupSelected={marqueeSelection.has(noteLayerId(note.id))}
            />
          ))}
          <AgentScene
            taskOfRun={board.taskOfRun}
            orch={sceneOrch}
            ui={agentUi}
            locale={settings.locale}
            zoom={camera.zoom}
            snapEnabled={settings.snapToGrid}
            worldPoint={worldPoint}
            zIndexOf={(layerId) => canvasLayerZIndex(layerOrder, layerId)}
            groupSelected={(layerId) => marqueeSelection.has(layerId)}
            withNudge={withGroupNudge}
            snapTargetsFor={(layerId) => [
              homeBounds,
              ...renderedCanvasRegions.map((candidate) => ({ position: candidate.position, size: candidate.size })),
              ...[...boundsByLayer].filter(([id]) => id !== layerId).map(([, bounds]) => bounds)
            ]}
          />
          {boardPlace && (
            <BoardCard
              board={board}
              orch={sceneOrch}
              ui={agentUi}
              locale={settings.locale}
              workspaceId={workspace.activeId}
              bounds={withGroupNudge(boardLayerId(workspace.activeId), boardPlace)}
              zoom={camera.zoom}
              stackIndex={canvasLayerZIndex(layerOrder, boardLayerId(workspace.activeId))}
              selected={marqueeSelection.has(boardLayerId(workspace.activeId))}
              snapEnabled={settings.snapToGrid}
              snapTargets={[
                homeBounds,
                ...renderedCanvasRegions.map((candidate) => ({ position: candidate.position, size: candidate.size })),
                ...[...boundsByLayer].filter(([id]) => id !== boardLayerId(workspace.activeId)).map(([, bounds]) => bounds)
              ]}
              defaultProject={settings.lastDirectory ?? null}
              onBoundsChange={(next) => void board.place(workspace.activeId, next)}
              onHide={() => void board.place(workspace.activeId, null)}
            />
          )}
        </div>
      </div>

      {pointerNavigation.marquee && (
        <div
          className="canvas-marquee"
          aria-hidden="true"
          style={{
            left: pointerNavigation.marquee.left,
            top: pointerNavigation.marquee.top,
            width: pointerNavigation.marquee.width,
            height: pointerNavigation.marquee.height
          }}
        />
      )}

      {homeEditing && (
        <div className="home-editor-toolbar" data-interactive="true">
          <strong>{t(settings.locale, "homeEditor")}</strong>
          <button type="button" onClick={onResetHomeLayout}>{t(settings.locale, "resetHome")}</button>
          <button className="home-editor-toolbar__done" type="button" disabled={!homeLayoutValid}
            title={homeLayoutValid ? undefined : t(settings.locale, "homeLayoutOutside")}
            onClick={onFinishHomeEdit}>{t(settings.locale, "doneEditing")}</button>
        </div>
      )}

      {contextMenu && (
        <CanvasContextMenu
          kind={contextMenu.kind}
          position={contextMenu.position}
          locale={settings.locale}
          launcherItems={settings.canvasLauncherItems}
          currentRegionColor={contextRegion?.color ?? null}
          onCreateRegion={() => {
            setRegionEditor({ mode: "create", focus: "title", position: contextMenu.position, worldPoint: contextMenu.worldPoint });
            setContextMenu(null);
          }}
          onCreateNote={() => createNote(contextMenu.worldPoint)}
          onLaunch={(provider) => launchAt(provider, contextMenu.worldPoint)}
          onOpenBrowser={() => {
            onOpenBrowser(contextMenu.worldPoint);
            setContextMenu(null);
          }}
          onCreateOrchestrationAgent={(provider) => {
            agentUi.openCreate(provider, contextMenu.worldPoint);
            setContextMenu(null);
          }}
          onOpenSettings={() => {
            onOpenSettings();
            setContextMenu(null);
          }}
          onRenameRegion={() => {
            if (!contextMenu.targetId) return;
            setRegionEditor({ mode: "edit", focus: "title", position: contextMenu.position, regionId: contextMenu.targetId });
            setContextMenu(null);
          }}
          onChangeRegionColor={(color) => {
            if (!contextRegion) return;
            onChangeCanvasRegion({ ...contextRegion, color });
            setContextMenu(null);
          }}
          onDeleteRegion={() => {
            if (contextMenu.targetId) onDeleteCanvasRegion(contextMenu.targetId);
            setContextMenu(null);
          }}
          onEditNote={() => {
            if (contextMenu.targetId) {
              raiseLayer(noteLayerId(contextMenu.targetId));
              setNoteEditRequest((current) => ({ id: contextMenu.targetId!, version: (current?.version ?? 0) + 1 }));
            }
            setContextMenu(null);
          }}
          onBringNoteToFront={() => {
            if (contextMenu.targetId) raiseLayer(noteLayerId(contextMenu.targetId));
            setContextMenu(null);
          }}
          onDeleteNote={() => {
            if (contextMenu.targetId) onDeleteStickyNote(contextMenu.targetId);
            setContextMenu(null);
          }}
          onMoveToWorkspace={() => {
            const target = contextMenu.targetId;
            setContextMenu(null);
            if (!target) return;
            if (contextMenu.kind === "region") {
              setWsDialog({ kind: "move", item: "region", id: target, label: settings.canvasRegions.find((r) => r.id === target)?.title ?? "" });
              return;
            }
            if (contextMenu.kind === "note") {
              setWsDialog({ kind: "move", item: "note", id: target, label: t(settings.locale, "stickyNote") });
              return;
            }
            const ref = parseCanvasLayerId(target);
            if (!ref) return;
            if (ref.kind === "browser") setWsDialog({ kind: "move", item: "browser", id: "browser", label: t(settings.locale, "browser") });
            else if (ref.kind === "terminal" && ref.targetId) setWsDialog({ kind: "move", item: "terminal", id: ref.targetId, label: sessions.find((x) => x.id === ref.targetId)?.title ?? "" });
            else if (ref.kind === "plugin" && ref.targetId) setWsDialog({ kind: "move", item: "plugin", id: ref.targetId, label: settings.pluginCanvas.find((x) => x.id === ref.targetId)?.title ?? "" });
            else if (ref.kind === "agent" && ref.targetId) setWsDialog({ kind: "move", item: "agents", id: ref.targetId, label: "" });
          }}
          onClose={() => setContextMenu(null)}
        />
      )}

      {radialLauncher && (
        <RadialLauncher
          anchor={radialLauncher.anchor}
          pointerAnchor={radialLauncher.pointerAnchor}
          items={settings.radialLauncherItems}
          locale={settings.locale}
          pointerId={radialLauncher.pointerId}
          onActivate={activateRadialItem}
          onClose={closeRadialLauncher}
        />
      )}

      {regionEditor && (regionEditor.mode === "create" || editedRegion) && (
        <CanvasRegionMenu
          key={regionEditor.mode === "create" ? "create" : `edit:${regionEditor.regionId}:${regionEditor.focus}`}
          mode={regionEditor.mode}
          focus={regionEditor.focus}
          position={regionEditor.position}
          initialTitle={regionEditor.mode === "create" ? t(settings.locale, "canvasRegionDefaultName") : editedRegion!.title}
          initialColor={regionEditor.mode === "create" ? CANVAS_REGION_COLORS[0] : editedRegion!.color}
          locale={settings.locale}
          onSubmit={(title, color) => {
            if (regionEditor.mode === "create") {
              onCreateCanvasRegion(canvasRegionAtPoint(title, color, regionEditor.worldPoint, crypto.randomUUID()));
            } else if (editedRegion) {
              onChangeCanvasRegion({ ...editedRegion, title, color });
            }
            setRegionEditor(null);
          }}
          onClose={() => setRegionEditor(null)}
        />
      )}

      {commandPaletteOpen && (
        <CanvasCommandPalette
          locale={settings.locale}
          sessions={sessions}
          launcherItems={settings.canvasLauncherItems}
          onFocusSession={(session) => {
            raiseLayer(terminalLayerId(session.id));
            focusController.focus(terminalCanvasWidgetId(session.id), "explicit");
            onFocusSession(session);
          }}
          onLaunch={(provider) => launchAt(provider, viewportCenterWorldPoint())}
          onCreateRegion={() => {
            setCommandPaletteOpen(false);
            setRegionEditor({ mode: "create", focus: "title", position: centerMenuPosition(), worldPoint: viewportCenterWorldPoint() });
          }}
          onCreateNote={() => createNote(viewportCenterWorldPoint())}
          onCreateOrchestrationAgent={(provider) => {
            setCommandPaletteOpen(false);
            agentUi.openCreate(provider, viewportCenterWorldPoint());
          }}
          onOpenBrowser={() => onOpenBrowser(viewportCenterWorldPoint())}
          onOpenSettings={onOpenSettings}
          workspaces={workspace.state.workspaces.filter((w) => !w.closed).map((w) => ({ id: w.id, title: workspaceTitle(settings.locale, w) }))}
          onSwitchWorkspace={(id) => { setCommandPaletteOpen(false); workspace.switchTo(id); }}
          onClose={() => setCommandPaletteOpen(false)}
        />
      )}

      <OrchestrationOverlays taskOfRun={board.taskOfRun} orch={orch} ui={agentUi} locale={settings.locale} defaultProject={settings.lastDirectory} folderBusy={folderBusy} />
      <NotifyBanner locale={settings.locale} notes={notes.banner} onOpen={notes.openNote} onDismiss={notes.dismiss} />
      <WorkspaceDialogs dialog={wsDialog} controls={workspace} orch={orch} layout={workspaceLayout} locale={settings.locale}
        onClose={() => setWsDialog(null)} onOpenRun={(runId) => openRunInWorkspace(runId)} />
      <BrowserElsewhereDialog controls={workspace} locale={settings.locale} />

      <div className="canvas-overlays" ref={overlays}>
        <div className="canvas-overlay-slot canvas-overlay-slot--top-center">
          <WorkspaceBar controls={workspace} counts={counts} locale={settings.locale} onDialog={openWsDialog}
            board={{ shown: !!boardPlace, toggle: () => {
              if (boardPlace) { raiseLayer(boardLayerId(workspace.activeId)); return; }
              const c = viewportCenterWorldPoint();
              void board.place(workspace.activeId, { position: { x: Math.round(c.x - BOARD_SIZE.width / 2), y: Math.round(c.y - BOARD_SIZE.height / 2) }, size: { ...BOARD_SIZE } });
            } }} />
        </div>
        {CANVAS_OVERLAY_PLACEMENTS.map((placement) => (
          <div className={`canvas-overlay-slot canvas-overlay-slot--${placement}`} key={placement}>
            {settings.minimapPlacement === placement && (
              <CanvasMinimap viewport={viewport} camera={camera} homeBounds={homeBounds}
                canvasRegions={renderedCanvasRegions} sessions={renderedSessions} stickyNotes={renderedStickyNotes}
                pluginCanvas={renderedPluginCanvas} browserCanvas={renderedBrowserCanvas}
                locale={settings.locale} interactionMode={settings.minimapInteractionMode}
                workspaceId={workspace.activeId} onCameraChange={commitCamera} />
            )}
            {settings.canvasControlsPlacement === placement && (
              <div className="canvas-controls" data-interactive="true">
                <button type="button" onClick={onGoHome} title={t(settings.locale, "home")}><UiIcon name="home" size={17} /></button>
                <button type="button" onClick={() => wheelNavigation.zoomBy(0.82)} title={t(settings.locale, "zoomOut")}><UiIcon name="zoom-out" size={17} /></button>
                <button type="button" onClick={() => wheelNavigation.zoomBy(1.22)} title={t(settings.locale, "zoomIn")}><UiIcon name="zoom-in" size={17} /></button>
              </div>
            )}
            {settings.showShortcutHints && settings.shortcutHintsPlacement === placement && (
              <aside className="shortcut-hints" aria-label={t(settings.locale, "keyboardShortcuts")}>
                <div><kbd>{settings.shortcuts.home}</kbd><span>{t(settings.locale, "homeShortcut")}</span></div>
                <div><kbd>{settings.shortcuts.renameWindow}</kbd><span>{t(settings.locale, "renameWindow")}</span></div>
                {settings.canvasWheelCaptureMode === "key" && settings.canvasWheelOverride !== null && (
                  <div><kbd>{displayCanvasNavigationBinding(settings.canvasWheelOverride, window.canvasTTY.window.isMacOS)}</kbd>
                    <span>{t(settings.locale, "canvasWheelOverrideHint")}</span></div>
                )}
                {settings.canvasNavigationOverride !== null && (
                  <div><kbd>{displayCanvasNavigationBinding(settings.canvasNavigationOverride, window.canvasTTY.window.isMacOS)}</kbd>
                    <span>{t(settings.locale, "canvasNavigationOverrideHint")}</span></div>
                )}
              </aside>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function copyBounds(bounds: SessionBounds): SessionBounds {
  return {
    position: { ...bounds.position },
    size: { ...bounds.size }
  };
}

function containedBounds<T extends SessionBounds & { id: string }>(
  items: readonly T[],
  region: CanvasRegion
): ReadonlyMap<string, SessionBounds> {
  return new Map(items
    .filter((item) => boundsInsideRegion(item, region))
    .map((item) => [item.id, copyBounds(item)]));
}

function shouldKeepCanvasContextMenu(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest(
    "textarea, input, select, [contenteditable='true'], .terminal-card, .plugin-canvas-card, .browser-card, .home-zone, .canvas-overlays, .canvas-menu, .canvas-region-editor, [data-canvas-region-id], [data-sticky-note-id], [data-interactive='true']"
  ));
}
