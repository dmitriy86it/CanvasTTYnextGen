// Agent cards and their links inside the canvas scene (world coordinates). The link gesture: drag from the lead's port
// onto an executor card, or press the port (click, Enter, Space) and then "Link here" on an executor; Escape cancels.
// Every rule (self, roles, repeat, projects) is checked in main; a refusal is shown on the card.
import { useEffect, useRef, useState } from "react";
import type { LocaleId, Point, SessionBounds } from "../../../../shared/contracts";
import type { OrchestrationAgentCard, OrchestrationAgentLink } from "../../../../shared/orchestration";
import { t, type TranslationKey } from "../../lib/i18n";
import { agentLayerId, pastCanvasDragThreshold } from "../workspace/canvasSelectionGesture";
import { AgentCard } from "./AgentCard";
import { linkTrace } from "./linkTrace";
import { ACTIVE_STATUSES, activeRole, agentState, cardRole, orchestrationAvailableHere, orchestrationEntry, participantState, runStatusKey, viewPauseLabel, TERMINAL_STATUSES, type AgentState } from "./runModel";
import { ReleaseNewerLink } from "./RunPanel";
import { conditionsLine, duration, findingsLine, roleStatus, type StatusLine } from "./runStatus";
import type { AgentCanvasUi } from "./useAgentCanvasUi";
import type { Orchestration } from "./useOrchestration";

interface AgentSceneProps {
  orch: Orchestration;
  ui: AgentCanvasUi;
  locale: LocaleId;
  zoom: number;
  snapEnabled: boolean;
  worldPoint(clientX: number, clientY: number): Point;
  zIndexOf(layerId: string): number;
  groupSelected(layerId: string): boolean;
  withNudge(layerId: string, bounds: SessionBounds): SessionBounds;
  snapTargetsFor(layerId: string): SessionBounds[];
}

const rightMid = (b: SessionBounds): Point => ({ x: b.position.x + b.size.width, y: b.position.y + b.size.height / 2 });
const leftMid = (b: SessionBounds): Point => ({ x: b.position.x, y: b.position.y + b.size.height / 2 });

function Line({ from, to, className }: { from: Point; to: Point; className: string }): React.JSX.Element {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  return (
    <div className={className} aria-hidden="true" style={{
      left: from.x, top: from.y, width: Math.hypot(dx, dy), transform: `rotate(${Math.atan2(dy, dx)}rad)`
    }} />
  );
}

export function AgentScene(props: AgentSceneProps): React.JSX.Element {
  const { orch, ui, locale, zoom } = props;
  const entry = orchestrationEntry(orchestrationAvailableHere());
  const portDrag = useRef<{ from: string; pointerId: number; start: Point; moved: boolean } | null>(null);
  const [preview, setPreview] = useState<{ from: string; to: Point } | null>(null);

  // Escape cancels both: the click mode and a drag from the port in progress (its release then links nothing).
  // Always listening: a press on the port is only in a ref until it moves.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      ui.setLinkingFrom(null);
      portDrag.current = null;
      setPreview(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ui]);

  const agents = orch.canvas.agents.map((card) => ({ card, bounds: props.withNudge(agentLayerId(card.agentId), card.bounds) }));
  const boundsOf = new Map(agents.map(({ card, bounds }) => [card.agentId, bounds]));
  const runOf = (link: OrchestrationAgentLink | undefined) => {
    const runId = link?.runIds.at(-1);
    return runId ? orch.runs[runId]?.view ?? null : null;
  };
  const linkOf = (card: OrchestrationAgentCard) =>
    orch.canvas.links.find((l) => l.fromAgentId === card.agentId || l.toAgentId === card.agentId);
  // "Working" only once its CLI process reported its start; before that the turn is only being started.
  const cardState = (card: OrchestrationAgentCard, link: OrchestrationAgentLink | undefined): AgentState => {
    const runId = link?.runIds.at(-1);
    const run = runId ? orch.runs[runId] ?? null : null;
    const s = agentState(card.role, run?.view ?? null);
    if (s !== "working" || !runId) return s;
    const p = participantState(cardRole(card.role, run!.view), run!.view, orch.activity[runId]?.entries ?? [], run!.open);
    return p.phase === "running" || p.phase === "finishing" ? "working" : "starting";
  };
  // The concrete line under the state: the same rules as the home widget and the summary.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const id = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(id); }, []);
  const cardStatus = (card: OrchestrationAgentCard, link: OrchestrationAgentLink | undefined): { status: StatusLine | null; time: string | null; conditions: string | null; findings: string | null } => {
    const runId = link?.runIds.at(-1);
    const run = runId ? orch.runs[runId] : undefined;
    if (!runId || !run) return { status: null, time: runId && orch.runErrors[runId] ? t(locale, "actRunError") : null, conditions: null, findings: null };
    const status = roleStatus(locale, cardRole(card.role, run.view), { view: run.view, entries: orch.activity[runId]?.entries ?? [], open: run.open, stageTitles: orch.stageTitles(runId), now });
    const time = status.quiet ?? (status.lastEventAt
      ? `${t(locale, "orchNow_lastEvent").replace("{time}", new Date(status.lastEventAt).toLocaleTimeString(locale))} · ${duration(locale, now - Date.parse(status.lastEventAt))}`
      : null);
    return { status, time, conditions: conditionsLine(locale, run.view), findings: findingsLine(locale, run.view) };
  };

  return (
    <>
      {orch.canvas.links.map((link) => {
        const from = boundsOf.get(link.fromAgentId);
        const to = boundsOf.get(link.toAgentId);
        if (!from || !to) return null;
        const view = runOf(link);
        const busy = view !== null && (ACTIVE_STATUSES.includes(view.status) || !!view.newer); // a newer version's run holds its link whatever its journaled status
        return <Line key={link.linkId} from={rightMid(from)} to={leftMid(to)} className={`agent-link ${busy ? "agent-link--busy" : ""}`} />;
      })}
      {preview && boundsOf.get(preview.from) && (
        <Line from={rightMid(boundsOf.get(preview.from)!)} to={preview.to} className="agent-link agent-link--preview" />
      )}
      {agents.map(({ card, bounds }) => {
        const layerId = agentLayerId(card.agentId);
        const link = linkOf(card);
        const view = runOf(link);
        const shown = cardStatus(card, link);
        return (
          <AgentCard
            key={card.agentId}
            card={{ ...card, bounds }}
            locale={locale}
            zoom={zoom}
            stackIndex={props.zIndexOf(layerId)}
            state={cardState(card, link)}
            status={shown.status}
            pause={view ? viewPauseLabel(locale, view, orch.activity[view.runId]?.entries ?? []) : null}
            statusTime={shown.time}
            conditions={shown.conditions}
            findings={shown.findings}
            ended={view !== null && TERMINAL_STATUSES.includes(view.status)}
            message={ui.messages[card.agentId] ?? null}
            linking={ui.linkingFrom === card.agentId ? "source" : ui.linkingFrom && card.role === "executor" ? "target" : null}
            linked={link !== undefined}
            hasRun={!!link?.runIds.length}
            selected={props.groupSelected(layerId)}
            snapEnabled={props.snapEnabled}
            snapTargets={props.snapTargetsFor(layerId)}
            onBoundsChange={(agentId, next) => orch.moveAgent(agentId, next)}
            onDelete={(agentId) => void ui.deleteAgent(agentId)}
            portDisabledHint={entry.hint ? t(locale, entry.hint) : undefined}
            onPortActivate={(agentId) => { if (!entry.disabled) ui.setLinkingFrom(ui.linkingFrom === agentId ? null : agentId); }}
            onConnectHere={(agentId) => { if (ui.linkingFrom) void ui.connect(ui.linkingFrom, agentId); }}
            onOpenRun={() => { if (link) ui.openRun(link.linkId); }}
            onSummary={() => { if (link) ui.openPanel(link.linkId, { tab: "summary" }); }}
            onObserve={() => { if (link) ui.openPanel(link.linkId, { tab: "activity", role: card.role }); }}
            onPortDown={(agentId, event) => {
              linkTrace("port.down", { agentId, pointerId: event.pointerId, button: event.button, x: event.clientX, y: event.clientY });
              if (event.button !== 0 || entry.disabled) return;
              event.preventDefault();
              event.stopPropagation();
              event.currentTarget.setPointerCapture(event.pointerId);
              portDrag.current = { from: agentId, pointerId: event.pointerId, start: { x: event.clientX, y: event.clientY }, moved: false };
            }}
            onPortMove={(event) => {
              const d = portDrag.current;
              if (!d || d.pointerId !== event.pointerId) return;
              event.stopPropagation();
              if (!d.moved && !pastCanvasDragThreshold(d.start, { x: event.clientX, y: event.clientY })) return;
              if (!d.moved) linkTrace("port.moved", { pointerId: event.pointerId, x: event.clientX, y: event.clientY });
              d.moved = true;
              setPreview({ from: d.from, to: props.worldPoint(event.clientX, event.clientY) });
            }}
            onPortUp={(event) => {
              const d = portDrag.current;
              linkTrace("port.end", { type: event.type, pointerId: event.pointerId, drag: d ? { from: d.from, pointerId: d.pointerId, moved: d.moved } : null, x: event.clientX, y: event.clientY });
              if (!d || d.pointerId !== event.pointerId) return;
              event.stopPropagation();
              portDrag.current = null;
              setPreview(null);
              // cancelled, or the capture lost without a release (another pointer event took it): the gesture ends here
              if (event.type !== "pointerup") return;
              if (!d.moved) {
                ui.setLinkingFrom(ui.linkingFrom === d.from ? null : d.from);
                return;
              }
              const target = document.elementsFromPoint(event.clientX, event.clientY)
                .map((el) => el.closest<HTMLElement>("[data-agent-id]"))
                .find((el) => el !== null);
              const toId = target?.dataset.agentId;
              linkTrace("port.drop", { from: d.from, toId: toId ?? null, under: document.elementsFromPoint(event.clientX, event.clientY).slice(0, 5).map((el) => String(el.className).slice(0, 60)) });
              if (toId) void ui.connect(d.from, toId);
            }}
          />
        );
      })}
      {/* After the cards, at the z of the higher of its two cards: never hidden by its own cards (when they sit close
          or overlap), still below any window raised above them. */}
      {orch.canvas.links.map((link) => {
        const from = boundsOf.get(link.fromAgentId);
        const to = boundsOf.get(link.toAgentId);
        if (!from || !to) return null;
        const a = rightMid(from);
        const b = leftMid(to);
        const view = runOf(link);
        const busy = view !== null && (ACTIVE_STATUSES.includes(view.status) || !!view.newer); // a newer version's run holds its link whatever its journaled status
        return (
          <div key={link.linkId} className={`agent-link__chip${view?.permission ? " agent-link__chip--needs-you" : ""}`} data-interactive="true" data-agent-link-id={link.linkId}
            role="group" aria-label={t(locale, "orchLink")}
            style={{ left: (a.x + b.x) / 2, top: (a.y + b.y) / 2,
              zIndex: Math.max(props.zIndexOf(agentLayerId(link.fromAgentId)), props.zIndexOf(agentLayerId(link.toAgentId))) }}>
            <span className="agent-link__state">
              {view?.permission ? t(locale, "orchLinkNeedsYou") : view?.newer ? t(locale, "orchReadOnly") : view ? viewPauseLabel(locale, view, orch.activity[view.runId]?.entries ?? []) ?? t(locale, `orchStatus_${runStatusKey(view)}` as TranslationKey) : t(locale, "orchNoRun")}
            </span>
            {!busy && <button type="button" disabled={entry.disabled} title={entry.hint ? t(locale, entry.hint) : undefined}
              onClick={() => ui.openGoal(link.linkId)}>{t(locale, "orchNewGoal")}</button>}
            {view && <button type="button" onClick={() => ui.openRun(link.linkId)}>{t(locale, "orchOpenRun")}</button>}
            {view?.newer && <ReleaseNewerLink orch={orch} linkId={link.linkId} runId={view.runId} locale={locale} />}
            {view && <button type="button" onClick={() => {
              const r = view.permission?.role ?? activeRole(view);
              ui.openPanel(link.linkId, { tab: "activity", role: r === "check" ? "check" : r ?? "executor" });
            }}>{t(locale, "orchObserve")}</button>}
            {!busy && (
              <button type="button" className="agent-link__delete" onClick={() => void ui.deleteLink(link)}
                title={t(locale, "orchDeleteLink")} aria-label={t(locale, "orchDeleteLink")}>×</button>
            )}
          </div>
        );
      })}
    </>
  );
}
