// R-U09. The start-refusal path of folder_busy in the goal dialog: the dialog in A is filled and ready (the folder is
// free), then a run of another link on the same folder starts in B, then the person presses "Start" in A. Main refuses
// with folder_busy. Expected: the dialog names B and offers "Open B"; the button opens B and B's run; nothing started
// in A. The readiness check may also notice the busy folder by itself before the click; which path showed the hint is
// recorded (hintBeforeClick).
// Spec: workspaces-spec.md §5 (folder busy by a run in another workspace: where it is and a way to go there), §4.
// Exit 1 when the refusal is not explained or the button does not lead to B's run. Usage: node R-U09-….mjs [--out <dir>]
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { outDir, q, setup, sleep, start } from "./ui-env.mjs";

const OUT = outDir("r-u09");
const env = setup("r-u09");
// the lead asks a question on its first turn: B's run stays unfinished (waiting for the person)
fs.writeFileSync(path.join(env.D("script", "codex"), "1.asks.json"), JSON.stringify([{ tool: "question", question: "Какой формат?", options: ["CSV", "JSON"] }]));
const result = { repro: "R-U09", ok: false };
let h;
try {
  h = await start({ ...env, port: 9579, shots: OUT });
  const { app } = h;
  await h.size(1280, 800);
  await h.ready();
  const A = (await h.api(`w.create(${JSON.stringify({ title: "Альфа", root: env.projectA, activate: false })})`)).workspaces.at(-1).id;
  const B = (await h.api(`w.create(${JSON.stringify({ title: "Бета", root: env.projectA, activate: false })})`)).workspaces.at(-1).id;
  const bounds = (x, y) => ({ position: { x, y }, size: { width: 300, height: 222 } });
  const mk = (provider, ws, x, y) => h.api(`o.createAgent(${JSON.stringify({ agentId: randomUUID(), provider, project: env.projectA, workspaceId: ws, bounds: bounds(x, y) })})`);
  const leadA = await mk("codex", A, 1500, 60), execA = await mk("claude", A, 1900, 60);
  const leadB = await mk("codex", B, 1500, 60), execB = await mk("claude", B, 1900, 60);
  const linkA = await h.api(`o.createLink(${JSON.stringify({ linkId: randomUUID(), fromAgentId: leadA.agentId, toAgentId: execA.agentId })})`);
  const linkB = await h.api(`o.createLink(${JSON.stringify({ linkId: randomUUID(), fromAgentId: leadB.agentId, toAgentId: execB.agentId })})`);
  await h.reload();
  await h.switchTo(A);
  const newGoal = `[...document.querySelectorAll('[data-agent-link-id="${linkA.linkId}"] button')].find((b) => b.textContent.trim() === "Новая цель")`;
  await app.clickEl(newGoal);
  await app.waitFor(`${q(".orch-dialog textarea")} && true`, "goal dialog");
  await app.type(`document.querySelectorAll(".orch-dialog textarea")[0]`, "Заметка");
  await app.type(`document.querySelectorAll(".orch-dialog textarea")[1]`, "node --test passes");
  await app.waitFor(`${q("[data-orch-profile]")} && ${q("[data-orch-profile]")}.dataset.orchProfile !== "loading"`, "project settings");
  await app.waitFor(`["ready", "confirm", "blocked", "error"].includes(${q("[data-orch-readiness]")}?.dataset.orchReadiness)`, "readiness", 15_000);
  const confirms = await app.ev(`document.querySelectorAll(".orch-ready__item--confirm input[type=checkbox]").length`);
  for (let i = 0; i < confirms; i += 1) await app.clickEl(`document.querySelectorAll(".orch-ready__item--confirm input[type=checkbox]")[${i}]`);
  await app.waitFor(`!${q(".orch-dialog button[type=submit]")}.disabled`, "start enabled", 10_000);
  result.readinessBefore = await app.ev(`${q("[data-orch-readiness]")}?.dataset.orchReadiness`);
  // B's run takes the folder now
  const runB = (await h.api(`o.startOnLink(${JSON.stringify({ linkId: linkB.linkId, requestId: randomUUID(), goal: { text: "Импорт", criteria: ["node --test passes"], checks: [], commands: ["node --test"], workMode: "project", mode: "autopilot" } })})`)).runId;
  for (let i = 0; i < 200; i++) { const v = (await h.api(`o.get(${JSON.stringify(runB)})`)).view; if (["running", "paused", "preparing"].includes(v.status)) break; await sleep(100); }
  result.hintBeforeClick = await app.ev(`!!${q("[data-orch-folder-busy]")}`);
  const runsBefore = (await h.api("o.list()")).length;
  if (!(await app.ev(`${q(".orch-dialog button[type=submit]")}.disabled`))) await app.clickEl(q(".orch-dialog button[type=submit]"));
  else result.submitDisabledByReadiness = true;
  await sleep(1_500);
  result.dialogStillOpen = await app.ev(`!!${q(".orch-dialog")}`);
  result.hint = await app.ev(`${q("[data-orch-folder-busy]")}?.textContent ?? null`);
  result.dialogError = await app.ev(`${q(".orch-dialog .dialog-error")}?.textContent ?? null`);
  result.newRunsInA = (await h.api("o.list()")).length - runsBefore;
  result.hintNamesB = !!result.hint && result.hint.includes("Бета");
  await app.shot("r-u09-refused");
  if (result.hint) {
    await app.clickEl(q("[data-orch-folder-busy-open]"));
    await sleep(800);
    result.activeAfterOpen = (await h.state()).activeId === B ? "B" : "other";
    result.panelShowsRunB = await app.ev(`!!${q(".orch-panel")} && ${q(".orch-panel")}.textContent.includes(${JSON.stringify(runB.slice(0, 8))})`);
    await app.shot("r-u09-opened");
  }
  result.ok = result.hintNamesB && result.newRunsInA === 0 && result.activeAfterOpen === "B" && result.panelShowsRunB;
} catch (e) {
  result.error = String(e?.stack ?? e);
} finally {
  await h?.app.stop();
}
console.log(JSON.stringify(result));
process.exit(result.ok ? 0 : 1);
