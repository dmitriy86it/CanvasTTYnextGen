// Р4 check sandbox (stage-4-contract.md §2, §3): the generated Seatbelt profile, what it allows and refuses, and the
// self-test that must run before any project command. Every restriction is checked twice and in this order: the
// positive control OUTSIDE the sandbox proves the resource exists and the operation works, then the same operation
// INSIDE must be refused. A refusal of something unreachable would prove nothing.
// Nothing outside the fixture is read or written: the fake home, the credential files and every marker live in one
// mkdtemp directory named canvastty-sandbox-*, and the real $HOME is never touched.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { SANDBOX_EXEC, buildProfile, runSelftest, sandboxSupport } from "../src/main/services/orchestration/sandbox.ts";
import {
  CREDENTIALS,
  ORCHESTRATION_DIR,
  PREFIX,
  READABLE_IN_HOME,
  env as minimalEnv,
  makeFixture,
  makeNeighbourRun,
  mkbase
} from "./fixtures/orchestration/sandbox-fixtures.mjs";
import { OwnPids, waitDead } from "./fixtures/orchestration/reaper-pids.mjs";

const darwin = process.platform === "darwin";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- sandboxSupport ----------

test("sandboxSupport accepts darwin only", () => {
  assert.deepEqual(sandboxSupport("linux"), { supported: false, reason: "sandbox_unavailable" });
  assert.deepEqual(sandboxSupport("win32"), { supported: false, reason: "sandbox_unavailable" });
  assert.deepEqual(sandboxSupport("freebsd"), { supported: false, reason: "sandbox_unavailable" });
  assert.equal(sandboxSupport("darwin").supported, fs.existsSync(SANDBOX_EXEC));
  assert.equal(sandboxSupport().supported, darwin && fs.existsSync(SANDBOX_EXEC));
});

// ---------- buildProfile ----------

// A minimal set of existing directories: buildProfile canonicalises every path, so they must be real.
function layout(base, repoName = "repo") {
  const dirs = {
    root: path.join(base, "root"),
    repo: path.join(base, "root", "runs", "r", "workspace", repoName),
    tmp: path.join(base, "root", "runs", "r", "checks", "c", "tmp"),
    home: path.join(base, "root", "runs", "r", "checks", "c", "home"),
    sourcePath: path.join(base, "src proj"),
    sourceGitDir: path.join(base, "src proj", ".git"),
    nodeModules: path.join(base, "src proj", "node_modules"),
    realHome: path.join(base, "home")
  };
  for (const p of Object.values(dirs)) fs.mkdirSync(p, { recursive: true });
  fs.mkdirSync(path.join(dirs.sourceGitDir, "objects"), { recursive: true });
  return dirs;
}

describe("buildProfile", () => {
  const base = mkbase();
  after(() => fs.rmSync(base, { recursive: true, force: true }));

  test("is deterministic, self-contained and canonical", () => {
    const paths = layout(base);
    const a = buildProfile(paths);
    const b = buildProfile(paths);
    assert.equal(a.text, b.text);
    assert.equal(a.sha256, b.sha256);
    assert.equal(a.sha256, createHash("sha256").update(a.text, "utf8").digest("hex"));
    // No -D parameters: every path is a literal in the text (contract §2).
    assert.ok(!a.text.includes("(param"), "the profile must not use -D parameters");
    assert.ok(!/\bstring-append\b/.test(a.text), "paths are substituted whole, not concatenated at run time");
    // Layout of §2: the copy is allowed by itself, never its parent.
    assert.ok(a.text.includes(`(subpath "${paths.repo}")`));
    assert.ok(!a.text.includes(`(subpath "${path.dirname(paths.repo)}")`), "workspace/ must never be allowed as a whole");
    for (const key of ["root", "tmp", "home", "sourcePath", "sourceGitDir", "nodeModules"]) {
      assert.ok(a.text.includes(`"${paths[key]}"`), `${key} must appear in the profile`);
    }
    assert.ok(a.text.includes(`(subpath "${path.join(paths.sourceGitDir, "objects")}")`), "the source objects are read-only");
    // The minimal profile grants no network, no Unix socket, no PTY and no localhost: none of the opt-in fragments
    // of the prototype exists here. Comments are stripped first — only the rules count.
    const rules = a.text.split("\n").filter((l) => !l.trimStart().startsWith(";")).join("\n");
    assert.ok(!/network|mach-lookup|ptmx|ttys|localhost/.test(rules), rules);
  });

  test("keeps the deny-before-allow order Seatbelt depends on", () => {
    const paths = layout(base, "repo2");
    const { text } = buildProfile(paths);
    const at = (needle) => {
      const i = text.indexOf(needle);
      assert.notEqual(i, -1, `${needle} is missing`);
      return i;
    };
    assert.ok(at("(deny default)") < at("(allow file-read*)"));
    assert.ok(at(`(deny file-read* file-write* (subpath "${paths.root}")`) < at(`(allow file-read* file-write* (subpath "${paths.repo}")`));
    assert.ok(at(`(subpath "${paths.root}")`) < at(`(path-ancestors "${paths.repo}")`), "metadata of the parents is re-allowed after the deny");
    assert.ok(at(`(subpath "${paths.sourcePath}")`) < at(`(allow file-read* (subpath "${paths.nodeModules}")`));
    for (const p of [paths.repo, paths.tmp, paths.home, paths.nodeModules, path.join(paths.sourceGitDir, "objects")]) {
      assert.ok(text.includes(`(path-ancestors "${p}")`), `path-ancestors of ${p} is required for cd, realpath and alternates`);
    }
  });

  test("escapes quotes and backslashes and refuses what cannot be written as a literal", () => {
    const odd = path.join(base, 'we"ird\\name');
    fs.mkdirSync(odd, { recursive: true });
    const paths = { ...layout(base, "repo3"), repo: odd };
    const { text } = buildProfile(paths);
    assert.ok(text.includes(`(subpath "${base}/we\\"ird\\\\name")`), text);

    const newline = path.join(base, "line\nbreak");
    fs.mkdirSync(newline, { recursive: true });
    assert.throws(() => buildProfile({ ...paths, repo: newline }), /control characters/);
    assert.throws(() => buildProfile({ ...paths, repo: "relative/path" }), /must be an absolute path/);
    assert.throws(() => buildProfile({ ...paths, repo: path.join(base, "missing") }), /does not resolve/);
    assert.throws(() => buildProfile(null), /paths must be an object/);
  });

  test("substitutes the resolved path, not the symlink it was given", () => {
    const paths = layout(base, "repo4");
    const link = path.join(base, "link-to-repo");
    fs.symlinkSync(paths.repo, link);
    const { text } = buildProfile({ ...paths, repo: link });
    assert.ok(text.includes(`(subpath "${paths.repo}")`));
    assert.ok(!text.includes(link), "a symlink would let the rule be bypassed through the real path");
  });
});

// ---------- runSelftest: refusals that need no sandbox ----------

test("runSelftest refuses without a probe next to the supervisor", async () => {
  const r = await runSelftest({
    dir: os.tmpdir(), ws: { dir: os.tmpdir(), control: os.tmpdir(), tmp: os.tmpdir() },
    launch: { command: process.execPath, args: [path.join(os.tmpdir(), "no-supervisor.mjs")], env: {} },
    paths: {}
  });
  assert.equal(r.passed, false);
  assert.equal(r.checks, 0);
  assert.match(r.failed[0].name, /^sandbox\./);
  assert.ok(!JSON.stringify(r).includes("unsandboxed"), "there is no fallback to an unsandboxed run");
});

// ---------- the live profile ----------

describe("the generated profile on macOS", { skip: darwin ? false : "Seatbelt is macOS only" }, () => {
  let fx;
  let profilePath;
  let tcp;
  let uds;
  let port;
  let sockPath;
  let neighbourRun;
  let neighbourCheck;
  const trash = [];

  before(async () => {
    fx = await makeFixture();
    profilePath = path.join(fx.checkDir, "profile.sb");
    fs.writeFileSync(profilePath, buildProfile(fx.paths).text);
    neighbourRun = makeNeighbourRun(fx.paths.root);
    neighbourCheck = path.join(fx.runDir, "checks", `${PREFIX}other`);
    fs.mkdirSync(neighbourCheck, { recursive: true });
    fs.writeFileSync(path.join(neighbourCheck, "marker.txt"), "other check\n");
    fs.writeFileSync(path.join(fx.paths.repo, "in.txt"), "in the copy\n");

    // Listeners outside the sandbox. The kernel completes a connection from the backlog, so they answer the control
    // probe even while spawnSync blocks this process's event loop.
    const quiet = (c) => { c.on("error", () => {}); c.end("ok"); };
    tcp = net.createServer(quiet).on("error", () => {});
    await new Promise((res, rej) => { tcp.once("error", rej); tcp.listen({ host: "127.0.0.1", port: 0 }, res); });
    tcp.unref();
    port = tcp.address().port;
    sockPath = path.join(fx.base, "probe.sock");
    uds = net.createServer(quiet).on("error", () => {});
    await new Promise((res, rej) => { uds.once("error", rej); uds.listen(sockPath, res); });
    uds.unref();
  });

  after(async () => {
    tcp?.close();
    uds?.close();
    for (const p of trash) fs.rmSync(p, { recursive: true, force: true });
    await fx?.cleanup();
  });

  const run = (cmd, args, extra) => spawnSync(cmd, args, {
    cwd: fx.paths.repo, env: minimalEnv(fx.paths, extra), encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"]
  });
  const outside = (argv, extra) => run(argv[0], argv.slice(1), extra);
  const inside = (argv, extra) => run(SANDBOX_EXEC, ["-f", profilePath, ...argv], extra);
  const node = (code) => [process.execPath, "-e", code];

  // The positive control first, then the same argv and the same environment under the profile.
  function probe(name, expect, argv, extra) {
    const control = outside(argv, extra);
    assert.equal(control.status, 0, `control ${name} must pass outside the sandbox: ${control.stderr || control.stdout}`);
    const got = inside(argv, extra);
    if (expect === "allow") assert.equal(got.status, 0, `${name} must be allowed inside: ${got.stderr || got.stdout}`);
    else assert.notEqual(got.status, 0, `${name} must be refused inside, but it succeeded: ${got.stdout}`);
  }

  const writeOp = node('require("fs").writeFileSync(process.env.T, "x")');
  const readOp = node('require("fs").readFileSync(process.env.T)');
  const listOp = node('if (require("fs").readdirSync(process.env.T).length === 0) process.exit(3)');
  const mark = (base, tag) => {
    const p = path.join(base, `${PREFIX}${tag}`);
    trash.push(p);
    return p;
  };

  test("allows the copy, its .git, the check TMPDIR and HOME", () => {
    probe("write-repo", "allow", writeOp, { T: mark(fx.paths.repo, "repo") });
    probe("read-repo", "allow", readOp, { T: path.join(fx.paths.repo, "in.txt") });
    probe("write-repo-git", "allow", writeOp, { T: mark(path.join(fx.paths.repo, ".git"), "copygit") });
    probe("readdir-repo-git", "allow", listOp, { T: path.join(fx.paths.repo, ".git") });
    probe("write-check-tmp", "allow", writeOp, { T: mark(fx.paths.tmp, "tmp") });
    probe("write-check-home", "allow", writeOp, { T: mark(fx.paths.home, "home") });
  });

  test("allows read-only dependencies and source objects, and the tools that need them", () => {
    probe("readdir-node-modules", "allow", listOp, { T: fx.paths.nodeModules });
    probe("readdir-source-objects", "allow", listOp, { T: path.join(fx.paths.sourceGitDir, "objects") });
    // git in the copy resolves its alternates into the source objects and needs metadata of every parent.
    probe("git-log-shared-clone", "allow", ["/usr/bin/git", "log", "-1", "--format=%H"]);
    probe("cd-and-realpath", "allow", ["/bin/sh", "-c", 'cd "$0" && pwd -P >/dev/null', fx.paths.repo]);
    // node_modules is a symlink from the copy into the read-only source tree.
    probe("require-dependency", "allow", node('if (require("dep-a") !== "b-a") process.exit(3)'));
  });

  test("refuses the control data of this run", () => {
    probe("read-workspace-json", "deny", readOp, { T: path.join(fx.ws.dir, "workspace.json") });
    probe("write-workspace-dir", "deny", writeOp, { T: mark(fx.ws.dir, "restore.json") });
    probe("read-control-git", "deny", readOp, { T: path.join(fx.ws.control, "config") });
    probe("write-control-git", "deny", writeOp, { T: mark(fx.ws.control, "ctl") });
    probe("readdir-workspace-tmp", "deny", listOp, { T: fx.ws.tmp });
    probe("write-workspace-tmp", "deny", writeOp, { T: mark(fx.ws.tmp, "wstmp") });
    probe("read-journal", "deny", readOp, { T: path.join(fx.runDir, "journal.jsonl") });
    probe("write-journal", "deny", node('require("fs").appendFileSync(process.env.T, "")'), { T: path.join(fx.runDir, "journal.jsonl") });
    probe("readdir-texts", "deny", listOp, { T: path.join(fx.runDir, "texts") });
    probe("write-texts", "deny", writeOp, { T: mark(path.join(fx.runDir, "texts"), "text") });
    probe("readdir-locks", "deny", listOp, { T: path.join(fx.runDir, "locks") });
    probe("write-locks", "deny", writeOp, { T: mark(path.join(fx.runDir, "locks"), "lock") });
    probe("readdir-root", "deny", listOp, { T: fx.paths.root });
  });

  test("refuses a neighbouring check and a neighbouring run", () => {
    probe("read-other-check", "deny", readOp, { T: path.join(neighbourCheck, "marker.txt") });
    probe("write-other-check", "deny", writeOp, { T: mark(neighbourCheck, "oc") });
    probe("read-other-run", "deny", readOp, { T: path.join(neighbourRun, "marker.txt") });
    probe("write-other-run", "deny", writeOp, { T: mark(neighbourRun, "or") });
    probe("readdir-other-run-workspace", "deny", listOp, { T: path.join(neighbourRun) });
  });

  test("refuses the source working tree while its dependencies stay readable", () => {
    probe("readdir-source-tree", "deny", listOp, { T: fx.paths.sourcePath });
    probe("read-source-file", "deny", readOp, { T: path.join(fx.paths.sourcePath, "src", "app.js") });
    probe("read-source-git-config", "deny", readOp, { T: path.join(fx.paths.sourceGitDir, "config") });
    probe("write-source-tree", "deny", writeOp, { T: mark(fx.paths.sourcePath, "srcw") });
  });

  test("refuses writing anywhere else, and the credential stores of the home it was given", () => {
    probe("write-user-tmpdir", "deny", writeOp, { T: mark(fs.realpathSync(os.tmpdir()), "utmp") });
    probe("write-fake-home", "deny", writeOp, { T: mark(fx.home, "hw") });
    for (const rel of CREDENTIALS) probe(`read-home-${rel}`, "deny", readOp, { T: path.join(fx.home, rel) });
    // Honest limitation, asserted rather than hidden: the rest of the home stays readable (contract §2).
    probe("read-home-other-file", "allow", readOp, { T: path.join(fx.home, READABLE_IN_HOME) });
    probe("read-etc-hosts", "allow", readOp, { T: "/etc/hosts" });
  });

  test("refuses the network, Unix sockets and PTYs", (t) => {
    const connect = node('const s=require("net").connect({host:process.env.H,port:+process.env.P});'
      + 's.on("connect",()=>{s.destroy();process.exit(0)});s.on("error",()=>process.exit(3));setTimeout(()=>process.exit(4),4000)');
    probe("tcp-localhost", "deny", connect, { H: "127.0.0.1", P: String(port) });
    probe("tcp-listen", "deny", node('const s=require("net").createServer();s.on("error",()=>process.exit(3));'
      + 's.listen({host:"127.0.0.1",port:0},()=>s.close(()=>process.exit(0)));setTimeout(()=>process.exit(4),4000)'));
    probe("unix-connect", "deny", node('const s=require("net").connect(process.env.T);'
      + 's.on("connect",()=>{s.destroy();process.exit(0)});s.on("error",()=>process.exit(3));setTimeout(()=>process.exit(4),4000)'),
    { T: sockPath });
    // A Unix socket path is limited to ~104 bytes, far less than a run directory, so the bind is relative to TMPDIR.
    trash.push(path.join(fx.paths.tmp, "s.sock"));
    probe("unix-listen-in-tmpdir", "deny", node('const fs=require("fs");process.chdir(process.env.T);'
      + 'const s=require("net").createServer();s.on("error",()=>process.exit(3));'
      + 's.listen("./s.sock",()=>s.close(()=>{fs.rmSync("./s.sock",{force:true});process.exit(0)}));'
      + 'setTimeout(()=>process.exit(4),4000)'), { T: fx.paths.tmp });
    probe("open-ptmx", "deny", node('const fs=require("fs");fs.closeSync(fs.openSync("/dev/ptmx","r+"))'));

    const dnsOp = node('require("dns").lookup(process.env.T,(e)=>process.exit(e?3:0));setTimeout(()=>process.exit(4),4000)');
    if (outside(dnsOp, { T: "example.com" }).status !== 0) t.diagnostic("DNS check skipped: no resolver outside the sandbox");
    else probe("dns-lookup", "deny", dnsOp, { T: "example.com" });
  });

  test("signals reach the sandbox instance only: this process is refused, an own child is not", () => {
    probe("signal-outside", "deny", node(`process.kill(${process.pid}, 0)`));
    probe("signal-own-child", "allow", node('const c = require("child_process").spawn("/bin/sleep", ["30"]); process.kill(c.pid, 0); c.kill("SIGKILL")'));
  });

  // The whole mechanism under the real profile: the supervisor runs inside it with the sweep on, the target leaves a
  // setsid /bin/sh -> /bin/sleep escapee, and the supervisor's scan must kill it before `done`.
  test("the check supervisor inside the profile kills a setsid escapee before done", async (t) => {
    const pids = new OwnPids();
    const escFile = mark(fx.paths.tmp, "reaper-esc.pid");
    try {
      const sup = spawn(SANDBOX_EXEC, ["-f", profilePath, "--", process.execPath, path.join(ORCHESTRATION_DIR, "supervisor.mjs"),
        process.execPath, path.join(ORCHESTRATION_DIR, "../../tests/fixtures/orchestration/reaper-escapee.mjs"), escFile], {
        cwd: fx.paths.repo, stdio: ["pipe", "ignore", "pipe", "pipe", "pipe"],
        env: minimalEnv(fx.paths, { ELECTRON_RUN_AS_NODE: "1", SUP_ENV_ALLOW: "PATH,HOME,TMPDIR", SUP_SANDBOX_SWEEP: "1", SUP_LEFTOVER_MS: "300" })
      });
      pids.track(sup.pid, "supervisor.mjs");
      let status = "", stderr = "";
      sup.stdio[3].setEncoding("utf8").on("data", (d) => { status += d; });
      sup.stderr.setEncoding("utf8").on("data", (d) => { stderr += d; });
      sup.stdio[4].end();
      const code = await new Promise((r) => sup.on("close", r));
      if (fs.existsSync(escFile)) pids.track(Number(fs.readFileSync(escFile, "utf8")), "/bin/sleep");
      const done = status.split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((m) => m.ev === "done");
      t.diagnostic(`exit=${code} sandbox=${JSON.stringify(done?.sandbox)} stderr=${stderr.slice(0, 300)}`);
      assert.equal(code, 0);
      assert.equal(done.leaderExit.code, 0);
      assert.equal(done.sandbox.cleared, true, JSON.stringify(done.sandbox));
      assert.ok(done.sandbox.killed >= 1);
      const esc = Number(fs.readFileSync(escFile, "utf8"));
      assert.equal(await waitDead(esc, 0), true, "the escapee is dead when done is written");
    } finally {
      await pids.cleanup();
    }
  });

  test("a detached descendant that outlives the process group keeps the restrictions", async () => {
    const script = 'require("child_process").spawn("/bin/sh",["-c",'
      + '\'sleep 1; { cat "$0" >/dev/null 2>&1 && echo READ-OK || echo READ-DENIED; : > "$1" 2>/dev/null && echo WRITE-OK || echo WRITE-DENIED; }'
      + ' > "$2"\', process.env.DENY, process.env.DENYW, process.env.OUT], {detached:true, stdio:"ignore"}).unref()';
    const wait = async (out) => {
      for (let i = 0; i < 100 && !(fs.existsSync(out) && fs.readFileSync(out, "utf8").includes("WRITE-")); i++) await sleep(100);
      return fs.readFileSync(out, "utf8");
    };
    const deny = path.join(fx.ws.dir, "workspace.json");
    const env = (tag) => ({ DENY: deny, DENYW: mark(fx.ws.dir, `det-${tag}`), OUT: mark(fx.paths.tmp, `det-${tag}.txt`) });

    const controlEnv = env("control");
    assert.equal(outside(node(script), controlEnv).status, 0);
    const control = await wait(controlEnv.OUT);
    assert.match(control, /READ-OK/);
    assert.match(control, /WRITE-OK/);

    const sandboxEnv = env("sandbox");
    assert.equal(inside(node(script), sandboxEnv).status, 0);
    const sandboxed = await wait(sandboxEnv.OUT);
    assert.match(sandboxed, /READ-DENIED/);
    assert.match(sandboxed, /WRITE-DENIED/);
  });
});

// ---------- the self-test itself ----------

describe("runSelftest on the real layout", { skip: darwin ? false : "Seatbelt is macOS only" }, () => {
  let fx;
  before(async () => { fx = await makeFixture(); });
  after(async () => { await fx?.cleanup(); });

  test("passes, leaves nothing behind and uses the profile buildProfile generates", async (t) => {
    const before = new Set(fs.readdirSync(fx.paths.repo));
    // A private temporary directory: other test files run sandboxed checks in parallel and leave their own
    // canvastty-sandbox-* entries in the shared one while they run. Short: the probe socket path is limited to 104 bytes.
    const savedTmp = process.env.TMPDIR;
    const systemTmp = fs.realpathSync(fs.mkdtempSync("/tmp/cst-"));
    process.env.TMPDIR = systemTmp;
    t.after(() => { process.env.TMPDIR = savedTmp; fs.rmSync(systemTmp, { recursive: true, force: true }); });
    assert.equal(fs.realpathSync(os.tmpdir()), systemTmp);
    const tmpBefore = new Set(fs.readdirSync(systemTmp));
    const result = await runSelftest({ dir: fx.checkDir, ws: fx.ws, launch: fx.launch, paths: fx.paths });
    assert.deepEqual(result.failed, [], JSON.stringify(result.failed, null, 2));
    assert.equal(result.passed, true);
    t.diagnostic(`runSelftest judged ${result.checks} sandboxed checks, each against a control outside`);
    assert.ok(result.checks >= 49, `expected the whole mandatory set, got ${result.checks} checks`);

    const used = fs.readFileSync(path.join(fx.checkDir, "selftest-profile.sb"), "utf8");
    assert.equal(used, buildProfile(fx.paths).text);

    // The copy must be exactly as it was: treeBefore is taken before the self-test and compared after the check.
    assert.deepEqual([...new Set(fs.readdirSync(fx.paths.repo))].sort(), [...before].sort());
    for (const dir of [fx.ws.dir, fx.ws.control, fx.ws.tmp, fx.runDir, path.join(fx.runDir, "texts"), path.join(fx.runDir, "locks"),
      path.join(fx.runDir, "checks"), path.join(fx.paths.root, "runs")]) {
      const left = fs.readdirSync(dir).filter((n) => n.startsWith(PREFIX));
      assert.deepEqual(left, [], `${dir} still holds ${left.join(", ")}`);
    }
    // Nothing of ours stays in the shared temporary directory either; whatever else lives there is not touched.
    assert.deepEqual(fs.readdirSync(systemTmp).filter((n) => n.startsWith(PREFIX) && !tmpBefore.has(n)), []);
    assert.deepEqual(fs.readdirSync(path.join(fx.runDir, "checks")), [fx.checkRunId]);
    assert.equal(fs.existsSync(path.join(fx.ws.dir, "restore.json")), false, "no restore intent was fabricated");
  });

  test("fails instead of passing when a positive control cannot be established", async () => {
    // An empty node_modules makes the "dependencies are readable" control unprovable: the answer is a failure,
    // never a pass and never a run without the sandbox.
    const empty = path.join(fx.base, "empty_modules");
    fs.mkdirSync(empty, { recursive: true });
    const result = await runSelftest({ dir: fx.checkDir, ws: fx.ws, launch: fx.launch, paths: { ...fx.paths, nodeModules: empty } });
    assert.equal(result.passed, false);
    assert.ok(result.failed.some((f) => f.name === "control.allow.readdir-node-modules"), JSON.stringify(result.failed));
  });

  test("catches a profile that does not cover the run instead of reporting a pass", async () => {
    // The same self-test, with the deny aimed at an unrelated directory: the control data of the run becomes
    // reachable from inside, and every check that must be refused has to be reported as a failure.
    const elsewhere = path.join(fx.base, "not_the_root");
    fs.mkdirSync(elsewhere, { recursive: true });
    const result = await runSelftest({ dir: fx.checkDir, ws: fx.ws, launch: fx.launch, paths: { ...fx.paths, root: elsewhere } });
    assert.equal(result.passed, false);
    // Only the reads: writing outside the three allowed subpaths stays refused by (deny default) in any case, which
    // is why the deny of <root> and of the source project is what the reads depend on.
    const names = result.failed.map((f) => f.name);
    for (const name of ["deny.read-workspace-json", "deny.read-journal", "deny.readdir-texts", "deny.read-control-git",
      "deny.readdir-workspace-tmp", "deny.read-other-check", "child.deny.read-workspace-json", "detach.deny.read-workspace-json"]) {
      assert.ok(names.includes(name), `${name} must be reported; got ${names.join(", ")}`);
    }
    assert.ok(result.failed.every((f) => f.detail.length > 0));
  });

  test("the probe ships next to the supervisor", () => {
    assert.ok(fs.existsSync(path.join(ORCHESTRATION_DIR, "sandbox-probe.mjs")));
    assert.ok(fs.existsSync(path.join(ORCHESTRATION_DIR, "supervisor.mjs")));
  });
});
