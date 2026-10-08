// The task board survives a rollback to 1.5.13 (stage-b-board.md §3): a profile with orchestration/board.json, a
// run whose goal names a task and an accepted result is opened by the packaged 1.5.13; it lists the run, a card is
// created (canvas.json is written), the app quits. board.json is byte for byte the same, nothing is set aside, the
// journal is the same, and this build reads the board back with the task «Done (accepted by you, without checks)».
// Fake CLIs and a temporary profile; no model call.
// Usage: node scripts/rollback-board-1513.mjs "<path>/Raoden Loom.app" [out.json]
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { FIXTURES, NODE, launch, workspace } from "./orchestration-app-kit.mjs";
import { createRunManager, testNativeRuntime } from "../src/main/services/orchestration/manager.ts";
import { createProfileStore, suggestProfile } from "../src/main/services/orchestration/profile.ts";
import { boardStatuses } from "../src/shared/taskBoard.ts";

const APP = path.resolve(process.argv[2]);
const OUT = process.argv[3];
const { D, project, script } = workspace("rb13.");
const src = project("board-app");
const ROOT = D("profile", "orchestration");
const GIT = execFileSync("/usr/bin/which", ["git"], { encoding: "utf8" }).trim();
const BIN = D("bin");
fs.mkdirSync(BIN);
for (const p of ["codex", "claude"]) fs.writeFileSync(path.join(BIN, p), `#!/bin/sh\nexec "${NODE}" "${path.join(FIXTURES, `mock-${p}.mjs`)}" "$@"\n`, { mode: 0o755 });
const SHELL = D("shell");
fs.writeFileSync(SHELL, `#!/bin/sh\ncase "$1" in -ilc|-c) shift ;; esac\nexec /bin/sh -c "$1"\n`, { mode: 0o755 });
const C1 = { keep: null, text: "done", covers: ["R1"], evidence: { kind: "change", check: null } };
const answers = [
  { report: { stages: [{ title: "fix", task: "write note", conditions: [C1] }], dropped: [], dropRequirements: [], question: null } },
  { report: { summary: "done", done: true }, writes: [["README.md", "note\n"]] },
  { report: { conditions: [{ id: "C1", status: "met", paths: ["README.md"], note: "ok" }], findings: [], request: "none", question: null } },
  { report: { conditions: [], findings: [], request: "none", question: null, requirements: [{ id: "R1", status: "met", note: "ok" }] } }
];
const providers = D("providers.json");
const p = { path: `${BIN}:/usr/bin:/bin`, env: { HOME: D(), MOCK_STATE: D("state"), MOCK_SCRIPT: script("board", answers), MOCK_CHECKS: "none" } };
fs.mkdirSync(D("state"));
fs.writeFileSync(providers, JSON.stringify({ codex: { executable: path.join(BIN, "codex"), version: "codex-cli 0.155.1", ...p },
  claude: { executable: path.join(BIN, "claude"), version: "2.1.281 (Claude Code)", ...p }, shell: SHELL, checkEnv: { PATH: `/usr/bin:/bin:${path.dirname(GIT)}`, HOME: D() } }));
const LAUNCH = { command: NODE, args: [path.resolve("src/orchestration/supervisor.mjs")], env: {} };
const manager = () => createRunManager({ platform: "darwin", root: ROOT, gitPath: () => GIT, launch: () => LAUNCH, nodePath: () => NODE, stopGraceMs: 2000,
  agents: async () => { throw new Error("not used"); }, native: testNativeRuntime(providers, () => LAUNCH), leadSandbox: false, journalV2: true });
const sha = (f) => createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const out = { checks: {} };
let app;
try {
  // 1. this build: a task, its run (completed without checks), the person accepts it
  const m = manager();
  await createProfileStore(ROOT).save(src, { ...(await suggestProfile(src)), workMode: "project", checks: ["false"] });
  const t = (await m.boardCreate({ workspaceId: "common", project: src, title: "Заметка", text: "Добавить заметку", criteria: ["есть"] })).value;
  const runId = randomUUID();
  const r = await m.create({ requestId: runId, source: src, goal: { text: "note", criteria: ["есть"], checks: [], commands: [], mode: "autopilot", task: { id: t.id, key: t.key } } });
  if (!r.ok) throw new Error(JSON.stringify(r));
  for (let i = 0; i < 600 && (await m.get(runId)).value.view.status !== "completed"; i++) await new Promise((res) => setTimeout(res, 100));
  const acc = await m.boardAccept(t.id);
  if (!acc.ok) { const v = (await m.get(runId)).value.view; throw new Error(`accept refused: ${acc.code} ${v.status} ${v.reason} ${v.progress?.completion}`); }
  await m.shutdown();
  const BOARD = path.join(ROOT, "board.json"), JOURNAL = path.join(ROOT, "runs", runId, "journal.jsonl");
  const before = { board: sha(BOARD), journal: sha(JOURNAL) };
  // 2. the packaged 1.5.13 opens the profile, lists the run, writes canvas.json, quits
  app = await launch({ userData: D("profile"), port: 9600 + Math.floor(Math.random() * 100), shots: D("shots"), executable: path.join(APP, "Contents/MacOS/Raoden Loom"), hermetic: false });
  const version = await app.ev("document.querySelector('.app-header, header')?.innerText ?? ''");
  out.version = String(version).match(/v?1\.5\.\d+/)?.[0] ?? version;
  const listed = await app.ev(`window.canvasTTY.orchestration.list().then((r) => r.value.map((s) => [s.view.runId, s.view.status]))`);
  out.checks.oldListsRun = JSON.stringify(listed) === JSON.stringify([[runId, "completed"]]);
  const made = await app.ev(`window.canvasTTY.orchestration.createAgent({ agentId: crypto.randomUUID(), provider: "codex", project: ${JSON.stringify(src)}, bounds: { position: { x: 0, y: 0 }, size: { width: 300, height: 200 } }, workspaceId: "common" }).then((r) => JSON.stringify(r).slice(0, 300))`);
  out.created = made;
  out.checks.oldWroteCanvas = JSON.parse(made).ok === true && fs.existsSync(path.join(ROOT, "canvas.json"));
  out.exit = await app.quit();
  app = null;
  // 3. the board is as it was; this build reads it back
  out.checks.boardUnchanged = sha(BOARD) === before.board;
  out.checks.journalUnchanged = sha(JOURNAL) === before.journal;
  out.checks.nothingSetAside = fs.readdirSync(ROOT).filter((f) => f.startsWith("board.json.")).length === 0;
  const m2 = manager();
  const v = (await m2.board()).value;
  const st = boardStatuses(v.board, v.facts).get(t.id);
  out.checks.boardBack = v.board.tasks.length === 1 && v.board.tasks[0].accepted?.runId === runId && st?.done === "accepted";
  await m2.shutdown();
  out.ok = Object.values(out.checks).every(Boolean);
} catch (error) {
  out.ok = false;
  out.error = String(error?.stack ?? error).slice(0, 2000);
} finally {
  if (app) out.exit = await app.quit?.();
}
console.log(JSON.stringify(out, null, 1));
if (OUT) fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
process.exitCode = out.ok ? 0 : 1;
