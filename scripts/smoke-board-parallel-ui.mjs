// Electron UI smoke for C1, parallel tasks and the board's result (docs/agent-orchestration/implementation/stage-c-parallel.md):
// the real window at 1280×800, fake Codex/Claude CLIs (one script per work folder), a temporary Git project.
//   1. two independent tasks that both add src/shared.mjs, the project in «Separate copy» with node --test;
//   2. «Run the board», 2 at once: both runs go at the same time on one link; the cards do not multiply — the link
//      says «2 runs» and switches between them;
//   3. the first «Done» goes into the board's result with its checks; the second conflicts: the merge waits for the
//      person, the board names the file and nothing moves; resolved in the merge copy, «Done, check» — both in the
//      result, checks passed;
//   4. «Create a branch from the board's result»: a new name at the result; the project folder, its HEAD and status
//      as they were.
// Needs `npm run build` first. Starts no real model. Usage: node scripts/smoke-board-parallel-ui.mjs [--shots <dir>]
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { FIXTURES, NODE, canvasState, card, createAgent, launch as launchApp, q, waitForValue, workspace, JOURNAL_V2 } from "./orchestration-app-kit.mjs";

const { D, project, script } = workspace("cto-board-par-");
const shotsArg = process.argv.indexOf("--shots");
const SHOTS = shotsArg > 0 ? path.resolve(process.argv[shotsArg + 1]) : D("shots");
fs.mkdirSync(SHOTS, { recursive: true });
const PORT = 9800 + Math.floor(Math.random() * 150);
const failures = [];
const passed = [];
const expect = (ok, what, got) => { (ok ? passed : failures).push(ok ? what : `${what}: ${JSON.stringify(got)?.slice(0, 400)}`); };
if (!JOURNAL_V2) throw new Error("the board is journal v2 only (goal.task)");

// ---------- the project and the fake CLIs: one script per work folder (MOCK_SCRIPT_PER_CWD) ----------
const node = project("board-par-app");
const SHARED = "src/shared.mjs";
const steps = (value) => [
  { report: { stages: [{ title: "Общий модуль", task: `Add ${SHARED}`, conditions: [{ keep: null, text: `${SHARED} exists`, covers: ["R1"], evidence: { kind: "change", check: null } }] }], dropped: [], dropRequirements: [], question: null } },
  { report: { summary: `${value} added`, done: true }, writes: [[SHARED, `export const shared = "${value}";\n`]] },
  { report: { conditions: [{ id: "C1", status: "met", paths: [SHARED], note: "done" }], findings: [], request: "none", question: null } },
  { report: { conditions: [], findings: [], request: "none", question: null, requirements: [{ id: "R1", status: "met", note: "done" }] } }
];
script("par/1", steps("one"));
script("par/2", steps("two"));
const SCRIPT = D("script", "par");
fs.mkdirSync(D("mock-state", ".codex"), { recursive: true });
fs.writeFileSync(D("mock-state", ".codex", "config.toml"), "");
const ledger = D("ledger.jsonl");
const wrap = (p) => {
  const f = D(`${p}-mock`);
  fs.writeFileSync(f, `#!/bin/sh\nexec "${NODE}" "${path.join(FIXTURES, `mock-${p}.mjs`)}" "$@"\n`, { mode: 0o755 });
  return f;
};
const PATHS = `${path.dirname(NODE)}:/usr/bin:/bin`;
const env = (extra) => ({ HOME: D("mock-state"), MOCK_STATE: D("mock-state"), MOCK_LEDGER: ledger, MOCK_CHECKS: "none", MOCK_SCRIPT: SCRIPT, MOCK_SCRIPT_PER_CWD: "1", ...extra });
const SHELL = D("login-shell");
fs.writeFileSync(SHELL, `#!/bin/sh\n[ "$1" = "-ilc" ] && shift\nexec /bin/sh -c "$1"\n`, { mode: 0o755 });
const providers = D("providers.json");
fs.writeFileSync(providers, JSON.stringify({
  codex: { executable: wrap("codex"), version: "codex-cli 0.155.1", path: PATHS, env: env({ CODEX_HOME: D("mock-state", ".codex") }) },
  claude: { executable: wrap("claude"), version: "2.1.281 (Claude Code)", path: PATHS, env: env({}) },
  shell: SHELL, checkEnv: { PATH: PATHS, HOME: D("mock-state") }
}));
const git = (...a) => execFileSync("git", a, { cwd: node, encoding: "utf8" }).trim();
const ledgerCount = () => (fs.existsSync(ledger) ? fs.readFileSync(ledger, "utf8").split("\n").filter(Boolean).length : 0);

let app;
const laptop = () => app.call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
const task = (key) => `[data-board-task="${key}"]`;
const shown = (key) => app.ev(`(() => { const el = ${q(task(key))}; return el && { column: el.dataset.boardTaskColumn, done: el.dataset.boardDone ?? null,
  mark: el.querySelector("[data-board-merge-mark]")?.textContent ?? null }; })()`);
async function newTask({ title, text, criteria }) {
  await app.clickEl(q("[data-board-new]"));
  await app.waitFor(`${q("[data-board-form]")} && true`, "task form");
  await app.type(q('[data-board-field="title"]'), title);
  await app.type(q('[data-board-field="text"]'), text);
  await app.type(q('[data-board-field="criteria"]'), criteria);
  await app.clickEl(q("[data-board-save]"));
  await app.waitFor(`!${q("[data-board-form]")}`, "task form closed");
}
async function boardShot(name) {
  const r = await app.ev(`(() => { const b = ${q("[data-board]")}.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; })()`);
  const shot = await app.call("Page.captureScreenshot", { format: "png", clip: { ...r, scale: 2 } });
  fs.writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(shot.data, "base64"));
}
const view = () => app.ev("window.canvasTTY.orchestration.board().then((r) => r.value)");

try {
  app = await launchApp({ userData: D("user-data"), providers, port: PORT, shots: SHOTS });
  await laptop();
  // ---------- 1. the link, the board, two tasks, a separate copy ----------
  await createAgent(app, "Агент Codex (лид)", node);
  await createAgent(app, "Агент Claude (исполнитель)", node);
  const c = await canvasState(app);
  const lead = c.agents.find((a) => a.provider === "codex"), exec = c.agents.find((a) => a.provider === "claude");
  const ends = () => Promise.all([app.center(card(lead.agentId, ".agent-card__port")), app.center(card(exec.agentId, ".agent-card__body"))]);
  let prev = null;
  const [from, to] = await waitForValue(async () => { const e = await ends(); const still = prev && JSON.stringify(prev) === JSON.stringify(e); prev = e; return still ? e : null; }, "the cards laid out");
  await app.drag(from, to, 20);
  await app.waitFor("window.canvasTTY.orchestration.canvas().then((r) => r.value.links.length === 1)", "link");
  await app.clickEl(q("[data-board-button]"));
  await app.waitFor(`${q("[data-board]")} && true`, "the board on the canvas");
  await newTask({ title: "Общий модуль one", text: "Добавить src/shared.mjs со значением one", criteria: "src/shared.mjs есть" });
  await newTask({ title: "Общий модуль two", text: "Добавить src/shared.mjs со значением two", criteria: "src/shared.mjs есть" });
  const linkId = (await canvasState(app)).links[0].linkId;
  const saved = await app.ev(`window.canvasTTY.orchestration.profile(${JSON.stringify(linkId)}).then((r) => window.canvasTTY.orchestration.saveProfile(${JSON.stringify(linkId)},
    { ...r.value.profile, workMode: "copy", checks: ["node --test"] })).then((r) => r.ok)`);
  expect(saved === true, "the project's settings: a separate copy, node --test", saved);
  const before = { head: git("rev-parse", "HEAD"), status: git("status", "--porcelain"), branches: git("for-each-ref", "--format=%(refname)", "refs/heads"), files: fs.readdirSync(node).sort() };

  // ---------- 2. «Run the board», 2 at once ----------
  await app.clickEl(q("[data-board-autopilot-start]"));
  await app.waitFor(`${q("[data-board-autopilot-confirm]")} && true`, "the autopilot's explanation");
  const parallel = await app.ev(`${q("[data-board-budget-parallel]")}?.value ?? null`);
  expect(parallel === "2", "«Run the board» offers 2 tasks at once by default", parallel);
  await boardShot("par-01-autopilot-ask-board");
  await app.clickEl(q("[data-board-autopilot-yes]"));
  await app.waitFor(`${q('[data-board-autopilot="on"]')} && true`, "the autopilot on");
  expect((await app.ev(`${q("[data-board-autopilot-parallel]")}?.textContent`)) === "2 параллельно", "the autopilot says «2 at once»");
  const both = await waitForValue(async () => {
    const v = await view();
    const live = v.facts.filter((f) => ["preparing", "running", "paused"].includes(f.status));
    return live.length === 2 ? live : null;
  }, "two runs at once", 60_000);
  expect(both.length === 2 && new Set(both.map((f) => f.board)).size === 1 && both[0].board?.startsWith("refs/raoden/board/"), "two runs at once, both from the board's result", both.map((f) => [f.taskKey, f.board]));
  const chip = await waitForValue(() => app.ev(`${q("[data-agent-runs]")}?.dataset.agentRuns ?? null`), "the link's «2 runs»", 20_000).catch(() => null);
  expect(chip === "2" && (await app.ev("document.querySelectorAll('[data-agent-id]').length")) === 2, "the cards do not multiply; the link says «2 runs»", chip);
  const taskOnCard = () => app.ev(`${q(`[data-agent-id="${exec.agentId}"] [data-agent-task]`)}?.textContent ?? null`);
  const first = await waitForValue(taskOnCard, "the card names its task", 20_000).catch(() => null);
  await app.clickEl(q("[data-agent-runs]"));
  const second = await waitForValue(async () => { const x = await taskOnCard(); return x && x !== first ? x : null; }, "the card switched to the other run", 10_000).catch(() => null);
  expect(!!first && !!second && first !== second, "the switch shows the other run on the same cards", [first, second]);
  await app.shot("par-02-two-runs");
  await boardShot("par-02-two-runs-board");

  // ---------- 3. the first into the result, the second conflicts ----------
  await app.waitFor(`${q('[data-board-merge-waits="merge_conflict"]')} && true`, "the merge conflict waits for the person", 180_000);
  const conflictText = await app.ev(`${q("[data-board-merge-conflicts]")}?.textContent ?? ""`);
  expect(conflictText.includes(SHARED), "the board names the conflicting file", conflictText);
  const v1 = await view();
  const [head] = v1.heads;
  const done1 = head.merges.find((m) => m.status === "completed");
  const waits = head.merges.find((m) => m.status === "paused");
  expect(done1 && waits && head.commit === git("rev-parse", head.ref), "one task in the result; the other's merge waits; the head where the first left it", head.merges.map((m) => [m.task.key, m.status]));
  const markWaits = await shown(waits.task.key);
  const markDone = await shown(done1.task.key);
  expect(markDone?.mark === "в итоге доски" && markWaits?.mark === "не объединено: конфликт", "the marks: «in the board's result» / «not merged: conflict»", [markDone, markWaits]);
  expect(git("cat-file", "-t", waits.task.commit) === "commit" && git("rev-parse", `${head.commit}^{tree}`) !== git("rev-parse", `${waits.task.commit}^{tree}`), "the conflicting task's result is kept as it was, out of the result");
  await app.shot("par-03-merge-conflict");
  await boardShot("par-03-merge-conflict-board");
  // the person resolves in the merge copy (their own editor), never in the project folder
  fs.writeFileSync(path.join(waits.dir, SHARED), 'export const shared = "one-two";\n');
  await app.clickEl(q("[data-board-merge-check]"));
  await app.waitFor(`${q('[data-board-autopilot-stop="all_done"]')} && true`, "the autopilot done", 120_000);
  const headLine = await app.ev(`${q("[data-board-head-tasks]")}?.textContent ?? null`);
  const checks = await app.ev(`${q("[data-board-head-checks]")}?.dataset.boardHeadChecks ?? null`);
  expect(headLine === `Итог доски: ${done1.task.key}, ${waits.task.key}` && checks === "passed", "both in the board's result, checks passed", [headLine, checks]);
  const v2 = await view();
  const h2 = v2.heads[0];
  expect(execFileSync("git", ["show", `${h2.commit}:${SHARED}`], { cwd: node, encoding: "utf8" }) === 'export const shared = "one-two";\n', "the result holds the person's resolution");
  await boardShot("par-04-both-in-result-board");

  // ---------- 4. «Create a branch from the board's result»; the project folder as it was ----------
  await app.clickEl(q("[data-board-head-branch]"));
  await app.waitFor(`${q('[data-board-head-confirm="branch"]')} && true`, "the branch explanation");
  await app.clickEl(q("[data-board-head-yes]"));
  const msg = await waitForValue(() => app.ev(`${q(".board-card__message")}?.textContent ?? null`), "the branch message", 10_000).catch(() => null);
  const name = msg?.replace("Создана ветка ", "") ?? "";
  expect(name.startsWith("raoden/board-") && git("rev-parse", `refs/heads/${name}`) === h2.commit, "«Create a branch from the board's result»: a new name at the result", msg);
  const after = { head: git("rev-parse", "HEAD"), status: git("status", "--porcelain"), branches: git("for-each-ref", "--format=%(refname)", "refs/heads"), files: fs.readdirSync(node).sort() };
  expect(after.head === before.head && after.status === before.status && JSON.stringify(after.files) === JSON.stringify(before.files),
    "the project folder, its HEAD and status as they were", { before, after });
  expect(after.branches.split("\n").filter((b) => !b.startsWith("refs/heads/raoden/")).join() === before.branches.split("\n").join(), "the person's branches as they were; only raoden/ names added", after.branches);
  await app.shot("par-05-done");
} catch (error) {
  failures.push(`error: ${String(error?.stack ?? error).slice(0, 1500)}`);
  try { await app?.shot("failure"); } catch {}
} finally {
  const exit = await app?.quit?.();
  console.log(JSON.stringify({ ok: failures.length === 0, passed: passed.length, passedList: passed, failures, fakeCliProcesses: ledgerCount(), shots: SHOTS, exit }, null, 2));
  process.exitCode = failures.length === 0 ? 0 : 1;
}
