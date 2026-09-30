// Page of the "Stop and hide" harness: the real CloseDialog, fed by the real TerminalManager in main (over IPC) and by
// orchestration answers this page controls (run snapshots, a snapshot that cannot be read, a stop that ends a run).
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { CloseDialog, type WorkspaceControls } from "../../src/renderer/src/features/workspaces/WorkspaceUi.tsx";
import type { Orchestration } from "../../src/renderer/src/features/orchestration/useOrchestration.ts";
import { IPC, type SessionSnapshot } from "../../src/shared/contracts.ts";

type RunView = { status: string; revision: number } | null;
interface Config { ws: string; runs: Record<string, RunView>; runErrors?: Record<string, true>; stopBecomes?: Record<string, string> }
declare global { interface Window { hipc: { invoke(...a: unknown[]): Promise<unknown>; on(ch: string, fn: (p: never) => void): void }; __h: unknown; canvasTTY: unknown } }

let sessions: SessionSnapshot[] = [];
let runs: Record<string, { view: { runId: string; status: string; revision: number } }> = {};
let config: Config | null = null;
let log = { closeCalls: 0, closed: false, retries: 0, commands: [] as string[] };
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((f) => f());
window.hipc.on(IPC.terminalSession, ({ session }: { session: SessionSnapshot }) => {
  sessions = sessions.some((s) => s.id === session.id) ? sessions.map((s) => (s.id === session.id ? { ...s, ...session } : s)) : [...sessions, session];
  notify();
});
window.hipc.on(IPC.terminalRemoved, ({ id }: { id: string }) => { sessions = sessions.filter((s) => s.id !== id); notify(); });
const setRun = (id: string, view: RunView) => {
  runs = { ...runs };
  if (view) runs[id] = { view: { runId: id, ...view } };
  else delete runs[id];
  notify();
};
window.canvasTTY = {
  orchestration: {
    command: async (req: { runId: string }) => {
      log.commands.push(req.runId);
      const to = config?.stopBecomes?.[req.runId];
      if (to) setTimeout(() => setRun(req.runId, { status: to, revision: 99 }), 100);
      return { ok: true, value: { status: "accepted" } };
    }
  }
};

function Harness({ cfg }: { cfg: Config }) {
  const [, tick] = useState(0);
  useEffect(() => { const f = () => tick((x) => x + 1); listeners.add(f); return () => { listeners.delete(f); }; }, []);
  const card = (agentId: string, provider: string, role: string) => ({ agentId, provider, role, project: "/private/tmp/project", workspaceId: cfg.ws, createdAt: "", bounds: { position: { x: 0, y: 0 }, size: { width: 300, height: 222 } } });
  const orch = {
    canvas: { v: 1, agents: [card("lead", "codex", "lead"), card("exec", "claude", "executor")], owners: {},
      links: Object.keys(cfg.runs).map((r, i) => ({ linkId: `l${i}`, fromAgentId: "lead", toAgentId: "exec", createdAt: "", runIds: [r] })) },
    runs, runErrors: cfg.runErrors ?? {},
    commands: { request: (runId: string, revision: number, command: unknown) => ({ runId, revision, command, commandId: `c-${runId}-${revision}` }), settle() {} },
    retry: () => { log.retries += 1; }
  } as unknown as Orchestration;
  const controls = {
    state: { available: true, error: null, activeId: cfg.ws, workspaces: [
      { id: "common", title: "", root: null, createdAt: "", closed: false, camera: null },
      { id: cfg.ws, title: "Альфа", root: null, createdAt: "", closed: false, camera: null }] },
    activeId: cfg.ws, allSessions: sessions,
    close: async () => { log.closeCalls += 1; return null; },
    stopSession: (id: string) => window.hipc.invoke("h:stop", id),
    openSession: (id: string) => sessions.some((s) => s.id === id),
    switchTo() {}, notify() {}
  } as unknown as WorkspaceControls;
  if (log.closed) return null;
  return <CloseDialog controls={controls} orch={orch} locale="ru" id={cfg.ws} onClose={() => { log.closed = true; notify(); }} onOpenRun={() => {}} />;
}

const root = createRoot(document.getElementById("root")!);
window.__h = {
  async mount(cfg: Config) {
    config = cfg;
    log = { closeCalls: 0, closed: false, retries: 0, commands: [] };
    sessions = (await window.hipc.invoke("h:list")) as SessionSnapshot[];
    runs = {};
    for (const [id, view] of Object.entries(cfg.runs)) if (view) runs[id] = { view: { runId: id, ...view } };
    root.render(<Harness key={cfg.ws} cfg={cfg} />);
  },
  unmount() { root.render(null); },
  setRun,
  status: () => ({ ...log, commands: [...log.commands] })
};
