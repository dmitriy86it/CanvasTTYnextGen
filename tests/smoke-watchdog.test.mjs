// The time limit of the smoke scripts (scripts/smoke-watchdog.mjs): a hung script reports where it was and what ran
// under it, kills that tree and exits with 124.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const HELPER = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "smoke-watchdog.mjs");
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("a hung script: last step, live processes, the app's last 50 lines, the tree killed, exit 124", { skip: process.platform === "win32" }, () => {
  const script = `
    import { spawn } from "node:child_process";
    import { step, watch } from ${JSON.stringify(HELPER)};
    const app = watch(spawn("/bin/sh", ["-c", "i=0; while [ $i -lt 80 ]; do i=$((i+1)); echo out-$i; echo err-$i >&2; done; exec /bin/sleep 60"], { stdio: ["ignore", "pipe", "pipe"] }), "fake app");
    console.log("pid", app.pid);
    step("wait: the run panel");
    await new Promise((r) => setTimeout(r, 120_000)); // hung`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", env: { ...process.env, SMOKE_TIMEOUT_MS: "1500" }, timeout: 60_000 });
  assert.equal(r.status, 124, r.stderr);
  const pid = Number(/pid (\d+)/.exec(r.stdout)[1]);
  assert.match(r.stderr, /time limit of 2 s reached/);
  assert.match(r.stderr, /last step: wait: the run panel/);
  assert.match(r.stderr, new RegExp(`live child processes \\(1\\):\\n  ${pid} <- \\d+  /bin/sleep 60`));
  assert.match(r.stderr, new RegExp(`fake app \\(pid ${pid}\\) stdout, last 50 lines:\\nout-31\\n[\\s\\S]*out-80\\n`));
  assert.doesNotMatch(r.stderr, /out-30\n/);
  assert.match(r.stderr, /stderr, last 50 lines:\nerr-31\n[\s\S]*err-80/);
  assert.equal(alive(pid), false, "the app was killed");
});

test("a script that finishes is not held by the limit", () => {
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", `import { step } from ${JSON.stringify(HELPER)}; step("x"); console.log("done");`],
    { encoding: "utf8", env: { ...process.env, SMOKE_TIMEOUT_MS: "60000" }, timeout: 20_000 });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "done\n");
});

// Hermetic smoke runs: a program the app starts outside the fakes and the allowed folders is named (the real check
// runs at the end of every kit smoke; here the folders are given so the temporary folder is not allowed).
test("checkProcesses names a program outside the allowed folders, and a script an interpreter runs from there", { skip: process.platform === "win32" }, async () => {
  const { checkProcesses } = await import(HELPER);
  const fs = await import("node:fs");
  const os = await import("node:os");
  const { spawn } = await import("node:child_process");
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "smoke-foreign-")));
  // a CLI installed as a shell script (a copy of a system binary would be killed by macOS code signing); a native
  // program found by its file is what the manual check of the real codex showed (docs TROUBLESHOOTING T134)
  fs.writeFileSync(path.join(dir, "codex"), "/bin/sleep 30\n", { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "agent.mjs"), "setTimeout(() => {}, 30_000);\n");
  const native = spawn("/bin/sh", [path.join(dir, "codex")], { stdio: "ignore" });
  const script = spawn(process.execPath, [path.join(dir, "agent.mjs")], { stdio: "ignore" });
  const system = spawn("/bin/sleep", ["30"], { stdio: "ignore" }); // allowed
  // an inline command line, a "/word" in it (a commit message): no script file — allowed (the sleep it starts is too)
  const inline = spawn("/bin/sh", ["-c", "echo 'fix /health: ok'; /bin/sleep 30"], { stdio: "ignore" });
  try {
    await new Promise((r) => setTimeout(r, 500));
    const roots = ["/bin/", "/usr/bin/", "/System/", "/usr/lib/", "/lib/", fs.realpathSync(process.execPath)];
    const found = checkProcesses(process.pid, roots);
    assert.deepEqual(found.map((f) => f.pid).sort(), [native.pid, script.pid].sort(), JSON.stringify(found));
    assert.equal(found.find((f) => f.pid === native.pid).program, path.join(dir, "codex"));
    assert.equal(found.find((f) => f.pid === script.pid).program, path.join(dir, "agent.mjs"));
    assert.deepEqual(checkProcesses(process.pid), [], "the default list allows the temporary folders and this node");
  } finally {
    for (const c of [native, script, system, inline]) c.kill("SIGKILL");
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// UX audit PR 3 (native-ui flake): only the app's descendants by ppid are judged, and a pid that ended and was taken
// by an unrelated process (a parallel `npm test`'s node) between the tree and lsof is not judged by the newcomer.
test("checkProcesses judges only the app's descendants, and never a reused pid by its new program", async () => {
  const { checkProcesses, descendants } = await import(HELPER);
  const START = "Tue Oct  7 14:03:01 2026";
  const rows = [
    { pid: 10, ppid: 1, start: START, command: "/app/Electron" },
    { pid: 11, ppid: 10, start: START, command: "/bin/sh -c node --test" },
    { pid: 12, ppid: 11, start: START, command: "node --test" }, // the app's own check
    { pid: 13, ppid: 10, start: START, command: "/tmp/codex-mock" },
    { pid: 20, ppid: 1, start: START, command: "node --test --test-concurrency=1 tests/a.test.mjs" } // npm test, not the app's
  ];
  assert.deepEqual(descendants(rows, 10).map((r) => r.pid), [11, 12, 13]);
  // paths that exist nowhere: the check resolves links (on Linux /bin/sh is /usr/bin/dash), these stay as they are
  const roots = ["/allowed/bin/", "/allowed/node"];
  const probe = (starts) => ({
    tree: (root) => descendants(rows, root),
    executables: () => new Map([[11, "/allowed/bin/sh"], [12, "/opt/homebrew/Cellar/node/26.8.1/bin/node"], [13, "/tmp/codex-mock"], [20, "/opt/homebrew/Cellar/node/26.8.1/bin/node"]]),
    startTimes: () => new Map([[11, START], [12, starts], [13, START], [20, START]])
  });
  // pid 12 is still the app's check: its foreign node is named; npm test's (pid 20) never is
  assert.deepEqual(checkProcesses(10, roots, new Set(), probe(START)).map((f) => f.pid), [12, 13]);
  // pid 12 ended and was reused before lsof (another start time): not judged, and looked at again next sample
  const seen = new Set();
  assert.deepEqual(checkProcesses(10, roots, seen, probe("Tue Oct  7 14:05:44 2026")).map((f) => f.pid), [13]);
  assert.equal(seen.has("12 node --test"), false);
});

// orchestration-ui flake: node-pty's spawn-helper starts a terminal card's shell and becomes it within a moment; a
// sample in that moment named it. The helper itself is allowed — not its folder.
test("checkProcesses allows node-pty's spawn-helper, the file only", async () => {
  const { checkProcesses, descendants } = await import(HELPER);
  const root = fs.realpathSync(path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
  // macOS only: node-pty has no spawn-helper on Linux; the watchdog keeps the path as written then
  const file = path.join(root, "node_modules/node-pty/build/Release/spawn-helper");
  const helper = fs.existsSync(file) ? fs.realpathSync(file) : file;
  const START = "Tue Oct  7 14:03:01 2026";
  const rows = [{ pid: 10, ppid: 1, start: START, command: "/app/Electron" }, { pid: 11, ppid: 10, start: START, command: `${helper} /home /bin/sh -l` },
    { pid: 12, ppid: 10, start: START, command: "other" }];
  const probe = { tree: (r) => descendants(rows, r), executables: () => new Map([[11, helper], [12, path.join(path.dirname(helper), "pty.node")]]),
    startTimes: () => new Map([[11, START], [12, START]]) };
  assert.deepEqual(checkProcesses(10, undefined, new Set(), probe).map((f) => f.pid), [12]);
});
