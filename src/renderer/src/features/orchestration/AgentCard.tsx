import { useEffect, useRef, useState } from "react";
import type { LocaleId, Point, SessionBounds } from "../../../../shared/contracts";
import type { OrchestrationAgentCard } from "../../../../shared/orchestration";
import { ProviderIcon } from "../../components/ProviderIcon";
import { UiIcon } from "../../components/UiIcon";
import { t, type TranslationKey } from "../../lib/i18n";
import { snapMove } from "../workspace/snap";
import type { AgentState } from "./runModel";
import type { StatusLine } from "./runStatus";

export const AGENT_CARD_SIZE = { width: 300, height: 222 };

interface AgentCardProps {
  card: OrchestrationAgentCard;
  locale: LocaleId;
  zoom: number;
  stackIndex: number;
  state: AgentState;
  status: StatusLine | null; // what it does now, from the shared display rules (runStatus.ts)
  statusTime: string | null; // the last event's time or the silence, already in words
  ended: boolean; // its link's latest run has ended: the summary is offered
  message: string | null;
  linking: "source" | "target" | null; // keyboard/click linking mode
  linked: boolean;
  hasRun: boolean;
  selected: boolean;
  snapEnabled: boolean;
  snapTargets: readonly SessionBounds[];
  onBoundsChange(agentId: string, bounds: SessionBounds): void;
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
}

const STATE_KEY: Record<AgentState, TranslationKey> = {
  idle: "orchAgentIdle", starting: "orchAgentStarting", working: "orchAgentWorking", waiting: "orchAgentWaiting", needs_you: "orchAgentNeedsYou", paused: "orchAgentPaused",
  stopping: "orchAgentStopping", completed: "orchAgentCompleted", stopped: "orchAgentStopped", failed: "orchAgentFailed", read_only: "orchReadOnly"
};

const MOVING = ["starting", "working", "checking", "waiting_agent"];

// A managed orchestration agent (stage-8-contract.md §1): not a terminal, never a PTY. Moves like a note; its size is
// fixed. The lead's port starts a link by drag (or by click/Enter, then "Link here" on an executor).
export function AgentCard(props: AgentCardProps): React.JSX.Element {
  const { card, locale, zoom, state, status, message, linking, snapEnabled, snapTargets } = props;
  const drag = useRef<{ pointerId: number; start: Point; startPos: Point } | null>(null);
  const [position, setPosition] = useState(card.bounds.position);
  const [confirming, setConfirming] = useState(false);
  const live = useRef(card.bounds.position);
  useEffect(() => {
    live.current = card.bounds.position;
    setPosition(card.bounds.position);
  }, [card.bounds.position]);
  const size = card.bounds.size;
  const name = card.project.split("/").filter(Boolean).at(-1) ?? card.project;

  const startDrag = (event: React.PointerEvent<HTMLElement>): void => {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { pointerId: event.pointerId, start: { x: event.clientX, y: event.clientY }, startPos: live.current };
  };
  const moveDrag = (event: React.PointerEvent<HTMLElement>): void => {
    const d = drag.current;
    if (!d || d.pointerId !== event.pointerId || event.buttons === 0) return;
    const raw = { x: d.startPos.x + (event.clientX - d.start.x) / zoom, y: d.startPos.y + (event.clientY - d.start.y) / zoom };
    const next = snapEnabled ? snapMove(raw, size, snapTargets) : raw;
    live.current = next;
    setPosition(next);
  };
  const endDrag = (event: React.PointerEvent<HTMLElement>): void => {
    if (drag.current?.pointerId !== event.pointerId) return;
    const moved = live.current.x !== drag.current.startPos.x || live.current.y !== drag.current.startPos.y;
    drag.current = null;
    if (moved) props.onBoundsChange(card.agentId, { position: live.current, size });
  };

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
        onPointerCancel={endDrag} onLostPointerCapture={() => { drag.current = null; }}>
        <span className="agent-card__identity">
          <ProviderIcon provider={card.provider} size="small" />
          <strong>{card.provider === "codex" ? "Codex" : "Claude"}</strong>
          <small>{t(locale, card.role === "lead" ? "orchRoleLead" : "orchRoleExecutor")}</small>
        </span>
        <button className="agent-card__close" type="button" onClick={() => (props.linked ? setConfirming(true) : props.onDelete(card.agentId))}
          title={t(locale, "orchDeleteCard")} aria-label={t(locale, "orchDeleteCard")}>
          <UiIcon name="trash" size="1.1em" />
        </button>
      </header>
      <div className="agent-card__body">
        <div className="agent-card__project" title={card.project}>
          <UiIcon name="folder" size="1.1em" />
          <span><strong>{name}</strong><small>{card.project}</small></span>
        </div>
        <div className="agent-card__status" role="status">
          <span className={`agent-card__state agent-card__state--${state}`}>{t(locale, STATE_KEY[state])}</span>
          {/* the pill already names a held state (paused, ended, waiting for you); the sentence adds what moves */}
          {status && MOVING.includes(status.state) && <span className="agent-card__doing" data-agent-doing title={status.doing}>{status.doing}</span>}
        </div>
        {status && (status.wait || status.now) && <div className="agent-card__line" data-agent-now>{status.wait ?? status.now}</div>}
        {props.statusTime && <div className="agent-card__line agent-card__line--time" data-agent-time>{props.statusTime}</div>}
        {message && <div className="agent-card__message" role="alert">{message}</div>}
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
