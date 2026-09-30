// Electron UI smoke for stage A0 (acceptance-review-spec.md §2.2): a run whose journal a newer version wrote is shown
// read-only next to a v1 run, on a temporary profile with fake Codex/Claude CLIs. Three launches on one user-data dir:
//   first:    two links in one project; link A starts a v1 run that stops at the plan review;
//   (closed): a v2 journal (goal text, v2-only records, valid hash chain) is written for link B;
//   second:   link B says "read only" and offers no new goal or delete; its cards say "read only" (never paused) with no
//             continue or stop; its panel shows the goal and the raw records and no action but closing and "Release
//             link"; direct commands from the renderer are refused; the v1 run resumes to completed;
//   third:    reopened, the same; then "Release link" through the chip: confirmed, the link goes, the release is
//             written down, the run stays in the workspace history read only;
//   fourth:   reopened, the link stays gone. The newer run's files never change (content, size, mode, mtime).
// Needs `npm run build` first. Starts no real model. Usage: node scripts/smoke-a0-newer-ui.mjs [--shots <dir>]
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { FIXTURES, NODE, byText, canvasState, launch as launchApp, q, runs, sleep, startGoal, workspace } from "./orchestration-app-kit.mjs";
import { ZERO_HASH, canonical } from "../src/main/services/orchestration/journal.ts";

const { D, project, script } = workspace("a0-ui-");
const shotsArg = process.argv.indexOf("--shots");
const SHOTS = shotsArg > 0 ? path.resolve(process.argv[shotsArg + 1]) : D("shots");
fs.mkdirSync(SHOTS, { recursive: true });
const PORT = 9400 + Math.floor(Math.random() * 400);
const failures = [];
const passed = [];
const expect = (ok, what, got) => { (ok ? passed : failures).push(ok ? what : `${what}: ${JSON.stringify(got)?.slice(0, 400)}`); };
const sha = (b) => createHash("sha256").update(b).digest("hex");

const projectA = project("project-a");
const planR = { report: { stages: [{ title: "Заметка", task: "Add src/note.mjs exporting a constant" }], question: null } };
const verdict = (v) => ({ report: { verdict: v, findings: [], question: null } });
const codexScript = script("codex", [planR, verdict("accept"), verdict("complete")]);
const claudeScript = script("claude", [{ report: { summary: "note added", done: true }, writes: [["src/note.mjs", "export const note = 'a';\n"]] }]);
fs.mkdirSync(D("mock-state", ".codex"), { recursive: true });
const ledger = D("ledger.jsonl");
const wrap = (p) => {
  const f = D(`${p}-mock`);
  fs.writeFileSync(f, `#!/bin/sh\nexec "${NODE}" "${path.join(FIXTURES, `mock-${p}.mjs`)}" "$@"\n`, { mode: 0o755 });
  return f;
};
const env = (extra) => ({ HOME: D("mock-state"), MOCK_STATE: D("mock-state"), MOCK_LEDGER: ledger, ...extra });
const providers = D("providers.json");
fs.writeFileSync(providers, JSON.stringify({
  codex: { executable: wrap("codex"), version: "codex-cli 0.155.1", path: `${path.dirname(NODE)}:/usr/bin:/bin`,
    env: env({ MOCK_SCRIPT: codexScript, CODEX_HOME: D("mock-state", ".codex") }) },
  claude: { executable: wrap("claude"), version: "2.1.281 (Claude Code)", path: `${path.dirname(NODE)}:/usr/bin:/bin`,
    env: env({ MOCK_SCRIPT: claudeScript }) }
}));
const ledgerCount = () => (fs.existsSync(ledger) ? fs.readFileSync(ledger, "utf8").split("\n").filter(Boolean).length : 0);
const userData = D("user-data");
const root = path.join(userData, "orchestration");
const launch = () => launchApp({ userData, providers, port: PORT, shots: SHOTS });

// The newer version's journal: its own version and record types on the same envelope and hash chain.
function writeNewer(runId, goalText) {
  const dir = path.join(root, "runs", runId);
  fs.mkdirSync(path.join(dir, "texts"), { recursive: true, mode: 0o700 });
  const g = Buffer.from(JSON.stringify({ text: goalText, criteria: ["c"], checks: [], commands: ["true"] }));
  const ref = { sha256: sha(g), bytes: g.length };
  fs.writeFileSync(path.join(dir, "texts", ref.sha256), g);
  let prev = ZERO_HASH;
  const lines = [["run.created", { goal: ref }], ["plan.recorded", { turnId: randomUUID(), version: 1, plan: ref, firstStage: 1, stageCount: 1, conditionsAssigned: 2 }],
    ["review.assessed", { turnId: randomUUID(), stage: 1, request: "none", report: ref, applied: ref, clarificationVersion: 0, runKey: "k" }],
    ["plan.proposed", { turnId: randomUUID(), plan: ref, firstStage: 1, stageCount: 1, conditionsAssigned: 3 }]].map(([type, data], seq) => {
    const body = { v: 2, seq, ts: `2026-09-30T10:00:0${seq}.000Z`, runId, type, prevHash: prev, data };
    prev = sha(canonical(body));
    return canonical({ ...body, hash: prev }) + "\n";
  });
  fs.writeFileSync(path.join(dir, "journal.jsonl"), lines.join(""));
  return dir;
}
function footprint(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      const st = fs.lstatSync(p);
      out[path.relative(dir, p)] = e.isDirectory() ? `dir ${st.mode}` : `${sha(fs.readFileSync(p))} ${st.size} ${st.mode} ${st.mtimeMs}`;
      if (e.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out;
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const chip = (linkId) => q(`[data-agent-link-id="${linkId}"]`);

const newerId = randomUUID();
const GOAL = "Цель из более новой версии";
let app;
let linkA, linkB, v1, lb, newerDir;
const canvasPath = path.join(root, "canvas.json");
try {
  // =============== first launch: two links, a v1 run at the plan review ===============
  app = await launch();
  const ids = await app.ev(`(async () => {
    const o = window.canvasTTY.orchestration;
    const mk = async (provider, x) => (await o.createAgent({ agentId: crypto.randomUUID(), provider, project: ${JSON.stringify(projectA)}, bounds: { position: { x, y: 80 }, size: { width: 300, height: 176 } }, workspaceId: "common" })).value.agentId;
    const leadA = await mk("codex", 40), execA = await mk("claude", 420), leadB = await mk("codex", 40 + 0), execB = await mk("claude", 420);
    const la = (await o.createLink({ linkId: crypto.randomUUID(), fromAgentId: leadA, toAgentId: execA })).value.linkId;
    const lb = (await o.createLink({ linkId: crypto.randomUUID(), fromAgentId: leadB, toAgentId: execB })).value.linkId;
    return { la, lb };
  })()`);
  linkA = ids.la; linkB = ids.lb;
  expect(!!linkA && !!linkB, "first: two links created in main", ids);
  // the cards were created from the renderer's API: reload so the canvas shows what main holds
  await app.ev("location.reload()");
  await app.waitFor(`${chip(linkA)} && ${chip(linkB)} && true`, "both link chips");
  // one lead card per link lies on top of the other: move link B's pair away through main
  const c0 = await canvasState(app);
  lb = c0.links.find((l) => l.linkId === linkB);
  await app.ev(`Promise.all([${JSON.stringify(lb.fromAgentId)}, ${JSON.stringify(lb.toAgentId)}].map((id, i) => window.canvasTTY.orchestration.moveAgent(id, { position: { x: 40 + i * 380, y: 420 }, size: { width: 300, height: 176 } })))`);
  await app.ev("location.reload()");
  await app.waitFor(`${chip(linkA)} && ${chip(linkB)} && true`, "both link chips after the move");
  await startGoal(app, linkA, { reviewPlan: true });
  await app.waitFor(`window.canvasTTY.orchestration.list().then((r) => r.value.some((s) => s.view.status === "paused"))`, "v1 run at the plan review", 60_000);
  v1 = (await runs(app))[0]?.runId;
  expect(!!v1, "first: the v1 run exists", await runs(app));
  await app.shot("a0-01-v1-plan-review");
  await app.stop();
  app = null;

  // =============== between launches: the newer version's run on link B ===============
  newerDir = writeNewer(newerId, GOAL);
  const cv = JSON.parse(fs.readFileSync(canvasPath, "utf8"));
  cv.links.find((l) => l.linkId === linkB).runIds = [newerId];
  cv.owners = { ...(cv.owners ?? {}), [newerId]: "common" };
  fs.writeFileSync(canvasPath, JSON.stringify(cv));
  const before = footprint(newerDir);
  const v1Lines = () => fs.readFileSync(path.join(root, "runs", v1, "journal.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const cliBefore = ledgerCount();

  // =============== second launch ===============
  app = await launch();
  await app.waitFor(`${chip(linkB)} && true`, "link B chip");
  const list = await runs(app);
  const nr = list.find((r) => r.runId === newerId);
  expect(nr?.status === "paused" && nr.reason === "newer_version" && nr.open === false, "second: the newer run is listed read-only", list);
  expect(list.some((r) => r.runId === v1), "second: the v1 run is listed", list);
  await app.waitFor(`${chip(linkB)}.querySelector(".agent-link__state")?.textContent === "Только просмотр"`, "link B says read only");
  const chipButtons = await app.ev(`[...${chip(linkB)}.querySelectorAll("button")].map((b) => b.textContent.trim())`);
  expect(!chipButtons.includes("Новая цель") && !chipButtons.includes("×"), "second: link B offers no new goal and no delete", chipButtons);
  expect(chipButtons.includes("Отпустить связь"), "second: link B offers Release link", chipButtons);
  const cardsB = await app.ev(`[${JSON.stringify(lb.fromAgentId)}, ${JSON.stringify(lb.toAgentId)}].map((id) => { const c = document.querySelector('[data-agent-id="' + id + '"]'); return {
    state: c?.querySelector(".agent-card__state")?.textContent, line: c?.querySelector("[data-agent-now]")?.textContent ?? null,
    buttons: [...(c?.querySelectorAll("button") ?? [])].map((b) => b.textContent.trim()), text: c?.textContent ?? "" }; })`);
  expect(cardsB.every((c) => c.state === "Только просмотр" && c.line === "создан более новой версией Raoden Loom"), "second: link B's cards say read only, created by a newer version", cardsB);
  expect(cardsB.every((c) => !c.buttons.some((b) => /Продолжить|Остановить/.test(b)) && !/пауз/i.test(c.text)), "second: no continue or stop on the cards, never paused", cardsB);
  await app.clickEl(byText(`[data-agent-link-id="${linkB}"] button`, "Открыть запуск"));
  await app.waitFor(`${q("[data-orch-newer]")} && true`, "the newer run's panel");
  await app.waitFor(`document.querySelectorAll("[data-orch-newer-history] li").length === 4`, "four records in the history");
  const panel = await app.ev(`(() => { const p = ${q("[data-orch-newer]")}; return {
    version: p.dataset.orchNewer, title: p.querySelector(".orch-summary__headline").textContent, goal: p.querySelector("[data-orch-newer-goal]").textContent,
    types: [...p.querySelectorAll("[data-orch-newer-history] code")].map((c) => c.textContent),
    buttons: [...p.querySelectorAll("button")].map((b) => b.getAttribute("aria-label") ?? b.textContent.trim()),
    text: p.textContent }; })()`);
  expect(panel.version === "2" && panel.title.includes("более новой версией Raoden Loom"), "second: the panel names the newer version", panel);
  expect(panel.goal.includes(GOAL), "second: the goal of run.created is shown", panel.goal);
  expect(same(panel.types, ["run.created", "plan.recorded", "review.assessed", "plan.proposed"]), "second: the raw records are the history", panel.types);
  expect(same(panel.buttons, ["Закрыть", "Отпустить связь"]), "second: no action but closing and Release link", panel.buttons);
  expect(!/поврежд/i.test(panel.text), "second: not called damaged", panel.text);
  await app.shot("a0-02-newer-panel");
  const refused = await app.ev(`Promise.all(["stop", "resume", "step"].map((kind) => window.canvasTTY.orchestration.command({ runId: ${JSON.stringify(newerId)}, commandId: crypto.randomUUID(), expectedRevision: 0, command: { kind } }).then((r) => r.ok ? "accepted" : r.code)))`);
  expect(refused.every((c) => c === "run_newer_version"), "second: direct commands from the renderer are refused", refused);
  await app.key("Escape", "Escape", 27);
  await app.waitFor(`!${q("[data-orch-newer]")}`, "panel closed");

  // the v1 run next to it goes on by the old rules
  await app.clickEl(byText(`[data-agent-link-id="${linkA}"] button`, "Открыть запуск"));
  await app.waitFor(`${q("[data-orch-resume]")} && true`, "resume of the v1 run");
  await app.clickEl(q("[data-orch-resume]"));
  await app.waitFor(`window.canvasTTY.orchestration.get(${JSON.stringify(v1)}).then((r) => r.value.view.status === "completed")`, "v1 completed", 120_000);
  expect(v1Lines().every((l) => l.v === 1), "second: the v1 run is written only as v1", v1Lines().map((l) => l.v));
  expect(ledgerCount() > cliBefore, "second: CLIs ran for the v1 run", [cliBefore, ledgerCount()]);
  await app.shot("a0-03-v1-completed");
  await app.stop();
  app = null;
  expect(same(footprint(newerDir), before), "second: the newer run's files are unchanged", footprint(newerDir));

  // =============== third launch: reopened ===============
  app = await launch();
  await app.waitFor(`${chip(linkB)}?.querySelector(".agent-link__state")?.textContent === "Только просмотр"`, "reopened: link B says read only");
  await app.clickEl(byText(`[data-agent-link-id="${linkB}"] button`, "Открыть запуск"));
  await app.waitFor(`document.querySelectorAll("[data-orch-newer-history] li").length === 4`, "reopened: the history");
  await app.key("Escape", "Escape", 27);
  await app.waitFor(`!${q("[data-orch-newer]")}`, "reopened: panel closed");
  // "Release link" through the chip: a confirmation that explains it, then the link goes
  const v1Refused = await app.ev(`window.canvasTTY.orchestration.releaseNewerLink({ commandId: crypto.randomUUID(), linkId: ${JSON.stringify(linkA)}, runId: ${JSON.stringify(v1)} }).then((r) => r.ok ? "ok" : r.code)`);
  expect(v1Refused === "run_not_newer", "third: a direct release of the v1 run's link is refused", v1Refused);
  await app.clickEl(`${chip(linkB)}.querySelector("[data-orch-release-link]")`);
  await app.waitFor(`${chip(linkB)}?.querySelector("[data-orch-release-confirm]") && true`, "the release confirmation");
  const confirmText = await app.ev(`${chip(linkB)}.querySelector("[data-orch-release-confirm]").textContent`);
  expect(/Журнал запуска не меняется/.test(confirmText) && /только для просмотра/.test(confirmText) && /окажется без связи/.test(confirmText), "third: the confirmation explains the release", confirmText);
  await app.shot("a0-04-release-confirm");
  expect(same(footprint(newerDir), before), "third: nothing changed before the confirmation", null);
  await app.clickEl(`${chip(linkB)}.querySelector("[data-orch-release-do]")`);
  await app.waitFor(`!${chip(linkB)}`, "link B is gone", 20_000);
  const released = JSON.parse(fs.readFileSync(canvasPath, "utf8"));
  expect(!released.links.some((l) => l.linkId === linkB) && released.releasedNewerRuns?.length === 1
    && released.releasedNewerRuns[0].runId === newerId && released.releasedNewerRuns[0].linkId === linkB && released.releasedNewerRuns[0].folder === projectA
    && typeof released.releasedNewerRuns[0].appVersion === "string", "third: canvas.json records the release", released.releasedNewerRuns);
  const listed = (await runs(app)).find((r) => r.runId === newerId);
  expect(listed?.reason === "newer_version", "third: the run is still listed read-only", listed);
  await app.shot("a0-05-released");
  await app.stop();
  app = null;
  expect(same(footprint(newerDir), before), "third: the newer run's files are unchanged", footprint(newerDir));

  // =============== fourth launch: the link stays gone ===============
  app = await launch();
  await app.waitFor(`${chip(linkA)} && true`, "fourth: link A chip");
  await sleep(500);
  expect(!(await app.ev(`!!${chip(linkB)}`)), "fourth: link B stays gone", null);
  expect((await runs(app)).some((r) => r.runId === newerId), "fourth: the newer run is listed", null);
  await app.stop();
  app = null;
  expect(same(footprint(newerDir), before), "fourth: the newer run's files are unchanged", footprint(newerDir));
  expect(!fs.existsSync(path.join(root, "activity", `${newerId}.jsonl`)), "no activity file for the newer run", null);
} catch (error) {
  failures.push(`exception: ${error?.stack ?? error}`);
} finally {
  if (app) await app.stop().catch(() => {});
}
console.log(JSON.stringify({ passed: passed.length, failures, shots: SHOTS }, null, 2));
process.exit(failures.length ? 1 : 0);
