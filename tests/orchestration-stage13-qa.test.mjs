// Stage 13 review: the QA version is confirmed only by the version contract — the verification writes the commit id
// it observed to a fresh $CANVASTTY_QA_RESULT file and CanvasTTY compares full ids. Mentioning $CANVASTTY_COMMIT in the
// command, a comment or printing the expected id to stdout confirms nothing. A real cycle with fake CLIs and programs.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { findGit } from "../src/main/services/orchestration/git.ts";
import { qaVersion } from "../src/main/services/orchestration/finish.ts";
import { createRunManager, testNativeRuntime } from "../src/main/services/orchestration/manager.ts";
import { createProfileStore, suggestProfile, validateProfile } from "../src/main/services/orchestration/profile.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GIT = findGit(process.env);
const NODE = fs.realpathSync(process.execPath);
const LAUNCH = { command: NODE, args: [path.join(HERE, "..", "src", "orchestration", "supervisor.mjs")], env: {} };
const OPTS = { skip: process.platform === "win32" && "orchestration runs on macOS and Linux", timeout: 120_000 };
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "canvastty-qa-")));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
fs.writeFileSync(path.join(TMP, "gitconfig"), "");
const GIT_ENV = { PATH: process.env.PATH, HOME: TMP, GIT_CONFIG_GLOBAL: path.join(TMP, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const g = (cwd, ...args) => execFileSync(GIT, args, { cwd, encoding: "utf8", env: GIT_ENV });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 60_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(50); }
  throw new Error(`timed out waiting for ${what}`);
}
let n = 0;
const tmp = (name) => path.join(TMP, `${name}-${++n}`);
function wrapper(name, mock) {
  const file = path.join(TMP, name);
  fs.writeFileSync(file, `#!/bin/sh\nexec "${NODE}" "${path.join(HERE, "fixtures", "orchestration", mock)}" "$@"\n`, { mode: 0o755 });
  return file;
}
const CODEX = wrapper("codex", "mock-codex.mjs");
const CLAUDE = wrapper("claude", "mock-claude.mjs");
const SHELL = path.join(TMP, "test-shell");
fs.writeFileSync(SHELL, `#!/bin/sh\n[ "$1" = "-ilc" ] && shift\nexec /bin/sh -c "$1"\n`, { mode: 0o755 });
function providersFile() {
  const file = tmp("providers") + ".json";
  const p = { path: `${TMP}:/usr/bin:/bin`, env: { HOME: TMP, MOCK_STATE: fs.mkdtempSync(path.join(TMP, "state-")), MOCK_SCRIPT: script() } };
  fs.writeFileSync(file, JSON.stringify({
    codex: { executable: CODEX, version: "codex-cli 0.155.1", ...p }, claude: { executable: CLAUDE, version: "2.1.281 (Claude Code)", ...p },
    shell: SHELL, checkEnv: { ...GIT_ENV, PATH: `/usr/bin:/bin:${path.dirname(GIT)}`, HOME: TMP }
  }));
  return file;
}
// plan, a stage that sets a.txt to 2, accept, complete
function script() {
  const dir = tmp("script");
  fs.mkdirSync(dir);
  const answers = [{ stages: [{ title: "fix", task: "t" }], question: null }, { summary: "done", done: true },
    { verdict: "accept", findings: [], question: null }, { verdict: "complete", findings: [], question: null }];
  answers.forEach((a, i) => fs.writeFileSync(path.join(dir, `${i + 1}.json`), JSON.stringify(a)));
  fs.writeFileSync(path.join(dir, "2.writes.json"), JSON.stringify([{ rel: "a.txt", base64: Buffer.from("2\n").toString("base64") }]));
  return dir;
}
const manager = (root, providers) => createRunManager({
  platform: "darwin", // the engine under test; the platform gate has its own tests
  root, gitPath: () => GIT, launch: () => LAUNCH, nodePath: () => NODE, stopGraceMs: 2000,
  agents: async () => { throw new Error("not used"); }, native: testNativeRuntime(providers, () => LAUNCH)
});
const view = async (m, runId) => (await m.get(runId)).value.view;
const settled = (m, runId, what = "the end") => until(async () => {
  const v = await view(m, runId);
  return ["completed", "paused", "failed", "stopped"].includes(v.status) && !v.permission ? v : null;
}, what);
const resume = (m, v) => m.command(v.runId, { commandId: randomUUID(), expectedRevision: v.revision, command: { kind: "resume" } });
const qaOf = (v) => v.progress.finish.find((f) => f.step === "qa");
const commitOf = (v) => v.progress.finish.find((f) => f.step === "commit").commit;
const lines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean) : []);

// A project with a.txt, QA configured with `verify` (deploy counted in `deploys`), one run to its first stop.
async function qaRun(verify, { reportsVersion, command = "" } = {}) {
  const src = tmp("project");
  fs.mkdirSync(src);
  fs.writeFileSync(path.join(src, "a.txt"), "1\n");
  for (const a of [["init", "-q", "-b", "main"], ["add", "-A"], ["commit", "-q", "-m", "init"]]) g(src, ...a);
  const root = tmp("root");
  const providers = providersFile();
  const deploys = tmp("deploys");
  const m = manager(root, providers);
  const qa = { environment: "qa", command: `echo run >> ${deploys}${command ? `; ${command}` : ""}`, verify, ...(reportsVersion !== undefined ? { reportsVersion } : {}) };
  await createProfileStore(root).save(src, { ...(await suggestProfile(src)), checks: ["true"], finish: { commit: true, push: null, qa } });
  const runId = randomUUID();
  assert.ok((await m.create({ requestId: runId, source: src, goal: { text: "a to 2", criteria: ["c"], checks: [], mode: "autopilot", finish: { commit: true, push: false, qa: true } } })).ok);
  return { src, root, providers, runId, m, deploys, base: g(src, "rev-parse", "HEAD").trim() };
}

test("qaVersion: only a full id on the first non-empty line counts, compared whole", () => {
  const c = "a".repeat(40);
  assert.deepEqual(qaVersion(`\n  ${c.toUpperCase()}  \nnoise\n`, c), { version: "confirmed", observed: c });
  assert.deepEqual(qaVersion(`${"b".repeat(40)}\n${c}\n`, c), { version: "mismatch", observed: "b".repeat(40) }, "only the first line");
  assert.deepEqual(qaVersion("e".repeat(64), c), { version: "mismatch", observed: "e".repeat(64) });
  assert.deepEqual(qaVersion(c.slice(0, 7), c), { version: "invalid", observed: null }, "an abbreviated id is not accepted");
  assert.deepEqual(qaVersion(`${c} deployed`, c), { version: "invalid", observed: null });
  assert.deepEqual(qaVersion("  \n\n", c), { version: "not_reported", observed: null });
  assert.deepEqual(qaVersion(null, c), { version: "not_reported", observed: null });
  assert.deepEqual(qaVersion(c, null), { version: "mismatch", observed: c }, "no expected commit: never confirmed");
});

test("profile: reportsVersion is a boolean, false by default", async () => {
  const p = await suggestProfile(TMP);
  const qa = { environment: "qa", command: "d", verify: "v" };
  assert.equal(validateProfile({ ...p, finish: { commit: true, push: null, qa } }).finish.qa.reportsVersion, false);
  assert.equal(validateProfile({ ...p, finish: { commit: true, push: null, qa: { ...qa, reportsVersion: true } } }).finish.qa.reportsVersion, true);
  assert.throws(() => validateProfile({ ...p, finish: { commit: true, push: null, qa: { ...qa, reportsVersion: "yes" } } }), /reportsVersion/);
});

// External review repro: `true # $CANVASTTY_COMMIT` was taken as a verification tied to the commit.
test("a comment mentioning $CANVASTTY_COMMIT confirms no version: passed, not_checked", OPTS, async () => {
  const r = await qaRun("true # $CANVASTTY_COMMIT");
  const done = await settled(r.m, r.runId);
  assert.equal(done.status, "completed", JSON.stringify(done));
  assert.deepEqual([qaOf(done).status, qaOf(done).version, qaOf(done).observed], ["done", "not_checked", null]);
  await r.m.shutdown();
});

test("the expected id printed to stdout without the contract is not read: not_checked", OPTS, async () => {
  const r = await qaRun(`echo "$CANVASTTY_COMMIT"; echo "$CANVASTTY_COMMIT" > "$CANVASTTY_QA_RESULT"`, { reportsVersion: false });
  const done = await settled(r.m, r.runId);
  assert.deepEqual([done.status, qaOf(done).status, qaOf(done).version, qaOf(done).observed], ["completed", "done", "not_checked", null]);
  await r.m.shutdown();
});

test("contract: an old version is a mismatch, paused; resuming reruns only the verification until it reports the commit", OPTS, async () => {
  const reported = tmp("reported");
  const r = await qaRun(`cat ${reported} > "$CANVASTTY_QA_RESULT"`, { reportsVersion: true });
  fs.writeFileSync(reported, `${r.base}\n`); // the environment still runs the version before the run
  const v = await settled(r.m, r.runId);
  assert.deepEqual([v.status, v.reason], ["paused", "finish_unconfirmed"], JSON.stringify(v));
  assert.deepEqual([qaOf(v).status, qaOf(v).version, qaOf(v).observed], ["unknown", "mismatch", r.base]);
  fs.writeFileSync(reported, `${"b".repeat(40)}\n`); // another, unrelated version
  await resume(r.m, v);
  const again = await until(async () => { const x = await view(r.m, r.runId); return x.status === "paused" && x.revision > v.revision + 1 ? x : null; }, "the second pause");
  assert.deepEqual([again.reason, qaOf(again).status, qaOf(again).version, qaOf(again).observed, qaOf(again).established], ["finish_unconfirmed", "unknown", "mismatch", "b".repeat(40), true]);
  fs.writeFileSync(reported, `${commitOf(again)}\n`);
  await resume(r.m, again);
  const done = await settled(r.m, r.runId);
  assert.equal(done.status, "completed", JSON.stringify(done));
  assert.deepEqual([qaOf(done).status, qaOf(done).version, qaOf(done).observed], ["done", "confirmed", commitOf(done)]);
  assert.equal(lines(r.deploys).length, 1, "the deploy ran once");
  await r.m.shutdown();
});

test("contract: an empty result, or the id only on stdout, is not_reported", OPTS, async () => {
  const r = await qaRun(`echo "$CANVASTTY_COMMIT"`, { reportsVersion: true });
  const v = await settled(r.m, r.runId);
  assert.deepEqual([v.status, v.reason, qaOf(v).status, qaOf(v).version, qaOf(v).observed], ["paused", "finish_unconfirmed", "unknown", "not_reported", null]);
  await r.m.shutdown();
});

test("contract: garbage or an abbreviated id is invalid; nothing of it is kept as observed", OPTS, async () => {
  const r = await qaRun(`echo "$CANVASTTY_COMMIT" | cut -c1-7 > "$CANVASTTY_QA_RESULT"`, { reportsVersion: true });
  const v = await settled(r.m, r.runId);
  assert.deepEqual([v.status, v.reason, qaOf(v).status, qaOf(v).version, qaOf(v).observed], ["paused", "finish_unconfirmed", "unknown", "invalid", null]);
  await r.m.shutdown();
  const r2 = await qaRun(`echo "deployed OK" > "$CANVASTTY_QA_RESULT"`, { reportsVersion: true });
  const v2 = await settled(r2.m, r2.runId);
  assert.deepEqual([qaOf(v2).status, qaOf(v2).version, qaOf(v2).observed], ["unknown", "invalid", null]);
  await r2.m.shutdown();
});

test("contract: the delivered commit reported (blank line, upper case) is confirmed and the run completes", OPTS, async () => {
  const r = await qaRun(`printf '\\n  %s\\n' "$(echo "$CANVASTTY_COMMIT" | tr a-f A-F)" > "$CANVASTTY_QA_RESULT"`, { reportsVersion: true });
  const done = await settled(r.m, r.runId);
  assert.equal(done.status, "completed", JSON.stringify(done));
  assert.deepEqual([qaOf(done).status, qaOf(done).version, qaOf(done).observed, qaOf(done).commit], ["done", "confirmed", commitOf(done), commitOf(done)]);
  await r.m.shutdown();
});

test("a failed deploy is failed: the verification does not run, no version", OPTS, async () => {
  const ran = tmp("verify-ran");
  const r = await qaRun(`touch ${ran}`, { reportsVersion: true, command: "exit 3" });
  const v = await settled(r.m, r.runId);
  assert.deepEqual([v.status, v.reason, qaOf(v).status, qaOf(v).version ?? null], ["paused", "finish_unconfirmed", "failed", null]);
  assert.equal(fs.existsSync(ran), false);
  await r.m.shutdown();
});

test("after the answer of the deploy was lost: only the verification runs, with the contract it confirms", OPTS, async () => {
  const marker = tmp("marker");
  const r = await qaRun(`cat ${marker} > "$CANVASTTY_QA_RESULT"`, { reportsVersion: true, command: `echo "$CANVASTTY_COMMIT" > ${marker}; sleep 60` });
  await until(async () => fs.existsSync(marker), "the deploy started");
  await r.m.shutdown(); // the application ends while the deploy runs
  const m2 = manager(r.root, r.providers);
  const v = await view(m2, r.runId);
  assert.deepEqual([v.status, v.reason], ["paused", "app_closed"]);
  await resume(m2, v);
  const asked = await settled(m2, r.runId, "the pause before the verification");
  assert.deepEqual([asked.reason, qaOf(asked).status], ["finish_unconfirmed", "outcome_unknown"]);
  await resume(m2, asked);
  const done = await settled(m2, r.runId);
  assert.equal(done.status, "completed", JSON.stringify(done));
  assert.deepEqual([qaOf(done).status, qaOf(done).established, qaOf(done).version, qaOf(done).observed], ["done", true, "confirmed", commitOf(done)]);
  assert.equal(lines(r.deploys).length, 1, "the deploy ran once");
  await m2.shutdown();
});

test("each verification gets a new empty result file in the run's folder: an earlier report does not confirm", OPTS, async () => {
  const gate = tmp("gate");
  const seen = tmp("seen");
  // the first verification writes the right id but fails; the next one passes and writes nothing
  const r = await qaRun(`echo "$CANVASTTY_QA_RESULT $(wc -c < "$CANVASTTY_QA_RESULT" | tr -d ' ') $(ls -l "$CANVASTTY_QA_RESULT" | cut -c1-10)" >> ${seen}; `
    + `[ -f ${gate} ] && exit 0; echo "$CANVASTTY_COMMIT" > "$CANVASTTY_QA_RESULT"; exit 1`, { reportsVersion: true });
  const v = await settled(r.m, r.runId);
  assert.deepEqual([v.reason, qaOf(v).status, qaOf(v).version ?? null], ["finish_unconfirmed", "unknown", null], "a failing verification establishes no version");
  fs.writeFileSync(gate, "");
  await resume(r.m, v);
  const again = await until(async () => { const x = await view(r.m, r.runId); return x.status === "paused" && x.revision > v.revision + 1 ? x : null; }, "the second pause");
  assert.deepEqual([qaOf(again).status, qaOf(again).version], ["unknown", "not_reported"]);
  const runs = lines(seen).map((l) => l.split(" "));
  assert.equal(runs.length, 2);
  assert.notEqual(runs[0][0], runs[1][0], "a new file each time");
  for (const [file, size, mode] of runs) {
    assert.deepEqual([size, mode], ["0", "-rw-------"]);
    assert.ok(file.startsWith(path.join(r.root, "runs", r.runId) + path.sep) && !file.startsWith(r.src), file);
    assert.equal(fs.existsSync(file), false, "removed after reading");
  }
  assert.equal(lines(r.deploys).length, 1);
  await r.m.shutdown();
});
