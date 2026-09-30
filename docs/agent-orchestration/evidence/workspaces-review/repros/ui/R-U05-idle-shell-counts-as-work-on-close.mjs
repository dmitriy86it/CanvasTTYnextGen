// R-U05. Closing a workspace whose only content is an open, idle shell: §5 says "работы нет — скрыть" and "shell-терминалы
// не считаются работой", but openWsDialog treats any live terminal as work and opens the "stop and hide" dialog, which
// offers to kill the shell. The switcher's own counters (same §6 rule) show no work for this workspace.
// Spec: workspaces-spec.md §5 (Закрыть пространство; легенда переключателя), §6 "Открытый shell не считается работой".
// Exit 1 when the dialog is shown instead of hiding. Usage: node R-U05-….mjs [--out <dir>]
import { outDir, q, setup, sleep, start } from "./ui-env.mjs";

const OUT = outDir("r-u05");
const env = setup("r-u05");
const result = { repro: "R-U05", ok: false };
let h;
try {
  h = await start({ ...env, port: 9574, shots: OUT });
  const { app } = h;
  await h.size(1280, 800);
  await h.ready();
  const A = (await h.api(`w.create(${JSON.stringify({ title: "Альфа", root: env.projectA, activate: false })})`)).workspaces.at(-1).id;
  await h.reload();
  await h.switchTo(A);
  const term = await app.ev(`window.canvasTTY.terminal.create({ provider: "terminal", profile: "normal", cwd: ${JSON.stringify(env.projectA)}, position: { x: 1500, y: 200 }, workspaceId: ${JSON.stringify(A)} })`);
  await sleep(1_000);
  result.tabCounts = await app.ev(`(() => { const t = ${h.tab(A)}; return { runs: !!t.querySelector("[data-ws-runs]"), cli: !!t.querySelector("[data-ws-cli]"), attention: !!t.querySelector("[data-ws-attention]"), title: t.title }; })()`);
  await app.clickEl(q("[data-workspace-menu]"));
  await app.clickEl(q('[data-ws-action="close"]'));
  await sleep(800);
  result.dialogShown = await app.ev(`!!${q("[data-ws-close]")}`);
  result.dialogItems = await app.ev(`[...document.querySelectorAll("[data-ws-close-item]")].map((li) => li.dataset.wsCloseItem)`);
  result.hidden = (await h.state()).workspaces.find((w) => w.id === A).closed;
  result.terminalId = term.id;
  await app.shot("r-u05-close");
  result.ok = !result.dialogShown && result.hidden;
} catch (e) {
  result.error = String(e?.stack ?? e);
} finally {
  await h?.app.stop();
}
console.log(JSON.stringify(result));
process.exit(result.ok ? 0 : 1);
