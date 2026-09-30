// Electron main of the "Stop and hide" harness (scripts/smoke-workspaces-close.mjs): the real TerminalManager with a
// fake PTY whose answer to the stop signal is chosen per terminal, so a failed signal, a signal without an exit and a
// slow exit are reproduced without a real CLI. The page mounts the real CloseDialog; this file drives it with mouse
// events on points that elementFromPoint confirms, and judges by the application's state.
import { app, BrowserWindow, ipcMain } from "electron";
import path from "node:path";
import { TerminalManager } from "../../src/main/services/TerminalManager.ts";

type Behaviour = "exit" | "exit-slow" | "silent" | "throw";
const DIR = process.env.HARNESS_DIR as string;
let win: BrowserWindow;
const behaviours: Behaviour[] = [];
const kills: Record<string, number> = {};
const stops: Record<string, number> = {};
const pidToId = new Map<number, string>();
let nextPid = 20000;

const manager = new TerminalManager((channel, payload) => win?.webContents.send(channel, payload), {
  get: (provider: string) => ({ state: "available", provider, executable: "/synthetic/codex", launcher: "native", environment: {}, checked: [] })
} as never, undefined, undefined, false, (() => {
  const behaviour = behaviours.shift() ?? "exit";
  const pid = nextPid++;
  let exitHandler: ((e: { exitCode: number }) => void) | null = null;
  return {
    pid, process: "synthetic", write() {}, resize() {},
    onData() { return { dispose() {} }; },
    onExit(fn: (e: { exitCode: number }) => void) { exitHandler = fn; return { dispose() {} }; },
    kill() {
      const id = pidToId.get(pid) ?? String(pid);
      kills[id] = (kills[id] ?? 0) + 1;
      if (behaviour === "throw") throw new Error("synthetic kill refused");
      if (behaviour === "exit") setTimeout(() => exitHandler?.({ exitCode: 0 }), 30);
      if (behaviour === "exit-slow") setTimeout(() => exitHandler?.({ exitCode: 0 }), 1500);
    }
  };
}) as never);
manager.configureWorkspaces({ active: () => "a", isOpen: () => true });

// Each scenario has its own workspace, so live terminals left by an earlier scenario are not in its dialog.
ipcMain.handle("h:create", (_e, behaviour: Behaviour, title: string, workspaceId: string) => {
  behaviours.push(behaviour);
  const s = manager.create({ provider: "codex", cwd: "/private/tmp", profile: "normal", position: { x: 0, y: 0 }, workspaceId } as never);
  manager.rename(s.id, title);
  pidToId.set(nextPid - 1, s.id);
  return manager.list().find((x) => x.id === s.id);
});
ipcMain.handle("h:list", () => manager.list());
// The real stop with its production limits, counted per terminal.
ipcMain.handle("h:stop", (_e, id: string) => { stops[id] = (stops[id] ?? 0) + 1; return manager.stop(id); });
ipcMain.handle("h:counts", () => ({ kills, stops }));
// The ordinary close of a card, from another path while the dialog stops the same terminal.
ipcMain.handle("h:dispose", (_e, id: string) => manager.dispose(id));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ev = <T>(js: string): Promise<T> => win.webContents.executeJavaScript(js, true);
async function waitFor(js: string, what: string, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await ev<boolean>(js).catch(() => false)) return; await sleep(25); }
  throw new Error(`timed out: ${what}`);
}
// A real click: the point must land on the element (or inside it), then mouse down/up at that point.
async function click(selector: string): Promise<void> {
  const p = await ev<{ x: number; y: number; hit: boolean } | null>(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null;
    const r = el.getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height / 2; const h = document.elementFromPoint(x, y);
    return { x: Math.round(x), y: Math.round(y), hit: !!h && (h === el || el.contains(h)) }; })()`);
  if (!p) throw new Error(`no element ${selector}`);
  if (!p.hit) throw new Error(`the point does not land on ${selector}`);
  win.webContents.sendInputEvent({ type: "mouseDown", x: p.x, y: p.y, button: "left", clickCount: 1 });
  win.webContents.sendInputEvent({ type: "mouseUp", x: p.x, y: p.y, button: "left", clickCount: 1 });
}
const state = (key: string) => ev<string | null>(`document.querySelector('[data-ws-close-item="${key}"]')?.dataset.wsCloseState ?? null`);

const checks: { name: string; ok: boolean; got?: unknown }[] = [];
const expect = (ok: boolean, name: string, got?: unknown) => { checks.push(ok ? { name, ok } : { name, ok, got }); };

async function scenario(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); } catch (e) { expect(false, `${name}: ${(e as Error).message}`); }
  await ev("window.__h.unmount()");
}

async function run(): Promise<void> {
  // S1 partial refusal: a run stops, a terminal exits, another terminal's signal fails.
  await scenario("partial", async () => {
    const ok = await ev<{ id: string }>(`window.hipc.invoke("h:create", "exit", "exits", "s1")`);
    const bad = await ev<{ id: string }>(`window.hipc.invoke("h:create", "throw", "refuses", "s1")`);
    await ev(`window.__h.mount({ ws: "s1", runs: { r1: { status: "running", revision: 1 } }, stopBecomes: { r1: "stopped" } })`);
    await waitFor(`!!document.querySelector('[data-ws-close-stop]')`, "dialog");
    await click("[data-ws-close-stop]");
    await waitFor(`document.querySelector('[data-ws-close-item="term:${bad.id}"]')?.dataset.wsCloseState === "error"`, "the refused terminal shows its error");
    await waitFor(`document.querySelector('[data-ws-close-item="term:${ok.id}"]')?.dataset.wsCloseState === "stopped" && document.querySelector('[data-ws-close-item="run:r1"]')?.dataset.wsCloseState === "stopped"`, "the others stopped");
    await sleep(300);
    const h = await ev<{ closeCalls: number; closed: boolean }>("window.__h.status()");
    expect(h.closeCalls === 0 && !h.closed, "partial: not hidden while a participant is not stopped", h);
    expect(await ev<boolean>(`!!document.querySelector('[data-ws-close-item="term:${bad.id}"] [data-ws-close-open]')`), "partial: the refused terminal can be opened");
    expect(await ev<boolean>(`!document.querySelector('[data-ws-close-item="term:${ok.id}"] [data-ws-close-open]')`), "partial: a stopped one has no Open");
    expect((await ev<string>(`document.querySelector('[data-ws-close-summary]')?.textContent ?? ""`)).length > 0, "partial: the summary says it");
    const listed = await ev<{ id: string }[]>(`window.hipc.invoke("h:list")`);
    expect(listed.some((s) => s.id === bad.id) && !listed.some((s) => s.id === ok.id), "partial: main keeps the live one and removed the exited one", listed.map((s) => s.id));
    const before = await ev<{ kills: Record<string, number>; stops: Record<string, number> }>(`window.hipc.invoke("h:counts")`);
    await click("[data-ws-close-hide]");
    await waitFor("window.__h.status().closed", "hidden on the explicit choice");
    const after = await ev<{ kills: Record<string, number>; stops: Record<string, number> }>(`window.hipc.invoke("h:counts")`);
    const h2 = await ev<{ closeCalls: number; commands: string[] }>("window.__h.status()");
    expect(h2.closeCalls === 1 && JSON.stringify(after) === JSON.stringify(before) && h2.commands.length === 1, "partial: the explicit hide stops nothing again", { before, after, h2 });
  });

  // S2 a signal sent, no exit: "stopping" at once, then "did not exit" — never "stopped", never hidden.
  await scenario("no exit", async () => {
    const t = await ev<{ id: string }>(`window.hipc.invoke("h:create", "silent", "ignores the signal", "s2")`);
    await ev(`window.__h.mount({ ws: "s2", runs: {} })`);
    await waitFor(`!!document.querySelector('[data-ws-close-stop]')`, "dialog");
    await click("[data-ws-close-stop]");
    await waitFor(`document.querySelector('[data-ws-close-item="term:${t.id}"]')?.dataset.wsCloseState === "stopping"`, "stopping", 1000);
    const early = await ev<{ closed: boolean }>("window.__h.status()");
    expect(!early.closed, "no exit: the signal alone does not hide");
    await waitFor(`document.querySelector('[data-ws-close-item="term:${t.id}"]')?.dataset.wsCloseState === "timeout"`, "timeout after the limit", 9000);
    const listed = await ev<{ id: string; exitCode: number | null }[]>(`window.hipc.invoke("h:list")`);
    expect(listed.some((s) => s.id === t.id && s.exitCode === null), "no exit: the process stays managed in main");
    expect(!(await ev<{ closed: boolean }>("window.__h.status()")).closed, "no exit: not hidden");
    expect(await ev<boolean>(`!!document.querySelector('[data-ws-close-item="term:${t.id}"] [data-ws-close-open]')`), "no exit: Open stays");
  });

  // S3 a run whose snapshot could not be read: shown, retry offered, never counted as stopped; stopped once read.
  await scenario("unknown run", async () => {
    const t = await ev<{ id: string }>(`window.hipc.invoke("h:create", "exit", "exits", "s3")`);
    await ev(`window.__h.mount({ ws: "s3", runs: { r2: null }, runErrors: { r2: true }, stopBecomes: { r2: "stopped" } })`);
    await waitFor(`!!document.querySelector('[data-ws-close-stop]')`, "dialog");
    expect(await state("run:r2") === "unreadable", "unknown: the row says its state could not be read", await state("run:r2"));
    expect(await ev<boolean>(`!!document.querySelector('[data-ws-close-unknown]')`), "unknown: the dialog warns about the unknown result");
    await click('[data-ws-close-item="run:r2"] [data-ws-close-retry]');
    await waitFor("window.__h.status().retries === 1", "unknown: retry asks for the state again", 3000);
    expect(true, "unknown: retry asks for the state again");
    await click("[data-ws-close-stop]");
    await waitFor(`document.querySelector('[data-ws-close-item="term:${t.id}"]')?.dataset.wsCloseState === "stopped"`, "the terminal stopped");
    await sleep(600);
    const h = await ev<{ closed: boolean; closeCalls: number }>("window.__h.status()");
    expect(!h.closed && h.closeCalls === 0, "unknown: not hidden while a run's state is unknown", h);
    await ev(`window.__h.setRun("r2", { status: "running", revision: 3 })`); // the retry read it: it is still running
    await waitFor("window.__h.status().closed", "stopped once read, then hidden");
    const h2 = await ev<{ commands: string[] }>("window.__h.status()");
    expect(h2.commands.join() === "r2", "unknown: the stop went to the run once its state was known", h2.commands);
  });

  // S4 new work appears while the listed participants stop: not hidden, and said so.
  await scenario("new work", async () => {
    await ev(`window.hipc.invoke("h:create", "exit-slow", "slow exit", "s4")`);
    await ev(`window.__h.mount({ ws: "s4", runs: {} })`);
    await waitFor(`!!document.querySelector('[data-ws-close-stop]')`, "dialog");
    await click("[data-ws-close-stop]");
    await ev(`window.hipc.invoke("h:create", "silent", "started meanwhile", "s4")`);
    await waitFor(`!!document.querySelector('.dialog-error')`, "the new work is named", 8000);
    const h = await ev<{ closed: boolean; closeCalls: number }>("window.__h.status()");
    expect(!h.closed && h.closeCalls === 0, "new work: not hidden", h);
  });

  // S6 the card is closed (dispose) while the dialog's stop waits: the live process is not "stopped", not hidden.
  await scenario("dispose during stop", async () => {
    const t = await ev<{ id: string }>(`window.hipc.invoke("h:create", "silent", "closed meanwhile", "s6")`);
    await ev(`window.__h.mount({ ws: "s6", runs: {} })`);
    await waitFor(`!!document.querySelector('[data-ws-close-stop]')`, "dialog");
    await click("[data-ws-close-stop]");
    await waitFor(`document.querySelector('[data-ws-close-item="term:${t.id}"]')?.dataset.wsCloseState === "stopping"`, "stopping", 1000);
    await ev(`window.hipc.invoke("h:dispose", ${JSON.stringify(t.id)})`);
    await waitFor(`["timeout", "stopped", "unconfirmed"].includes(document.querySelector('[data-ws-close-item="term:${t.id}"]')?.dataset.wsCloseState)`, "the stop's answer", 9000);
    const st = await state(`term:${t.id}`);
    expect(st === "timeout", "dispose during stop: shown as not ended, never stopped", st);
    await sleep(400);
    expect(!(await ev<{ closed: boolean }>("window.__h.status()")).closed, "dispose during stop: not hidden");
    const listed = await ev<{ id: string }[]>(`window.hipc.invoke("h:list")`);
    expect(listed.some((x) => x.id === t.id), "dispose during stop: main still manages the live process");
    expect(await ev<boolean>(`!!document.querySelector('[data-ws-close-hide]')`), "dispose during stop: the explicit hide stays");
  });

  // S7 main has no record of a listed terminal when the stop asks (its card was closed before): "not confirmed".
  await scenario("absent", async () => {
    const t = await ev<{ id: string }>(`window.hipc.invoke("h:create", "silent", "closed before", "s7")`);
    await ev(`window.__h.mount({ ws: "s7", runs: {} })`);
    await waitFor(`!!document.querySelector('[data-ws-close-stop]')`, "dialog");
    await ev(`window.hipc.invoke("h:dispose", ${JSON.stringify(t.id)})`);
    await click("[data-ws-close-stop]");
    await waitFor(`document.querySelector('[data-ws-close-item="term:${t.id}"]')?.dataset.wsCloseState === "unconfirmed"`, "absent is shown as not confirmed", 3000);
    await sleep(400);
    expect(!(await ev<{ closed: boolean }>("window.__h.status()")).closed, "absent: not hidden automatically");
  });

  // S5 "Hide, work continues" before any stop: nothing is stopped.
  await scenario("hide only", async () => {
    await ev(`window.hipc.invoke("h:create", "silent", "keeps working", "s5")`);
    const before = await ev(`window.hipc.invoke("h:counts")`);
    await ev(`window.__h.mount({ ws: "s5", runs: { r3: { status: "running", revision: 1 } } })`);
    await waitFor(`!!document.querySelector('[data-ws-close-hide]')`, "dialog");
    await click("[data-ws-close-hide]");
    await waitFor("window.__h.status().closed", "hidden");
    const after = await ev(`window.hipc.invoke("h:counts")`);
    const h = await ev<{ commands: string[] }>("window.__h.status()");
    expect(JSON.stringify(before) === JSON.stringify(after) && h.commands.length === 0, "hide only: no signal, no stop command", { before, after, h });
  });
}

app.whenReady().then(async () => {
  win = new BrowserWindow({ width: 1000, height: 760, show: true, webPreferences: { preload: path.join(DIR, "preload.js"), contextIsolation: false } });
  await win.loadFile(path.join(DIR, "index.html"));
  await waitFor("!!window.__h", "harness page");
  await run().catch((e) => expect(false, `run: ${(e as Error).message}`));
  const failures = checks.filter((c) => !c.ok);
  process.stdout.write(`${JSON.stringify({ ok: failures.length === 0, passed: checks.filter((c) => c.ok).map((c) => c.name), failures })}\n`);
  app.exit(failures.length === 0 ? 0 : 1);
});
