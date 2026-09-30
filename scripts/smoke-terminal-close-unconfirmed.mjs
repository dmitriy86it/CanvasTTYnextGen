// Electron smoke of the whole app for a terminal card closed after a stop that saw no exit (workspaces-spec.md §4,
// §5; external review /private/tmp/raoden-stop-card-visibility-review.test.mjs). The shell ignores SIGHUP, so the stop
// really times out and the process really lives on. The card is closed with its own close button (App's handler),
// the workspace close dialog is opened from the menu, "Open" is clicked: every click is a real mouse event on a point
// elementFromPoint confirms. No model, no user project or userData: a temporary Git project and userData, HOME and
// SHELL pointed at the temporary directory. Needs `npm run build` first.
// Usage: node scripts/smoke-terminal-close-unconfirmed.mjs [--shots <dir>]
import fs from "node:fs";
import path from "node:path";
import { launch, q, sleep, workspace } from "./orchestration-app-kit.mjs";

const { D, project } = workspace("cto-close-unconfirmed-");
const shotsArg = process.argv.indexOf("--shots");
const SHOTS = shotsArg > 0 ? path.resolve(process.argv[shotsArg + 1]) : D("shots");
fs.mkdirSync(SHOTS, { recursive: true });
fs.mkdirSync(D("home"), { recursive: true });
const PORT = 9950 + Math.floor(Math.random() * 40);
const failures = [];
const passed = [];
const expect = (ok, what, got) => { (ok ? passed : failures).push(ok ? what : `${what}: ${JSON.stringify(got)?.slice(0, 500)}`); };
const projectA = project("alpha");

let app;
const api = (expr) => app.ev(`(async () => { const w = window.canvasTTY.workspaces; const r = await (${expr}); if (r && r.ok === false) throw new Error(r.code + " " + r.message); return r && "ok" in r ? r.value : r; })()`);
const cardSel = (id) => `[data-canvas-layer-id="terminal:${id}"]`;
const inMain = async (id) => (await app.ev("window.canvasTTY.terminal.list()")).find((s) => s.id === id) ?? null;
const alive = (pid) => { try { process.kill(Number(pid), 0); return true; } catch { return false; } };
const buffer = (id) => `window.canvasTTY.terminal.readBuffer(${JSON.stringify(id)}).then((b) => b.buffer)`;

// A shell that ignores the stop signal; returns its id and pid.
const stubbornShell = async (x, mark) => {
  const ws = (await api("w.get()")).activeId;
  const t = await api(`window.canvasTTY.terminal.create({ provider: "terminal", profile: "normal", cwd: ${JSON.stringify(projectA)}, position: { x: ${x}, y: 200 }, workspaceId: ${JSON.stringify(ws)} })`);
  await app.waitFor(`${q(cardSel(t.id))} && true`, `card ${mark}`);
  await sleep(600);
  await app.ev(`window.canvasTTY.terminal.input(${JSON.stringify(t.id)}, "trap '' HUP; echo ${mark}=$$\\n")`);
  const pid = await app.waitFor(`${buffer(t.id)}.then((b) => (b.match(/${mark}=(\\d+)/) ?? [])[1] ?? null)`, `pid ${mark}`);
  return { id: t.id, pid };
};
const closeCard = async (id) => {
  await app.reveal(q(`${cardSel(id)} .terminal-card__action--close`));
  await app.clickEl(q(`${cardSel(id)} .terminal-card__action--close`));
};
const openCloseDialog = async () => {
  await app.clickEl(q("[data-workspace-menu]"));
  await app.clickEl(q('[data-ws-action="close"]'));
};

try {
  app = await launch({ userData: D("user-data"), port: PORT, shots: SHOTS, env: { HOME: D("home"), SHELL: "/bin/sh" } });
  await app.call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await app.waitFor("document.querySelector('.workspace') && document.querySelector('[data-workspace-bar]') && true", "canvas");
  await sleep(800);

  // a workspace of its own, created through the dialog
  await app.clickEl(q("[data-workspace-new]"));
  await app.waitFor(`${q("[data-ws-form]")} && true`, "new workspace dialog");
  await app.type(q("[data-ws-root]"), projectA);
  await app.type(q("[data-ws-title]"), "Альфа");
  await app.clickEl(q("[data-ws-submit]"));
  await app.waitFor(`!${q("[data-ws-form]")}`, "dialog closed");
  const A = (await api("w.get()")).workspaces.find((w) => w.title === "Альфа").id;

  // ---------- ordinary close: the card goes and stays gone, main drops the session ----------
  const plain = await api(`window.canvasTTY.terminal.create({ provider: "terminal", profile: "normal", cwd: ${JSON.stringify(projectA)}, position: { x: 900, y: 200 }, workspaceId: ${JSON.stringify(A)} })`);
  await app.waitFor(`${q(cardSel(plain.id))} && true`, "plain card");
  await sleep(600);
  await closeCard(plain.id);
  await app.waitFor(`!${q(cardSel(plain.id))}`, "plain card gone");
  await sleep(1200);
  expect(!(await app.ev(`!!${q(cardSel(plain.id))}`)) && !(await inMain(plain.id)), "ordinary close: the card is gone, main has no session, nothing comes back", null);

  // ---------- the defect's path: stop times out, the card is closed, it comes back marked ----------
  const t1 = await stubbornShell(100, "PIDA");
  const stop1 = await app.ev(`window.canvasTTY.terminal.stop(${JSON.stringify(t1.id)})`);
  expect(stop1.outcome === "timeout" && alive(t1.pid), "the stop sees no exit: timeout, the process lives", stop1);
  await closeCard(t1.id);
  await app.waitFor(`${q(`${cardSel(t1.id)} [data-terminal-close-unconfirmed]`)} && true`, "card back, marked", 5000);
  const m1 = await inMain(t1.id);
  expect(m1?.exitCode === null && m1?.closeUnconfirmed === true && alive(t1.pid), "main keeps the live session, marked", m1);
  expect(await app.ev(`${q(`${cardSel(t1.id)} [data-terminal-close-unconfirmed]`)}.textContent.includes("не подтверждено")`), "the card says its end is not confirmed, not stopped", null);
  await app.shot("01-card-back-unconfirmed");

  // closing the workspace asks again and lists it
  await openCloseDialog();
  await app.waitFor(`${q("[data-ws-close]")} && true`, "the close dialog opens (the terminal is work)", 5000);
  expect(await app.ev(`${q(`[data-ws-close-item="term:${t1.id}"]`)}?.textContent.includes("не подтверждено") ?? false`), "the dialog lists it as not confirmed", await app.ev(`${q("[data-ws-close]")}.textContent`));
  expect(await app.ev(`!!${q("[data-ws-close-stop]")}`), "the dialog offers to stop it", null);
  await app.shot("02-close-dialog-lists-it");
  // "Open" leads to its card
  await app.clickEl(q(`[data-ws-close-item="term:${t1.id}"] [data-ws-close-open]`));
  await app.waitFor(`!${q("[data-ws-close]")} && ${q(cardSel(t1.id))}.classList.contains("terminal-card--selected")`, "Open focuses the card");
  const onScreen = await app.ev(`(() => { const r = ${q(cardSel(t1.id))}.getBoundingClientRect(); return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; })()`);
  expect(onScreen, "Open: the card is selected and on screen", null);

  // explicit hide without stopping: nothing is stopped, the card is there after reopening
  await openCloseDialog();
  await app.waitFor(`${q("[data-ws-close]")} && true`, "close dialog again");
  await app.clickEl(q("[data-ws-close-hide]"));
  await app.waitFor(`!${q(`[data-workspace-tab="${A}"]`)}`, "hidden");
  await sleep(600);
  expect(alive(t1.pid) && (await inMain(t1.id))?.exitCode === null, "explicit hide stops nothing", null);
  // reopened the way a person does: the menu's list of hidden workspaces, "Open"
  await app.clickEl(q("[data-workspace-menu]"));
  await app.clickEl(q('[data-ws-action="hidden"]'));
  await app.clickEl(q(`[data-ws-hidden-item="${A}"] button`));
  await app.waitFor(`${q(`[data-workspace-tab="${A}"]`)}?.getAttribute("aria-selected") === "true"`, "reopened");
  await app.waitFor(`${q(`${cardSel(t1.id)} [data-terminal-close-unconfirmed]`)} && true`, "after reopening: the card, still marked");
  expect(true, "after hiding and reopening the card is there, still marked", null);

  // the late exit removes the card for good
  await app.ev(`window.canvasTTY.terminal.input(${JSON.stringify(t1.id)}, "exit\\n")`);
  await app.waitFor(`!${q(cardSel(t1.id))}`, "card gone with the exit", 5000);
  await sleep(1500);
  expect(!(await app.ev(`!!${q(cardSel(t1.id))}`)) && !(await inMain(t1.id)) && !alive(t1.pid), "the late exit: card and session gone, nothing comes back", null);

  // ---------- "Open" when there is no record any more: said so, the dialog stays ----------
  const t2 = await stubbornShell(100, "PIDB");
  await app.ev(`window.canvasTTY.terminal.stop(${JSON.stringify(t2.id)})`);
  await closeCard(t2.id);
  await app.waitFor(`${q(`${cardSel(t2.id)} [data-terminal-close-unconfirmed]`)} && true`, "second card back, marked", 5000);
  await openCloseDialog();
  await app.waitFor(`${q(`[data-ws-close-item="term:${t2.id}"]`)} && true`, "dialog lists the second terminal");
  await app.ev(`window.canvasTTY.terminal.input(${JSON.stringify(t2.id)}, "exit\\n")`);
  await app.waitFor(`!${q(cardSel(t2.id))}`, "second card gone with its exit", 5000);
  await app.clickEl(q(`[data-ws-close-item="term:${t2.id}"] [data-ws-close-open]`));
  await app.waitFor(`${q("[data-ws-close] [role=alert]")} && true`, "a message instead of a silent close");
  expect(await app.ev(`${q("[data-ws-close] [role=alert]")}.textContent.includes("нет записи")`), "Open without a record says so; the dialog stays", await app.ev(`${q("[data-ws-close]")}?.textContent`));
  await app.shot("03-open-without-record");
  await app.clickEl(q("[data-ws-close-cancel]"));
} catch (error) {
  failures.push(`error: ${error?.stack ?? error}`);
  try { await app?.shot("failure"); } catch {}
} finally {
  await app?.stop();
}
const ok = failures.length === 0;
console.log(JSON.stringify({ ok, passed, failures, shots: SHOTS }, null, 2));
process.exit(ok ? 0 : 1);
