// Presentation state around the agent cards: which dialog or panel is open, the linking mode, the last refusal shown
// on a card. Every decision still comes from main through useOrchestration.
import type { OrchestrationBaseRef } from "../../../../shared/orchestration";
import { useCallback, useMemo, useRef, useState } from "react";
import type { LocaleId, Point } from "../../../../shared/contracts";
import type { OrchestrationAgentLink, OrchestrationProviderKind } from "../../../../shared/orchestration";
import { AGENT_CARD_SIZE } from "./agentCardGeometry";
import { linkTrace } from "./linkTrace";
import { createIdKeeper, TERMINAL_STATUSES } from "./runModel";
import { outcomeText, type Orchestration } from "./useOrchestration";

export type PanelTab = "summary" | "overview" | "activity" | "changes" | "log" | "history";
export type PanelRole = "lead" | "executor" | "reviewer" | "check";
// The one run panel: which link, which tab and participant, and a counter that grows with every "open" so that opening
// the panel that is already open still has a visible effect (it scrolls to the pinned summary and highlights it).
// runId: a run opened by id (a workspace's history, a link that is gone); absent: the link's latest run.
export interface PanelState { linkId: string | null; runId?: string; tab: PanelTab; role: PanelRole; focus: number }

export interface CardMessage { text: string; tone: "error" | "info" }

export function useAgentCanvasUi(orch: Orchestration, locale: LocaleId, workspaceId: string) {
  const [linkingFrom, setLinkingFrom] = useState<string | null>(null);
  const [createAt, setCreateAt] = useState<{ provider: OrchestrationProviderKind; point: Point } | null>(null);
  const [goalLinkId, setGoalLinkId] = useState<string | null>(null);
  // B2: the board task the goal dialog starts from (its text and requirements; the run names it in goal.task)
  const [goalTask, setGoalTask] = useState<GoalTask | null>(null);
  const [panel, setPanel] = useState<PanelState | null>(null);
  const panelLinkId = panel?.linkId ?? null;
  const focusCount = useRef(0);
  const [messages, setMessages] = useState<Record<string, CardMessage>>({});
  // A link or card id is kept across a transport failure, so the retry names the same object.
  const ids = useRef(createIdKeeper(() => crypto.randomUUID())).current;

  // A refusal stays on the card for a while, then goes; the next action on the card replaces it.
  // UX audit PR 3: what only informs (the cards are already linked) is not drawn as an error.
  const say = useCallback((agentId: string, text: string | null, tone: CardMessage["tone"] = "error"): void => {
    const said = text ? { text, tone } : null;
    setMessages((m) => {
      const { [agentId]: _, ...rest } = m;
      return said ? { ...rest, [agentId]: said } : rest;
    });
    if (said) window.setTimeout(() => setMessages((m) => (m[agentId] === said ? (({ [agentId]: _, ...rest }) => rest)(m) : m)), 8000);
  }, []);

  const connect = useCallback(async (fromAgentId: string, toAgentId: string): Promise<void> => {
    setLinkingFrom(null);
    const key = `link:${fromAgentId}:${toAgentId}`;
    linkTrace("createLink.sent", { fromAgentId, toAgentId });
    const { outcome } = await orch.createLink({ linkId: ids.idFor(key), fromAgentId, toAgentId });
    linkTrace("createLink.result", { kind: outcome.kind, code: "code" in outcome ? outcome.code : null });
    if (outcome.kind !== "transport") ids.settle(key);
    const text = outcomeText(locale, outcome);
    say(fromAgentId, text, outcome.kind === "refused" && outcome.code === "link_duplicate" ? "info" : "error");
    if (toAgentId !== fromAgentId) say(toAgentId, null);
  }, [ids, locale, orch, say]);

  const createAgent = useCallback(async (provider: OrchestrationProviderKind, project: string, point: Point): Promise<string | null> => {
    const key = `agent:${provider}:${project}:${point.x}:${point.y}:${workspaceId}`;
    const { outcome } = await orch.createAgent({
      agentId: ids.idFor(key), provider, project, workspaceId,
      bounds: { position: { x: Math.round(point.x), y: Math.round(point.y) }, size: { ...AGENT_CARD_SIZE } }
    });
    if (outcome.kind !== "transport") ids.settle(key);
    return outcomeText(locale, outcome);
  }, [ids, locale, orch, workspaceId]);

  const deleteAgent = useCallback(async (agentId: string): Promise<void> => {
    const { outcome } = await orch.deleteAgent(agentId);
    say(agentId, outcomeText(locale, outcome));
    if (outcome.kind === "accepted" && linkingFrom === agentId) setLinkingFrom(null);
  }, [linkingFrom, locale, orch, say]);

  const deleteLink = useCallback(async (link: OrchestrationAgentLink): Promise<void> => {
    const { outcome } = await orch.deleteLink(link.linkId);
    say(link.fromAgentId, outcomeText(locale, outcome));
    if (outcome.kind === "accepted" && panelLinkId === link.linkId) setPanel(null);
  }, [locale, orch, panelLinkId, say]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: orch.watchRun is a new closure each render that only calls a stable setter
  return useMemo(() => ({
    linkingFrom, setLinkingFrom, messages, connect, createAgent, deleteAgent, deleteLink,
    createAt, openCreate: (provider: OrchestrationProviderKind, point: Point) => setCreateAt({ provider, point }),
    closeCreate: () => setCreateAt(null),
    goalLinkId, goalTask, openGoal: (linkId: string, task: GoalTask | null = null) => { setPanel(null); setGoalTask(task); setGoalLinkId(linkId); },
    closeGoal: () => { setGoalLinkId(null); setGoalTask(null); },
    panel, panelLinkId,
    // "Open run": the overview; "Observe": the live activity of one participant. The same panel either way.
    openPanel: (linkId: string, opts: { tab?: PanelTab; role?: PanelRole } = {}) => {
      setGoalLinkId(null);
      focusCount.current += 1;
      const focus = focusCount.current;
      setPanel((cur) => ({ linkId, tab: opts.tab ?? (cur?.linkId === linkId ? cur.tab : "overview"), role: opts.role ?? (cur?.linkId === linkId ? cur.role : "executor"), focus }));
    },
    setPanelView: (next: { tab?: PanelTab; role?: PanelRole }) => setPanel((cur) => (cur ? { ...cur, ...next } : cur)),
    // "Open run" of an ended run starts at its summary; of a run that goes on, at the overview.
    openRun: (linkId: string) => {
      const runId = orch.canvas.links.find((l) => l.linkId === linkId)?.runIds.at(-1);
      const status = runId ? orch.runs[runId]?.view.status : undefined;
      setGoalLinkId(null);
      focusCount.current += 1;
      const focus = focusCount.current;
      setPanel((cur) => ({ linkId, tab: status && TERMINAL_STATUSES.includes(status) ? "summary" : "overview", role: cur?.linkId === linkId ? cur.role : "executor", focus }));
    },
    // A run by id, with or without its link: the summary once it ended, the overview while it goes on.
    openRunById: (runId: string, tab?: PanelTab) => {
      orch.watchRun(runId);
      const linkId = orch.canvas.links.find((l) => l.runIds.includes(runId))?.linkId ?? null;
      const status = orch.runs[runId]?.view.status;
      setGoalLinkId(null);
      focusCount.current += 1;
      const focus = focusCount.current;
      setPanel({ linkId, runId, tab: tab ?? (!status || TERMINAL_STATUSES.includes(status) ? "summary" : "overview"), role: "executor", focus });
    },
    closePanel: () => setPanel(null),
    // The native browser view composites above the DOM; it hides while one of these is open.
    overlayOpen: createAt !== null || goalLinkId !== null || panel !== null
  }), [connect, createAgent, createAt, deleteAgent, deleteLink, goalLinkId, goalTask, linkingFrom, messages, orch.canvas.links, orch.runs, panel, panelLinkId]);
}

export type AgentCanvasUi = ReturnType<typeof useAgentCanvasUi>;
// anyway: the person confirmed «Start anyway» for a task that waits for others (§4.2)
// base (B4, owner's decision 11): the branch a dependency's result was taken into — a separate copy may start from it
export interface GoalTask { id: string; key: string; title: string; text: string; criteria: string[]; anyway?: boolean; base?: OrchestrationBaseRef }
