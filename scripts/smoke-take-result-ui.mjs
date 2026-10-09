// Electron UI smoke for PR 5 of the UX audit 2026-10-05 (top-10 №10), at a laptop size (1280×800), with the fake
// Codex/Claude CLIs and temporary Git projects:
//   1. a run in a separate copy completes: «Забрать результат» is its main button; «Создать ветку в проекте» makes a
//      branch with the run's change, the project's files, index and HEAD stay as they were, the summary says so;
//   2. «Применить к рабочей папке» where the person has a file in the way: refused, the files named, nothing written;
//   3. «In the project folder» with uncommitted changes: the dialog warns with their number, «Switch to a separate copy»
//      changes this goal only (the saved project settings keep the project folder);
//   4. «Проверить сейчас» found a command failing before any change: at Start the choice; «leave them out» starts the
//      run without that command, the project settings unchanged.
// Needs `npm run build` first. Usage: node scripts/smoke-take-result-ui.mjs [--shots <dir>]
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { FIXTURES, JOURNAL_V2, NODE, byText, canvasState, card, createAgent, launch, q, sleep, startGoal, workspace } from "./orchestration-app-kit.mjs";

const { TMP, D, git, project, script } = workspace("cto-take-");
const shotsArg = process.argv.indexOf("--shots");
const SHOTS = shotsArg > 0 ? path.resolve(process.argv[shotsArg + 1]) : D("shots");
fs.mkdirSync(SHOTS, { recursive: true });
const failures = [];
const passed = [];
const notes = {};
const expect = (ok, what, got) => { (ok ? passed : failures).push(ok ? what : `${what}: ${JSON.stringify(got)?.slice(0, 500)}`); };

const alpha = project("alpha"), beta = project("beta"), gamma = project("gamma"), delta = project("delta");
const planV2 = (title, task) => ({ report: { stages: [{ title, task, conditions: [{ keep: null, text: "node --test passes", covers: ["R1"], evidence: { kind: "check", check: "cmd-1" } }] }],
  dropped: [], dropRequirements: [], question: null } });
const plan = (title, task) => (JOURNAL_V2 ? planV2(title, task) : { report: { stages: [{ title, task }], question: null } });
const review = JOURNAL_V2 ? { report: { conditions: [], findings: [], request: "none", question: null } } : { report: { verdict: "accept", findings: [], question: null } };
const final = JOURNAL_V2 ? { report: { conditions: [], findings: [], request: "none", question: null, requirements: [{ id: "R1", status: "met", note: "node --test passes" }] } }
  : { report: { verdict: "complete", findings: [], question: null } };
const codexScript = script("codex", [plan("Заметка", "Add src/note.mjs"), review, final, plan("Заметка", "Add src/note.mjs"), review, final, plan("Заметка", "Add src/note.mjs")]);
const note = { report: { summary: "Добавлен src/note.mjs.", done: true }, writes: [["src/note.mjs", "export const note = 1;\n"]] };
const claudeScript = script("claude", [note, note, note]);
fs.mkdirSync(D("mock-state", ".codex"), { recursive: true });
const wrap = (p) => {
  const f = D(`${p}-mock`);
  fs.writeFileSync(f, `#!/bin/sh\nexec "${NODE}" "${path.join(FIXTURES, `mock-${p}.mjs`)}" "$@"\n`, { mode: 0o755 });
  return f;
};
// the login shell as the checks call it (-ilc, -lc, -c <line>), without the machine's profile files
const SHELL = D("login-shell");
fs.writeFileSync(SHELL, `#!/bin/sh\ncase "$1" in -*) shift ;; esac\nexec /bin/sh -c "$1"\n`, { mode: 0o755 });
const PATHS = `${path.dirname(NODE)}:/usr/bin:/bin`;
const env = (extra) => ({ HOME: D("mock-state"), MOCK_STATE: D("mock-state"), ...extra });
const providers = D("providers.json");
fs.writeFileSync(providers, JSON.stringify({
  codex: { executable: wrap("codex"), version: "codex-cli 0.160.0", path: PATHS, env: env({ MOCK_SCRIPT: codexScript, CODEX_HOME: D("mock-state", ".codex") }) },
  claude: { executable: wrap("claude"), version: "2.1.293 (Claude Code)", path: PATHS, env: env({ MOCK_SCRIPT: claudeScript }) },
  shell: SHELL, checkEnv: { PATH: PATHS, HOME: D("mock-state") }
}));

let app;
const api = (expr) => app.ev(`(async () => { const o = window.canvasTTY.orchestration; const r = await (${expr}); if (r && r.ok === false) throw new Error(r.code + " " + r.message); return r && "ok" in r ? r.value : r; })()`);
const viewOf = (runId) => api(`o.get(${JSON.stringify(runId)})`).then((s) => s.view);
const waitView = async (runId, pred, what, ms = 90_000) => {
  const end = Date.now() + ms;
  let v;
  while (Date.now() < end) { v = await viewOf(runId); if (pred(v)) return v; await sleep(150); }
  throw new Error(`timeout: ${what} ${JSON.stringify(v)?.slice(0, 400)}`);
};
const newestRun = async (before) => {
  const end = Date.now() + 30_000;
  for (;;) {
    const ids = (await api("o.list()")).map((s) => s.view.runId).filter((id) => !before.includes(id));
    if (ids.length) return ids[0];
    if (Date.now() > end) throw new Error("no new run");
    await sleep(150);
  }
};
const runIds = async () => (await api("o.list()")).map((s) => s.view.runId);
async function pair(dir) {
  await createAgent(app, "Агент Codex (лид)", dir);
  await createAgent(app, "Агент Claude (исполнитель)", dir);
  const c = await canvasState(app);
  const lead = c.agents.find((a) => a.provider === "codex" && a.project === dir), exec = c.agents.find((a) => a.provider === "claude" && a.project === dir);
  await app.drag(await app.center(card(lead.agentId, ".agent-card__port")), await app.center(card(exec.agentId, ".agent-card__body")), 20);
  await app.waitFor(`window.canvasTTY.orchestration.canvas().then((r) => r.value.links.some((l) => l.fromAgentId === ${JSON.stringify(lead.agentId)}))`, "link");
  return (await canvasState(app)).links.find((l) => l.fromAgentId === lead.agentId).linkId;
}
const closePanel = async () => {
  for (let i = 0; i < 3 && await app.ev(`!!${q(".orch-panel")} || !!${q(".orch-dialog")}`); i++) { await app.key("Escape", "Escape", 27); await sleep(300); }
};
// what a branch must not touch on the person's side
const userSide = (dir) => ({
  index: fs.readFileSync(path.join(dir, ".git", "index")).toString("base64"),
  head: fs.readFileSync(path.join(dir, ".git", "HEAD"), "utf8"),
  main: git(dir, "rev-parse", "refs/heads/main").trim(),
  note: fs.existsSync(path.join(dir, "src", "note.mjs"))
});
const outcome = () => app.ev(`${q("[data-orch-take-outcome]")}?.dataset.orchTakeOutcome ?? null`);
const goalOf = { task: "Добавить заметку", criteria: "node --test passes", commands: ["node --test"], workMode: "copy" };

try {
  app = await launch({ userData: D("user-data"), providers, port: 9800 + Math.floor(Math.random() * 150), shots: SHOTS });
  await app.call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await app.waitFor(`${q(".workspace")} && true`, "window", 30_000);

  // 1. a separate copy: the main button, a new branch, the person's side untouched
  const linkA = await pair(alpha);
  let before = await runIds();
  await startGoal(app, linkA, goalOf);
  const runA = await newestRun(before);
  await waitView(runA, (v) => v.status === "completed", "A completed");
  await app.waitFor(`!!${q("[data-orch-take-open]")}`, "the take button", 20_000);
  expect(await app.ev(`${q("[data-orch-take-open]")}.dataset.orchPrimary === "take" && ${q("[data-orch-take-open]")}.textContent === "Забрать результат"`), "completed in a copy: «Забрать результат» is the main button", null);
  expect(!(await app.ev(`!!${q("[data-orch-view-changes]")}`)), "«Посмотреть изменения» is no longer the main button", null);
  await app.clickEl(q("[data-orch-take-open]"));
  await app.waitFor(`!!${q("[data-orch-take]")}`, "the take panel");
  const from = await app.ev(`${q("[data-orch-take-from]")}.textContent`);
  expect(/контрольная точка этапа 1/.test(from), "the source is said: the checkpoint", from);
  const name = await app.ev(`${q("[data-orch-take-name]")}.value`);
  expect(new RegExp(`^raoden/dobavit-zametku-${runA.slice(0, 8)}$`).test(name), "a branch name from the goal and the run", name);
  await app.ev(`${q("[data-orch-take]")}.scrollIntoView({ block: "center" })`);
  await sleep(300);
  await app.shot("01-take-before");
  const side = userSide(alpha);
  await app.clickEl(q("[data-orch-take-branch]"));
  await app.waitFor(`!!${q("[data-orch-take-outcome]")}`, "branch outcome", 30_000);
  expect(await outcome() === "created", "the branch is created", await outcome());
  expect(git(alpha, "show", `${name}:src/note.mjs`) === "export const note = 1;\n", "the branch holds the run's file", null);
  expect(JSON.stringify(userSide(alpha)) === JSON.stringify(side), "the project's index, HEAD, main and files did not change", [userSide(alpha), side]);
  await app.waitFor(`!!${q("[data-orch-taken]")}`, "the summary line");
  const taken = await app.ev(`${q("[data-orch-taken]")}.textContent`);
  expect(taken === `Результат забран: ветка ${name}`, "the summary: «Результат забран: ветка …»", taken);
  await app.ev(`${q("[data-orch-take-outcome]")}.scrollIntoView({ block: "center" })`);
  await sleep(300);
  await app.shot("02-take-after");
  expect(await app.ev(`${q("[data-orch-take-branch]")}.disabled`), "again: the branch button is off once the result is taken", null);
  expect(git(alpha, "for-each-ref", "--format=%(refname)", "refs/heads/raoden/").trim().split("\n").length === 1, "one branch only", null);
  await closePanel();

  // 2. «Apply» where the person's own file is in the way: refused, nothing written
  const linkB = await pair(beta);
  before = await runIds();
  await startGoal(app, linkB, goalOf);
  const runB = await newestRun(before);
  await waitView(runB, (v) => v.status === "completed", "B completed");
  fs.writeFileSync(path.join(beta, "src", "note.mjs"), "// mine\n");
  await app.waitFor(`!!${q("[data-orch-take-open]")}`, "the take button B", 20_000);
  await app.clickEl(q("[data-orch-take-open]"));
  await app.waitFor(`!!${q("[data-orch-take-apply]")}`, "the apply button");
  await app.clickEl(q("[data-orch-take-apply]"));
  await app.waitFor(`!!${q("[data-orch-take-outcome]")}`, "apply outcome", 30_000);
  const refusal = await app.ev(`${q("[data-orch-take-outcome]")}.textContent`);
  expect(await outcome() === "conflict" && /src\/note\.mjs/.test(refusal) && /ничего не изменилось/.test(refusal), "apply: refused, the file named, nothing changed", refusal);
  expect(fs.readFileSync(path.join(beta, "src", "note.mjs"), "utf8") === "// mine\n", "the person's file is as they left it", null);
  await app.ev(`${q("[data-orch-take-outcome]")}.scrollIntoView({ block: "center" })`);
  await sleep(300);
  await app.shot("03-take-conflict");
  await closePanel();

  // 3. the project folder with uncommitted changes: the warning; the switch is for this goal only
  const linkC = await pair(gamma);
  const prof = await api(`o.profile(${JSON.stringify(linkC)})`).then((v) => v.profile);
  expect(prof.workMode === "copy", "a new project: «a separate copy» is suggested", prof.workMode);
  await api(`o.saveProfile(${JSON.stringify(linkC)}, ${JSON.stringify({ ...prof, workMode: "project" })})`);
  fs.appendFileSync(path.join(gamma, "README.md"), "\nmy edit\n");
  fs.writeFileSync(path.join(gamma, "draft.txt"), "draft\n");
  await app.clickEl(byText(`[data-agent-link-id="${linkC}"] button`, "Новая цель"));
  await app.waitFor(`${q(".orch-dialog textarea")} && true`, "goal dialog");
  await app.type(`document.querySelectorAll(".orch-dialog textarea")[0]`, "Добавить заметку");
  await app.type(`document.querySelectorAll(".orch-dialog textarea")[1]`, "node --test passes");
  await app.waitFor(`!!${q("[data-orch-dirty]")}`, "the uncommitted-changes warning", 30_000);
  const dirty = await app.ev(`${q("[data-orch-dirty]")}.textContent`);
  expect(/незакоммиченные изменения \(2\)/.test(dirty) && /Безопаснее — отдельная копия/.test(dirty), "the warning with the number of changes", dirty);
  await app.ev(`${q("[data-orch-dirty]")}.scrollIntoView({ block: "center" })`);
  await sleep(300);
  await app.shot("04-dirty-warning");
  await app.clickEl(q("[data-orch-dirty-switch]"));
  await app.waitFor(`${q("[data-orch-workmode]")}?.dataset.orchWorkmode === "copy"`, "the goal switched to a copy");
  await app.waitFor(`!${q("[data-orch-dirty]")}`, "the warning gone");
  expect((await api(`o.profile(${JSON.stringify(linkC)})`)).profile.workMode === "project", "the project settings still say the project folder", null);
  await closePanel();

  // 4. a command failing before any change: the choice at Start; «leave them out» for this run only
  const linkD = await pair(delta);
  const profD = await api(`o.profile(${JSON.stringify(linkD)})`).then((v) => v.profile);
  await app.clickEl(byText(`[data-agent-link-id="${linkD}"] button`, "Новая цель"));
  await app.waitFor(`${q(".orch-dialog textarea")} && true`, "goal dialog D");
  await app.waitFor(`${q("[data-orch-profile]")}?.dataset.orchProfile !== "loading"`, "project settings D", 20_000);
  await app.type(`document.querySelectorAll(".orch-dialog textarea")[0]`, "Добавить заметку");
  await app.type(`document.querySelectorAll(".orch-dialog textarea")[1]`, "node --test passes");
  const failing = "node -e \"console.error('lint: 3 problems'); process.exit(1)\"";
  await app.type(q("[data-orch-commands]"), `node --test\n${failing}`);
  await app.waitFor(`["ready", "confirm", "blocked"].includes(${q("[data-orch-readiness]")}?.dataset.orchReadiness)`, "light readiness", 30_000);
  await app.clickEl(q("[data-orch-check-now]"));
  await app.waitFor(`${q("[data-orch-readiness]")}?.dataset.orchChecked === "full"`, "check now", 120_000);
  const line = await app.ev(`${q('[data-ready-id="source_1"]')}?.textContent ?? ""`);
  expect(/Прошла до изменений агентов \(во временной копии проекта\)/.test(line), "the wording: «до изменений агентов (во временной копии проекта)»", line);
  await app.waitFor(`!${q(".orch-dialog button[type=submit]")}.disabled`, "start enabled", 10_000);
  await app.clickEl(q(".orch-dialog button[type=submit]"));
  await app.waitFor(`!!${q("[data-orch-failing-choice]")}`, "the choice");
  const choice = await app.ev(`${q("[data-orch-failing-choice]")}.textContent`);
  const failedLine = await app.ev(`[...document.querySelectorAll('[data-ready-id^="source_"]')].map((e) => e.textContent).find((x) => x.includes("Упала")) ?? ""`);
  expect((failedLine.includes("lint: 3 problems") || failedLine.includes("process.exit(1)")) && !(choice.includes("lint: 3 problems") || choice.includes("process.exit(1)")) && /отмечены выше/.test(choice), "the failing command is named once, in its readiness item; the choice points to it", { failedLine, choice });
  expect(await app.ev(`${q("[data-orch-failing-drop]")}.dataset.orchPrimary === "drop_failing"`), "«leave them out» is the main button", null);
  expect(!(await app.ev(`!!${q(".orch-panel")}`)), "nothing started before the choice", null);
  await app.ev(`${q("[data-orch-failing-choice]")}.scrollIntoView({ block: "center" })`);
  await sleep(300);
  await app.shot("05-failing-choice");
  before = await runIds();
  await app.clickEl(q("[data-orch-failing-drop]"));
  const runD = await newestRun(before);
  const vD = await waitView(runD, (v) => (v.progress?.checks?.length ?? 0) > 0, "D's checks");
  expect(JSON.stringify(vD.progress.checks.map((c) => c.title)) === JSON.stringify(["node --test"]), "the run has only the passing command", vD.progress.checks);
  expect(JSON.stringify((await api(`o.profile(${JSON.stringify(linkD)})`)).profile.checks) === JSON.stringify(profD.checks), "the project settings' commands unchanged", null);
  await api(`o.command(${JSON.stringify(runD)}, { commandId: ${JSON.stringify(randomUUID())}, expectedRevision: (await o.get(${JSON.stringify(runD)})).value.view.revision, command: { kind: "stop" } })`).catch(() => {});
  await waitView(runD, (v) => ["stopped", "completed", "failed", "paused"].includes(v.status), "D no longer working");

  const quit = await app.quit();
  app = null;
  process.stdout.write(`${JSON.stringify({ ok: failures.length === 0, passed: passed.length, failures, notes, shots: SHOTS, exit: quit }, null, 2)}\n`);
  process.exitCode = failures.length ? 1 : 0;
} catch (error) {
  await app?.shot("failure").catch(() => {});
  process.stdout.write(`${JSON.stringify({ ok: false, error: String(error?.stack ?? error), passed, failures, notes, shots: SHOTS }, null, 2)}\n`);
  process.exitCode = 1;
} finally {
  await app?.stop().catch(() => {});
  if (shotsArg > 0) fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
