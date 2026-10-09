// B4 acceptance probe (stage-b-board.md §5.3 п. 1): the board's autopilot over a chain A → B → C of small changes with
// tests, on the development build with journal v2, a temporary application profile and a temporary copy of the
// series fixture (a Git repository). The project settings: a separate copy, rights «Рабочая папка» for both CLIs,
// the check «node --test», models «Как в CLI» — except Codex when model/list does not offer the model of
// ~/.codex/config.toml: then gpt-6-sol for the lead and the reviewer, set in the project settings (never in config.toml).
// «Вести доску» is turned on in the board card; nothing else is clicked until it stops. A permission prompt is
// recorded and denied (the person's safe answer; the autopilot itself never answers).
//   --rehearse   fake CLIs (no model request): checks this script
//   --real       the installed codex and claude (REAL model requests)
// --calls <n> the probe's model call budget (default 30) · --minutes <n> (default 60) · --out <dir>
// (default docs/agent-orchestration/evidence/real-b4). On either limit the autopilot is turned off and the run stopped.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FIXTURES, NODE, launch as launchApp, q, sleep, workspace } from "./orchestration-app-kit.mjs";

const REAL = process.argv.includes("--real");
const REHEARSE = process.argv.includes("--rehearse");
if (REAL === REHEARSE) throw new Error("exactly one of --real or --rehearse");
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const CALLS = Number(arg("--calls") ?? 30);
const LIMIT_MS = Number(arg("--minutes") ?? 60) * 60_000;
const FALLBACK_MODEL = "gpt-6-sol";
const { TMP, D, git, script } = workspace(REAL ? "cto-b4-" : "cto-b4-rh-");
const OUT = path.resolve(arg("--out") ?? (REAL ? path.join(FIXTURES, "..", "..", "..", "docs", "agent-orchestration", "evidence", "real-b4") : D("out")));
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

// ---------- the chain ----------
const TASKS = [
  { title: "clamp", text: "Add a function clamp(x, lo, hi) in src/clamp.mjs (ES module, named export) that returns x limited to [lo, hi] and throws RangeError when lo > hi. Add a unit test tests/clamp.test.mjs. Do not modify tests/clamp.accept.test.mjs.",
    criteria: ["tests/clamp.accept.test.mjs passes unchanged", "node --test passes"], file: "src/clamp.mjs" },
  { title: "inRange", text: "Add a function inRange(x, lo, hi) in src/range.mjs (named export) that returns true when clamp(x, lo, hi) === x, importing clamp from ./clamp.mjs. Add tests/range.test.mjs. Change no other file.",
    criteria: ["src/range.mjs uses clamp from src/clamp.mjs", "node --test passes"], file: "src/range.mjs" },
  { title: "describe", text: "Add a function describe(x, lo, hi) in src/describe.mjs (named export) that returns \"in\" or \"out\" using inRange from ./range.mjs. Add tests/describe.test.mjs. Change no other file.",
    criteria: ["src/describe.mjs uses inRange from src/range.mjs", "node --test passes"], file: "src/describe.mjs" }
];

function rehearsalProviders() {
  const dir = D("rehearsal");
  fs.mkdirSync(path.join(dir, "mock-state", ".codex"), { recursive: true });
  const change = (text, covers) => ({ keep: null, text, covers, evidence: { kind: "change", check: null } });
  const codex = [], claude = [];
  const bodies = [
    "export function clamp(x, lo, hi) {\n  if (lo > hi) throw new RangeError(\"empty range\");\n  return Math.min(hi, Math.max(lo, x));\n}\n",
    "import { clamp } from \"./clamp.mjs\";\nexport const inRange = (x, lo, hi) => clamp(x, lo, hi) === x;\n",
    "import { inRange } from \"./range.mjs\";\nexport const describe = (x, lo, hi) => (inRange(x, lo, hi) ? \"in\" : \"out\");\n"
  ];
  TASKS.forEach((t, i) => {
    codex.push({ report: { stages: [{ title: t.title, task: t.text, conditions: [change(`${t.file} exists`, ["R1"]), change("tests pass", ["R2"])] }], dropped: [], dropRequirements: [], question: null } },
      { report: { conditions: [{ id: "C1", status: "met", paths: [t.file], note: "done" }, { id: "C2", status: "met", paths: [t.file], note: "done" }], findings: [], request: "none", question: null } },
      { report: { conditions: [], findings: [], request: "none", question: null, requirements: [{ id: "R1", status: "met", note: "done" }, { id: "R2", status: "met", note: "done" }] } });
    claude.push({ report: { summary: t.title, done: true }, writes: [[t.file, bodies[i]]] });
  });
  const st = path.join(dir, "mock-state");
  const wrap = (p) => {
    const f = path.join(dir, `${p}-mock`);
    fs.writeFileSync(f, `#!/bin/sh\nexec "${NODE}" "${path.join(FIXTURES, `mock-${p}.mjs`)}" "$@"\n`, { mode: 0o755 });
    return f;
  };
  const env = (extra) => ({ HOME: st, MOCK_STATE: st, ...extra });
  const file = path.join(dir, "providers.json");
  fs.writeFileSync(file, JSON.stringify({
    codex: { executable: wrap("codex"), version: "codex-cli 0.155.1", path: `${path.dirname(NODE)}:/usr/bin:/bin`, env: env({ MOCK_SCRIPT: script("codex", codex), CODEX_HOME: path.join(st, ".codex") }) },
    claude: { executable: wrap("claude"), version: "2.1.287 (Claude Code)", path: `${path.dirname(NODE)}:/usr/bin:/bin`, env: env({ MOCK_SCRIPT: script("claude", claude) }) }
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
for (const a of [["init", "-q", "-b", "main"], ["add", "-A"], ["commit", "-q", "-m", "b4 probe project"]]) git(project, ...a);
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
  for (const [i, t] of TASKS.entries()) {
    const r = await app.ev(`window.canvasTTY.orchestration.boardCreate(${JSON.stringify({ workspaceId: "common", project: real, title: t.title, text: t.text, criteria: t.criteria, dependsOn: i ? [ids[i - 1].id] : [] })})`);
    if (!r.ok) throw new Error(`task ${t.title}: ${r.code}`);
    ids.push(r.value);
  }
  log(`tasks: ${ids.map((t) => t.key).join(" → ")}`);
  await app.ev("location.reload()");
  await app.waitFor(`${q("[data-board-button]")} && true`, "the workspace bar", 30_000);
  await app.clickEl(q("[data-board-button]"));
  await app.waitFor(`${q("[data-board-autopilot-start]")} && true`, "the board with «Вести доску»", 30_000);
  await app.clickEl(q("[data-board-autopilot-start]"));
  await app.type(q("[data-board-budget-runs]"), "3");
  await app.type(q("[data-board-budget-minutes]"), String(Math.round(LIMIT_MS / 60_000)));
  await app.shot("b4-01-autopilot-asked").catch(() => {});
  await app.clickEl(q("[data-board-autopilot-yes]"));
  await app.waitFor(`${q('[data-board-autopilot="on"]')} && true`, "the autopilot on", 15_000);
  log("«Вести доску» on (budget: 3 runs)");

  // ---------- until it stops ----------
  const seen = new Set();
  let stop = null;
  while (!stop) {
    await sleep(2000);
    const v = await app.ev("window.canvasTTY.orchestration.board().then((r) => r.value)");
    const st = v.autopilot[linkId];
    const runIds = v.facts.map((f) => f.runId);
    for (const id of runIds) if (!seen.has(id)) { seen.add(id); log(`run ${id.slice(0, 8)} of ${v.facts.find((f) => f.runId === id).taskKey} started`); }
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
  await shotBoard("b4-02-board-at-the-end").catch(() => {});

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
  // each next task's base is the branch the task before it left; the commits chain; the project folder untouched
  const keys = ids.map((t) => t.key);
  report.chain = keys.map((k, i) => ({ key: k, base: report.tasks[k].base ? `${report.tasks[k].base.key} ${report.tasks[k].base.branch}` : "working folder",
    baseIsPrevBranch: i === 0 ? report.tasks[k].base === null : !!report.tasks[k].base && report.tasks[k].base.branch === report.tasks[keys[i - 1]].branch && report.tasks[k].base.commit === report.tasks[keys[i - 1]].commit }));
  report.ancestry = keys.slice(1).map((k, i) => {
    const a = report.tasks[keys[i]].commit, b = report.tasks[k].commit;
    if (!a || !b) return { pair: `${keys[i]}→${k}`, ok: false };
    try { git(project, "merge-base", "--is-ancestor", a, b); return { pair: `${keys[i]}→${k}`, ok: true }; } catch { return { pair: `${keys[i]}→${k}`, ok: false }; }
  });
  const lastBranch = report.tasks[keys.at(-1)].branch;
  report.lastBranchFiles = lastBranch ? git(project, "ls-tree", "-r", "--name-only", lastBranch).trim().split("\n") : [];
  report.projectFolder = { headSame: git(project, "rev-parse", "HEAD").trim() === headBefore, status: git(project, "status", "--porcelain").trim(), branches: git(project, "branch", "--format=%(refname:short)").trim().split("\n") };
  report.calls = Object.values(report.tasks).reduce((n, r) => n + (r.calls ?? 0), 0);
  report.protocolErrors = Object.values(report.tasks).reduce((n, r) => n + (r.protocolErrors?.length ?? 0), 0);
  report.asks = Object.values(report.tasks).reduce((n, r) => n + (r.asks ?? 0), 0);
  await app.shot("b4-03-window-at-the-end").catch(() => {});
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
  && report.chain?.every((c) => c.baseIsPrevBranch) && report.ancestry?.every((a) => a.ok) && report.projectFolder?.headSame && report.projectFolder.status === ""
  && report.protocolErrors === 0 && report.calls <= CALLS && report.hashesSame;
fs.writeFileSync(path.join(OUT, "report.json"), `${anon(JSON.stringify(report, null, 2))}\n`);
fs.writeFileSync(path.join(OUT, "probe.log"), `${logLines.join("\n")}\n`);
process.stdout.write(`${JSON.stringify({ ok: report.ok, halted, stop: report.autopilotStop?.code ?? null, calls: report.calls ?? null, asks: report.asks ?? null, minutes: report.durationMin, out: anon(OUT) })}\n`);
process.exitCode = report.ok ? 0 : 1;
