// Electron smoke for stage 7: preload -> IPC -> run manager in the unpackaged app, with fake Codex/Claude CLIs
// (tests/fixtures/orchestration/mock-*.mjs). Two launches on one user-data directory:
//   first:   refusals (foreign window, bad arguments), run A through to completed, run B paused at plan_review,
//            a watch left open and released by a reload;
//   restart: nothing continues by itself, B continues only on an explicit resume.
// Needs `npm run build` first. Starts no real model: the test providers come from a development-only variable.
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import electronPath from "electron";
import { step, watch } from "./smoke-watchdog.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const FIXTURES = path.join(ROOT, "tests", "fixtures", "orchestration");
const NODE = fs.realpathSync(process.execPath);
const MARKER = "CANVASTTY_ORCHESTRATION_IPC_SMOKE_READY ";
const TMP = fs.realpathSync(fs.mkdtempSync("/tmp/cto-"));
const D = (...p) => path.join(TMP, ...p);
const failures = [];
const expect = (ok, what, got) => { if (!ok) failures.push(`${what}: ${JSON.stringify(got)?.slice(0, 400)}`); };

// the project: check-project without its deliberately failing test, with prepared node_modules
const src = D("project");
fs.cpSync(path.join(FIXTURES, "check-project"), src, { recursive: true });
fs.rmSync(path.join(src, "tests", "broken.test.mjs"));
fs.mkdirSync(path.join(src, "node_modules", "left-pad"), { recursive: true });
fs.writeFileSync(path.join(src, "node_modules", "left-pad", "index.mjs"), "export default (s) => s;\n");
fs.writeFileSync(D("gitconfig"), "");
const gitEnv = { PATH: process.env.PATH, HOME: TMP, GIT_CONFIG_GLOBAL: D("gitconfig"), GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "smoke", GIT_AUTHOR_EMAIL: "smoke@localhost", GIT_COMMITTER_NAME: "smoke", GIT_COMMITTER_EMAIL: "smoke@localhost" };
for (const args of [["init", "-q", "-b", "main"], ["add", "-A"], ["commit", "-q", "-m", "smoke project"]]) execFileSync("git", args, { cwd: src, env: gitEnv });

// scripted answers of the fake CLIs, in call order across both runs (A: plan, review, final; B the same)
function script(name, steps) {
  const d = D("script", name);
  fs.mkdirSync(d, { recursive: true });
  steps.forEach((s, i) => {
    fs.writeFileSync(path.join(d, `${i + 1}.json`), JSON.stringify(s.report));
    if (s.writes) fs.writeFileSync(path.join(d, `${i + 1}.writes.json`), JSON.stringify(s.writes.map(([rel, text]) => ({ rel, base64: Buffer.from(text).toString("base64") }))));
  });
  return d;
}
const planR = { report: { stages: [{ title: "note", task: "Add src/note.mjs exporting a constant" }], question: null } };
const verdict = (v) => ({ report: { verdict: v, findings: [], question: null } });
const codexScript = script("codex", [planR, verdict("accept"), verdict("complete"), planR, verdict("accept"), verdict("complete")]);
const claudeScript = script("claude", [
  { report: { summary: "note added", done: true }, writes: [["src/note.mjs", "export const note = 'a';\n"]] },
  { report: { summary: "note added", done: true }, writes: [["src/note.mjs", "export const note = 'b';\n"]] }
]);
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

const cfg = { source: src, ledger, runA: randomUUID(), runB: randomUUID() };
const config = D("smoke.json");
const userData = D("user-data");

async function launch(phase) {
  fs.writeFileSync(config, JSON.stringify({ ...cfg, phase }));
  step(`launch: ${phase}`);
  const child = spawn(electronPath, [ROOT, `--user-data-dir=${userData}`, "--disable-gpu"], {
    env: { ...process.env, CANVASTTY_ORCHESTRATION_TEST_PROVIDERS: providers, CANVASTTY_ORCHESTRATION_IPC_SMOKE: config },
    stdio: ["ignore", "pipe", "pipe"]
  });
  watch(child, phase);
  let out = "";
  child.stdout.on("data", (c) => { out = (out + c).slice(-256 * 1024); });
  child.stderr.on("data", (c) => { out = (out + c).slice(-256 * 1024); });
  const exit = await new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolve({ code: null, signal: "timeout" }); }, 180_000);
    child.once("exit", (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
  const line = out.split("\n").find((l) => l.startsWith(MARKER));
  if (!line) throw new Error(`${phase}: no report (exit ${JSON.stringify(exit)}). Output:\n${out.slice(-4000)}`);
  return { report: JSON.parse(line.slice(MARKER.length)), exit };
}

const ledgerCount = () => (fs.existsSync(ledger) ? fs.readFileSync(ledger, "utf8").split("\n").filter(Boolean).length : 0);
const refused = (r) => r && r.ok === false ? r.code : r;
try {
  const first = await launch("first");
  const f = first.report, r = f.renderer;
  expect(first.exit.code === 0, "first: clean exit", first.exit);
  expect(f.ledgerAtStart === 0 && f.ledgerBeforeRenderer === 0 && f.openAtStart === 0, "first: no process and no open run at start", f);
  expect(String(f.foreign).startsWith("refused"), "first: foreign window refused", f.foreign);
  expect(f.ledgerAfterForeign === 0, "first: nothing started by the foreign window", f.ledgerAfterForeign);
  expect(r.catalog.ok && r.catalog.value.checks.some((c) => c.id === "node-test"), "catalog", r.catalog);
  expect(r.listBefore.ok && r.listBefore.value.length === 0, "list before", r.listBefore);
  for (const k of ["badId", "extraField", "badCheck", "badCommand", "badText"]) expect(refused(r[k]) === "invalid_argument", k, r[k]);
  expect(r.listAfterBad.value.length === 0, "no run after bad arguments", r.listAfterBad);
  expect(r.created.ok && r.created.value.created === true, "created", r.created);
  expect(r.repeat.ok && r.repeat.value.created === false && r.repeat.value.runId === cfg.runA, "repeat create", r.repeat);
  expect(refused(r.conflict) === "request_conflict", "conflicting repeat", r.conflict);
  expect(r.final?.view.status === "completed", "run A completed", r.final);
  expect(r.events.count > 0 && r.events.increasing && r.events.startsWithSnapshot && r.events.sawActive && r.events.last?.view.status === "completed", "events", r.events);
  // the application's provider configuration, as the fake CLIs received it (stage-7-contract.md §1.2)
  const argvs = fs.readdirSync(D("mock-state")).filter((f) => f.endsWith(".json"))
    .flatMap((f) => JSON.parse(fs.readFileSync(D("mock-state", f), "utf8")).turns ?? []).map((t) => t.argv);
  const flag = (a, f) => a[a.indexOf(f) + 1];
  const codexArgv = argvs.filter((a) => a[0] === "exec"), claudeArgv = argvs.filter((a) => a.includes("-p"));
  expect(codexArgv.length > 0 && codexArgv.every((a) => flag(a, "-m") === "gpt-6-astra" && a.includes('model_reasoning_effort="high"')), "codex argv", codexArgv.map((a) => a.slice(0, 8)));
  expect(claudeArgv.length > 0 && claudeArgv.every((a) => flag(a, "--model") === "claude-sonnet-5" && flag(a, "--max-budget-usd") === "1"), "claude argv", claudeArgv.length);
  expect(r.history.first?.[0]?.[1] === "run.created" && r.history.more && r.history.rest > 0, "history pages", r.history);
  expect(r.goalText?.ok && /add a file/.test(r.goalText.value.text), "goal text", r.goalText);
  expect(refused(r.unknownText) === "text_not_found", "unknown text", r.unknownText);
  expect(r.stale.value?.code === "stale_revision" && JSON.stringify(r.staleRepeat) === JSON.stringify(r.stale), "stale revision and its repeat", [r.stale, r.staleRepeat]);
  expect(r.terminalStop.value?.status === "rejected", "stop on a completed run", r.terminalStop);
  expect(r.pausedB?.view.status === "paused" && r.pausedB.view.reason === "plan_review", "run B paused for the plan review", r.pausedB);
  expect(f.watchersBeforeReload === 1 && f.watchersAfterReload === 0, "the reload released the open watch", [f.watchersBeforeReload, f.watchersAfterReload]);
  const afterFirst = ledgerCount();

  const second = await launch("restart");
  const s = second.report, q = s.renderer;
  expect(second.exit.code === 0, "restart: clean exit", second.exit);
  expect(s.ledgerAtStart === afterFirst && s.ledgerBeforeRenderer === afterFirst && s.ledgerAfterForeign === afterFirst, "restart: nothing started by itself", [afterFirst, s]);
  expect(s.openAtStart === 0, "restart: no run opened by itself", s.openAtStart);
  const listed = Object.fromEntries((q.list.value ?? []).map((x) => [x.view.runId, x]));
  expect(listed[cfg.runA]?.view.status === "completed" && listed[cfg.runB]?.view.status === "paused" && listed[cfg.runB]?.open === false, "restart: list from the journals", q.list);
  expect(q.resume.value?.status === "accepted" && JSON.stringify(q.resumeRepeat) === JSON.stringify(q.resume), "resume and its repeat", [q.resume, q.resumeRepeat]);
  expect(q.finalB?.view.status === "completed", "run B completed after the explicit resume", q.finalB);
  expect(ledgerCount() > afterFirst, "the resume started the fake CLIs", ledgerCount());
  const summary = { ok: failures.length === 0, failures, fakeCliProcesses: ledgerCount(), runA: r.final?.view, runB: q.finalB?.view };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  process.exitCode = failures.length ? 1 : 0;
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}
