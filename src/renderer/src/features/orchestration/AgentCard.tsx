import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { LocaleId, Point, SessionBounds } from "../../../../shared/contracts";
import type { OrchestrationActivityEntry, OrchestrationAgentCard } from "../../../../shared/orchestration";
import { ProviderIcon } from "../../components/ProviderIcon";
import { UiIcon } from "../../components/UiIcon";
import { t, type TranslationKey } from "../../lib/i18n";
import { constrainResize, snapMove, snapResize, type ResizeDirection } from "../workspace/snap";
import { AGENT_CARD_EXPANDED, AGENT_CARD_LIMITS as LIMITS, AGENT_CARD_SIZE, agentCardSize, isCompact, withoutHome } from "./agentCardGeometry";
import type { AgentState } from "./runModel";
import { entryLabel, FEED_KINDS, structured } from "./RunPanel";
import { isServiceEntry, type StatusLine } from "./runStatus";
import type { CardMessage } from "./useAgentCanvasUi";


interface AgentCardProps {
  card: OrchestrationAgentCard;
  locale: LocaleId;
  zoom: number;
  stackIndex: number;
  state: AgentState;
  status: StatusLine | null; // what it does now, from the shared display rules (runStatus.ts)
  activity: readonly OrchestrationActivityEntry[]; // the link's latest run's events: the live feed of a larger card
  statusTime: string | null; // the last event's time or the silence, already in words
  conditions?: string | null; // A2: "N of M conditions met" (runStatus.ts conditionsLine)
  findings?: string | null; // A3: "open blocking: N" (runStatus.ts findingsLine)
  cost?: string | null; // UX audit Н7: "Model calls: N · tokens: …" (runStatus.ts costLine)
  ended: boolean; // its link's latest run has ended: the summary is offered
  message: CardMessage | null;
  linking: "source" | "target" | null; // keyboard/click linking mode
  linked: boolean;
  hasRun: boolean;
  selected: boolean;
  snapEnabled: boolean;
  snapTargets: readonly SessionBounds[];
  onBoundsChange(agentId: string, bounds: SessionBounds, expanded?: SessionBounds["size"]): void;
  onDelete(agentId: string): void;
  onPortDown(agentId: string, event: React.PointerEvent<HTMLButtonElement>): void;
  onPortMove(event: React.PointerEvent<HTMLButtonElement>): void;
  onPortUp(event: React.PointerEvent<HTMLButtonElement>): void;
  onPortActivate(agentId: string): void;
  portDisabledHint?: string; // linking is unavailable on this platform: the port is shown, inactive, with this hint
  onConnectHere(agentId: string): void;
  onOpenRun(agentId: string): void;
  onObserve(agentId: string): void;
  onSummary(agentId: string): void;
  pause?: string | null; // a paused run's short form ("Waiting for you: …"), the link chip's words (runModel viewPauseLabel)
}

const RESIZE_DIRECTIONS: ResizeDirection[] = ["n", "ne", "e", "se", "s", "sw", "w", "nw"];

const STATE_KEY: Record<AgentState, TranslationKey> = {
  idle: "orchAgentIdle", starting: "orchAgentStarting", working: "orchAgentWorking", waiting: "orchAgentWaiting", needs_you: "orchAgentNeedsYou", paused: "orchAgentPaused",
  stopping: "orchAgentStopping", completed: "orchAgentCompleted", completed_no_checks: "orchAgentCompletedNoChecks", stopped: "orchAgentStopped", failed: "orchAgentFailed", read_only: "orchReadOnly"
};

const MOVING = ["starting", "working", "checking", "waiting_agent"];

// A managed orchestration agent (stage-8-contract.md §1): not a terminal, never a PTY. Moves and resizes like a
// terminal card (1.5.13); a larger card shows the agent's latest events. The lead's port starts a link by drag (or by
// click/Enter, then "Link here" on an executor).
export function AgentCard(props: AgentCardProps): React.JSX.Element {
  const { card, locale, zoom, state, status, message, linking, snapEnabled, snapTargets } = props;
  const drag = useRef<{ pointerId: number; start: Point; startPos: Point } | null>(null);
  const resizing = useRef<{ pointerId: number; direction: ResizeDirection; start: Point; startBounds: SessionBounds } | null>(null);
  const [bounds, setBounds] = useState<SessionBounds>(card.bounds);
  const [confirming, setConfirming] = useState(false);
  const live = useRef<SessionBounds>(card.bounds);
  useEffect(() => {
    live.current = card.bounds;
    setBounds(card.bounds);
  }, [card.bounds]);
  const { position, size } = bounds;
  const compact = isCompact(size);
  const name = card.project.split("/").filter(Boolean).at(-1) ?? card.project;
  const apply = (next: SessionBounds): void => { live.current = next; setBounds(next); };
  // a larger size is the one "Expand" returns to
  const save = (next: SessionBounds): void => props.onBoundsChange(card.agentId, next, isCompact(next.size) ? undefined : next.size);

  const startDrag = (event: React.PointerEvent<HTMLElement>): void => {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { pointerId: event.pointerId, start: { x: event.clientX, y: event.clientY }, startPos: live.current.position };
  };
  const moveDrag = (event: React.PointerEvent<HTMLElement>): void => {
    const d = drag.current;
    if (!d || d.pointerId !== event.pointerId || event.buttons === 0) return;
    const raw = { x: d.startPos.x + (event.clientX - d.start.x) / zoom, y: d.startPos.y + (event.clientY - d.start.y) / zoom };
    apply({ position: snapEnabled ? snapMove(raw, live.current.size, snapTargets) : raw, size: live.current.size });
  };
  const endDrag = (event: React.PointerEvent<HTMLElement>): void => {
    if (drag.current?.pointerId !== event.pointerId) return;
    const moved = live.current.position.x !== drag.current.startPos.x || live.current.position.y !== drag.current.startPos.y;
    drag.current = null;
    if (moved) props.onBoundsChange(card.agentId, live.current);
  };
  const startResize = (event: React.PointerEvent<HTMLDivElement>, direction: ResizeDirection): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    resizing.current = { pointerId: event.pointerId, direction, start: { x: event.clientX, y: event.clientY }, startBounds: live.current };
  };
  const resize = (event: React.PointerEvent<HTMLDivElement>): void => {
    const r = resizing.current;
    if (!r || r.pointerId !== event.pointerId || event.buttons === 0) return; // a buttonless move is a hover
    event.preventDefault();
    event.stopPropagation();
    const dx = (event.clientX - r.start.x) / zoom;
    const dy = (event.clientY - r.start.y) / zoom;
    const b = r.startBounds;
    const constrained = constrainResize({
      position: { x: b.position.x + (r.direction.includes("w") ? dx : 0), y: b.position.y + (r.direction.includes("n") ? dy : 0) },
      size: { width: b.size.width + (r.direction.includes("e") ? dx : 0) - (r.direction.includes("w") ? dx : 0),
        height: b.size.height + (r.direction.includes("s") ? dy : 0) - (r.direction.includes("n") ? dy : 0) }
    }, r.direction, LIMITS);
    apply(snapEnabled ? snapResize(constrained, r.direction, snapTargets, LIMITS) : constrained);
  };
  const endResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (resizing.current?.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    resizing.current = null;
    save(live.current);
  };
  // compact <-> the size it had last time it was larger
  const toggle = (): void => {
    const larger = live.current.size; // kept to come back to, read before the card shrinks
    const next = compact
      ? { position: live.current.position, size: agentCardSize(card.expanded ?? AGENT_CARD_EXPANDED) }
      : { position: live.current.position, size: { ...AGENT_CARD_SIZE } };
    apply(next);
    props.onBoundsChange(card.agentId, next, compact ? undefined : larger);
  };
  // a double click on the header does what its «Expand / Collapse» button does (the button is the keyboard's way)
  const header = useRef<HTMLElement>(null);
  const toggleRef = useRef(toggle);
  toggleRef.current = toggle;
  useEffect(() => {
    const el = header.current;
    const onDouble = (event: MouseEvent): void => { if (!(event.target as HTMLElement).closest("button")) toggleRef.current(); };
    el?.addEventListener("dblclick", onDouble);
    return () => el?.removeEventListener("dblclick", onDouble);
  }, []);
  const doing = status && MOVING.includes(status.state) ? status.doing : null;
  const extra = status ? status.wait ?? status.now : null;
  const facts = [props.conditions, props.findings].filter(Boolean).join(" · ");

  return (
    <article
      className={`agent-card agent-card--${card.provider} agent-card--${state} ${props.selected ? "agent-card--selected" : ""} ${linking ? `agent-card--linking-${linking}` : ""}`}
      data-interactive="true"
      data-agent-id={card.agentId}
      data-agent-role={card.role}
      data-canvas-layer-id={`agent:${card.agentId}`}
      aria-label={`${card.provider === "codex" ? "Codex" : "Claude"} — ${t(locale, card.role === "lead" ? "orchRoleLead" : "orchRoleExecutor")}`}
      style={{ zIndex: props.stackIndex, width: size.width, height: size.height, transform: `translate(${position.x}px, ${position.y}px)` }}
    >
      <header className="agent-card__header" onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={endDrag}
        onPointerCancel={endDrag} onLostPointerCapture={() => { drag.current = null; }} ref={header}>
        <span className="agent-card__identity">
          <ProviderIcon provider={card.provider} size="small" />
          <strong>{card.provider === "codex" ? "Codex" : "Claude"}</strong>
          <small title={t(locale, card.role === "lead" ? "orchTerm_lead" : "orchTerm_executor")} data-term={card.role}>{t(locale, card.role === "lead" ? "orchRoleLead" : "orchRoleExecutor")}</small>
        </span>
        <span className="agent-card__header-actions">
          <button className="agent-card__expand" type="button" data-agent-expand={compact ? "compact" : "expanded"} onClick={toggle}
            title={t(locale, compact ? "orchCardExpand" : "orchCardCollapse")} aria-label={t(locale, compact ? "orchCardExpand" : "orchCardCollapse")}>
            <UiIcon name={compact ? "maximize" : "restore"} size="1.05em" />
          </button>
          <button className="agent-card__close" type="button" onClick={() => (props.linked ? setConfirming(true) : props.onDelete(card.agentId))}
            title={t(locale, "orchDeleteCard")} aria-label={t(locale, "orchDeleteCard")}>
            <UiIcon name="trash" size="1.1em" />
          </button>
        </span>
      </header>
      <div className="agent-card__body">
        {/* every line is one line: a long one ends with "…" and says all of it in its tooltip (1.5.13) */}
        <div className="agent-card__project" title={card.project}>
          <UiIcon name="folder" size="1.1em" />
          <strong>{name}</strong><small>{card.project}</small>
        </div>
        <div className="agent-card__status" role="status">
          <span className={`agent-card__state agent-card__state--${state}`} data-agent-pause={props.pause && (state === "paused" || state === "needs_you") ? "yes" : undefined}
            title={props.pause && (state === "paused" || state === "needs_you") ? props.pause : t(locale, STATE_KEY[state])}>
            {props.pause && (state === "paused" || state === "needs_you") ? props.pause : t(locale, STATE_KEY[state])}</span>
          {props.statusTime && <span className="agent-card__time" data-agent-time title={props.statusTime}>{props.statusTime}</span>}
        </div>
        {/* the pill already names a held state (paused, ended, waiting for you); the sentence adds what moves */}
        {doing && <div className="agent-card__line agent-card__doing" data-agent-doing title={doing}>{doing}</div>}
        {extra && <div className="agent-card__line" data-agent-now title={extra}>{extra}</div>}
        {facts && (
          <div className="agent-card__line" data-agent-facts title={facts}>
            {props.conditions && <span data-agent-conditions>{props.conditions}</span>}
            {props.conditions && props.findings && " · "}
            {props.findings && <span data-agent-findings>{props.findings}</span>}
          </div>
        )}
        {props.cost && <div className="agent-card__line" data-agent-cost title={props.cost}>{props.cost}</div>}
        {message && <div className={`agent-card__message agent-card__message--${message.tone}`} role={message.tone === "error" ? "alert" : "status"}>{message.text}</div>}
        {/* semantic zoom: far out the card keeps its lines and gives the wheel back to the canvas */}
        {!compact && zoom >= 0.5 && props.hasRun && <CardFeed locale={locale} entries={props.activity} role={card.role} height={size.height} />}
        {confirming && (
          <div className="agent-card__confirm" role="alertdialog" aria-label={t(locale, "orchDeleteCard")}>
            <span>{t(locale, "orchDeleteCardLinked")}</span>
            <button type="button" className="agent-card__danger" onClick={() => { setConfirming(false); props.onDelete(card.agentId); }}>{t(locale, "orchDeleteCard")}</button>
            <button type="button" autoFocus onClick={() => setConfirming(false)}>{t(locale, "orchCancel")}</button>
          </div>
        )}
        <div className="agent-card__actions">
          {linking === "target" && (
            <button className="agent-card__connect" type="button" onClick={() => props.onConnectHere(card.agentId)}>{t(locale, "orchConnectHere")}</button>
          )}
          {props.ended && (
            <button className="agent-card__summary" type="button" onClick={() => props.onSummary(card.agentId)}>{t(locale, "orchSummaryButton")}</button>
          )}
          {props.hasRun && (
            <button className="agent-card__open" type="button" onClick={() => props.onOpenRun(card.agentId)}>{t(locale, "orchOpenRun")}</button>
          )}
          {props.hasRun && (
            <button className="agent-card__observe" type="button" onClick={() => props.onObserve(card.agentId)}>{t(locale, "orchObserve")}</button>
          )}
        </div>
      </div>
      {RESIZE_DIRECTIONS.map((direction) => (
        <div key={direction} className={`terminal-card__resize-handle terminal-card__resize-handle--${direction}`} aria-hidden="true" data-agent-resize={direction}
          onPointerDown={(event) => startResize(event, direction)} onPointerMove={resize} onPointerUp={endResize} onPointerCancel={endResize}
          onLostPointerCapture={() => { resizing.current = null; }} />
      ))}
      {card.role === "lead" && (
        <button
          className="agent-card__port"
          type="button"
          aria-label={t(locale, "orchPort")}
          title={props.portDisabledHint ?? t(locale, "orchPort")}
          disabled={props.portDisabledHint !== undefined}
          aria-pressed={linking === "source"}
          onPointerDown={(event) => props.onPortDown(card.agentId, event)}
          onPointerMove={props.onPortMove}
          onPointerUp={props.onPortUp}
          onPointerCancel={props.onPortUp}
          onLostPointerCapture={props.onPortUp}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              props.onPortActivate(card.agentId);
            }
          }}
        />
      )}
    </article>
  );
}

// The agent's latest events, as the activity feed says them (RunPanel entryLabel), newest at the bottom. It follows new
// events while the reader is at the bottom; scrolled up, it stays where the reader is until they come back down.
function CardFeed({ locale, entries, role, height }: { locale: LocaleId; entries: readonly OrchestrationActivityEntry[]; role: "lead" | "executor"; height: number }): React.JSX.Element {
  // the lead's card is also the reviewer's (the reviewer is a session of the lead's CLI)
  const items = useMemo(() => entries.filter((e) => (role === "lead" ? e.role === "lead" || e.role === "reviewer" : e.role === "executor")
    && FEED_KINDS.has(e.kind) && !isServiceEntry(e)).slice(-200), [entries, role]);
  const box = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);
  useLayoutEffect(() => {
    const el = box.current;
    // a new event, or a taller card, while the reader is at the bottom: still at the bottom
    if (el && following && items.length + height > 0) el.scrollTop = el.scrollHeight;
  }, [items.length, height, following]);
  const onScroll = (): void => {
    const el = box.current;
    if (el) setFollowing(el.scrollHeight - el.scrollTop - el.clientHeight < 8);
  };
  return (
    <div className="agent-card__feed" ref={box} onScroll={onScroll} data-agent-feed data-following={following ? "yes" : "no"} data-wheel-owner="local">
      {items.length === 0 && <p className="agent-card__feed-empty">{t(locale, "orchCardFeedEmpty")}</p>}
      {items.map((e) => {
        // a report a CLI wrote as JSON is "Message: report", as in the activity feed
        const text = withoutHome(structured(e) ? `${t(locale, "orchAct_message")}: ${t(locale, "orchFeedReport")}` : entryLabel(locale, e, entries));
        return (
          <div key={e.id} className="agent-card__feed-item" data-activity-id={e.id} title={text}>
            <time>{e.ts ? new Date(e.ts).toLocaleTimeString(locale) : "—"}</time> <span>{text}</span>
          </div>
        );
      })}
    </div>
  );
}
