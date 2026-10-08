// The task board survives a rollback (stage-b-board.md §3): this build writes a profile with orchestration/board.json,
// a task whose run completed without checks and was accepted, and a task whose run waits at the plan review. A packaged
// older build (1.5.12, 1.5.13) opens the profile, lists both runs, continues the waiting one to its end, writes
// canvas.json (a card) and quits. Then: board.json is byte for byte the same, nothing is set aside, the finished run's
// journal is the same, and this build reads the board back — the accepted task «Done (accepted by you, without checks)»,
// the continued one in «Review» (completed without checks) with its task. Fake CLIs and temporary profiles; no model call.
// Usage: node scripts/rollback-board.mjs "<path>/Raoden Loom.app" […more apps] [--out file.json]
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { FIXTURES, NODE, launch, workspace } from "./orchestration-app-kit.mjs";
import { createRunManager, testNativeRuntime } from "../src/main/services/orchestration/manager.ts";
import { createProfileStore, suggestProfile } from "../src/main/services/orchestration/profile.ts";
import { boardStatuses } from "../src/shared/taskBoard.ts";

const args = process.argv.slice(2);
const OUT = args.includes("--out") ? args[args.indexOf("--out") + 1] : null;
const APPS = args.filter((a, i) => a !== "--out" && args[i - 1] !== "--out").map((a) => path.resolve(a));
const GIT = execFileSync("/usr/bin/which", ["git"], { encoding: "utf8" }).trim();
const sha = (f) => createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const until = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 200)); } return null; };
const C1 = { keep: null, text: "done", covers: ["R1"], evidence: { kind: "change", check: null } };
const PLAN = { report: { stages: [{ title: "fix", task: "write note", conditions: [C1] }], dropped: [], dropRequirements: [], question: null } };
const exec = (text) => ({ report: { summary: "done", done: true }, writes: [["README.md", text]] });
const REVIEW = { report: { conditions: [{ id: "C1", status: "met", paths: ["README.md"], note: "ok" }], findings: [], request: "none", question: null } };
const FINAL = { report: { conditions: [], findings: [], request: "none", question: null, requirements: [{ id: "R1", status: "met", note: "ok" }] } };

async function check(APP) {
  const version = execFileSync("plutil", ["-extract", "CFBundleShortVersionString", "raw", path.join(APP, "Contents/Info.plist")], { encoding: "utf8" }).trim();
  const out = { app: APP, version, checks: {} };
  const { D, project, script } = workspace("rbk.");
  const src = project("board-app");
  const ROOT = D("profile", "orchestration");
  // run A: plan, execute, review, final; run B: its plan here, then execute, review, final in the older build
  const SCRIPT = script("board", [PLAN, exec("first\n"), REVIEW, FINAL, PLAN, exec("second\n"), REVIEW, FINAL]);
  fs.mkdirSync(D("state"));
  const BIN = D("bin");
  fs.mkdirSync(BIN);
  const VERSION = { codex: "codex-cli 0.155.1", claude: "2.1.281 (Claude Code)" };
  for (const p of ["codex", "claude"]) {
    fs.writeFileSync(path.join(BIN, p), `#!/bin/sh\n[ "$1" = "--version" ] && { echo "${VERSION[p]}"; exit 0; }\nMOCK_SCRIPT="${SCRIPT}" MOCK_CHECKS=none MOCK_STATE="${D("state")}" exec "${NODE}" "${path.join(FIXTURES, `mock-${p}.mjs`)}" "$@"\n`, { mode: 0o755 });
  }
  fs.mkdirSync(D(".codex"));
  fs.writeFileSync(D(".codex", "config.toml"), ""); // the fake reviewer reads the temporary CODEX_HOME's config
  const SHELL = D("shell");
  fs.writeFileSync(SHELL, `#!/bin/sh\ncase "$1" in -ilc|-c) shift ;; esac\nexec /bin/sh -c "$1"\n`, { mode: 0o755 });
  const providers = D("providers.json");
  const p = { path: `${BIN}:/usr/bin:/bin`, env: { HOME: D(), MOCK_STATE: D("state"), MOCK_SCRIPT: SCRIPT, MOCK_CHECKS: "none" } };
  fs.writeFileSync(providers, JSON.stringify({ codex: { executable: path.join(BIN, "codex"), version: VERSION.codex, ...p },
    claude: { executable: path.join(BIN, "claude"), version: VERSION.claude, ...p }, shell: SHELL, checkEnv: { PATH: `/usr/bin:/bin:${path.dirname(GIT)}`, HOME: D() } }));
  const LAUNCH = { command: NODE, args: [path.resolve("src/orchestration/supervisor.mjs")], env: {} };
  const manager = () => createRunManager({ platform: "darwin", root: ROOT, gitPath: () => GIT, launch: () => LAUNCH, nodePath: () => NODE, stopGraceMs: 2000,
    agents: async () => { throw new Error("not used"); }, native: testNativeRuntime(providers, () => LAUNCH), leadSandbox: false, journalV2: true });
  let app;
  try {
    // 1. this build
    const m = manager();
    await createProfileStore(ROOT).save(src, { ...(await suggestProfile(src)), workMode: "project", checks: ["false"] });
    const task = async (title) => (await m.boardCreate({ workspaceId: "common", project: src, title, text: title, criteria: ["есть"] })).value;
    const goal = (t, extra = {}) => ({ text: t.text, criteria: ["есть"], checks: [], commands: [], mode: "autopilot", ...(process.env.NO_TASK ? {} : { task: { id: t.id, key: t.key } }), ...extra });
    const a = await task("Принятая"), b = await task("Продолжаемая");
    const runA = randomUUID(), runB = randomUUID();
    if (!(await m.create({ requestId: runA, source: src, goal: goal(a) })).ok) throw new Error("run A refused");
    if (!await until(async () => (await m.get(runA)).value.view.status === "completed", 60_000)) throw new Error("run A did not complete");
    const acc = await m.boardAccept(a.id);
    if (!acc.ok && !process.env.NO_TASK) throw new Error(`accept refused: ${acc.code}`);
    if (!(await m.create({ requestId: runB, source: src, goal: goal(b, { reviewPlan: true }) })).ok) throw new Error("run B refused");
    if (!await until(async () => (await m.get(runB)).value.view.reason === "plan_review", 60_000)) throw new Error("run B did not reach the plan review");
    await m.shutdown();
    const BOARD = path.join(ROOT, "board.json"), JOURNAL_A = path.join(ROOT, "runs", runA, "journal.jsonl"), JOURNAL_B = path.join(ROOT, "runs", runB, "journal.jsonl");
    const before = { board: sha(BOARD), journalA: sha(JOURNAL_A), journalB: fs.statSync(JOURNAL_B).size };
    // 2. the older build
    app = await launch({ userData: D("profile"), port: 9600 + Math.floor(Math.random() * 100), shots: D("shots"), executable: path.join(APP, "Contents/MacOS/Raoden Loom"), hermetic: false,
      env: { HOME: D(), SHELL: "/bin/bash", PATH: `${BIN}:${path.dirname(NODE)}:/usr/bin:/bin:/usr/sbin:/sbin`, CODEX_HOME: D(".codex") } });
    await app.waitFor("document.querySelector('.workspace') && window.canvasTTY && true", "window", 60_000);
    const listed = await app.ev("window.canvasTTY.orchestration.list().then((r) => r.value.map((s) => [s.view.runId, s.view.status, s.view.reason]))");
    out.listed = listed;
    out.checks.oldListsRuns = JSON.stringify([...listed].sort()) === JSON.stringify([[runA, "completed", null], [runB, "paused", "plan_review"]].sort());
    out.resumed = await app.ev(`window.canvasTTY.orchestration.get(${JSON.stringify(runB)}).then((r) => window.canvasTTY.orchestration.command(
      { runId: ${JSON.stringify(runB)}, commandId: crypto.randomUUID(), expectedRevision: r.value.view.revision, command: { kind: "resume" } })).then((r) => JSON.stringify(r).slice(0, 200))`);
    out.endB = await until(() => app.ev(`window.canvasTTY.orchestration.get(${JSON.stringify(runB)}).then((r) => { const v = r.value.view;
      return ["completed", "failed", "stopped"].includes(v.status) || (v.status === "paused" && v.reason !== "plan_review") ? v.status + "/" + v.reason : null; })`), 120_000);
    out.checks.oldContinuedRun = out.endB === "completed/null";
    const made = await app.ev(`window.canvasTTY.orchestration.createAgent({ agentId: crypto.randomUUID(), provider: "codex", project: ${JSON.stringify(src)},
      bounds: { position: { x: 0, y: 0 }, size: { width: 300, height: 200 } }, workspaceId: "common" }).then((r) => r.ok)`);
    out.checks.oldWroteCanvas = made === true && fs.existsSync(path.join(ROOT, "canvas.json"));
    out.exit = await app.quit();
    app = null;
    // 3. the board as it was; this build reads both runs back with their tasks
    out.checks.boardUnchanged = sha(BOARD) === before.board;
    out.checks.finishedJournalUnchanged = sha(JOURNAL_A) === before.journalA;
    out.checks.continuedJournalGrew = fs.statSync(JOURNAL_B).size > before.journalB;
    out.checks.nothingSetAside = fs.readdirSync(ROOT).filter((f) => f.startsWith("board.json.")).length === 0;
    const m2 = manager();
    const v = (await m2.board()).value;
    const st = boardStatuses(v.board, v.facts);
    out.statuses = [a, b].map((t) => ({ key: t.key, ...st.get(t.id) }));
    out.checks.boardBack = v.board.tasks.length === 2 && st.get(a.id)?.done === "accepted"
      && st.get(b.id)?.column === "review" && st.get(b.id)?.reason === "no_checks" && st.get(b.id)?.current === runB;
    await m2.shutdown();
    out.ok = Object.values(out.checks).every(Boolean);
  } catch (error) {
    out.ok = false;
    out.error = String(error?.stack ?? error).slice(0, 2000);
  } finally {
    if (app) out.exit = await app.quit?.();
  }
  return out;
}

const results = [];
for (const app of APPS) results.push(await check(app));
console.log(JSON.stringify(results, null, 1));
if (OUT) fs.writeFileSync(OUT, JSON.stringify(results, null, 1));
process.exitCode = results.length && results.every((r) => r.ok) ? 0 : 1;
