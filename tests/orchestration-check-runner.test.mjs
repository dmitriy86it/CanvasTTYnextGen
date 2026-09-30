// Integration checks for startCheck (src/main/services/orchestration/checkRunner.ts) with the real
// src/orchestration/supervisor.mjs and tiny fixtures written into this test's own temp directory
// (canvastty-reaper-*): no CanvasTTY check is run, nothing outside that directory is touched.
//
// The sandbox is real: /usr/bin/sandbox-exec runs the supervisor under TEST_PROFILE, which scopes signals exactly as
// the check profile does ((deny signal) + (allow signal (target same-sandbox))) and allows everything else, so the
// fixtures can write their pid files into TMP. The full check profile is sandbox.ts's and is exercised in
// orchestration-sandbox.test.mjs. fake-sandbox.sh (same argv shape, `exec`s its command, no sandbox) stands in only
// where the supervisor must run OUTSIDE a sandbox. sandbox.ts, checks.ts and store.ts are stubbed through the
// injected parameters only — checkRunner.ts has no stubs.
//
// Process accounting: every pid a fixture reports is tracked in tests/fixtures/orchestration/reaper-pids.mjs, whose
// after() cleanup kills only those pids, after `ps` confirms they still run the fixture's command.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { CHECK_ENV_NAMES, decideCheck, startCheck } from "../src/main/services/orchestration/checkRunner.ts";
import { OwnPids, alive, waitDead } from "./fixtures/orchestration/reaper-pids.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SUPERVISOR = path.join(ROOT, "src/orchestration/supervisor.mjs");
const RUNNER = path.join(ROOT, "src/main/services/orchestration/checkRunner.ts");
const ESCAPEE = path.join(ROOT, "tests/fixtures/orchestration/reaper-escapee.mjs"); // setsid /bin/sh -> /bin/sleep
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "canvastty-reaper-")));
const pids = new OwnPids();
const sandboxOnly = { skip: process.platform === "darwin" ? false : "sandbox-exec is macOS only" };
const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const TEST_PROFILE = "(version 1)\n(allow default)\n(deny signal)\n(allow signal (target same-sandbox))\n";

after(async () => {
  const killed = await pids.cleanup();
  if (killed.length) console.log(`# after: SIGKILL own leftovers ${killed.join("; ")}`);
  fs.rmSync(TMP, { recursive: true, force: true }); // only our own mkdtemp
});

// ---- fixtures, written once into TMP ----
const F = {};
const fixture = (name, body, mode = 0o600) => {
  const p = path.join(TMP, name);
  fs.writeFileSync(p, body, { mode });
  F[name] = p;
  return p;
};

// Stand-in for sandbox-exec: same argv shape, refuses a missing profile, execs the target (pid = leader = pgid).
fixture("fake-sandbox.sh", `#!/bin/sh
[ "$1" = "-f" ] || exit 64
[ -f "$2" ] || exit 65
shift 2
[ "$1" = "--" ] && shift
exec "$@"
`, 0o755);

fixture("ok.mjs", `
process.stdout.write(JSON.stringify({ cwd: process.cwd(), env: process.env }) + "\\n");
process.stderr.write("stderr-marker\\n");
`);
fixture("fail.mjs", `process.stdout.write("failing\\n"); process.exit(3);\n`);
fixture("sleep.mjs", `
import fs from "node:fs";
fs.writeFileSync(process.argv[2], String(process.pid));
process.stdout.write("up\\n");
setTimeout(() => {}, 30000);
`);
fixture("spam.mjs", `
import fs from "node:fs";
fs.writeFileSync(process.argv[2], String(process.pid));
const chunk = "x".repeat(4096) + "\\n";
for (let i = 0; i < 40; i++) process.stdout.write(chunk);
process.stderr.write(chunk);
setTimeout(() => {}, 30000);
`);
// Leftover inside the target's process group: the supervisor is expected to clear it.
fixture("group-child.mjs", `
import { spawn } from "node:child_process";
spawn(process.execPath, [process.argv[2], process.argv[3]], { stdio: "ignore" });
setTimeout(() => process.exit(0), 300);
`);
// Stub supervisors: the only way to see done.groupCleared === false (the real one kills the group first), and a
// done without the sandbox field (the scan never reported).
fixture("stub-supervisor.mjs", `
import fs from "node:fs";
const say = (o) => fs.writeSync(3, JSON.stringify(o) + "\\n");
say({ ev: "started", pgid: process.pid, env: [] });
say({ ev: "leader_exit", code: 0, signal: null });
say({ ev: "done", leaderExit: { code: 0, signal: null }, stopRequested: false, groupCleared: false });
process.exit(0);
`);
fixture("stub-supervisor-noscan.mjs", `
import fs from "node:fs";
const say = (o) => fs.writeSync(3, JSON.stringify(o) + "\\n");
say({ ev: "started", pgid: process.pid, env: [] });
say({ ev: "leader_exit", code: 0, signal: null });
say({ ev: "done", leaderExit: { code: 0, signal: null }, stopRequested: false, groupCleared: true });
process.exit(0);
`);

// ---- injected stubs for the neighbours' files (§8 API) ----
const sha256 = (data) => createHash("sha256").update(data).digest("hex");

function makeWs() {
  const runId = randomUUID();
  const root = path.join(TMP, "state", runId.slice(0, 8));
  const dir = path.join(root, "runs", runId, "workspace");
  const repo = path.join(dir, "repo");
  const source = path.join(root, "source");
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(path.join(source, "node_modules"), { recursive: true });
  fs.mkdirSync(path.join(source, ".git"), { recursive: true });
  return {
    runId, root, dir, repo, control: path.join(dir, "control.git"), tmp: path.join(dir, "tmp"),
    sourcePath: source, sourceGitDir: path.join(source, ".git"), gitPath: "/usr/bin/git",
    baseline: { commit: "c".repeat(40), tree: "t".repeat(40), parent: null }, head: null
  };
}

function makeWriter(opts = {}) {
  const events = [];
  return {
    events,
    texts: [],
    async putText(content) {
      if (opts.failPutText) throw new Error("putText refused");
      const bytes = Buffer.byteLength(content);
      this.texts.push(Buffer.from(content).toString("utf8"));
      return { sha256: sha256(content), bytes };
    },
    async recordCheckStarted(data) {
      if (opts.failStarted) throw new Error("started refused");
      events.push({ type: "check.started", data });
    },
    async recordCheckFinished(data) {
      if (opts.failFinished) throw new Error("finished refused");
      events.push({ type: "check.finished", data });
    }
  };
}

const sandboxStub = (over = {}) => ({
  sandboxSupport: () => ({ supported: true }),
  buildProfile: () => ({ text: TEST_PROFILE, sha256: "a".repeat(64) }),
  runSelftest: async () => ({ passed: true, checks: 7, failed: [] }),
  ...over
});

function makeOpts(over = {}) {
  const ws = over.ws ?? makeWs();
  const command = {
    id: "unit", title: "unit tests", executable: process.execPath, argv: [],
    timeoutMs: 20_000, maxOutputBytes: 16_384, ...(over.command ?? {})
  };
  return {
    ws,
    registry: { commands: [command] },
    id: command.id,
    deps: { lockfileRelPath: "package-lock.json", lockfileSha256: "b".repeat(64), nodeModulesPath: path.join(ws.sourcePath, "node_modules") },
    writer: over.writer ?? makeWriter(),
    launch: { command: process.execPath, args: [over.supervisor ?? SUPERVISOR], env: {} },
    resolveCheck: (registry, id) => {
      const found = registry.commands.find((c) => c.id === id);
      if (!found) throw new Error("unknown_check");
      return found;
    },
    sandbox: over.sandbox ?? sandboxStub(),
    preflight: over.preflight ?? (async () => ({ ok: true, base: { commit: "c".repeat(40), tree: "t".repeat(40) }, treeBefore: "1".repeat(40) })),
    postflight: over.postflight ?? (async () => ({ ok: true, treeAfter: "1".repeat(40) })),
    evidence: over.evidence ?? ((facts) => sha256(JSON.stringify(facts))),
    sandboxExec: over.sandboxExec ?? SANDBOX_EXEC,
    outputGraceMs: 800,
    supervisor: { graceIntMs: 1500, graceTermMs: 1000, leftoverMs: 500 },
    ...(over.rest ?? {})
  };
}

const waitFile = async (file, ms = 8000) => {
  for (const until = Date.now() + ms; Date.now() < until;) {
    if (fs.existsSync(file)) return Number(fs.readFileSync(file, "utf8"));
    await sleep(25);
  }
  throw new Error(`fixture never wrote ${file}`);
};

// ---- tests ----

test("passing command: passed, fixed env, cwd = copy, output stored, events in order", sandboxOnly, async (t) => {
  const writer = makeWriter();
  const o = makeOpts({ writer, command: { argv: [F["ok.mjs"]] } });
  const { checkRunId, result } = startCheck(o);
  const r = await result;
  t.diagnostic(`status=${r.status} cleanup=${JSON.stringify(r.cleanup)} exit=${r.process.exitCode}`);

  assert.equal(r.status, "passed");
  assert.equal(r.reason, null);
  assert.equal(r.checkRunId, checkRunId);
  assert.equal(r.process.exitCode, 0);
  assert.deepEqual(r.cleanup, { groupCleared: true, sandboxCleared: true, killed: 0, observed: "process_group_and_sandbox_scan" });
  assert.equal(r.copy.treeBefore, "1".repeat(40));
  assert.equal(r.copy.treeAfter, "1".repeat(40));
  assert.equal(r.sandbox.profileSha256, "a".repeat(64));
  assert.match(r.evidenceFingerprint, /^[0-9a-f]{64}$/);
  assert.ok(r.durationMs >= 0);
  assert.equal(r.output.dropped, 0);
  assert.ok(r.output.ref && r.output.ref.bytes > 0);
  assert.match(r.output.head + r.output.tail, /stderr-marker/);

  assert.deepEqual(writer.events.map((e) => e.type), ["check.started", "check.finished"]);
  const started = writer.events[0].data;
  assert.equal(started.checkRunId, checkRunId);
  assert.equal(started.profileSha256, "a".repeat(64));
  assert.match(started.commandSha256, /^[0-9a-f]{64}$/);
  const finished = writer.events[1].data;
  assert.equal(finished.status, "passed");
  assert.equal(finished.output.sha256, r.output.ref.sha256);
  assert.equal(finished.evidenceFingerprint, r.evidenceFingerprint);

  // The check's own view: fixed env, cwd, profile file; node_modules is the preflight's, the runner makes none.
  const seen = JSON.parse((r.output.head + r.output.tail).split("\n")[0]);
  assert.equal(seen.cwd, fs.realpathSync(o.ws.repo));
  for (const name of CHECK_ENV_NAMES) assert.ok(name in seen.env, `${name} missing`);
  for (const name of ["ELECTRON_RUN_AS_NODE", "SUP_ENV_ALLOW", "USER", "TERM", "SHELL", "LOGNAME", "NODE_OPTIONS"]) {
    assert.ok(!(name in seen.env), `${name} leaked into the check`);
  }
  // Not passed by us: /bin/sh (the sandbox stand-in) adds PWD/SHLVL/_ on exec and CoreFoundation puts
  // __CF_USER_TEXT_ENCODING into the process's own environment. Nothing else may appear.
  const added = ["PWD", "SHLVL", "_", "__CF_USER_TEXT_ENCODING"];
  const extra = Object.keys(seen.env).filter((k) => !CHECK_ENV_NAMES.includes(k) && !added.includes(k));
  assert.deepEqual(extra, []);
  assert.equal(seen.env.CI, "1");
  assert.equal(seen.env.LC_ALL, "C");
  assert.match(seen.env.HOME, /checks\/[0-9a-f-]{36}\/home$/);
  assert.match(seen.env.TMPDIR, /checks\/[0-9a-f-]{36}\/tmp$/);
  assert.equal(seen.env.PATH, `${path.dirname(process.execPath)}:/usr/bin:/bin`);
  assert.ok(fs.existsSync(path.join(o.ws.root, "runs", o.ws.runId, "checks", checkRunId, "profile.sb")));
  assert.equal(fs.existsSync(path.join(o.ws.repo, "node_modules")), false);
});

test("failing command: failed with its own exit code, no reason", sandboxOnly, async () => {
  const r = await startCheck(makeOpts({ command: { argv: [F["fail.mjs"]] } })).result;
  assert.equal(r.status, "failed");
  assert.equal(r.reason, null);
  assert.equal(r.process.exitCode, 3);
  assert.equal(r.cleanup.groupCleared, true);
});

test("timeout: stop is sent, not_verified(timeout), group cleared", sandboxOnly, async (t) => {
  const pidFile = path.join(TMP, `to-${randomUUID()}.pid`);
  const r = await startCheck(makeOpts({ command: { argv: [F["sleep.mjs"], pidFile], timeoutMs: 700 } })).result;
  t.diagnostic(`exit=${r.process.exitCode} signal=${r.process.signal}`);
  assert.equal(r.status, "not_verified");
  assert.equal(r.reason, "timeout");
  assert.equal(r.process.stopCause, "timeout");
  assert.equal(r.cleanup.groupCleared, true);
  assert.equal(r.process.exitCode, null);
  assert.equal(r.process.signal, "SIGINT"); // stop => SIGINT to the leader first
  const pid = Number(fs.readFileSync(pidFile, "utf8"));
  pids.track(pid, "sleep.mjs");
  assert.equal(alive(pid), false);
});

test("stop(): not_verified(stopped), target gone", sandboxOnly, async () => {
  const pidFile = path.join(TMP, `stop-${randomUUID()}.pid`);
  const run = startCheck(makeOpts({ command: { argv: [F["sleep.mjs"], pidFile] } }));
  const pid = await waitFile(pidFile);
  pids.track(pid, "sleep.mjs");
  run.stop();
  const r = await run.result;
  assert.equal(r.status, "not_verified");
  assert.equal(r.reason, "stopped");
  assert.equal(r.process.stopCause, "user");
  assert.equal(r.cleanup.groupCleared, true);
  assert.equal(alive(pid), false);
});

test("output limit: head and tail kept, dropped counted, not_verified(output_limit)", sandboxOnly, async (t) => {
  const pidFile = path.join(TMP, `spam-${randomUUID()}.pid`);
  const max = 2048;
  const r = await startCheck(makeOpts({ command: { argv: [F["spam.mjs"], pidFile], maxOutputBytes: max } })).result;
  t.diagnostic(`bytes=${r.output.bytes} dropped=${r.output.dropped}`);
  assert.equal(r.status, "not_verified");
  assert.equal(r.reason, "output_limit");
  assert.equal(r.process.stopCause, "output_limit");
  assert.ok(r.output.bytes > max, "more than the limit was produced");
  assert.ok(r.output.dropped > 0, "dropped bytes counted");
  const kept = Buffer.byteLength(r.output.head) + Buffer.byteLength(r.output.tail);
  assert.ok(kept <= max, `kept ${kept} <= ${max}`);
  assert.equal(r.output.bytes - r.output.dropped, kept);
  assert.ok(r.output.head.length > 0 && r.output.tail.length > 0, "head and tail both kept");
  assert.equal(r.cleanup.groupCleared, true);
  const pid = Number(fs.readFileSync(pidFile, "utf8"));
  pids.track(pid, "spam.mjs");
  assert.equal(alive(pid), false);
});

test("launch error: missing sandbox-exec => not_verified(spawn_failed) with the code", async () => {
  const r = await startCheck(makeOpts({
    command: { argv: [F["ok.mjs"]] },
    sandboxExec: path.join(TMP, "no-such-sandbox-exec")
  })).result;
  assert.equal(r.status, "not_verified");
  assert.equal(r.reason, "spawn_failed");
  assert.equal(r.detail.spawnError, "ENOENT", "the sandbox-exec spawn itself failed: no supervisor ran");
  assert.equal(r.process.exitCode, null);
});

test("main dies: fd0 closes, the supervisor stops the group and the sandbox scan kills the escapee", sandboxOnly, async (t) => {
  const escFile = path.join(TMP, `owner-esc-${randomUUID()}.pid`);
  const leaderFile = path.join(TMP, `owner-leader-${randomUUID()}.pid`);
  const owner = fixture(`owner-${randomUUID()}.mjs`, `
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { startCheck } from ${JSON.stringify(RUNNER)};

const root = ${JSON.stringify(path.join(TMP, "owner-state"))};
const runId = randomUUID();
const dir = path.join(root, "runs", runId, "workspace");
const repo = path.join(dir, "repo");
fs.mkdirSync(repo, { recursive: true });
const nm = path.join(root, "node_modules");
fs.mkdirSync(nm, { recursive: true });
const command = { id: "unit", title: "t", executable: process.execPath, argv: [${JSON.stringify(ESCAPEE)}, ${JSON.stringify(escFile)}, ${JSON.stringify(leaderFile)}], timeoutMs: 60000, maxOutputBytes: 8192 };
startCheck({
  ws: { runId, root, dir, repo, control: path.join(dir, "control.git"), tmp: path.join(dir, "tmp"),
        sourcePath: root, sourceGitDir: path.join(root, ".git"), gitPath: "/usr/bin/git",
        baseline: { commit: "c", tree: "t", parent: null }, head: null },
  registry: { commands: [command] }, id: "unit",
  deps: { lockfileRelPath: "package-lock.json", lockfileSha256: "b", nodeModulesPath: nm },
  writer: { putText: async () => ({ sha256: "0".repeat(64), bytes: 0 }), recordCheckStarted: async () => {}, recordCheckFinished: async () => {} },
  launch: { command: process.execPath, args: [${JSON.stringify(SUPERVISOR)}], env: {} },
  resolveCheck: (r, id) => r.commands.find((c) => c.id === id),
  sandbox: { sandboxSupport: () => ({ supported: true }), buildProfile: () => ({ text: ${JSON.stringify(TEST_PROFILE)}, sha256: "a".repeat(64) }), runSelftest: async () => ({ passed: true, checks: 1, failed: [] }) },
  preflight: async () => ({ ok: true, base: { commit: "c", tree: "t" }, treeBefore: "1" }),
  postflight: async () => ({ ok: true, treeAfter: "1" }),
  evidence: () => "f".repeat(64),
  sandboxExec: ${JSON.stringify(SANDBOX_EXEC)}
});
setTimeout(() => {}, 60000);
`);
  const proc = spawn(process.execPath, [owner], { stdio: ["ignore", "pipe", "pipe"] });
  pids.track(proc.pid, "owner-");
  let err = "";
  proc.stderr.on("data", (d) => { err += d; });
  const leader = await waitFile(leaderFile, 15000).catch((e) => {
    throw new Error(`${e.message}; owner stderr: ${err.slice(0, 800)}`);
  });
  pids.track(leader, "reaper-escapee.mjs");
  const esc = pids.track(await waitFile(escFile), "sleep");
  assert.equal(alive(leader), true);
  assert.equal(alive(esc), true);

  proc.kill("SIGKILL"); // main is gone: fd0 EOF is the only signal the supervisor gets
  const leaderDead = await waitDead(leader, 15000);
  const escDead = await waitDead(esc, 15000);
  t.diagnostic(`after main death: leader alive=${!leaderDead} escapee alive=${!escDead}`);
  assert.equal(leaderDead, true, "the supervisor must stop the group when its lifeline closes");
  assert.equal(escDead, true, "the sandbox scan must kill the setsid escapee without main");
});

// The escapee is alive while the check is stopped from outside: whatever stops the check, the scan still runs.
for (const [how, over, reason] of [
  ["stop()", {}, "stopped"],
  ["timeout", { timeoutMs: 1500 }, "timeout"]
]) {
  test(`${how} with a live setsid escapee: not_verified(${reason}), escapee killed by the scan`, sandboxOnly, async (t) => {
    const escFile = path.join(TMP, `esc-${randomUUID()}.pid`);
    const leaderFile = path.join(TMP, `lead-${randomUUID()}.pid`);
    const run = startCheck(makeOpts({ command: { argv: [ESCAPEE, escFile, leaderFile], ...over } }));
    const leader = pids.track(await waitFile(leaderFile), "reaper-escapee.mjs");
    const esc = pids.track(await waitFile(escFile), "sleep");
    if (how === "stop()") run.stop();
    const r = await run.result;
    t.diagnostic(`status=${r.status}/${r.reason} cleanup=${JSON.stringify(r.cleanup)}`);
    assert.deepEqual([r.status, r.reason], ["not_verified", reason]);
    assert.equal(alive(leader), false);
    assert.equal(alive(esc), false, "the escapee is dead once the result is out");
    assert.equal(r.cleanup.sandboxCleared, true);
    assert.ok(r.cleanup.killed >= 1);
  });
}

// Observation unavailable, twice: the real supervisor outside any sandbox refuses to scan (and signals nothing, so
// the escapee must still be alive — the test kills it), and a supervisor whose done has no sandbox field at all.
test("real supervisor NOT in a sandbox: not_sandboxed, nothing killed, cleanup_unverified", sandboxOnly, async (t) => {
  const pidFile = path.join(TMP, `nosb-${randomUUID()}.pid`);
  const r = await startCheck(makeOpts({ command: { argv: [ESCAPEE, pidFile] }, sandboxExec: F["fake-sandbox.sh"] })).result;
  const pid = pids.track(await waitFile(pidFile), "sleep");
  t.diagnostic(`status=${r.status}/${r.reason} cleanup=${JSON.stringify(r.cleanup)} detail=${JSON.stringify(r.detail)}`);
  assert.equal(r.process.exitCode, 0);
  assert.deepEqual([r.status, r.reason], ["not_verified", "cleanup_unverified"]);
  assert.deepEqual(r.cleanup, { groupCleared: true, sandboxCleared: false, killed: 0, observed: "process_group_and_sandbox_scan" });
  assert.equal(r.detail.sandbox, "not_sandboxed");
  assert.equal(alive(pid), true, "an unsandboxed supervisor must not signal anything outside its group");
  assert.deepEqual((await pids.cleanup()).length, 1);
});

for (const exit of ["ok.mjs", "fail.mjs"]) {
  test(`done without a sandbox field (${exit}): cleanup_unverified, never passed or failed`, sandboxOnly, async () => {
    const r = await startCheck(makeOpts({ command: { argv: [F[exit]] }, supervisor: F["stub-supervisor-noscan.mjs"] })).result;
    assert.deepEqual([r.status, r.reason], ["not_verified", "cleanup_unverified"]);
    assert.deepEqual(r.cleanup, { groupCleared: true, sandboxCleared: false, killed: null, observed: "process_group_and_sandbox_scan" });
  });
}

test("leftover child inside the group: the supervisor clears it, the result never claims more", sandboxOnly, async (t) => {
  const pidFile = path.join(TMP, `grp-${randomUUID()}.pid`);
  const r = await startCheck(makeOpts({
    command: { argv: [F["group-child.mjs"], F["sleep.mjs"], pidFile] }
  })).result;
  const pid = await waitFile(pidFile);
  pids.track(pid, "sleep.mjs");
  t.diagnostic(`status=${r.status}/${r.reason} cleanup=${JSON.stringify(r.cleanup)} childAlive=${alive(pid)}`);
  assert.equal(r.process.exitCode, 0);
  assert.equal(r.cleanup.groupCleared, true, "the child stayed in the group, so the supervisor killed it");
  assert.equal(alive(pid), false, "the leftover of the group is gone before the result");
  assert.equal(r.cleanup.sandboxCleared, true);
  assert.equal(r.status, "passed");
});

test("done.groupCleared === false => not_verified(cleanup_unverified) (stub supervisor: the real one kills the group)", sandboxOnly, async () => {
  const r = await startCheck(makeOpts({
    command: { argv: [F["ok.mjs"]] },
    supervisor: F["stub-supervisor.mjs"]
  })).result;
  assert.equal(r.status, "not_verified");
  assert.equal(r.reason, "cleanup_unverified");
  assert.equal(r.cleanup.groupCleared, false);
  assert.equal(r.process.exitCode, 0, "exit code 0 with leftovers is still not passed");
});

// A setsid'ed /bin/sh -> /bin/sleep escapee: a platform binary, invisible to any env search and outside the group.
// It lives in the same sandbox instance as the supervisor, so the supervisor's scan finds and kills it; the result
// must say so, and the escapee must be dead once the result is out.
test("setsid escapee that is a platform binary: killed by the sandbox scan before the result", sandboxOnly, async (t) => {
  const pidFile = path.join(TMP, `escsh-${randomUUID()}.pid`);
  const r = await startCheck(makeOpts({ command: { argv: [ESCAPEE, pidFile] } })).result;
  const pid = pids.track(await waitFile(pidFile), "sleep");
  t.diagnostic(`escapee alive=${alive(pid)} cleanup=${JSON.stringify(r.cleanup)} status=${r.status}/${r.reason}`);

  assert.equal(alive(pid), false, "the escapee is dead once the result is out");
  assert.equal(r.cleanup.groupCleared, true);
  assert.equal(r.cleanup.sandboxCleared, true);
  assert.ok(r.cleanup.killed >= 1, "the scan, not the group, killed it");
  assert.equal(r.cleanup.observed, "process_group_and_sandbox_scan");
  assert.equal(r.status, "passed");
});

test("refusal before check.started: no event at all", async () => {
  const writer = makeWriter();
  const r = await startCheck(makeOpts({
    writer,
    command: { argv: [F["ok.mjs"]] },
    preflight: async () => ({ ok: false, reason: "workspace_unverified", detail: { marker: "missing" } })
  })).result;
  assert.equal(r.status, "not_verified");
  assert.equal(r.reason, "workspace_unverified");
  assert.deepEqual(writer.events, []);
  assert.equal(r.copy.treeBefore, null);
});

test("failed selftest and unsupported platform => sandbox_unavailable, nothing is started", async () => {
  const writer = makeWriter();
  const bad = await startCheck(makeOpts({
    writer, command: { argv: [F["ok.mjs"]] },
    sandbox: sandboxStub({ runSelftest: async () => ({ passed: false, checks: 7, failed: [{ name: "network", detail: "tcp allowed" }] }) })
  })).result;
  assert.equal(bad.reason, "sandbox_unavailable");
  assert.equal(bad.sandbox.selftest.passed, false);
  assert.deepEqual(writer.events, []);

  const unsupported = await startCheck(makeOpts({
    command: { argv: [F["ok.mjs"]] },
    sandbox: sandboxStub({ sandboxSupport: () => ({ supported: false, reason: "sandbox_unavailable" }) })
  })).result;
  assert.equal(unsupported.reason, "sandbox_unavailable");
  assert.equal(unsupported.sandbox.profileSha256, null, "no profile is even generated");
});

test("store failures: check.started refused => no event; check.finished refused => store_failed", sandboxOnly, async () => {
  const noStart = await startCheck(makeOpts({ writer: makeWriter({ failStarted: true }), command: { argv: [F["ok.mjs"]] } })).result;
  assert.equal(noStart.reason, "store_failed");
  assert.equal(noStart.process.exitCode, null, "the process is never started");

  const noFinish = await startCheck(makeOpts({ writer: makeWriter({ failFinished: true }), command: { argv: [F["ok.mjs"]] } })).result;
  assert.equal(noFinish.status, "not_verified");
  assert.equal(noFinish.reason, "store_failed");
  assert.equal(noFinish.process.exitCode, 0, "the command itself did finish with 0");
});

test("tree and dependency changes after the check => their reason, with the event written", sandboxOnly, async () => {
  const writer = makeWriter();
  const r = await startCheck(makeOpts({
    writer, command: { argv: [F["ok.mjs"]] },
    postflight: async () => ({ ok: false, reason: "tree_changed", treeAfter: "2".repeat(40), detail: { added: ["x"] } })
  })).result;
  assert.equal(r.status, "not_verified");
  assert.equal(r.reason, "tree_changed");
  assert.equal(r.copy.treeAfter, "2".repeat(40));
  assert.deepEqual(writer.events.map((e) => e.type), ["check.started", "check.finished"]);
  assert.equal(writer.events[1].data.treeAfter, "2".repeat(40));
});

test("decideCheck: §5 rules in order", () => {
  const base = {
    supervisorSpawnError: null, done: { ev: "done", leaderExit: { code: 0, signal: null }, groupCleared: true },
    supervisorExitCode: 0, exitCode: 0, signal: null, stopCause: null, stopRequested: false,
    groupCleared: true, sandboxCleared: true, postReason: null
  };
  const cases = [
    [{}, ["passed", null]],
    [{ exitCode: 3 }, ["failed", null]],
    [{ supervisorSpawnError: "ENOENT" }, ["not_verified", "spawn_failed"]],
    [{ done: { ev: "done", error: "spawn", code: "ENOENT", leaderExit: null } }, ["not_verified", "spawn_failed"]],
    [{ done: null }, ["not_verified", "interrupted"]],
    [{ done: { ev: "done", error: "fd4_missing", leaderExit: null } }, ["not_verified", "interrupted"]],
    [{ stopCause: "output_limit" }, ["not_verified", "output_limit"]],
    [{ stopCause: "timeout" }, ["not_verified", "timeout"]],
    [{ stopCause: "user" }, ["not_verified", "stopped"]],
    [{ stopRequested: true }, ["not_verified", "stopped"]],
    [{ stopCause: "timeout", exitCode: 3 }, ["not_verified", "timeout"]],
    [{ postReason: "tree_changed" }, ["not_verified", "tree_changed"]],
    [{ postReason: "deps_changed", exitCode: 3 }, ["not_verified", "deps_changed"]],
    [{ groupCleared: false }, ["not_verified", "cleanup_unverified"]],
    [{ sandboxCleared: false }, ["not_verified", "cleanup_unverified"]],
    [{ sandboxCleared: false, exitCode: 3 }, ["not_verified", "cleanup_unverified"]],
    [{ supervisorExitCode: 1 }, ["not_verified", "cleanup_unverified"]],
    [{ groupCleared: false, exitCode: 3 }, ["not_verified", "cleanup_unverified"]],
    [{ exitCode: null, signal: "SIGKILL" }, ["not_verified", "interrupted"]],
    [{ sandboxCleared: undefined }, ["not_verified", "cleanup_unverified"]] // observation unavailable is not a pass
  ];
  for (const [over, want] of cases) {
    const got = decideCheck({ ...base, ...over });
    assert.deepEqual([got.status, got.reason], want, JSON.stringify(over));
  }
});
