// Evidence of a real series scenario (scripts/real-autopilot-series.mjs), taken after the run was stopped and the app's
// own processes are gone, on success and on halt: the project's state as git sees it, the rights asked for against what
// each CLI reported, and the run's journal and activity copied next to them with a manifest.
//
// Read only: every git call runs without optional locks (no index refresh, no index.lock) and nothing is added, stashed
// or checked out. A piece that fails goes to `errors` or `missing`; nothing here throws on a broken or absent source.
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const NOT_REPORTED = "не сообщено CLI";
const DIFF_MAX = 200 * 1024;
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

// The state of a project folder or a worktree. `accept` is the acceptance test's path relative to `dir`, `acceptBlob`
// its git blob id when the scenario started.
export function projectState(dir, { accept, acceptBlob } = {}) {
  const errors = [];
  const git = (args, piece) => {
    try {
      return execFileSync("git", ["--no-optional-locks", ...args], { cwd: dir, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      errors.push(`${piece}: ${String(e.stderr || e.message).trim().slice(0, 500)}`);
      return null;
    }
  };
  const state = { dir, head: git(["rev-parse", "HEAD"], "head")?.trim() ?? null, branch: git(["rev-parse", "--abbrev-ref", "HEAD"], "branch")?.trim() ?? null,
    // diff-index, not `git diff`: porcelain diff refreshes and rewrites the index for a stat-dirty file despite the
    // no-optional-locks setting (git 2.54); the plumbing command compares the same HEAD against the work tree read only
    status: git(["status", "--porcelain", "--untracked-files=all"], "status"), diffStat: git(["diff-index", "--stat", "HEAD"], "diffStat"), diff: git(["diff-index", "-p", "HEAD"], "diff") };
  if (state.diff !== null && state.diff.length > DIFF_MAX) { state.diff = state.diff.slice(0, DIFF_MAX); state.diffTruncated = true; }
  state.newFiles = (git(["ls-files", "--others", "--exclude-standard", "-z"], "newFiles") ?? "").split("\0").filter(Boolean).map((f) => {
    try { const buf = fs.readFileSync(path.join(dir, f)); return { path: f, bytes: buf.length, sha256: sha256(buf) }; }
    catch (e) { errors.push(`newFiles ${f}: ${e.message}`); return { path: f, bytes: null, sha256: null }; }
  });
  if (accept) {
    const exists = fs.existsSync(path.join(dir, accept));
    const blobNow = exists ? git(["hash-object", "--", accept], "accept blob")?.trim() ?? null : null;
    let sha256Now = null;
    if (exists) try { sha256Now = sha256(fs.readFileSync(path.join(dir, accept))); } catch (e) { errors.push(`accept sha256: ${e.message}`); }
    const listed = state.status === null || state.status.split("\n").some((l) => l.slice(3).split(" -> ").includes(accept));
    state.accept = { path: accept, blobAtStart: acceptBlob ?? null, blobNow, sha256Now, unchanged: blobNow !== null && blobNow === acceptBlob && !listed };
  }
  state.errors = errors;
  return state;
}

// What rights were asked for, what the UI showed and what each CLI said about its own session. Only a session fact counts
// as reported; the absence of a mismatch warning is not evidence.
export function rightsState({ requested = {}, mapping, claudeArgv, activity = [] } = {}) {
  const facts = (provider) => activity.filter((a) => a?.kind === "session" && a.provider === provider && a.detail?.reported);
  const reported = (provider, fields) => {
    const list = facts(provider).map((a) => Object.fromEntries(fields.map((f) => [f, a.detail[f] ?? NOT_REPORTED])));
    return list.length ? list : NOT_REPORTED;
  };
  return {
    claude: { requested: requested.claude ?? null, mapping: mapping ?? null, argv: claudeArgv ?? null, reported: reported("claude", ["permissionMode"]) },
    codex: { requested: requested.codex ?? null, mapping: mapping ?? null, reported: reported("codex", ["approvalPolicy", "sandbox"]) }
  };
}

// Writes the scenario's evidence into `${outDir}/${name}/`, replacing an earlier call's (the final call wins). Every
// written file passes through `anon`. Returns the manifest.
export function saveScenarioEvidence(outDir, name, { journalFile, activityFile, projects = [], rights, anon = String } = {}) {
  const dir = path.join(outDir, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const manifest = { files: [], missing: [], savedAt: null };
  const write = (file, text) => {
    const buf = Buffer.from(anon(text));
    fs.writeFileSync(path.join(dir, file), buf);
    manifest.files.push({ file, bytes: buf.length, sha256: sha256(buf) });
  };
  const copy = (file, src, what) => {
    if (!src) return manifest.missing.push({ what, why: "no source path given" });
    try { write(file, fs.readFileSync(src, "utf8")); } catch (e) { manifest.missing.push({ what, why: e.code === "ENOENT" ? `not found: ${src}` : e.message }); }
  };
  copy("journal.jsonl", journalFile, "journal");
  copy("activity.jsonl", activityFile, "activity");
  for (const { label, state } of projects) {
    if (!state) { manifest.missing.push({ what: `project ${label}`, why: "no state captured" }); continue; }
    const { diff, ...rest } = state;
    write(`project-${label}.json`, JSON.stringify(rest, null, 2));
    if (diff === null || diff === undefined) manifest.missing.push({ what: `project ${label} diff`, why: "git diff failed (see errors)" });
    else write(`project-${label}.diff`, diff);
  }
  if (rights) write("rights.json", JSON.stringify(rights, null, 2));
  else manifest.missing.push({ what: "rights", why: "not given" });
  manifest.savedAt = new Date().toISOString();
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return manifest;
}
