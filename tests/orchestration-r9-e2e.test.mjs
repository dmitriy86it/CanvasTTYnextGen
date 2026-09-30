// Stage 9 (stage-9-contract.md): defects found by the application E2E (scripts/e2e-orchestration.mjs), at the manager
// level, and the development-only seam the E2E uses to lose a command's reply.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { findGit } from "../src/main/services/orchestration/git.ts";
import { createRunManager, dropCommandReplies } from "../src/main/services/orchestration/manager.ts";
import { createTestAgents, plan } from "./fixtures/orchestration/test-agents.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GIT = findGit(process.env);
const NODE = fs.realpathSync(process.execPath);
const LAUNCH = { command: NODE, args: [path.join(HERE, "..", "src", "orchestration", "supervisor.mjs")], env: {} };
const OPTS = { skip: process.platform !== "darwin" && process.platform !== "linux" && "orchestration runs on macOS and Linux", timeout: 120_000 };

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "canvastty-r9-")));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
fs.writeFileSync(path.join(TMP, "gitconfig"), "");
const g = (cwd, ...args) => execFileSync(GIT, args, { cwd, encoding: "utf8", env: { PATH: process.env.PATH, HOME: TMP,
  GIT_CONFIG_GLOBAL: path.join(TMP, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 30_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await sleep(50); }
  throw new Error(`timed out waiting for ${what}`);
}

let n = 0;
// A run paused at the plan review: one plan turn, then nothing runs until a command.
async function pausedRun() {
  const src = path.join(TMP, `src-${++n}`);
  fs.cpSync(path.join(HERE, "fixtures", "orchestration", "check-project"), src, { recursive: true });
  fs.mkdirSync(path.join(src, "node_modules", "left-pad"), { recursive: true });
  fs.writeFileSync(path.join(src, "node_modules", "left-pad", "index.mjs"), "export default (s) => s;\n");
  for (const a of [["init", "-q", "-b", "main"], ["add", "-A"], ["commit", "-q", "-m", "fixture"]]) g(src, ...a);
  const root = path.join(TMP, `root-${n}`);
  const agents = createTestAgents({ plan: { report: plan("one") } });
  const m = createRunManager({ platform: "darwin", root, gitPath: () => GIT, launch: () => LAUNCH, nodePath: () => NODE, agents: async () => agents, stopGraceMs: 2000 });
  const runId = randomUUID();
  const created = await m.create({ requestId: runId, source: src, goal: { text: "extend sum", criteria: ["sum works"], checks: ["node-test"], reviewPlan: true } });
  assert.ok(created.ok, JSON.stringify(created));
  await until(async () => (await m.get(runId)).value.view.status === "paused", "plan_review");
  return { m, root, runId };
}
const records = (root, runId) => fs.readFileSync(path.join(root, "runs", runId, "journal.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

test("text: an unreadable text file is refused as text_unreadable without a path or an errno; readable again, it loads", OPTS, async () => {
  const { m, root, runId } = await pausedRun();
  const goal = records(root, runId)[0].data.goal;
  const file = path.join(root, "runs", runId, "texts", goal.sha256);
  fs.chmodSync(file, 0o000);
  try {
    const r = await m.text(runId, goal.sha256);
    assert.deepEqual([r.ok, r.code], [false, "text_unreadable"], JSON.stringify(r));
    assert.ok(!r.message.includes("/") && !/EACCES/.test(r.message), r.message);
  } finally {
    fs.chmodSync(file, 0o600);
  }
  assert.match((await m.text(runId, goal.sha256)).value.text, /extend sum/);
  fs.renameSync(file, `${file}.moved`);
  assert.equal((await m.text(runId, goal.sha256)).code, "text_missing", "a missing file keeps its own code");
  fs.renameSync(`${file}.moved`, file);
  await m.shutdown();
});

test("dropCommandReplies: the command is carried out, its reply lost once; the same request again gets the recorded result", OPTS, async () => {
  const { m, root, runId } = await pausedRun();
  const dir = fs.mkdtempSync(path.join(TMP, "drop-"));
  const wrapped = dropCommandReplies(m, dir);
  const view = (await m.get(runId)).value.view;
  const req = { commandId: randomUUID(), expectedRevision: view.revision, command: { kind: "stop" } };
  fs.writeFileSync(path.join(dir, "stop"), "");
  await assert.rejects(wrapped.command(runId, req), /reply to this command was dropped/);
  assert.ok(!fs.existsSync(path.join(dir, "stop")), "one reply only");
  await until(async () => (await m.get(runId)).value.view.status === "stopped", "main to carry the command out");
  const again = await wrapped.command(runId, req);
  assert.deepEqual(again, { ok: true, value: { status: "accepted", code: null } }, "the repeat is answered with the recorded result");
  assert.equal(records(root, runId).filter((r) => r.type === "command.received").length, 1, "done once");
  assert.equal(wrapped.get, m.get, "everything else is the manager's own");
  await m.shutdown();
});
