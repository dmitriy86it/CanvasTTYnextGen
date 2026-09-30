// The coordinator's pre-check of a heredoc prompt (scripts/answer-rule.mjs heredocWrites) and the file-based wait for
// its decision (scripts/coordinator-decision.mjs awaitDecision).
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { allowedByAssignment, heredocWrites } from "../scripts/answer-rule.mjs";
import { awaitDecision } from "../scripts/coordinator-decision.mjs";

// The command that stopped S3 in real-stage-13/series-S3-S5-S6-attempt3 (report.json scenarios.S3.stoppedAtPrompt).
const S3 = "cat > src/duration.mjs <<'EOF'\nimport ms from \"ms\";\n\nexport function toMs(text) {\n  const value = typeof text === \"string\" && text.length > 0 ? ms(text) : undefined;\n  if (value === undefined) throw new TypeError(`Not a duration: ${String(text)}`);\n  return value;\n}\nEOF\ncat > tests/duration.test.mjs <<'EOF'\nimport assert from \"node:assert/strict\";\nimport { test } from \"node:test\";\nimport { toMs } from \"../src/duration.mjs\";\n\ntest(\"converts durations\", () => {\n  assert.equal(toMs(\"2s\"), 2000);\n  assert.equal(toMs(\"1h\"), 3600000);\n  assert.equal(toMs(\"1.5s\"), 1500);\n  assert.equal(toMs(\"0ms\"), 0);\n});\n\ntest(\"rejects non-durations with TypeError\", () => {\n  for (const bad of [\"soon\", \"\", 5, null, undefined, {}]) {\n    assert.throws(() => toMs(bad), TypeError);\n  }\n});\nEOF\nnpm test 2>&1 | tail -12; git status --short";
const SRC = "import ms from \"ms\";\n\nexport function toMs(text) {\n  const value = typeof text === \"string\" && text.length > 0 ? ms(text) : undefined;\n  if (value === undefined) throw new TypeError(`Not a duration: ${String(text)}`);\n  return value;\n}\n";

const temps = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "cto-coord-")); temps.push(d); return d; };
after(() => { for (const d of temps) fs.rmSync(d, { recursive: true, force: true }); });
const project = () => { const d = tmp(); fs.mkdirSync(path.join(d, "src")); fs.mkdirSync(path.join(d, "tests")); return d; };
const OPTS = { protectedFiles: ["tests/duration.accept.test.mjs"] };
const doc = (header, rest = "") => `${header}\nexport const x = 1;\nEOF\n${rest}`;

test("the attempt-3 S3 heredoc command passes the pre-check and stays not auto-allowed", () => {
  const dir = project();
  const r = heredocWrites(S3, dir, OPTS);
  assert.deepEqual(r.problems, []);
  assert.equal(r.ok, true);
  assert.deepEqual(r.writes.map((w) => w.path), ["src/duration.mjs", "tests/duration.test.mjs"]);
  assert.deepEqual(r.writes[0], { path: "src/duration.mjs", bytes: Buffer.byteLength(SRC), sha256: crypto.createHash("sha256").update(SRC).digest("hex") });
  assert.equal(r.rest, "npm test 2>&1 | tail -12; git status --short");
  assert.deepEqual(r.mkdirs, []);
  assert.ok(heredocWrites(`/bin/zsh -lc '${S3.replaceAll("'", "\"")}'`, dir, OPTS).ok);
  assert.equal(allowedByAssignment({ kind: "tool", tool: "Bash", summary: S3, detail: JSON.stringify({ command: S3 }) }, dir), null);
});

test("other header forms, mkdir -p and no rest", () => {
  const dir = project();
  const r = heredocWrites(`mkdir -p src/lib tests/unit\n${doc("cat <<\"EOF\" > src/lib/a.mjs")}${doc("cat>tests/unit/b.mjs<<'EOF'")}`, dir, OPTS);
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.mkdirs, ["src/lib", "tests/unit"]);
  assert.deepEqual(r.writes.map((w) => w.path), ["src/lib/a.mjs", "tests/unit/b.mjs"]);
  assert.equal(r.rest, null);
  assert.deepEqual(heredocWrites(doc("cat > c.test.mjs <<'EOF'"), dir, { cwd: path.join(dir, "tests") }).writes.map((w) => w.path), ["tests/c.test.mjs"]);
});

test("out of scope stops", () => {
  const dir = project();
  const outside = tmp();
  fs.writeFileSync(path.join(outside, "f.mjs"), "x");
  fs.writeFileSync(path.join(dir, "tests/duration.accept.test.mjs"), "x");
  fs.symlinkSync(path.join(outside, "f.mjs"), path.join(dir, "src/link.mjs"));
  const linked = project();
  fs.rmSync(path.join(linked, "src"), { recursive: true });
  fs.symlinkSync(outside, path.join(linked, "src"));
  const cases = {
    protected: doc("cat > tests/duration.accept.test.mjs <<'EOF'"), pkg: doc("cat > package.json <<'EOF'"), up: doc("cat > ../x <<'EOF'"),
    abs: doc("cat > /tmp/x <<'EOF'"), modules: doc("cat > node_modules/x <<'EOF'"), symlinkTarget: doc("cat > src/link.mjs <<'EOF'"),
    unquoted: doc("cat > src/a.mjs <<EOF"), append: doc("cat >> src/a.mjs <<'EOF'"), tee: doc("tee src/a.mjs <<'EOF'"),
    unclosed: "cat > src/a.mjs <<'EOF'\nx\n", cd: doc("cd src\ncat > a.mjs <<'EOF'"), cdInRest: doc("cat > src/a.mjs <<'EOF'", "cd tests && ls"),
    rm: doc("cat > src/a.mjs <<'EOF'", "rm -rf tests"), subst: doc("cat > src/a.mjs <<'EOF'", "cat $(echo x)"),
    curl: doc("cat > src/a.mjs <<'EOF'", "curl https://example.com"), push: doc("cat > src/a.mjs <<'EOF'", "git push"),
    trailing: doc("cat > src/a.mjs <<'EOF' && npm test"), none: "npm test", mkdirOut: `mkdir -p lib\n${doc("cat > src/a.mjs <<'EOF'")}`,
    cwdOut: [doc("cat > src/a.mjs <<'EOF'"), { cwd: "/tmp" }]
  };
  for (const [name, c] of Object.entries(cases)) {
    const [cmd, opts] = Array.isArray(c) ? c : [c, {}];
    const r = heredocWrites(cmd, dir, { ...OPTS, ...opts });
    assert.equal(r.ok, false, name);
    assert.ok(r.problems.length, name);
  }
  const s = heredocWrites(doc("cat > src/a.mjs <<'EOF'"), linked, OPTS);
  assert.equal(s.ok, false);
  assert.match(s.problems.join(), /symlink/);
  assert.match(heredocWrites(doc("cd src\ncat > a.mjs <<'EOF'"), dir).problems.join(), /cd changes where files are written/);
});

// a decision written by the "coordinator" once the pending file appears
const setup = () => { const d = tmp(); return { pendingDir: path.join(d, "pending"), decisionsDir: path.join(d, "decisions") }; };
const answerWith = (dirs, id, body) => async () => {
  if (fs.existsSync(path.join(dirs.pendingDir, `${id}.json`)) && !fs.existsSync(path.join(dirs.decisionsDir, `${id}.used.json`))) {
    fs.writeFileSync(path.join(dirs.decisionsDir, `${body.requestId ?? id}.json`), typeof body === "string" ? body : JSON.stringify(body));
  }
};
const clock = () => { let t = 0; return () => (t += 100); };
const wait = (dirs, extra) => awaitDecision({ request: { requestId: "r1", command: "x" }, ...dirs, stillPending: async () => true, deadline: 2000, decided: new Set(), now: clock(), ...extra });

test("allow_once: pending file written, decision used once, requestId recorded", async () => {
  const dirs = setup();
  const decided = new Set();
  const r = await wait(dirs, { decided, pause: answerWith(dirs, "r1", { requestId: "r1", decision: "allow_once", reason: "heredoc into src/tests" }) });
  assert.equal(r.decision, "allow_once");
  assert.equal(r.reason, "heredoc into src/tests");
  assert.equal(typeof r.waitedMs, "number");
  assert.ok(decided.has("r1"));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dirs.pendingDir, "r1.json"), "utf8")), { requestId: "r1", command: "x" });
  assert.ok(fs.existsSync(path.join(dirs.decisionsDir, "r1.used.json")));
  assert.ok(!fs.existsSync(path.join(dirs.decisionsDir, "r1.json")));
  // a second wait for the same id with a fresh set does not find the used file
  assert.equal((await wait(dirs, { pause: async () => {} })).decision, "timeout");
  // with the same set it is a repeat, nothing read or written
  const fresh = setup();
  assert.equal((await wait(fresh, { decided })).decision, "repeat");
  assert.ok(!fs.existsSync(fresh.pendingDir));
});

test("stop, invalid file, other requestId, stale", async () => {
  let dirs = setup();
  let r = await wait(dirs, { pause: answerWith(dirs, "r1", { requestId: "r1", decision: "stop", reason: "not planned" }) });
  assert.deepEqual([r.decision, r.reason], ["stop", "not planned"]);
  for (const bad of ["{", { requestId: "r1", decision: "allow_run", reason: "x" }, { requestId: "r1", decision: "allow_once", reason: " " }]) {
    dirs = setup();
    const decided = new Set();
    r = await wait(dirs, { decided, pause: answerWith(dirs, "r1", bad) });
    assert.equal(r.decision, "stop");
    assert.match(r.reason, /^invalid decision file/);
    assert.ok(!decided.has("r1"));
  }
  dirs = setup();
  fs.mkdirSync(dirs.decisionsDir, { recursive: true });
  fs.writeFileSync(path.join(dirs.decisionsDir, "r1.json"), JSON.stringify({ requestId: "r2", decision: "allow_once", reason: "x" }));
  assert.equal((await wait(dirs, { pause: async () => {} })).decision, "stop");
  dirs = setup();
  r = await wait(dirs, { pause: answerWith(dirs, "r1", { requestId: "r2", decision: "allow_once", reason: "x" }) });
  assert.equal(r.decision, "timeout");
  assert.ok(fs.existsSync(path.join(dirs.decisionsDir, "r2.json")));
  dirs = setup();
  let pending = true;
  r = await wait(dirs, { stillPending: async () => pending, pause: async () => { pending = false; } });
  assert.deepEqual([r.decision, r.reason], ["stale", "the request is no longer pending"]);
  dirs = setup();
  let calls = 0;
  const decided = new Set();
  r = await wait(dirs, { decided, stillPending: async () => ++calls < 3, pause: answerWith(dirs, "r1", { requestId: "r1", decision: "allow_once", reason: "x" }) });
  assert.equal(r.decision, "stale");
  assert.ok(!decided.has("r1"));
  assert.ok(fs.existsSync(path.join(dirs.decisionsDir, "r1.used.json")));
  await assert.rejects(wait(setup(), { request: { requestId: "../x" } }), /bad requestId/);
});

test("record comes back with the coordinator's timestamps; *.tmp and other files are not read", async () => {
  const dirs = setup();
  const record = { requestId: "r1", decision: "allow_once", reason: "planned heredoc", detectedAt: "2026-09-26T11:08:13.000Z", writtenAt: "2026-09-26T11:08:20.000Z" };
  let n = 0;
  const r = await wait(dirs, { pause: async () => {
    // first a half-written temp file and a stray name, the real file only on a later poll
    if (++n === 1) { fs.writeFileSync(path.join(dirs.decisionsDir, "r1.json.tmp"), "{"); fs.writeFileSync(path.join(dirs.decisionsDir, "r1.json.bak"), "{"); }
    if (n === 3) fs.writeFileSync(path.join(dirs.decisionsDir, "r1.json"), JSON.stringify(record));
  } });
  assert.equal(r.decision, "allow_once");
  assert.deepEqual(r.record, record);
  assert.ok(fs.existsSync(path.join(dirs.decisionsDir, "r1.json.tmp")));
  const stop = setup();
  const s = await wait(stop, { pause: answerWith(stop, "r1", { ...record, decision: "stop" }) });
  assert.deepEqual([s.decision, s.record.writtenAt], ["stop", record.writtenAt]);
});

test("a late decision is not applied", async () => {
  const late = { requestId: "r1", decision: "allow_once", reason: "late" };
  // (a) the deadline passed: timeout, a file written afterwards stays untouched
  let dirs = setup();
  let t = 0;
  let r = await wait(dirs, { now: () => (t += 100), deadline: 250, pause: async () => {} });
  assert.equal(r.decision, "timeout");
  fs.writeFileSync(path.join(dirs.decisionsDir, "r1.json"), JSON.stringify(late));
  assert.ok(fs.existsSync(path.join(dirs.decisionsDir, "r1.json")));
  assert.ok(!fs.existsSync(path.join(dirs.decisionsDir, "r1.used.json")));
  // (b) the request was withdrawn before the file appeared: stale, the later file is not applied
  dirs = setup();
  let pending = true;
  const decided = new Set();
  r = await wait(dirs, { decided, stillPending: async () => pending, pause: async () => { pending = false; } });
  assert.equal(r.decision, "stale");
  fs.writeFileSync(path.join(dirs.decisionsDir, "r1.json"), JSON.stringify(late));
  assert.ok(!decided.has("r1"));
  assert.ok(!fs.existsSync(path.join(dirs.decisionsDir, "r1.used.json")));
  assert.equal(r.record, undefined);
});
