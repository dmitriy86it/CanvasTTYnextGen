// C1 acceptance probe (stage-c-parallel.md §9 C1): two independent tasks with tests run at once by the board's
// autopilot (parallelism 2), each in its own copy started from the board's result; the application merges each into
// the result with the project's check on the merged tree. The development build with journal v2, a temporary
// application profile, a temporary copy of the series fixture (a Git repository, without its fixed acceptance test:
// the tasks are independent). The project settings: a separate copy, rights «Рабочая папка» for both CLIs, the check
// «node --test», models «Как в CLI» — except Codex when model/list does not offer the model of ~/.codex/config.toml:
// then gpt-6-sol for the lead and the reviewer, set in the project settings (never in config.toml). «Вести доску» is
// turned on in the board card; nothing else is clicked until it stops. A permission prompt is recorded and denied.
//   --rehearse   fake CLIs (no model request): checks this script
//   --real       the installed codex and claude (REAL model requests)
// --calls <n> the model call budget (default 12) · --minutes <n> (default 45) · --out <dir>
// (default docs/agent-orchestration/evidence/real-c1). On either limit the autopilot is turned off and the runs stopped.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FIXTURES, NODE, launch as launchApp, q, sleep, workspace } from "./orchestration-app-kit.mjs";

const REAL = process.argv.includes("--real");
const REHEARSE = process.argv.includes("--rehearse");
if (REAL === REHEARSE) throw new Error("exactly one of --real or --rehearse");
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const CALLS = Number(arg("--calls") ?? 12);
const LIMIT_MS = Number(arg("--minutes") ?? 45) * 60_000;
const FALLBACK_MODEL = "gpt-6-sol";
const { TMP, D, git, script } = workspace(REAL ? "cto-c1-" : "cto-c1-rh-");
const OUT = path.resolve(arg("--out") ?? (REAL ? path.join(FIXTURES, "..", "..", "..", "docs", "agent-orchestration", "evidence", "real-c1") : D("out")));
fs.mkdirSync(OUT, { recursive: true });
const SHOTS = path.join(OUT, "shots");
fs.mkdirSync(SHOTS, { recursive: true });
const t0 = Date.now();
const anon = (s) => String(s ?? "").replaceAll(TMP, "<tmp>").replaceAll(os.homedir(), "~").replaceAll(os.userInfo().username, "<user>");
const logLines = [];
const log = (m) => { const l = `[+${((Date.now() - t0) / 1000).toFixed(1)}s] ${anon(m)}`; logLines.push(l); process.stderr.write(`${l}\n`); };
const report = { mode: REAL ? "real" : "rehearse", startedAt: new Date(t0).toISOString(), budget: { calls: CALLS, minutes: LIMIT_MS / 60_000 }, versions: {}, tasks: {}, prompts: [], failures: [] };

// ---------- the person's CLI settings: hashed before and after ----------
const sha = (files) => {
  const there = files.filter((f) => fs.existsSync(f));
  return there.length ? execFileSync("/bin/sh", ["-c", `cat ${there.map((f) => `'${f}'`).join(" ")} | shasum -a 256 | cut -c1-16`], { encoding: "utf8" }).trim() : null;
};
const HOME = os.homedir();
const hashes = () => ({ codexConfig: sha([path.join(HOME, ".codex", "config.toml")]), claudeSettings: sha([path.join(HOME, ".claude", "settings.json"), path.join(HOME, ".claude", "settings.local.json")]) });
report.hashesBefore = hashes();

const which = (name) => { try { return execFileSync("/bin/sh", ["-lc", `command -v ${name}`], { encoding: "utf8" }).trim(); } catch { return null; } };
if (REAL) for (const cli of ["codex", "claude"]) {
  const bin = which(cli);
  report.versions[cli] = bin ? execFileSync(bin, ["--version"], { encoding: "utf8" }).split("\n")[0].trim() : null;
  if (!bin) { process.stdout.write(`${JSON.stringify({ ok: false, stop: `${cli} not found` })}\n`); process.exit(1); }
}

// ---------- two independent tasks ----------
const TASKS = [
  { title: "clamp", text: "Add a function clamp(x, lo, hi) in src/clamp.mjs (ES module, named export) that returns x limited to [lo, hi] and throws RangeError when lo > hi. Add a unit test tests/clamp.test.mjs. Change no other file.",
    criteria: ["clamp limits x to [lo, hi] and throws RangeError when lo > hi", "node --test passes"], file: "src/clamp.mjs" },
  { title: "slugify", text: "Add a function slugify(text) in src/slugify.mjs (ES module, named export) that lowercases text, replaces every run of characters other than a-z and 0-9 with a single \"-\" and trims \"-\" from both ends. Add a unit test tests/slugify.test.mjs. Change no other file.",
    criteria: ["slugify(\" Hello, World! \") returns \"hello-world\"", "node --test passes"], file: "src/slugify.mjs" }
];

function rehearsalProviders() {
  const dir = D("rehearsal");
  fs.mkdirSync(path.join(dir, "mock-state", ".codex"), { recursive: true });
  const change = (text, covers) => ({ keep: null, text, covers, evidence: { kind: "change", check: null } });
  const codex = [], claude = [];
  const bodies = [
    "export function clamp(x, lo, hi) {\n  if (lo > hi) throw new RangeError(\"empty range\");\n  return Math.min(hi, Math.max(lo, x));\n}\n",
    "export const slugify = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, \"-\").replace(/^-+|-+$/g, \"\");\n"
  ];
  TASKS.forEach((t, i) => {
    codex.push({ report: { stages: [{ title: t.title, task: t.text, conditions: [change(`${t.file} exists`, ["R1"]), change("tests pass", ["R2"])] }], dropped: [], dropRequirements: [], question: null } },
      { report: { conditions: [{ id: "C1", status: "met", paths: [t.file], note: "done" }, { id: "C2", status: "met", paths: [t.file], note: "done" }], findings: [], request: "none", question: null } },
      { report: { conditions: [], findings: [], request: "none", question: null, requirements: [{ id: "R1", status: "met", note: "done" }, { id: "R2", status: "met", note: "done" }] } });
    claude.push({ report: { summary: t.title, done: true }, writes: [[t.file, bodies[i]]] });
  });
  const st = path.join(dir, "mock-state");
  // one script per work folder (MOCK_SCRIPT_PER_CWD): the two copies run at once. The task of the k-th folder is not
  // known ahead: both scripts write the file their folder's task asks for (the rehearsal checks the script, not the CLIs)
  const perCwd = (name, steps, per) => {
    for (let k = 0; k < TASKS.length; k++) script(`${name}/${k + 1}`, steps.slice(k * per, (k + 1) * per));
    return D("script", name);
  };
  const wrap = (p) => {
    const f = path.join(dir, `${p}-mock`);
    fs.writeFileSync(f, `#!/bin/sh\nexec "${NODE}" "${path.join(FIXTURES, `mock-${p}.mjs`)}" "$@"\n`, { mode: 0o755 });
    return f;
  };
  const env = (extra) => ({ HOME: st, MOCK_STATE: st, MOCK_SCRIPT_PER_CWD: "1", ...extra });
  const file = path.join(dir, "providers.json");
  fs.writeFileSync(file, JSON.stringify({
    codex: { executable: wrap("codex"), version: "codex-cli 0.155.1", path: `${path.dirname(NODE)}:/usr/bin:/bin`, env: env({ MOCK_SCRIPT: perCwd("codex", codex, 3), CODEX_HOME: path.join(st, ".codex") }) },
    claude: { executable: wrap("claude"), version: "2.1.287 (Claude Code)", path: `${path.dirname(NODE)}:/usr/bin:/bin`, env: env({ MOCK_SCRIPT: perCwd("claude", claude, 1) }) }
  }));
  return file;
}

// ---------- observation ----------
const journalOf = (root, runId) => {
  const f = path.join(root, "runs", runId, "journal.jsonl");
  return fs.existsSync(f) ? fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
};
const goalOf = (root, runId) => {
  const first = journalOf(root, runId)[0];
  return first ? JSON.parse(fs.readFileSync(path.join(root, "runs", runId, "texts", first.data.goal.sha256), "utf8")) : null;
};
const LIMIT_TEXT = /usage limit|rate limit|limit reached|hit your limit|quota|429|overloaded|try again (at|later|in)/i;

let app;
let halted = null;
const project = D("project");
fs.cpSync(path.join(FIXTURES, "series-project"), project, { recursive: true });
fs.rmSync(path.join(project, "tests", "clamp.accept.test.mjs")); // the tasks are independent: no fixed test of one of them
fs.writeFileSync(path.join(project, "tests", "version.test.mjs"), 'import assert from "node:assert/strict";\nimport { test } from "node:test";\nimport { VERSION } from "../src/index.mjs";\n\ntest("version", () => assert.equal(VERSION, "1.0.0"));\n');
for (const a of [["init", "-q", "-b", "main"], ["add", "-A"], ["commit", "-q", "-m", "c1 probe project"]]) git(project, ...a);
const headBefore = git(project, "rev-parse", "HEAD").trim();
const userData = D("user-data");
const root = path.join(userData, "orchestration");
try {
  app = await launchApp({ userData, providers: REHEARSE ? rehearsalProviders() : undefined, port: 9300 + Math.floor(Math.random() * 500), shots: SHOTS,
    env: { CANVASTTY_JOURNAL_V2: "1" }, hermetic: REHEARSE });
  await app.call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  const real = fs.realpathSync(project);
  const linkId = await app.ev(`(async () => {
    const o = window.canvasTTY.orchestration;
    const mk = async (provider, x) => (await o.createAgent({ agentId: crypto.randomUUID(), provider, project: ${JSON.stringify(real)}, bounds: { position: { x, y: 620 }, size: { width: 300, height: 176 } }, workspaceId: "common" })).value.agentId;
    const lead = await mk("codex", 40), exec = await mk("claude", 420);
    return (await o.createLink({ linkId: crypto.randomUUID(), fromAgentId: lead, toAgentId: exec })).value.linkId;
  })()`);
  // Codex: the model of config.toml if model/list offers it, else gpt-6-sol (the owner's permission)
  const models = await app.ev(`window.canvasTTY.orchestration.codexModels(${JSON.stringify(linkId)}, true).then((r) => r.ok ? r.value : { error: r.code })`);
  report.codexModels = { ok: models.ok ?? false, configModel: models.configModel ?? null, offered: models.ids?.length ?? 0, error: models.error ?? null };
  const configOffered = !!models.configModel && models.ids?.includes(models.configModel);
  if (!configOffered && !models.ids?.includes(FALLBACK_MODEL) && REAL) throw new Error(`neither the config model (${models.configModel}) nor ${FALLBACK_MODEL} is offered by model/list`);
  const codexModel = configOffered || REHEARSE ? null : FALLBACK_MODEL;
  report.models = { lead: codexModel ?? "as in CLI", executor: "as in CLI", reviewer: codexModel ?? "as in CLI", why: configOffered ? "config model offered" : REHEARSE ? "rehearsal" : `config model ${models.configModel} not offered` };
  const saved = await app.ev(`(async () => { const o = window.canvasTTY.orchestration; const info = (await o.profile(${JSON.stringify(linkId)})).value;
    const r = await o.saveProfile(${JSON.stringify(linkId)}, { ...info.profile, workMode: "copy", checks: ["node --test"], access: { claude: "workspace", codex: "workspace" },
      models: { lead: ${JSON.stringify(codexModel)}, executor: null, reviewer: ${JSON.stringify(codexModel)} } });
    return r.ok ? { workMode: r.value.workMode, access: r.value.access, models: r.value.models ?? null, checks: r.value.checks } : r; })()`);
  if (!saved?.access) throw new Error(`the project settings were not saved: ${JSON.stringify(saved)}`);
  report.settings = saved;
  log(`settings: ${JSON.stringify(saved)}`);
  // the chain on the board
  const ids = [];
  for (const t of TASKS) {
    const r = await app.ev(`window.canvasTTY.orchestration.boardCreate(${JSON.stringify({ workspaceId: "common", project: real, title: t.title, text: t.text, criteria: t.criteria })})`);
    if (!r.ok) throw new Error(`task ${t.title}: ${r.code}`);
    ids.push(r.value);
  }
  log(`tasks: ${ids.map((t) => t.key).join(", ")}`);
  await app.ev("location.reload()");
  await app.waitFor(`${q("[data-board-button]")} && true`, "the workspace bar", 30_000);
  await app.clickEl(q("[data-board-button]"));
  await app.waitFor(`${q("[data-board-autopilot-start]")} && true`, "the board with «Вести доску»", 30_000);
  await app.clickEl(q("[data-board-autopilot-start]"));
  await app.type(q("[data-board-budget-runs]"), "2");
  await app.type(q("[data-board-budget-parallel]"), "2");
  await app.type(q("[data-board-budget-minutes]"), String(Math.round(LIMIT_MS / 60_000)));
  await app.shot("c1-01-autopilot-asked").catch(() => {});
  await app.clickEl(q("[data-board-autopilot-yes]"));
  await app.waitFor(`${q('[data-board-autopilot="on"]')} && true`, "the autopilot on", 15_000);
  log("«Вести доску» on (budget: 2 runs, 2 at once)");

  // ---------- until it stops ----------
  const seen = new Set();
  let stop = null;
  let together = 0; // the most runs seen going on at once
  while (!stop) {
    await sleep(2000);
    const v = await app.ev("window.canvasTTY.orchestration.board().then((r) => r.value)");
    const st = v.autopilot[linkId];
    const runIds = v.facts.map((f) => f.runId);
    for (const id of runIds) if (!seen.has(id)) { seen.add(id); log(`run ${id.slice(0, 8)} of ${v.facts.find((f) => f.runId === id).taskKey} started`); }
    together = Math.max(together, v.facts.filter((f) => ["preparing", "running", "paused"].includes(f.status)).length);
    for (const m of v.heads?.[0]?.merges ?? []) if (!seen.has(m.runId)) { seen.add(m.runId); log(`merge ${m.runId.slice(0, 8)} of ${m.task.key} into the board's result`); }
    const calls = runIds.reduce((n, id) => n + journalOf(root, id).filter((r) => r.type === "turn.intent").length, 0);
    // a permission prompt: recorded and denied (the autopilot waits; it never answers)
    for (const id of runIds) {
      const view = await app.ev(`window.canvasTTY.orchestration.get(${JSON.stringify(id)}).then((r) => r.value.view)`);
      const p = view.permission;
      if (!p) continue;
      report.prompts.push({ at: new Date().toISOString(), task: v.facts.find((f) => f.runId === id).taskKey, role: p.role ?? null, kind: p.kind, tool: p.tool ?? null,
        summary: anon(p.summary ?? "").slice(0, 300), why: p.why ?? null, autopilotWaits: st?.waits ?? null, answer: "deny" });
      log(`permission prompt (${p.kind} ${p.tool ?? ""}: ${anon(p.summary ?? "").slice(0, 120)}); the autopilot ${st?.waits ?? "-"} → deny`);
      await app.ev(`window.canvasTTY.orchestration.command(${JSON.stringify(id)}, { commandId: crypto.randomUUID(), expectedRevision: ${view.revision}, command: { kind: "permission", requestId: ${JSON.stringify(p.requestId)}, decision: "deny" } })`);
    }
    if (calls > CALLS || Date.now() - t0 > LIMIT_MS) {
      halted = calls > CALLS ? `the call budget: ${calls} > ${CALLS}` : "the time limit";
      log(`HALT: ${halted}; the autopilot off, the run stopped`);
      await app.ev(`window.canvasTTY.orchestration.boardAutopilot(${JSON.stringify(linkId)}, false, "ru")`);
      for (const id of runIds) {
        const view = await app.ev(`window.canvasTTY.orchestration.get(${JSON.stringify(id)}).then((r) => r.value.view)`);
        if (!["completed", "stopped", "failed"].includes(view.status)) await app.ev(`window.canvasTTY.orchestration.command(${JSON.stringify(id)}, { commandId: crypto.randomUUID(), expectedRevision: ${view.revision}, command: { kind: "stop" } })`);
      }
      break;
    }
    if (st && !st.on) { stop = st.stop; break; }
  }
  report.autopilotStop = stop;
  log(`the autopilot stopped: ${JSON.stringify(stop)}`);
  await sleep(1500);
  const shotBoard = async (name) => {
    const r = await app.ev(`(() => { const b = ${q("[data-board]")}.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; })()`);
    const s = await app.call("Page.captureScreenshot", { format: "png", clip: { ...r, scale: 2 } });
    fs.writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(s.data, "base64"));
  };
  await shotBoard("c1-02-board-at-the-end").catch(() => {});

  // ---------- what the board, the journals and Git say ----------
  const v = await app.ev("window.canvasTTY.orchestration.board().then((r) => r.value)");
  for (const t of ids) {
    const runs = v.facts.filter((f) => f.taskId === t.id);
    const f = runs.at(-1);
    const rec = { title: t.title, runs: runs.length };
    report.tasks[t.key] = rec;
    if (!f) continue;
    const j = journalOf(root, f.runId);
    const last = j.filter((r) => r.type === "run.status").at(-1)?.data ?? null;
    const goal = goalOf(root, f.runId);
    Object.assign(rec, {
      status: last?.status ?? f.status, reason: last?.reason ?? null, completion: last?.completion?.kind ?? f.completion, workMode: f.workMode,
      branch: f.taken?.branch ?? null, commit: f.taken?.commit ?? null, base: goal?.base ?? null,
      calls: j.filter((r) => r.type === "turn.intent").length, turns: j.filter((r) => r.type === "turn.intent").map((r) => `${r.data.role ?? ""}/${r.data.provider}`),
      protocolErrors: j.filter((r) => /protocol/i.test(JSON.stringify(r.data ?? {}))).map((r) => `${r.type}: ${anon(JSON.stringify(r.data)).slice(0, 300)}`),
      permissionRecords: j.filter((r) => r.type.startsWith("permission.")).map((r) => `${r.type}: ${anon(JSON.stringify(r.data)).slice(0, 200)}`)
    });
    const activity = await app.ev(`(async () => { const out = []; let after = 0;
      for (;;) { const r = await window.canvasTTY.orchestration.activity(${JSON.stringify(f.runId)}, after, 500);
        if (!r.ok) return out; out.push(...r.value.entries); if (!r.value.more || !r.value.entries.length) return out; after = r.value.entries.at(-1).id; } })()`);
    rec.asks = activity.filter((e) => e.kind === "permission_requested").length;
    rec.hostAnswers = activity.filter((e) => e.kind === "permission_applied" && e.detail?.scope === "sandbox_static").length;
    rec.modelsReported = Object.fromEntries(["lead", "executor", "reviewer"].map((role) => [role, [...new Set(activity.filter((e) => e.kind === "session" && e.role === role && e.detail?.model).map((e) => e.detail.model))]]));
    rec.usageLimit = activity.some((e) => (e.kind === "error" || e.kind === "warning") && LIMIT_TEXT.test(JSON.stringify(e.detail ?? e.text ?? "")));
    fs.writeFileSync(path.join(OUT, `${t.key}-journal.jsonl`), anon(fs.readFileSync(path.join(root, "runs", f.runId, "journal.jsonl"), "utf8")));
    fs.writeFileSync(path.join(OUT, `${t.key}-activity.json`), `${anon(JSON.stringify(activity, null, 1))}\n`);
  }
  // both from the board's result, both merged into it with the check on the merged tree; the project folder untouched
  // at once: the runs' spans in their journals (created → last status) overlap; the 2 s poll may miss short runs
  const spans = ids.map((t) => v.facts.filter((f) => f.taskId === t.id).at(-1)).filter(Boolean).map((f) => {
    const j = journalOf(root, f.runId);
    return [Date.parse(j[0].ts), Date.parse(j.filter((r) => r.type === "run.status").at(-1)?.ts ?? j.at(-1).ts)];
  });
  report.together = Math.max(together, spans.length === 2 && spans[0][0] < spans[1][1] && spans[1][0] < spans[0][1] ? 2 : 1);
  report.overlapSec = spans.length === 2 ? Math.max(0, (Math.min(spans[0][1], spans[1][1]) - Math.max(spans[0][0], spans[1][0])) / 1000) : 0;
  const head = v.heads?.[0] ?? null;
  report.head = head && { ref: head.ref, commit: head.commit, checks: head.checks ?? null,
    merges: head.merges.map((m) => ({ task: m.task.key, status: m.status, completion: m.completion ?? null, reason: m.reason ?? null, conflicts: m.conflicts ?? [] })) };
  report.basesFromHead = ids.every((t) => report.tasks[t.key].base?.branch === head?.ref);
  for (const m of head?.merges ?? []) {
    const j = journalOf(root, m.runId);
    report.head.merges.find((x) => x.task === m.task.key).checked = j.filter((r) => r.type === "merge.checked").map((r) => ({ attempt: r.data.attempt, passed: r.data.passed }));
    fs.writeFileSync(path.join(OUT, `merge-${m.task.key}-journal.jsonl`), anon(fs.readFileSync(path.join(root, "runs", m.runId, "journal.jsonl"), "utf8")));
  }
  report.headFiles = head ? git(project, "ls-tree", "-r", "--name-only", head.commit).trim().split("\n") : [];
  report.headTest = head ? (() => {
    const dir = D("head-check");
    git(project, "worktree", "add", "-q", "--detach", dir, head.commit);
    try { return { ok: true, out: execFileSync(NODE, ["--test", "--test-reporter=tap"], { cwd: dir, encoding: "utf8" }).split("\n").filter((l) => /^# (pass|fail)/.test(l)) }; }
    catch (e) { return { ok: false, out: String(e.stdout ?? e).slice(-600) }; }
    finally { git(project, "worktree", "remove", "--force", dir); }
  })() : null;
  report.projectFolder = { headSame: git(project, "rev-parse", "HEAD").trim() === headBefore, status: git(project, "status", "--porcelain").trim(), branches: git(project, "branch", "--format=%(refname:short)").trim().split("\n") };
  report.calls = Object.values(report.tasks).reduce((n, r) => n + (r.calls ?? 0), 0);
  report.protocolErrors = Object.values(report.tasks).reduce((n, r) => n + (r.protocolErrors?.length ?? 0), 0);
  report.asks = Object.values(report.tasks).reduce((n, r) => n + (r.asks ?? 0), 0);
  await app.shot("c1-03-window-at-the-end").catch(() => {});
} catch (e) {
  halted = anon(e?.stack ?? String(e)).slice(0, 1500);
  log(`ERROR: ${halted}`);
} finally {
  await app?.quit().catch(() => app?.stop?.());
}
report.hashesAfter = hashes();
report.hashesSame = JSON.stringify(report.hashesBefore) === JSON.stringify(report.hashesAfter);
report.halted = halted;
report.durationMin = +((Date.now() - t0) / 60_000).toFixed(1);
report.ok = !halted && report.autopilotStop?.code === "all_done" && Object.values(report.tasks).every((t) => t.status === "completed" && t.completion === "confirmed" && t.branch)
  && report.together === 2 && report.basesFromHead && report.head?.merges.length === TASKS.length && report.head.merges.every((m) => m.status === "completed" && m.completion === "confirmed")
  && report.headTest?.ok && TASKS.every((t) => report.headFiles?.includes(t.file)) && report.projectFolder?.headSame && report.projectFolder.status === ""
  && report.protocolErrors === 0 && report.calls <= CALLS && report.hashesSame;
fs.writeFileSync(path.join(OUT, "report.json"), `${anon(JSON.stringify(report, null, 2))}\n`);
fs.writeFileSync(path.join(OUT, "probe.log"), `${logLines.join("\n")}\n`);
process.stdout.write(`${JSON.stringify({ ok: report.ok, halted, stop: report.autopilotStop?.code ?? null, calls: report.calls ?? null, asks: report.asks ?? null, minutes: report.durationMin, out: anon(OUT) })}\n`);
process.exitCode = report.ok ? 0 : 1;
