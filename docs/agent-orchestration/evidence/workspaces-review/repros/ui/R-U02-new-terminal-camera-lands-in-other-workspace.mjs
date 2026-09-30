// R-U02. A terminal opened in A (HOME launcher) while the person switches to B before the terminal is created: the
// terminal belongs to A, but createSession's focus camera (set after `await terminal.create` / `await saveSettings`,
// without a workspace label) is applied to B and saved as B's camera. B jumps to an empty place where A's card is.
// Spec: workspaces-spec.md §5 "Изменение камеры помечено пространством, показанным в момент жеста. Изменение, пришедшее
// после переключения с меткой другого пространства, отбрасывается"; §4 "Запоздалая запись камеры A пишется в A и не
// трогает B". The same unlabeled late setCamera exists in openBrowser and openPluginCanvasContribution (App.tsx).
// The switch must reach the page before main answers terminal.create: the key is sent right after the click, and the
// order is measured in the page (keydown time vs the session event of the new terminal). Up to 4 attempts.
// Exit 1 when B's camera changed in an attempt where the switch came first. Usage: node R-U02-….mjs [--out <dir>]
import { near, outDir, q, setup, sleep, start } from "./ui-env.mjs";

const OUT = outDir("r-u02");
const env = setup("r-u02");
const result = { repro: "R-U02", ok: true, attempts: [] };
let h;
try {
  h = await start({ ...env, port: 9572, shots: OUT });
  const { app } = h;
  await h.size(1280, 800);
  await h.ready();
  const A = (await h.api(`w.create(${JSON.stringify({ title: "Альфа", root: env.projectA, activate: false })})`)).workspaces.at(-1).id;
  const B = (await h.api(`w.create(${JSON.stringify({ title: "Бета", root: env.projectB, activate: false })})`)).workspaces.at(-1).id;
  await h.reload();
  const order = (await h.state()).workspaces.filter((w) => !w.closed).map((w) => w.id);
  await h.switchTo(B);
  await app.panBy({ x: -300, y: 120 }); // B: its own camera, away from HOME
  await sleep(900);
  await app.ev(`(() => { window.__t = {}; addEventListener("keydown", (e) => { if (e.metaKey && e.code.startsWith("Digit")) window.__t.key ??= performance.now(); }, true);
    window.canvasTTY.terminal.onSession(({ session }) => { if (!window.__t.known?.has(session.id)) { window.__t.session ??= performance.now(); window.__t.ws = session.workspaceId; } }); })()`);
  for (let attempt = 1; attempt <= 4; attempt++) {
    await h.switchTo(A);
    await app.clickEl(`document.querySelectorAll(".canvas-controls button")[0]`); // Home: the launcher in view
    await sleep(700); // A's camera saved before the attempt
    await app.ev(`window.canvasTTY.terminal.list().then((l) => { window.__t = { known: new Set(l.map((s) => s.id)) }; return true; })`);
    const camB = await h.stored(B);
    const shownB = camB;
    const launcher = q(".launcher-button--terminal");
    const p = await app.pointOn(launcher);
    const hit = await h.hits(launcher, p.x, p.y);
    await app.mouse("mouseMoved", p.x, p.y);
    await app.mouse("mousePressed", p.x, p.y, "left", 1);
    await app.mouse("mouseReleased", p.x, p.y, "left", 0);
    await h.chord(order.indexOf(B) + 1); // no wait: the switch as fast as a person's next key
    await app.waitFor(`${h.tab(B)}?.getAttribute("aria-selected") === "true"`, "B by ⌘digit");
    await sleep(1_500);
    const t = await app.ev("({ key: window.__t.key ?? null, session: window.__t.session ?? null, ws: window.__t.ws ?? null })");
    const nowB = await h.cameraNow();
    const storedB = await h.stored(B);
    const a = { attempt, launcherHit: hit, terminalOwner: t.ws, terminalOwnedByA: t.ws === A, switchBeforeCreate: t.key !== null && t.session !== null && t.key < t.session,
      camB: shownB, nowB, storedB, bShownUnchanged: near(nowB, camB), bStoredUnchanged: near(storedB, camB) };
    result.attempts.push(a);
    if (a.switchBeforeCreate && (!a.bShownUnchanged || !a.bStoredUnchanged)) { result.ok = false; await app.shot(`r-u02-attempt${attempt}`); break; }
  }
  result.raceHit = result.attempts.some((a) => a.switchBeforeCreate);
  if (!result.raceHit) result.inconclusive = "the switch never reached the page before the terminal was created";
} catch (e) {
  result.ok = false;
  result.error = String(e?.stack ?? e);
} finally {
  await h?.app.stop();
}
console.log(JSON.stringify(result));
process.exit(result.ok && result.raceHit ? 0 : 1);
