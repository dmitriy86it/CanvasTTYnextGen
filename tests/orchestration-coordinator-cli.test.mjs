// The series coordinator's short calls (scripts/coordinator.mjs): poll finds a request with no decision and logs it once,
// decide writes the decision atomically and refuses what it must not write.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { decide, poll } from "../scripts/coordinator.mjs";

const temps = [];
after(() => { for (const d of temps) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "cto-coord-")); temps.push(d); return d; };
const COMMAND = `cat > src/a.mjs <<'EOF'\n${"x".repeat(3000)}\nEOF`;
const pending = (out, requestId, extra = {}) => {
  fs.mkdirSync(path.join(out, "pending"), { recursive: true });
  fs.writeFileSync(path.join(out, "pending", `${requestId}.json`), JSON.stringify({ requestId, scenario: "S3", askedAt: "2026-09-26T10:00:00.000Z", cwd: "/p", projectDir: "/p",
    protectedFiles: ["tests/a.accept.mjs"], writableDirs: ["src", "tests"], command: COMMAND, precheck: { ok: true }, ...extra }));
};
const logOf = (out) => fs.readFileSync(path.join(out, "coordinator-log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const CLI = path.resolve("scripts/coordinator.mjs");

test("poll finds a request written while it waits and logs detected once", async () => {
  const out = tmp();
  setTimeout(() => pending(out, "req-1"), 300);
  const t = Date.now();
  const r = await poll(out, { wait: 5 });
  assert.ok(Date.now() - t < 2000, "returns as soon as the request appears");
  assert.deepEqual(r.unresolved.map((q) => q.requestId), ["req-1"]);
  assert.equal(r.unresolved[0].command, COMMAND);
  const first = r.unresolved[0].detectedAt;
  const again = await poll(out, { wait: 0 });
  assert.equal(again.unresolved[0].detectedAt, first);
  assert.deepEqual(logOf(out), [{ event: "detected", requestId: "req-1", at: first, askedAt: "2026-09-26T10:00:00.000Z" }]);
  assert.equal(r.driverAlive, false);
});

test("decided and used requests are not unresolved; applied is read from the driver log", async () => {
  const out = tmp(), log = path.join(out, "driver.log");
  for (const id of ["a", "b", "c"]) pending(out, id);
  fs.mkdirSync(path.join(out, "decisions"));
  fs.writeFileSync(path.join(out, "decisions", "a.json"), "{}");
  fs.writeFileSync(path.join(out, "decisions", "b.used.json"), "{}");
  fs.writeFileSync(log, Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n") + "\nS3: applied b\n");
  const r = await poll(out, { wait: 0, log });
  assert.deepEqual(r.unresolved.map((q) => q.requestId), ["c"]);
  assert.deepEqual(r.resolved.sort((x, y) => x.requestId.localeCompare(y.requestId)), [{ requestId: "a", applied: false }, { requestId: "b", applied: true }]);
  assert.deepEqual(r.logTail, ["line 5", "line 6", "line 7", "line 8", "line 9", "S3: applied b"]);
});

test("poll with no requests returns within wait + 1 s", async () => {
  const out = tmp(), t = Date.now();
  const r = await poll(out, { wait: 1 });
  assert.ok(Date.now() - t <= 2000);
  assert.deepEqual(r.unresolved, []);
  assert.ok(!fs.existsSync(path.join(out, "coordinator-log.jsonl")));
});

test("decide writes atomically with detectedAt and writtenAt, then refuses a second decision", async () => {
  const out = tmp();
  pending(out, "req-2");
  const detectedAt = (await poll(out, { wait: 0 })).unresolved[0].detectedAt;
  const r = decide(out, "req-2", "allow_once", "heredoc into src only");
  assert.equal(r.ok, true);
  assert.deepEqual(fs.readdirSync(path.join(out, "decisions")), ["req-2.json"]);
  const d = JSON.parse(fs.readFileSync(path.join(out, "decisions", "req-2.json"), "utf8"));
  assert.deepEqual({ ...d, writtenAt: "-" }, { requestId: "req-2", decision: "allow_once", reason: "heredoc into src only", detectedAt, writtenAt: "-" });
  assert.ok(!Number.isNaN(Date.parse(d.writtenAt)));
  assert.deepEqual(logOf(out).map((e) => e.event), ["detected", "decided"]);
  assert.match(decide(out, "req-2", "stop", "again").error, /already decided/);
  fs.renameSync(path.join(out, "decisions", "req-2.json"), path.join(out, "decisions", "req-2.used.json"));
  assert.match(decide(out, "req-2", "stop", "again").error, /already decided/);
  assert.equal((await poll(out, { wait: 0 })).unresolved.length, 0);
});

test("decide refuses a missing request, an empty reason, a bad id or decision, and writes nothing", () => {
  const out = tmp();
  pending(out, "req-3");
  assert.match(decide(out, "nope", "stop", "r").error, /no pending/);
  assert.match(decide(out, "req-3", "stop", "  ").error, /empty reason/);
  assert.match(decide(out, "../x", "stop", "r").error, /bad request id/);
  assert.match(decide(out, "req-3", "allow", "r").error, /allow_once or stop/);
  assert.ok(!fs.existsSync(path.join(out, "decisions")));
  assert.equal(decide(out, "req-3", "stop", "detectedAt unknown").ok, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(out, "decisions", "req-3.json"), "utf8")).detectedAt, null);
});

test("the CLI: poll prints the full command, decide exits 2 on refusal", () => {
  const out = tmp();
  pending(out, "req-4");
  const text = execFileSync(process.execPath, [CLI, "poll", out, "--wait", "0"], { encoding: "utf8" });
  assert.ok(text.includes(`command:\n${COMMAND}\n--- end of command`));
  assert.match(text, /driver: not running/);
  assert.equal(execFileSync(process.execPath, [CLI, "decide", out, "req-4", "stop", "outside", "the", "task"], { encoding: "utf8" }).startsWith("written"), true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(out, "decisions", "req-4.json"), "utf8")).reason, "outside the task");
  for (const args of [["decide", out, "req-4", "stop", "again"], ["poll"], ["poll", out, "--wait", "x"]]) {
    assert.throws(() => execFileSync(process.execPath, [CLI, ...args], { stdio: "ignore" }), (e) => e.status === 2);
  }
});
