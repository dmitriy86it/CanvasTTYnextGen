// The real series' evidence (scripts/series-evidence.mjs): project state read from real temporary git repositories
// without changing them, rights as the CLIs reported them, and the saved scenario folder with its manifest.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { projectState, rightsState, saveScenarioEvidence } from "../scripts/series-evidence.mjs";

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const temps = [];
after(() => { for (const d of temps) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cto-evidence-"))); temps.push(d); return d; };
const git = (cwd, ...args) => execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" });
const ACCEPT = "tests/duration.accept.test.mjs";

function repo() {
  const dir = tmp();
  git(dir, "init", "-q", "-b", "main");
  fs.mkdirSync(path.join(dir, "tests"));
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, ACCEPT), "test('accept', () => {});\n");
  fs.writeFileSync(path.join(dir, "src/sum.mjs"), "export const sum = (a, b) => a + b;\n");
  fs.writeFileSync(path.join(dir, ".gitignore"), "node_modules/\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  return { dir, blob: git(dir, "rev-parse", `HEAD:${ACCEPT}`).trim() };
}

test("an unchanged acceptance test, new files with their hashes, ignored files left out, the diff", () => {
  const { dir, blob } = repo();
  fs.appendFileSync(path.join(dir, "src/sum.mjs"), "export const twice = (a) => a * 2;\n");
  fs.writeFileSync(path.join(dir, "src/duration.mjs"), "export {};\n");
  fs.mkdirSync(path.join(dir, "node_modules/ms"), { recursive: true });
  fs.writeFileSync(path.join(dir, "node_modules/ms/index.js"), "x");
  const s = projectState(dir, { accept: ACCEPT, acceptBlob: blob });
  assert.deepEqual(s.errors, []);
  assert.equal(s.branch, "main");
  assert.match(s.head, /^[0-9a-f]{40}$/);
  assert.deepEqual(s.accept, { path: ACCEPT, blobAtStart: blob, blobNow: blob, sha256Now: s.accept.sha256Now, unchanged: true });
  assert.match(s.accept.sha256Now, /^[0-9a-f]{64}$/);
  assert.deepEqual(s.newFiles.map((f) => f.path), ["src/duration.mjs"]);
  assert.equal(s.newFiles[0].bytes, 11);
  assert.match(s.newFiles[0].sha256, /^[0-9a-f]{64}$/);
  assert.match(s.diff, /\+export const twice/);
  assert.match(s.diffStat, /src\/sum\.mjs/);
  assert.equal(s.diffTruncated, undefined);
});

test("a modified acceptance test is not unchanged and its blob differs; a deleted one has no blob", () => {
  const { dir, blob } = repo();
  fs.appendFileSync(path.join(dir, ACCEPT), "// weakened\n");
  const mod = projectState(dir, { accept: ACCEPT, acceptBlob: blob });
  assert.equal(mod.accept.unchanged, false);
  assert.notEqual(mod.accept.blobNow, blob);
  assert.match(mod.accept.blobNow, /^[0-9a-f]{40}$/);
  fs.rmSync(path.join(dir, ACCEPT));
  const del = projectState(dir, { accept: ACCEPT, acceptBlob: blob });
  assert.equal(del.accept.blobNow, null);
  assert.equal(del.accept.sha256Now, null);
  assert.equal(del.accept.unchanged, false);
});

test("read only: git status is the same before and after, no index.lock, the index file untouched", () => {
  const { dir, blob } = repo();
  fs.appendFileSync(path.join(dir, "src/sum.mjs"), "// x\n");
  fs.writeFileSync(path.join(dir, "new.txt"), "n\n");
  // a stale stat makes a plain `git status` want to refresh the index
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(dir, ACCEPT), later, later);
  const status = () => git(dir, "--no-optional-locks", "status", "--porcelain", "--untracked-files=all");
  const index = path.join(dir, ".git/index");
  const before = status(), indexBefore = fs.readFileSync(index), mtimeBefore = fs.statSync(index).mtimeMs;
  projectState(dir, { accept: ACCEPT, acceptBlob: blob });
  assert.equal(status(), before);
  assert.ok(!fs.existsSync(path.join(dir, ".git/index.lock")));
  assert.deepEqual(fs.readFileSync(index), indexBefore);
  assert.equal(fs.statSync(index).mtimeMs, mtimeBefore);
});

test("a worktree is captured apart from the main folder", () => {
  const { dir, blob } = repo();
  const wt = path.join(tmp(), "wt");
  git(dir, "worktree", "add", "-q", "-b", "cto-run", wt);
  fs.writeFileSync(path.join(wt, "src/wt-only.mjs"), "w\n");
  fs.appendFileSync(path.join(wt, ACCEPT), "// changed in the worktree\n");
  const main = projectState(dir, { accept: ACCEPT, acceptBlob: blob }), work = projectState(wt, { accept: ACCEPT, acceptBlob: blob });
  assert.deepEqual([main.errors, work.errors], [[], []]);
  assert.deepEqual([main.branch, work.branch], ["main", "cto-run"]);
  assert.deepEqual(main.newFiles, []);
  assert.equal(main.accept.unchanged, true);
  assert.deepEqual(work.newFiles.map((f) => f.path), ["src/wt-only.mjs"]);
  assert.equal(work.accept.unchanged, false);
});

test("a folder that is not a repository gives errors, not a throw", () => {
  const s = projectState(tmp(), { accept: ACCEPT, acceptBlob: "x" });
  assert.ok(s.errors.length > 0);
  assert.equal(s.head, null);
  assert.equal(s.accept.unchanged, false);
});

const session = (provider, detail) => ({ kind: "session", provider, role: "executor", text: "session started", detail: { reported: true, ...detail } });

test("rights: what each CLI reported, and «не сообщено CLI» where it said nothing", () => {
  const activity = [session("claude", { permissionMode: "acceptEdits" }), { kind: "session", provider: "claude", detail: { permissionMode: "plan" } },
    session("codex", { approvalPolicy: "on-request" }), { kind: "task_sent", provider: "codex", detail: { sandbox: "x" } }];
  const r = rightsState({ requested: { claude: "acceptEdits", codex: "workspace" }, mapping: ["Claude: acceptEdits"], claudeArgv: ["--permission-mode acceptEdits"], activity });
  assert.deepEqual(r.claude, { requested: "acceptEdits", mapping: ["Claude: acceptEdits"], argv: ["--permission-mode acceptEdits"], reported: [{ permissionMode: "acceptEdits" }] });
  assert.deepEqual(r.codex.reported, [{ approvalPolicy: "on-request", sandbox: "не сообщено CLI" }]);
  const none = rightsState({ requested: { claude: null, codex: "workspace" }, activity: [session("claude", {})] });
  assert.equal(none.codex.reported, "не сообщено CLI");
  assert.deepEqual(none.claude.reported, [{ permissionMode: "не сообщено CLI" }]);
  assert.equal(none.claude.mapping, null);
});

test("saved evidence: a missing journal goes to the manifest, the other files are written anonymised, a second call replaces the first", () => {
  const { dir, blob } = repo();
  fs.appendFileSync(path.join(dir, "src/sum.mjs"), "// by /opt/person-secret\n");
  const src = tmp(), out = tmp();
  const activityFile = path.join(src, "activity.jsonl");
  fs.writeFileSync(activityFile, `${JSON.stringify(session("claude", { permissionMode: "acceptEdits", cwd: "/opt/person-secret/p" }))}\n`);
  const anon = (t) => t.replaceAll("/opt/person-secret", "~");
  const rights = rightsState({ requested: { claude: "acceptEdits", codex: null }, activity: [] });
  const m = saveScenarioEvidence(out, "S3", { journalFile: path.join(src, "journal.jsonl"), activityFile, projects: [{ label: "app", state: projectState(dir, { accept: ACCEPT, acceptBlob: blob }) }], rights, anon });
  const at = (f) => path.join(out, "S3", f);
  assert.deepEqual(m.missing.map((x) => x.what), ["journal"]);
  assert.match(m.missing[0].why, /not found/);
  assert.deepEqual(m.files.map((f) => f.file), ["activity.jsonl", "project-app.json", "project-app.diff", "rights.json"]);
  assert.ok(!fs.existsSync(at("journal.jsonl")));
  assert.match(fs.readFileSync(at("activity.jsonl"), "utf8"), /"cwd":"~\/p"/);
  assert.doesNotMatch(fs.readFileSync(at("project-app.diff"), "utf8"), /secret/);
  assert.match(fs.readFileSync(at("project-app.diff"), "utf8"), /\+\/\/ by ~/);
  const proj = JSON.parse(fs.readFileSync(at("project-app.json"), "utf8"));
  assert.equal(proj.diff, undefined);
  assert.equal(proj.accept.unchanged, true);
  assert.equal(JSON.parse(fs.readFileSync(at("rights.json"), "utf8")).codex.reported, "не сообщено CLI");
  assert.deepEqual(JSON.parse(fs.readFileSync(at("manifest.json"), "utf8")), m);
  assert.equal(m.files[0].bytes, fs.statSync(at("activity.jsonl")).size);

  fs.writeFileSync(path.join(src, "journal.jsonl"), "{\"type\":\"run_stopped\"}\n");
  const m2 = saveScenarioEvidence(out, "S3", { journalFile: path.join(src, "journal.jsonl"), activityFile, rights, anon });
  assert.deepEqual(m2.missing, []);
  assert.ok(fs.existsSync(at("journal.jsonl")));
  assert.ok(!fs.existsSync(at("project-app.json")), "the final call wins");
});
