// Electron smoke for stage 7 (scripts/smoke-orchestration-ipc.mjs): the real preload, IPC and run manager with fake
// CLIs. Development builds only: index.ts reads the configuration file through developmentEnv. The renderer code is
// fixed here; the file only names the project, the run ids and the fake CLIs' process ledger.
import { readFileSync } from "node:fs";
import { BrowserWindow } from "electron";
import type { RunManager } from "./manager";

interface SmokeConfig { phase: "first" | "restart"; source: string; ledger: string; runA: string; runB: string }

const ledgerLines = (file: string) => { try { return readFileSync(file, "utf8").split("\n").filter(Boolean).length; } catch { return 0; } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Runs in the page, through window.canvasTTY only.
const RENDERER = `(async (p) => {
  const o = window.canvasTTY.orchestration;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const goal = (text, extra = {}) => ({ text, criteria: ["tests pass"], checks: ["node-test"], ...extra });
  const until = async (runId, ok) => {
    for (let i = 0; i < 600; i++) { const g = await o.get(runId); if (g.ok && ok(g.value.view)) return g.value; await sleep(100); }
    return (await o.get(runId)).value ?? null;
  };
  const uuid = () => crypto.randomUUID();
  const out = {};
  if (p.phase === "first") {
    out.catalog = await o.catalog();
    out.listBefore = await o.list();
    out.badId = await o.create({ requestId: "run-1", source: p.source, goal: goal("x") });
    out.extraField = await o.create({ requestId: p.runA, source: p.source, goal: goal("x"), executable: "/bin/sh" });
    out.badCheck = await o.create({ requestId: p.runA, source: p.source, goal: goal("x", { checks: ["../../bin/sh"] }) });
    out.badCommand = await o.command({ runId: p.runA, commandId: uuid(), expectedRevision: 0, command: { kind: "exec", argv: ["sh"] } });
    out.badText = await o.text(p.runA, "../../etc/passwd");
    out.listAfterBad = await o.list();

    const events = [];
    out.created = await o.create({ requestId: p.runA, source: p.source, goal: goal("add a file") });
    const w = o.watch(p.runA, (e) => events.push(e));
    out.watchSnapshot = await w.snapshot;
    out.repeat = await o.create({ requestId: p.runA, source: p.source, goal: goal("add a file") });
    out.conflict = await o.create({ requestId: p.runA, source: p.source, goal: goal("another goal") });
    const done = await until(p.runA, (v) => ["completed", "stopped", "failed"].includes(v.status) || v.status === "paused");
    out.final = done;
    w.unwatch();
    const newer = (a, b) => a.seq > b.seq || (a.seq === b.seq && a.tick > b.tick);
    const s0 = out.watchSnapshot.value;
    out.events = { count: events.length, increasing: events.every((e, i) => i === 0 || newer(e, events[i - 1])),
      startsWithSnapshot: events.length > 0 && events[0].seq === s0.seq && events[0].tick === s0.tick,
      sawActive: events.some((e) => e.view.active !== null), last: events.at(-1) ?? null };
    const page1 = await o.history(p.runA, 0, 3);
    const page2 = page1.ok ? await o.history(p.runA, page1.value.records.at(-1).seq + 1, 200) : null;
    out.history = { first: page1.ok && page1.value.records.map((r) => [r.seq, r.type]), more: page1.ok && page1.value.more,
      rest: page2?.ok && page2.value.records.length, lastSeq: page1.ok && page1.value.lastSeq };
    const goalRef = page1.ok && page1.value.records[0].data.goal;
    out.goalText = goalRef ? await o.text(p.runA, goalRef.sha256) : null;
    out.unknownText = await o.text(p.runA, "0".repeat(64));

    const rev = done.view.revision;
    const cmd = { runId: p.runA, commandId: uuid(), expectedRevision: rev + 5, command: { kind: "resume" } };
    out.stale = await o.command(cmd);
    out.staleRepeat = await o.command(cmd);
    out.terminalStop = await o.command({ runId: p.runA, commandId: uuid(), expectedRevision: rev, command: { kind: "stop" } });

    out.createdB = await o.create({ requestId: p.runB, source: p.source, goal: goal("plan first", { reviewPlan: true }) });
    out.pausedB = await until(p.runB, (v) => v.status === "paused");
    await o.watch(p.runB, () => {}).snapshot; // left open on purpose: the reload must release it in main
  } else {
    out.list = await o.list();
    const b = await o.get(p.runB);
    out.beforeResume = b;
    const cmd = { runId: p.runB, commandId: uuid(), expectedRevision: b.value.view.revision, command: { kind: "resume" } };
    out.resume = await o.command(cmd);
    out.resumeRepeat = await o.command(cmd);
    out.finalB = await until(p.runB, (v) => ["completed", "stopped", "failed"].includes(v.status) || (v.status === "paused" && v.reason !== "plan_review"));
  }
  return out;
})`;

export async function runOrchestrationIpcSmoke(window: BrowserWindow, preload: string, configFile: string, manager: RunManager): Promise<unknown> {
  const cfg = JSON.parse(readFileSync(configFile, "utf8")) as SmokeConfig;
  const report: Record<string, unknown> = { phase: cfg.phase, ledgerAtStart: ledgerLines(cfg.ledger), openAtStart: manager.openCount() };
  await sleep(1000); // nothing may start on its own meanwhile
  report.ledgerBeforeRenderer = ledgerLines(cfg.ledger);

  // A second window with the same preload is not the main renderer: refused before the manager is reached.
  const foreign = new BrowserWindow({ show: false, webPreferences: { preload, contextIsolation: true, sandbox: true, nodeIntegration: false } });
  try {
    await foreign.loadURL("data:text/html,<p>foreign</p>");
    report.foreign = await foreign.webContents.executeJavaScript(`Promise.all([
      window.canvasTTY.orchestration.list(),
      window.canvasTTY.orchestration.create(${JSON.stringify({ requestId: cfg.runA, source: cfg.source, goal: { text: "x", criteria: ["x"], checks: ["node-test"] } })})
    ]).then(() => "accepted", (e) => "refused: " + String(e.message).slice(-80))`);
  } finally {
    foreign.destroy();
  }
  report.ledgerAfterForeign = ledgerLines(cfg.ledger);

  report.renderer = await window.webContents.executeJavaScript(`${RENDERER}(${JSON.stringify(cfg)})`);
  report.watchersBeforeReload = manager.watcherCount();
  if (cfg.phase === "first") {
    await new Promise<void>((resolve) => { window.webContents.once("did-finish-load", () => resolve()); window.webContents.reload(); });
    report.watchersAfterReload = manager.watcherCount();
  }
  report.ledgerAtEnd = ledgerLines(cfg.ledger);
  report.openAtEnd = manager.openCount();
  return report;
}
