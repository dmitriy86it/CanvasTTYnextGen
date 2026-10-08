// The CLIs' capabilities, probed without a model call instead of compared with a list of versions: a new version with
// the same switches and protocol is ready without a warning; a changed --help or protocol is named; what would refuse
// the start is a blocker of the readiness first (one rule, startProblems); a CLI without the project's rights mode can
// run «as in my terminal» for one run, the project settings untouched. Fake CLIs (MOCK_CLAUDE_HELP, MOCK_CLAUDE_SANDBOX,
// MOCK_CODEX_SCHEMA) and local repositories only.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { createCapabilityCache } from "../src/main/services/orchestration/capabilities.ts";
import { findGit } from "../src/main/services/orchestration/git.ts";
import { createRunManager, testNativeRuntime } from "../src/main/services/orchestration/manager.ts";
import { createProfileStore, suggestProfile } from "../src/main/services/orchestration/profile.ts";
import { readRun, readText } from "../src/main/services/orchestration/store.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GIT = findGit(process.env);
const NODE = fs.realpathSync(process.execPath);
const LAUNCH = { command: NODE, args: [path.join(HERE, "..", "src", "orchestration", "supervisor.mjs")], env: {} };
const OPTS = { skip: process.platform === "win32" && "orchestration runs on macOS and Linux", timeout: 120_000 };
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "canvastty-caps-")));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
fs.writeFileSync(path.join(TMP, "gitconfig"), "");
const GIT_ENV = { PATH: `/usr/bin:/bin:${path.dirname(GIT)}`, HOME: TMP, GIT_CONFIG_GLOBAL: path.join(TMP, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const g = (cwd, ...args) => execFileSync(GIT, args, { cwd, encoding: "utf8", env: GIT_ENV });
const SHELL = path.join(TMP, "test-shell");
fs.writeFileSync(SHELL, `#!/bin/sh\ncase "$1" in -ilc|-c) shift ;; esac\nexec /bin/sh -c "$1"\n`, { mode: 0o755 });
let n = 0;
function project() {
  const dir = path.join(TMP, `project-${++n}`);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "a.txt"), "1\n");
  for (const a of [["init", "-q", "-b", "main"], ["add", "-A"], ["commit", "-q", "-m", "init"]]) g(dir, ...a);
  return dir;
}
function wrapper(name, mock) {
  const f = path.join(TMP, `${name}-${++n}`);
  fs.writeFileSync(f, `#!/bin/sh\nexec "${NODE}" "${path.join(HERE, "fixtures", "orchestration", mock)}" "$@"\n`, { mode: 0o755 });
  return f;
}
// a manager whose fake CLIs report these versions and behave as `env` says (help, protocol schema, sandbox)
function manager(env = {}, versions = {}) {
  const state = fs.mkdtempSync(path.join(TMP, "state-"));
  const file = path.join(TMP, `providers-${++n}.json`);
  const p = { path: `${TMP}:/usr/bin:/bin`, env: { HOME: TMP, MOCK_STATE: state, ...env } };
  fs.writeFileSync(file, JSON.stringify({
    codex: { executable: wrapper("codex", "mock-codex.mjs"), version: versions.codex ?? "codex-cli 0.155.1", ...p },
    claude: { executable: wrapper("claude", "mock-claude.mjs"), version: versions.claude ?? "2.1.281 (Claude Code)", ...p },
    shell: SHELL, checkEnv: { ...GIT_ENV, MOCK_STATE: state, ...env }
  }));
  const root = path.join(TMP, `root-${++n}`);
  const m = createRunManager({
    platform: "darwin", root, gitPath: () => GIT, launch: () => LAUNCH, nodePath: () => NODE, stopGraceMs: 2000, journalV2: true,
    agents: async () => { throw new Error("not used"); }, native: testNativeRuntime(file, () => LAUNCH), workspaceKnown: () => true
  });
  return Object.assign(m, { root, state });
}
async function linkOf(m, src, access = { claude: "workspace", codex: "workspace" }) {
  await createProfileStore(m.root).save(src, { ...(await suggestProfile(src)), access, checks: ["grep -qx 1 a.txt"] });
  const at = (x) => ({ position: { x, y: 0 }, size: { width: 300, height: 200 } });
  const [lead, exec, linkId] = [randomUUID(), randomUUID(), randomUUID()];
  assert.ok((await m.createAgent({ agentId: lead, provider: "codex", project: src, bounds: at(0) })).ok);
  assert.ok((await m.createAgent({ agentId: exec, provider: "claude", project: src, bounds: at(400) })).ok);
  assert.ok((await m.createLink({ linkId, fromAgentId: lead, toAgentId: exec })).ok);
  return linkId;
}
const ready = (m, linkId, extra = {}) => m.readiness({ linkId, commands: ["grep -qx 1 a.txt"], workMode: "project", ...extra });
const create = (m, src, goal = {}) => m.create({ requestId: randomUUID(), source: src,
  goal: { text: "keep a", criteria: ["a.txt says 1"], checks: [], mode: "autopilot", commands: ["grep -qx 1 a.txt"], workMode: "project", ...goal } });
const byId = (r) => Object.fromEntries(r.value.items.map((i) => [i.id, i]));

test("a new version with the same switches and protocol: ready, no «not compared» warning, every rights mode offered", OPTS, async () => {
  const m = manager({}, { codex: "codex-cli 0.199.0", claude: "2.1.999 (Claude Code)" });
  try {
    const src = project();
    const r = await ready(m, await linkOf(m, src));
    assert.ok(r.ok, JSON.stringify(r));
    const it = byId(r);
    assert.equal(it.clis.level, "ok", it.clis.detail);
    assert.ok(!it.access_codex && !it.access_claude);
    assert.equal(r.value.ready, true);
    const info = await m.profile((await m.canvas()).value.links[0].linkId, true);
    assert.deepEqual(info.value.capabilities.codex.map((x) => x.mode), ["terminal", "workspace", "full"]);
    assert.ok(info.value.capabilities.claude.map((x) => x.mode).includes("workspace"));
  } finally { await m.shutdown?.(); }
});

test("a changed --help or protocol: named in a warning, or a blocker naming the CLI, its version and what is missing", OPTS, async () => {
  const cases = [
    { env: { MOCK_CLAUDE_HELP: "no_settings" }, blocker: ["access_claude", "workspace", "no_settings"] },
    { env: { MOCK_CLAUDE_SANDBOX: "refused" }, blocker: ["access_claude", "workspace", "init_refused"] },
    { env: { MOCK_CODEX_SCHEMA: "no_workspace" }, blocker: ["access_codex", "workspace", "schema_missing"] },
    { env: { MOCK_CODEX_SCHEMA: "no_rights" }, blocker: ["access_codex", "workspace", "schema_missing"] },
    { env: { MOCK_CODEX_SCHEMA: "unavailable" }, blocker: ["access_codex", "workspace", "schema_unavailable"] },
    { env: { MOCK_CLAUDE_HELP: "no_json_schema" }, warning: /Claude 2\.1\.281: no --json-schema in --help/ }
  ];
  for (const c of cases) {
    const m = manager(c.env);
    try {
      const src = project();
      const r = await ready(m, await linkOf(m, src));
      assert.ok(r.ok, JSON.stringify(r));
      const it = byId(r);
      if (c.blocker) {
        const [id, mode, why] = c.blocker;
        assert.equal(it[id]?.level, "blocker", `${JSON.stringify(c.env)}: ${JSON.stringify(r.value.items.map((i) => i.id))}`);
        assert.equal(it[id].facts.mode, mode);
        assert.equal(it[id].facts.why, why);
        assert.match(it[id].detail, id === "access_codex" ? /^Codex 0\.155\.1: / : /^Claude 2\.1\.281: /);
        assert.equal(r.value.ready, false);
      } else {
        assert.equal(it.clis.level, "warning");
        assert.match(it.clis.detail, c.warning);
        assert.equal(r.value.ready, true, "a protocol difference is a warning, not a blocker");
      }
    } finally { await m.shutdown?.(); }
  }
});

test("the probe's answer is kept per program, version and modification time: a new version or a replaced program is probed again", OPTS, async () => {
  const exe = path.join(TMP, "some-cli");
  fs.writeFileSync(exe, "#!/bin/sh\n", { mode: 0o755 });
  const cache = createCapabilityCache(path.join(TMP, `caps-${++n}.json`));
  let probes = 0;
  const probe = async () => ({ provider: "codex", version: "x", modes: ["terminal"], missing: {}, model: true, differences: [], n: ++probes });
  await cache.get({ provider: "codex", executable: exe, version: "codex-cli 0.160.0" }, probe);
  await cache.get({ provider: "codex", executable: exe, version: "codex-cli 0.160.0" }, probe);
  assert.equal(probes, 1, "the same program and version: asked once");
  await cache.get({ provider: "codex", executable: exe, version: "codex-cli 0.161.0" }, probe);
  assert.equal(probes, 2, "a new version: probed again");
  fs.utimesSync(exe, new Date(), new Date(Date.now() + 5_000));
  await cache.get({ provider: "codex", executable: exe, version: "codex-cli 0.161.0" }, probe);
  assert.equal(probes, 3, "the program replaced (another mtime): probed again");
  // kept on disk: a new manager (the next start of the application) does not probe again
  const again = createCapabilityCache(path.join(TMP, `caps-${n}.json`));
  await again.get({ provider: "codex", executable: exe, version: "codex-cli 0.161.0" }, probe);
  assert.equal(probes, 3);
  // an answer the probe could not get is not kept: the next readiness asks again
  const failing = async () => ({ provider: "claude", version: "x", modes: ["terminal"], missing: { workspace: { why: "init_refused", detail: "no answer to initialize" } }, model: true, differences: [], n: ++probes });
  await again.get({ provider: "claude", executable: exe, version: "2.1.293" }, failing);
  await again.get({ provider: "claude", executable: exe, version: "2.1.293" }, failing);
  assert.equal(probes, 5);
});

test("readiness and start agree: the start never refuses the rights or the model for a reason the readiness did not show", OPTS, async () => {
  const variants = [{}, { MOCK_CLAUDE_HELP: "no_settings" }, { MOCK_CLAUDE_HELP: "no_choices" }, { MOCK_CODEX_SCHEMA: "no_workspace" }, { MOCK_CODEX_SCHEMA: "unavailable" }, { MOCK_CLAUDE_SANDBOX: "refused" }];
  for (const env of variants) {
    for (const access of [{ claude: "workspace", codex: "workspace" }, { claude: "acceptEdits", codex: "full" }]) {
      const m = manager(env);
      try {
        const src = project();
        const r = await ready(m, await linkOf(m, src, access));
        const blockers = r.value.items.filter((i) => i.level === "blocker").map((i) => i.id);
        const c = await create(m, src);
        const refused = !c.ok && (c.code === "access_unsupported" || c.code === "model_unsupported");
        assert.equal(refused, blockers.some((id) => id.startsWith("access_") || id.startsWith("model_")), `${JSON.stringify(env)} ${JSON.stringify(access)}: readiness ${blockers} / start ${JSON.stringify(c)}`);
        if (refused) assert.ok(r.value.items.some((i) => i.level === "blocker" && i.detail === c.message), "the same words as the readiness blocker");
        if (c.ok) await m.command?.(c.value.runId, { commandId: randomUUID(), expectedRevision: 0, command: { kind: "stop" } }).catch(() => {});
      } finally { await m.shutdown?.(); }
    }
  }
});

test("«as in my terminal» for this run only: the blocker goes, the goal runs with it, the project settings stay byte for byte", OPTS, async () => {
  const m = manager({ MOCK_CLAUDE_HELP: "no_settings" });
  try {
    const src = project();
    const linkId = await linkOf(m, src);
    const profileFile = path.join(m.root, "profiles", `${createHash("sha256").update(src).digest("hex")}.json`);
    const profileBefore = await createProfileStore(m.root).get(src);
    const bytes = fs.readFileSync(profileFile);
    const blocked = await ready(m, linkId);
    assert.equal(byId(blocked).access_claude?.level, "blocker");
    const once = await ready(m, linkId, { accessOverride: { claude: "terminal" } });
    assert.equal(once.value.ready, true);
    assert.ok(!byId(once).access_claude);
    assert.equal(byId(once).access_claude_once?.level, "info");
    const c = await create(m, src, { accessOverride: { claude: "terminal" } });
    assert.ok(c.ok, JSON.stringify(c));
    const read = await readRun(m.root, c.value.runId);
    const goal = JSON.parse((await readText(m.root, c.value.runId, read.state.goal)).toString("utf8"));
    assert.deepEqual(goal.access, { claude: "terminal", codex: "workspace" });
    assert.equal(goal.accessOverride, undefined, "the goal records the rights it ran with, not the dialog's switch");
    assert.deepEqual(await createProfileStore(m.root).get(src), profileBefore);
    assert.deepEqual(fs.readFileSync(profileFile), bytes);
    const without = await create(m, src);
    assert.equal(without.ok, false, "the next start without the choice is refused again");
    assert.equal(without.code, "access_unsupported");
  } finally { await m.shutdown?.(); }
});

test("the words of a blocker and of a refused start: the CLI, its version, what is missing and which mode it makes unavailable", async () => {
  const { accessProblemText, parseStartProblem } = await import("../src/renderer/src/features/orchestration/runModel.ts");
  const said = parseStartProblem("Claude 2.1.293: the rights mode workspace is not available (no_settings: --settings)");
  assert.deepEqual(said, { provider: "claude", version: "2.1.293", mode: "workspace", why: "no_settings", missing: "--settings" });
  assert.equal(accessProblemText("ru", said), "Claude 2.1.293: не принимает настройки песочницы (--settings) — режим «Рабочая папка» недоступен");
  assert.equal(accessProblemText("en", parseStartProblem("Codex 0.161.0: the rights mode workspace is not available (schema_missing: sandbox workspace-write)")),
    "Codex 0.161.0: its app-server protocol lacks: sandbox workspace-write — the «Work folder» mode is unavailable");
  assert.equal(parseStartProblem("something else"), null);
});
