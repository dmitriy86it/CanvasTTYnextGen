// The real series' prompt rule (scripts/real-autopilot-series.mjs): what a CLI's prompt may be answered «Разрешить один
// раз» with by the series' assignment — a read or test command, or a file change, inside the temporary project. It
// imitates the operator's decision, it is not a shell parser: a compound command is split on ; && || | and every part
// must pass the list on its own; anything the rule does not recognise returns null and the series stops (never an
// automatic refusal). Returns the reason, or null.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// Single commands of the earlier rule, kept as they were.
const SAFE_CMD = /^(?:npm (?:test|run test|ls)|node --test(?: [\w./*-]+)*|node [\w./-]+\.m?js|php artisan (?:test|route:list)(?: [\w=:/.-]+)*|(?:php )?vendor\/bin\/(?:phpunit|pest)(?: [\w=:/.-]+)*|composer (?:dump-autoload|validate)|git (?:status|diff|log|show)(?: [\w=:/.-]+)*|ls(?: -[a-zA-Z]+)*(?: [\w./-]+)*|cat [\w./-]+|head(?: -n ?\d+)? [\w./-]+|tail(?: -n ?\d+)? [\w./-]+|wc(?: -l)? [\w./-]+|pwd)$/;
// Read commands by name, with the options that write, follow forever or run something else left out; their path
// arguments are checked apart (inside the project).
const READ = {
  cat: () => true, head: () => true, wc: () => true, ls: () => true, grep: () => true, diff: () => true,
  shasum: () => true, sha256sum: () => true, md5: () => true,
  pwd: (a) => a.length === 0,
  tail: (a) => !a.some((t) => /^-[a-zA-Z0-9]*[fF]|^--follow/.test(t)),
  sort: (a) => !a.some((t) => /^-[a-zA-Z]*[oT]|^--(?:output|temporary-directory|compress-program)/.test(t)),
  find: (a) => !a.some((t) => /^-(?:exec|execdir|ok|okdir|delete|fprint0?|fprintf|fls)$/.test(t)),
  git: (a) => ["status", "diff", "log", "show"].includes(a[0]) && !a.some((t) => /^--output/.test(t))
};
// Discarded or merged stderr writes no file: `2>&1` (Claude adds it to almost every command) and `2>/dev/null` (the
// output only disappears; nothing is created or read). Any other redirection stops.
const STDERR = /^2>(?:&1|\/dev\/null)(?=$|[\s;&|])/;

// Words and operators, or null when the split is not clear: an unclosed quote, a separator, $ or ` inside quotes,
// an escape, a substitution, a redirection, a subshell or brace, a comment, a background &.
function lex(s) {
  const out = [];
  let cur = null;
  const push = () => { if (cur !== null) out.push(cur); cur = null; };
  for (let i = 0; i < s.length;) {
    const c = s[i];
    if (cur === null && STDERR.test(s.slice(i))) { i += STDERR.exec(s.slice(i))[0].length; continue; }
    if (c === "'" || c === "\"") {
      const j = s.indexOf(c, i + 1);
      if (j < 0) return null;
      const body = s.slice(i + 1, j);
      if (/[;&|<>`$\\\n]/.test(body)) return null;
      cur = (cur ?? "") + body;
      i = j + 1;
    } else if (/\s/.test(c) && c !== "\n") { push(); i++; }
    else if (c === ";" || c === "\n") { push(); out.push({ op: ";" }); i++; }
    else if (c === "&") { if (s[i + 1] !== "&") return null; push(); out.push({ op: "&&" }); i += 2; }
    else if (c === "|") { push(); out.push({ op: s[i + 1] === "|" ? "||" : "|" }); i += s[i + 1] === "|" ? 2 : 1; }
    else if ("\\`$<>(){}#".includes(c)) return null;
    else { cur = (cur ?? "") + c; i++; }
  }
  push();
  return out;
}

// The command in a prompt, or null when it is not a list of known read/test parts inside the project.
export function commandAllowed(raw, projectDir, cwd = projectDir) {
  const inside = (base, f) => { const abs = path.resolve(base, f); return abs === projectDir || abs.startsWith(`${projectDir}/`); };
  if (!inside(projectDir, cwd)) return null;
  const cmd = String(raw ?? "").trim().replace(/^(?:\/bin\/(?:ba|z)?sh -l?c )(['"])([\s\S]*)\1$/, "$2");
  const tokens = lex(cmd);
  if (!tokens) return null;
  const parts = [[]];
  for (const t of tokens) typeof t === "string" ? parts.at(-1).push(t) : parts.push([]);
  // an empty part is malformed, except after a closing ;
  if (tokens.at(-1)?.op === ";") parts.pop();
  let dir = cwd;
  for (const words of parts) {
    if (!words.length) return null;
    // a path argument (absolute, ~, with / or ..) must stay inside the project; an option's value after = too
    for (const w of words) {
      const v = w.startsWith("-") ? (w.includes("=") ? w.slice(w.indexOf("=") + 1) : /[/~]/.test(w) ? null : "") : w;
      if (v === null || v.startsWith("~")) return null;
      if ((v.includes("/") || v === "..") && !inside(dir, v)) return null;
    }
    if (words[0] === "cd") {
      if (words.length !== 2) return null;
      dir = path.resolve(dir, words[1]);
      continue;
    }
    if (!SAFE_CMD.test(words.join(" ")) && !READ[words[0]]?.(words.slice(1))) return null;
  }
  return parts.some((w) => w[0] !== "cd") ? cmd : null;
}

export function allowedByAssignment(p, projectDir) {
  if (!["command", "file_change", "tool"].includes(p.kind)) return null;
  const inside = (f) => { const abs = path.resolve(projectDir, f); return abs === projectDir || abs.startsWith(`${projectDir}/`); };
  let detail = {};
  try { detail = JSON.parse(p.detail ?? "{}"); } catch {}
  if (p.kind === "file_change" || ["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(p.tool)) {
    const files = [detail.file_path, detail.path, detail.notebook_path, ...(Array.isArray(detail.paths) ? detail.paths : []), ...(Array.isArray(detail.changes) ? detail.changes.map((c) => c?.path) : [])].filter((x) => typeof x === "string");
    if (files.length && files.every(inside)) return `file change inside the project: ${files.map((f) => path.relative(projectDir, path.resolve(projectDir, f))).join(", ")}`;
    return null;
  }
  if (typeof detail.cwd === "string" && !inside(detail.cwd)) return null;
  if (p.tool === "Read" || p.tool === "Grep" || p.tool === "Glob") return inside(detail.file_path ?? detail.path ?? projectDir) ? `read inside the project (${p.tool})` : null;
  const raw = typeof detail.command === "string" ? detail.command : Array.isArray(detail.command) ? detail.command.join(" ") : p.summary;
  const cmd = commandAllowed(raw, projectDir, typeof detail.cwd === "string" ? detail.cwd : projectDir);
  return cmd ? `test/read command inside the project: ${cmd}` : null;
}

// The coordinator's pre-check for a Bash prompt that writes task files by heredoc (never answered automatically:
// allowedByAssignment keeps returning null for it). Only `cat > PATH <<'DELIM'` / `cat <<'DELIM' > PATH` with a quoted
// delimiter, `mkdir -p` inside the writable dirs, and a remainder the read/test rule accepts; the body is literal and
// not checked. Returns what would be written and every problem found; ok when there are none.
export function heredocWrites(raw, projectDir, { cwd = projectDir, writableDirs = ["src", "tests"], protectedFiles = [] } = {}) {
  const writes = [], mkdirs = [], problems = [], restLines = [];
  const inside = (abs) => abs === projectDir || abs.startsWith(`${projectDir}/`);
  if (!inside(path.resolve(projectDir, cwd))) problems.push(`cwd outside the project: ${cwd}`);
  const realProject = (() => { try { return fs.realpathSync(projectDir); } catch { return null; } })();
  const protectedSet = new Set(protectedFiles.map((f) => path.normalize(f)));
  // a target (file or mkdir'ed dir) inside a writable dir, with no symlink on the way and no hard-linked file
  const target = (p, isFile) => {
    if (path.isAbsolute(p) || p.split("/").includes("..")) return void problems.push(`not a plain relative path: ${p}`);
    const abs = path.resolve(projectDir, cwd, p);
    if (!inside(abs)) return void problems.push(`outside the project: ${p}`);
    const rel = path.relative(projectDir, abs);
    const segs = rel.split(path.sep);
    if (!writableDirs.includes(segs[0]) || (isFile && segs.length < 2)) return void problems.push(`not inside ${writableDirs.join(", ")}: ${rel}`);
    if (isFile && protectedSet.has(rel)) return void problems.push(`protected file: ${rel}`);
    let cur = projectDir, st = null;
    for (const s of segs) {
      const next = path.join(cur, s);
      try { st = fs.lstatSync(next); } catch { st = null; break; }
      if (st.isSymbolicLink()) return void problems.push(`symlink on the way: ${path.relative(projectDir, next)}`);
      cur = next;
    }
    let real = null;
    try { real = fs.realpathSync(cur); } catch {}
    if (!realProject || !real || !(real === realProject || real.startsWith(`${realProject}/`))) return void problems.push(`resolves outside the project: ${rel}`);
    if (isFile && st && (!st.isFile() || st.nlink !== 1)) return void problems.push(`existing target is not a single-link regular file: ${rel}`);
    return rel;
  };
  const cmd = String(raw ?? "").trim().replace(/^(?:\/bin\/(?:ba|z)?sh -l?c )(['"])([\s\S]*)\1$/, "$2");
  const lines = cmd.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const h = /^cat\s*>\s*(?<file>[\w./-]+)\s*<<\s*(['"])(?<delim>\w+)\2$/.exec(line) ?? /^cat\s*<<\s*(['"])(?<delim>\w+)\1\s*>\s*(?<file>[\w./-]+)$/.exec(line);
    if (h) {
      const { file, delim } = h.groups;
      const end = lines.indexOf(delim, i + 1);
      if (end < 0) { problems.push(`heredoc ${delim} is never closed`); break; }
      const body = lines.slice(i + 1, end).map((l) => `${l}\n`).join("");
      const rel = target(file, true);
      if (rel) writes.push({ path: rel, bytes: Buffer.byteLength(body), sha256: crypto.createHash("sha256").update(body).digest("hex") });
      i = end;
    } else if (line.includes("<<")) {
      problems.push(/<<\s*\w/.test(line) ? `unquoted heredoc delimiter expands the body: ${line}` : `heredoc header not recognised: ${line}`);
      break;
    } else if (/(?:^|[;&|(]\s*)cd(?:\s|$)/.test(line)) problems.push("cd changes where files are written; decide by hand");
    else if (/^mkdir -p(?: [\w./-]+)+$/.test(line)) for (const d of line.split(" ").slice(2)) { const rel = target(d, false); if (rel) mkdirs.push(rel); }
    else restLines.push(line);
  }
  const rest = restLines.length ? restLines.join("\n") : null;
  if (rest !== null && !commandAllowed(rest, projectDir, path.resolve(projectDir, cwd))) problems.push(`the rest is not a read/test command: ${rest}`);
  if (!writes.length) problems.push("no heredoc write");
  return { ok: problems.length === 0, writes, mkdirs, rest, problems };
}
