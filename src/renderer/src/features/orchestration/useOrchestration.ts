// Canvas agents, links and the state of each link's latest run, as main reports them (stage-8-contract.md §2).
// Nothing here decides for main: operations go out, the answers and the watch events come back.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LocaleId } from "../../../../shared/contracts";
import type {
  OrchestrationActivityEntry,
  OrchestrationActivityPage,
  OrchestrationAgentCard,
  OrchestrationBounds,
  OrchestrationCanvas,
  OrchestrationCatalog,
  OrchestrationGoalInput,
  OrchestrationProviderKind,
  OrchestrationResult,
  OrchestrationRunView
} from "../../../../shared/orchestration";
import { t, type TranslationKey } from "../../lib/i18n";
import { AGENT_CARD_SIZE } from "./AgentCard";
import { activityGap, createCommandSender, mergeActivity, newerStamp, outcomeOf, parsePlan, type Outcome } from "./runModel";
import { readJournal, stageTitleMap, type RunJournalState, type StageTitles } from "./runStatus";

export interface RunState { seq: number; tick: number; view: OrchestrationRunView; open: boolean }
export interface RunActivityState {
  entries: OrchestrationActivityEntry[];
  gaps: OrchestrationActivityPage["gaps"];
  firstId: number;
  status: "loading" | "ready" | "error";
  resyncs: number; // stored pages read again after a hole in the live batches (a lost batch, a reload)
}
const EMPTY_ACTIVITY: RunActivityState = { entries: [], gaps: [], firstId: 0, status: "loading", resyncs: 0 };
export type { RunJournalState };
const EMPTY_JOURNAL: RunJournalState = { records: [], next: 0, status: "loading" };
// A stored text of a run (goal, plan, report, findings), by its sha256.
export type TextState = { status: "loading" } | { status: "error" } | { status: "ready"; text: string };
// A card's size is fixed by the renderer (older cards were stored smaller).
const withCardSize = (c: OrchestrationCanvas): OrchestrationCanvas => ({ ...c, agents: c.agents.map((a) => ({ ...a, bounds: { ...a.bounds, size: { ...AGENT_CARD_SIZE } } })) });

export function orchText(locale: LocaleId, key: string, fallback: TranslationKey = "orchError_generic"): string {
  return t(locale, key as TranslationKey) ?? t(locale, fallback);
}

// A user-facing sentence for an outcome that is not a success.
export function outcomeText(locale: LocaleId, outcome: Outcome): string | null {
  switch (outcome.kind) {
    case "accepted":
    case "in_progress": return null;
    case "transport": return t(locale, "orchTransportError");
    case "rejected":
    case "refused": {
      const text = t(locale, `orchError_${outcome.code}` as TranslationKey);
      // a settings or finish refusal names the field in main's own words (technical, not translated)
      const why = outcome.kind === "refused" && outcome.message && ["invalid_profile", "finish_not_configured"].includes(outcome.code) ? `: ${outcome.message}` : "";
      return text ? `${text}${why}` : `${t(locale, "orchError_generic")} (${outcome.code})`;
    }
  }
}

const api = () => window.canvasTTY.orchestration;
const PENDING_KEY = "canvastty.orchestration.pendingCommands";
// Commands whose answer is unknown survive a reload of the window (not a restart of the application).
const sessionPending = {
  read: () => { try { return sessionStorage.getItem(PENDING_KEY); } catch { return null; } },
  write: (v: string) => { try { sessionStorage.setItem(PENDING_KEY, v); } catch { /* not kept */ } }
};

export function useOrchestration() {
  const [canvas, setCanvas] = useState<OrchestrationCanvas>({ agents: [], links: [] });
  const [catalog, setCatalog] = useState<OrchestrationCatalog>({ checks: [] });
  const [runs, setRuns] = useState<Record<string, RunState>>({});
  const [activity, setActivity] = useState<Record<string, RunActivityState>>({});
  const activityRef = useRef(activity);
  activityRef.current = activity;
  const [loaded, setLoaded] = useState(false);
  const loadedRef = useRef(false);
  const [canvasStatus, setCanvasStatus] = useState<"loading" | "ready" | "error">("loading");
  const [runErrors, setRunErrors] = useState<Record<string, true>>({});
  const [watchEpoch, setWatchEpoch] = useState(0);
  const [journals, setJournals] = useState<Record<string, RunJournalState>>({});
  const journalRef = useRef(journals);
  const journalBusy = useRef(new Map<string, boolean>());
  const [texts, setTexts] = useState<Record<string, TextState>>({});
  const textsRef = useRef(texts);
  textsRef.current = texts;
  const commands = useRef(createCommandSender(() => crypto.randomUUID(), sessionPending)).current;
  const canvasRef = useRef(canvas);
  canvasRef.current = canvas;
  // Runs opened by id (a workspace's history, a run whose link is gone): watched like a link's latest run while shown.
  const [pinned, setPinned] = useState<string[]>([]);

  const reload = useCallback(async (): Promise<void> => {
    const r = await api().canvas().catch(() => null);
    if (r?.ok) { setCanvas(withCardSize(r.value)); setCanvasStatus("ready"); } else if (!loadedRef.current) setCanvasStatus("error");
  }, []);

  useEffect(() => {
    let live = true;
    void Promise.all([api().canvas().catch(() => null), api().catalog().catch(() => null)]).then(([c, k]) => {
      if (!live) return;
      if (c?.ok) setCanvas(withCardSize(c.value));
      if (k?.ok) setCatalog(k.value);
      setCanvasStatus(c?.ok ? "ready" : "error");
      loadedRef.current = !!c?.ok;
      setLoaded(true);
    });
    return () => { live = false; };
  }, []);

  // One watch per link's latest run. Each watch starts from its own snapshot (a new base); afterwards only newer
  // (seq, tick) states replace what is shown.
  const latestRunIds = useMemo(() => [...new Set([...canvas.links.map((l) => l.runIds.at(-1)), ...pinned].filter((id): id is string => !!id))], [canvas.links, pinned]);
  const runKey = latestRunIds.join(",");
  useEffect(() => {
    const stops = latestRunIds.map((runId) => {
      let base = true;
      let open = false;
      // Activity: the stored pages, then the live batches of the same subscription. A batch that does not follow what
      // is shown (a lost batch) reads the stored pages again from the last id shown; ids never repeat.
      let syncing: Promise<void> | null = null;
      let live = true;
      const put = (f: (cur: RunActivityState) => RunActivityState) =>
        setActivity((all) => ({ ...all, [runId]: f(all[runId] ?? EMPTY_ACTIVITY) }));
      const sync = (resync: boolean): Promise<void> => (syncing ??= (async () => {
        for (let i = 0; i < 20 && live; i++) {
          const after = activityRef.current[runId]?.entries.at(-1)?.id ?? 0;
          const r = await api().activity(runId, after, 500).catch(() => null);
          if (!live) return;
          if (!r?.ok) { put((cur) => ({ ...cur, status: "error" })); return; }
          const page = r.value;
          put((cur) => ({ entries: mergeActivity(cur.entries, page.entries), gaps: page.gaps, firstId: page.firstId, status: "ready", resyncs: cur.resyncs + (resync && i === 0 ? 1 : 0) }));
          activityRef.current = { ...activityRef.current, [runId]: { ...(activityRef.current[runId] ?? EMPTY_ACTIVITY), entries: mergeActivity(activityRef.current[runId]?.entries ?? [], page.entries) } };
          if (!page.more) return;
        }
      })().finally(() => { syncing = null; }));
      const offActivity = api().onActivity(runId, (e) => {
        const cur = activityRef.current[runId]?.entries ?? [];
        if (syncing || activityGap(cur, e.entries)) { void sync(true); return; }
        const next = mergeActivity(cur, e.entries);
        activityRef.current = { ...activityRef.current, [runId]: { ...(activityRef.current[runId] ?? EMPTY_ACTIVITY), entries: next } };
        put((c) => ({ ...c, entries: mergeActivity(c.entries, e.entries) }));
      });
      const w = api().watch(runId, (e) => {
        const first = base;
        base = false;
        setRuns((current) => (first || newerStamp(e, current[runId] ?? null)
          ? { ...current, [runId]: { seq: e.seq, tick: e.tick, view: e.view, open: first ? open : true } } // only a run this process holds sends events
          : current));
      });
      void w.snapshot.then((r) => {
        if (r.ok) { open = r.value.open; setRuns((c) => (c[runId] ? { ...c, [runId]: { ...c[runId], open: r.value.open } } : c)); }
        setRunErrors(({ [runId]: _, ...rest }) => (r.ok ? rest : { ...rest, [runId]: true }));
        void sync(false);
      }, () => setRunErrors((e) => ({ ...e, [runId]: true })));
      return () => { live = false; offActivity(); w.unwatch(); };
    });
    return () => { for (const stop of stops) stop(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runKey, watchEpoch]);

  // Journals: read once a run is known, again whenever its seq passes what was read. Records only, no model turn.
  const syncJournal = useCallback(async (runId: string): Promise<void> => {
    if (journalBusy.current.has(runId)) { journalBusy.current.set(runId, true); return; }
    journalBusy.current.set(runId, false);
    const put = (j: RunJournalState) => { journalRef.current = { ...journalRef.current, [runId]: j }; setJournals(journalRef.current); };
    try {
      await readJournal((from) => api().history(runId, from, 200), () => journalRef.current[runId] ?? EMPTY_JOURNAL, put);
    } finally {
      const again = journalBusy.current.get(runId);
      journalBusy.current.delete(runId);
      if (again) void syncJournal(runId);
    }
  }, []);
  useEffect(() => {
    for (const [runId, s] of Object.entries(runs)) {
      // a newer version's records are never interpreted here (its panel reads them as they are), unless its journal
      // declared minReaderVersion this build reads: then they are v1 records with fields v1 ignores
      if (s.view.newer && !s.view.newer.compatible) continue;
      const j = journalRef.current[runId];
      // a failed read waits for retry(); otherwise read when the run moved past what was read
      if (!j || (j.status !== "error" && s.seq >= j.next)) void syncJournal(runId);
    }
  }, [runs, syncJournal]);

  const loadText = useCallback((runId: string, sha256: string, force = false): void => {
    const cur = textsRef.current[sha256];
    if (cur && (cur.status !== "error" || !force)) return;
    const put = (v: TextState) => { textsRef.current = { ...textsRef.current, [sha256]: v }; setTexts(textsRef.current); };
    put({ status: "loading" });
    void api().text(runId, sha256).then((r) => put(r.ok ? { status: "ready", text: r.value.text } : { status: "error" }), () => put({ status: "error" }));
  }, []);

  // Every plan of each run (a replan names only the stages from its firstStage on): stage titles by global number.
  const planRefs = useMemo(() => Object.fromEntries(Object.entries(journals).map(([runId, j]) => [runId,
    j.records.filter((r) => r.type === "plan.recorded").map((r) => (r.data.plan as { sha256?: string } | undefined)?.sha256).filter((x): x is string => typeof x === "string")
  ])), [journals]);
  useEffect(() => { for (const [runId, shas] of Object.entries(planRefs)) for (const sha of shas) loadText(runId, sha); }, [planRefs, loadText]);
  const planTitles = useCallback((sha: string): string[] | null => {
    const text = texts[sha];
    return text?.status === "ready" ? parsePlan(text.text).map((p) => p.title) : null;
  }, [texts]);
  const stageTitles = useCallback((runId: string): StageTitles | null => {
    const j = journals[runId];
    return j ? stageTitleMap(j.records, planTitles) : null;
  }, [journals, planTitles]);

  // After a failed load: the canvas, the watches and the journals are asked again (nothing is started).
  const retry = useCallback((): void => {
    void reload();
    setRunErrors({});
    setWatchEpoch((n) => n + 1);
    for (const [runId, j] of Object.entries(journalRef.current)) if (j.status === "error") void syncJournal(runId);
  }, [reload, syncJournal]);

  // After stale_revision: the current state as a new base, never an older one.
  const refreshRun = useCallback(async (runId: string): Promise<void> => {
    const r = await api().get(runId).catch(() => null);
    if (!r?.ok) return;
    setRuns((current) => {
      const now = current[runId] ?? null;
      return !now || newerStamp(r.value, now) || (r.value.seq === now.seq && r.value.tick === now.tick)
        ? { ...current, [runId]: { seq: r.value.seq, tick: r.value.tick, view: r.value.view, open: r.value.open } }
        : current;
    });
  }, []);

  const apply = useCallback(async <T,>(call: () => Promise<OrchestrationResult<T>>, onValue?: (v: T) => void) => {
    const res = await outcomeOf(call);
    if (res.outcome.kind === "accepted" && res.value !== undefined) onValue?.(res.value);
    return res;
  }, []);

  return {
    loaded, canvas, catalog, runs, activity, reload, refreshRun, commands,
    watchRun: (runId: string) => setPinned((p) => (p.includes(runId) ? p : [...p, runId])),
    canvasStatus, runErrors, journals, texts, loadText, stageTitles, planTitles, retry, syncJournal,
    agentById: (id: string): OrchestrationAgentCard | undefined => canvasRef.current.agents.find((a) => a.agentId === id),

    createAgent: (input: { agentId: string; provider: OrchestrationProviderKind; project: string; bounds: OrchestrationBounds; workspaceId: string }) =>
      apply(() => api().createAgent(input), (card) => setCanvas((c) => (c.agents.some((a) => a.agentId === card.agentId) ? c : { ...c, agents: [...c.agents, card] }))),

    // Shown at once (geometry is the renderer's to draw), saved in main; a refusal reloads what main holds.
    moveAgent: (agentId: string, bounds: OrchestrationBounds) => {
      setCanvas((c) => ({ ...c, agents: c.agents.map((a) => (a.agentId === agentId ? { ...a, bounds } : a)) }));
      void apply(() => api().moveAgent(agentId, bounds)).then((r) => { if (r.outcome.kind !== "accepted") void reload(); });
    },

    deleteAgent: (agentId: string) => apply(() => api().deleteAgent(agentId), () => setCanvas((c) => ({
      agents: c.agents.filter((a) => a.agentId !== agentId),
      links: c.links.filter((l) => l.fromAgentId !== agentId && l.toAgentId !== agentId)
    }))),

    // A whole linked group to another workspace (main checks the group and its runs again).
    moveAgentGroup: (agentIds: string[], workspaceId: string) =>
      apply(() => api().moveAgentGroup(agentIds, workspaceId), (next) => setCanvas(withCardSize(next))),

    createLink: (input: { linkId: string; fromAgentId: string; toAgentId: string }) =>
      apply(() => api().createLink(input), (link) => setCanvas((c) => (c.links.some((l) => l.linkId === link.linkId) ? c : { ...c, links: [...c.links, link] }))),

    deleteLink: (linkId: string) => apply(() => api().deleteLink(linkId), () => setCanvas((c) => ({ ...c, links: c.links.filter((l) => l.linkId !== linkId) }))),

    // commandId: one per confirmation, so a repeat after a lost answer is the same release.
    releaseNewerLink: (input: { commandId: string; linkId: string; runId: string }) =>
      apply(() => api().releaseNewerLink(input), () => { setCanvas((c) => ({ ...c, links: c.links.filter((l) => l.linkId !== input.linkId) })); void reload(); }),

    // refused: main's answer as it came, so a folder_busy refusal can name the run holding the folder
    startOnLink: async (input: { linkId: string; requestId: string; goal: OrchestrationGoalInput }) => {
      let refused: unknown = null;
      const res = await apply(async () => {
        const r = await api().startOnLink(input);
        if (!r.ok) refused = r;
        return r;
      }, (r) => {
        setCanvas((c) => ({
          ...c, links: c.links.map((l) => (l.linkId === input.linkId && !l.runIds.includes(r.runId) ? { ...l, runIds: [...l.runIds, r.runId] } : l))
        }));
        void reload(); // the run's owner, as main wrote it with the reservation
      });
      return { ...res, refused };
    }
  };
}

export type Orchestration = ReturnType<typeof useOrchestration>;
