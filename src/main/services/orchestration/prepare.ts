// Stage 13: preparing the project's environment before the agents work, and telling a code failure from an unprepared
// environment and from an outside failure. Facts from the project's files only; commands are proposed, the user's
// profile decides which run. Lock files are used as they are (install, never update).
import { createHash } from "node:crypto";
import { lstat, readFile, stat } from "node:fs/promises";
import { connect } from "node:net";
import { join } from "node:path";

export interface PrepareStep {
  command: string; // a line of the user's login shell, run in the work folder
  unless: string | null; // a path relative to the work folder: when it exists, the step is not needed
}

const exists = (p: string) => lstat(p).then(() => true, () => false);

// Laravel's .env: never overwritten, the key generated only when it is empty. Done when .env has a key.
export const LARAVEL_ENV_STEP: Readonly<PrepareStep> = Object.freeze({
  command: `[ -f .env ] || cp .env.example .env; grep -Eq '^APP_KEY="?[^"[:space:]]' .env || php artisan key:generate --no-interaction`,
  unless: ".env"
});

// Steps the project's own files call for, in the order they must run. worktree: the run works in a fresh worktree,
// where ignored files such as .env are missing whatever the project folder has.
export async function suggestPrepare(root: string, opts: { worktree?: boolean } = {}): Promise<PrepareStep[]> {
  const steps: PrepareStep[] = [];
  const has = (f: string) => exists(join(root, f));
  if (await has("composer.json") && await hasSomethingToInstall(root, "composer.json")) {
    steps.push({ command: "composer install --no-interaction --no-progress", unless: "vendor/autoload.php" });
  }
  if (await has("artisan") && await has(".env.example") && (opts.worktree || (!(await has(".env")) && !(await has(".env.testing"))))) {
    steps.push({ ...LARAVEL_ENV_STEP });
  }
  if (await has("package.json") && await hasSomethingToInstall(root, "package.json")) {
    if (await has("pnpm-lock.yaml")) steps.push({ command: "pnpm install --frozen-lockfile", unless: "node_modules/.modules.yaml" });
    else if (await has("yarn.lock")) {
      steps.push(await has(".yarnrc.yml")
        ? { command: "yarn install --immutable", unless: "node_modules/.yarn-state.yml" }
        : { command: "yarn install --frozen-lockfile", unless: "node_modules/.yarn-integrity" });
    } else if (await has("package-lock.json")) steps.push({ command: "npm ci", unless: "node_modules/.package-lock.json" });
    // No JS lock file: plain `npm install` would resolve and write a new package-lock.json into the project (F-1), so
    // --no-package-lock. In a PHP project (composer.json) the package.json is its front end's, which the tests do not
    // need (F-1: a Laravel skeleton spent 12 s on it): no step at all.
    else if (!(await has("composer.json"))) steps.push({ command: "npm install --no-package-lock", unless: "node_modules" });
  }
  return steps;
}

// Whether a manifest asks for anything to install. npm, yarn and pnpm: a non-empty dependencies, devDependencies,
// optionalDependencies or workspaces in package.json; composer: a non-empty require or require-dev in composer.json.
// Without any, the install succeeds and makes no node_modules/vendor. A manifest that is missing or cannot be parsed is
// not judged: something to install.
const MANIFEST_KEYS = { "package.json": ["dependencies", "devDependencies", "optionalDependencies", "workspaces"], "composer.json": ["require", "require-dev"] };
export type Manifest = keyof typeof MANIFEST_KEYS;
export async function hasSomethingToInstall(root: string, manifest: Manifest): Promise<boolean> {
  let m: unknown;
  try { m = JSON.parse(await readFile(join(root, manifest), "utf8")); } catch { return true; }
  if (!m || typeof m !== "object" || Array.isArray(m)) return true;
  const full = (v: unknown): boolean => Array.isArray(v) ? v.length > 0
    : !!v && typeof v === "object" && Object.values(v).some((x) => (Array.isArray(x) ? x.length > 0 : x !== null && x !== undefined)); // workspaces: { packages: [] }
  return MANIFEST_KEYS[manifest].some((k) => full((m as Record<string, unknown>)[k]));
}

// The manifest an install step follows: its marker is under node_modules (npm, yarn, pnpm) or vendor (composer).
function manifestOf(step: PrepareStep): Manifest | null {
  const u = step.unless ?? "";
  if (u === "node_modules" || u.startsWith("node_modules/")) return "package.json";
  if (u.startsWith("vendor/") && /\bcomposer\b/.test(step.command)) return "composer.json";
  return null;
}

// The profile's steps for a run in a fresh worktree: a profile suggested in a project folder that has its .env has no
// .env step, yet the worktree has no .env. Added after composer (key:generate needs vendor/).
export async function worktreeSteps(root: string, steps: readonly PrepareStep[]): Promise<PrepareStep[]> {
  const out = [...steps];
  if (out.some((s) => s.unless === ".env") || !(await exists(join(root, "artisan"))) || !(await exists(join(root, ".env.example")))) return out;
  const composer = out.findIndex((s) => s.unless === "vendor/autoload.php");
  out.splice(composer + 1, 0, { ...LARAVEL_ENV_STEP });
  return out;
}

// The lock file an install step follows (install, never update): a changed lock means the installed state is stale.
export function lockOf(step: PrepareStep): string | null {
  const u = step.unless ?? "";
  if (u.startsWith("vendor/")) return /\bcomposer\b/.test(step.command) ? "composer.lock" : null;
  if (!u.startsWith("node_modules")) return null;
  if (/\bpnpm\b/.test(step.command)) return "pnpm-lock.yaml";
  if (/\byarn\b/.test(step.command)) return "yarn.lock";
  if (/\bnpm\s+ci\b/.test(step.command)) return "package-lock.json";
  return null;
}

const sha256File = (p: string) => readFile(p).then((b) => createHash("sha256").update(b).digest("hex"), () => null);

// sha256 of the lock files of these steps as they are now (recorded after a preparation).
export async function lockFingerprints(workDir: string, steps: readonly PrepareStep[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const step of steps) {
    const lock = lockOf(step);
    if (lock && !(lock in out)) { const h = await sha256File(join(workDir, lock)); if (h) out[lock] = h; }
  }
  return out;
}

// Which steps are needed now. A step is needed when what it makes is missing, or when its lock file changed since it
// was installed: against the fingerprint recorded by the last preparation (`known`), otherwise when the lock is newer
// than the marker. The marker alone does not prove the installed state matches the lock. A step without `unless` always
// runs.
export async function neededSteps(workDir: string, steps: readonly PrepareStep[], known: Readonly<Record<string, string>> = {}): Promise<{ step: PrepareStep; index: number }[]> {
  const out: { step: PrepareStep; index: number }[] = [];
  for (const [index, step] of steps.entries()) {
    if (await installsNothing(workDir, step)) continue;
    if (step.unless === null || !(await exists(join(workDir, step.unless))) || await stale(workDir, step, known)) out.push({ step, index });
  }
  return out;
}

// An install step with nothing to install succeeds and writes no node_modules/vendor: nothing to prepare, and its
// marker never appears. Judged by the project's files as they are now (hasSomethingToInstall), never by the run's
// journal; also `npm ci` of a package-lock.json without packages. ponytail: pnpm/yarn locks without packages are judged
// by package.json only.
export async function installsNothing(workDir: string, step: PrepareStep): Promise<boolean> {
  const manifest = manifestOf(step);
  if (manifest && !(await hasSomethingToInstall(workDir, manifest))) return true;
  if (lockOf(step) !== "package-lock.json") return false;
  try {
    const lock = JSON.parse(await readFile(join(workDir, "package-lock.json"), "utf8")) as { lockfileVersion?: unknown; packages?: Record<string, unknown>; dependencies?: Record<string, unknown> };
    if (typeof lock.lockfileVersion !== "number") return false; // not a lock npm wrote: not judged
    const pkgs = lock.packages ? Object.keys(lock.packages).filter((k) => k !== "") : null;
    return pkgs !== null ? pkgs.length === 0 : Object.keys(lock.dependencies ?? {}).length === 0;
  } catch {
    return false;
  }
}

async function stale(workDir: string, step: PrepareStep, known: Readonly<Record<string, string>>): Promise<boolean> {
  if (step.command === LARAVEL_ENV_STEP.command) {
    const env = await readFile(join(workDir, ".env"), "utf8").catch(() => "");
    return !/^APP_KEY="?[^"\s]/m.test(env);
  }
  const lock = lockOf(step);
  if (!lock) return false;
  if (known[lock] !== undefined) return (await sha256File(join(workDir, lock))) !== known[lock];
  const [l, m] = await Promise.all([stat(join(workDir, lock)).catch(() => null), stat(join(workDir, step.unless!)).catch(() => null)]);
  return !!l && !!m && l.mtimeMs > m.mtimeMs;
}

export type FailureClass = "code" | "environment" | "external";

// What a failed command says about its cause. The environment is the project's own setup (a missing program,
// dependencies, a database service that is not running); outside is the network or a remote service. Everything else
// is the code's business. ponytail: text patterns of common tools; an unknown message counts as code.
const ENV_SERVICE = /SQLSTATE\[HY000\] \[2002\]|SQLSTATE\[08006\]|could not connect to server|Connection refused.{0,40}(?:3306|5432|6379|27017)|could not find driver/i;
const EXTERNAL = /\b(?:ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|ECONNRESET|ETIMEDOUT)\b|getaddrinfo|Could not resolve host|Network is unreachable|network (?:error|timeout)|socket hang up|TLS handshake timeout|certificate verify failed|503 Service Unavailable|502 Bad Gateway|429 Too Many Requests|curl error \d+ while downloading|The "https?:\/\/[^"]+" file could not be downloaded/i;
const ENVIRONMENT = /command not found|: not found\b|No such file or directory.{0,80}(?:vendor\/autoload\.php|node_modules)|vendor\/autoload\.php|Could not open input file: artisan|Cannot find module '(?![./])[^']+'|ERR_MODULE_NOT_FOUND[\s\S]{0,200}node_modules|Class "?Composer\\Autoload|No application encryption key has been specified|MissingAppKeyException/i;

export function classifyFailure(text: string, exitCode: number | null): FailureClass {
  if (ENV_SERVICE.test(text)) return "environment";
  if (EXTERNAL.test(text)) return "external";
  if (exitCode === 127 || ENVIRONMENT.test(text)) return "environment";
  return "code";
}

// ---------- Laravel: the database the tests would use ----------

type Source = "phpunit" | "process" | "none" | `.env${string}`;

export interface LaravelTestDb {
  connection: string | null; // the driver of the active connection, or the scheme of a database URL in effect; null: unknown
  host: string | null;
  port: number | null;
  database: string | null;
  // where the connection comes from: phpunit.xml (in effect), .env.<APP_ENV> or .env (.env.example in a fresh
  // worktree), the environment of the process (login shell, direnv), or nowhere (config/database.php's default)
  source: Source;
  explicit: boolean; // set for the tests: the database named by phpunit.xml or .env.testing (in effect), or sqlite in memory
  risky: boolean; // not set for the tests and on a non-local host: maybe the production database
  configCached: boolean; // bootstrap/cache/config.php: the tests would use the cached configuration, not these values
  service: "reachable" | "unreachable" | "not_needed" | "unknown";
  // Stage 13 review: a database URL in effect replaces driver, host, port and database (ConfigurationUrlParser).
  // Only its variable is kept: the URL's user and password never leave this function.
  url: { variable: string; source: Source; parsed: boolean } | null;
  connectionName: string | null; // the active connection of config/database.php ('default'), not the driver
  // What config/database.php (read statically) does not tell: the field and the construct, e.g. "database_path()"
  unknown: { field: "default" | "connection" | "driver" | "url" | "host" | "database"; what: string } | null;
}

// A .env file as vlucas/phpdotenv reads the usual lines. A value that refers to another variable (${X}) is kept as
// written: resolving it is not attempted (a URL such as that is "not understood").
function envFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z0-9_.]+)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const q = /^(['"])(.*?)\1/.exec(m[2]);
    out[m[1]] = q ? q[2] : m[2].replace(/\s+#.*$/, "").trim();
  }
  return out;
}

// <env>/<server> of phpunit.xml outside comments, attributes in any order. Without force="true" PHPUnit does not
// replace a variable the process already has.
function phpunitEnv(xml: string): Record<string, { value: string; force: boolean }> {
  const out: Record<string, { value: string; force: boolean }> = {};
  for (const m of xml.replace(/<!--[\s\S]*?-->/g, "").matchAll(/<(?:env|server)\b([^>]*)>/g)) {
    const a: Record<string, string> = {};
    for (const x of m[1].matchAll(/([A-Za-z_:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) a[x[1]] = x[2] ?? x[3];
    if (a.name && a.value !== undefined && /^[A-Za-z0-9_]+$/.test(a.name)) out[a.name] = { value: a.value, force: a.force === "true" };
  }
  return out;
}

// ---------- config/database.php: a bounded subset of a PHP array, read without running PHP ----------

// A value of the file: a literal, env('NAME') or env('NAME', literal), an array, or anything else ("unsupported", with a
// short description of the construct: never its text, which may hold a password).
export type PhpValue =
  | { kind: "lit"; value: string | null }
  | { kind: "env"; name: string; def: string | null; defWhat?: string } // defWhat: a default outside the subset
  | { kind: "array"; entries: Map<string, PhpValue>; dynamic: boolean } // dynamic: a spread or a computed key
  | { kind: "unsupported"; what: string };
type Tok = { t: "str" | "num" | "id" | "op" | "istr"; v: string };

// Strings in '' and "" (no interpolation), numbers, names, comments (//, #, /* */), brackets and operators. null: a
// heredoc, an attribute, an unterminated string or comment, or no <?php (outside the subset).
function phpTokens(src: string): Tok[] | null {
  const out: Tok[] = [];
  // the first <?php (any case) opens the code; no tag, or another open tag (<?, <?=) before it: outside the subset
  const open = /<\?php(?=[ \t\n\r]|$)/i.exec(src);
  if (!open || src.slice(0, open.index).includes("<?")) return null;
  let i = open.index + 5;
  while (i < src.length) {
    const c = src[i];
    if (/[ \t\n\r]/.test(c)) { i++; continue; } // PHP's whitespace only: another character is a token outside the subset
    if (src.startsWith("<<<", i) || src.startsWith("#[", i)) return null;
    // a line comment ends at \n, \r or ?> (which stays, as tokens)
    if (c === "#" || src.startsWith("//", i)) { i = Math.min(...["\n", "\r", "?>"].map((e) => src.indexOf(e, i)).filter((e) => e >= 0), src.length); continue; }
    if (src.startsWith("/*", i)) { const e = src.indexOf("*/", i + 2); if (e < 0) return null; i = e + 2; continue; }
    if (c === "'" || c === '"') {
      let j = i + 1, v = "", plain = true;
      for (; j < src.length && src[j] !== c; j++) {
        if (src[j] === "\\" && (src[j + 1] === c || src[j + 1] === "\\")) { v += src[++j]; continue; }
        if (c === '"' && (src[j] === "$" || src[j] === "\\")) plain = false; // interpolation or an escape sequence
        v += src[j];
      }
      if (j >= src.length) return null;
      out.push({ t: plain ? "str" : "istr", v });
      i = j + 1;
      continue;
    }
    const m = /^(?:(\d[\d_.]*)|([$\\A-Za-z_][\w\\]*)|(=>|\.\.\.|::|->|\?\?|[\s\S]))/.exec(src.slice(i, i + 200))!;
    out.push({ t: m[1] ? "num" : m[2] ? "id" : "op", v: m[0] });
    i += m[0].length;
  }
  return out;
}

const OPEN: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
// the index of the bracket closing toks[i], or -1
function closing(toks: Tok[], i: number): number {
  let depth = 0;
  for (let j = i; j < toks.length; j++) {
    if (toks[j].t !== "op") continue;
    if (OPEN[toks[j].v]) depth++;
    else if (")]}".includes(toks[j].v) && --depth === 0) return j;
  }
  return -1;
}
// toks split by an operator outside brackets
function splitTop(toks: Tok[], sep: string): Tok[][] {
  const parts: Tok[][] = [[]];
  let depth = 0;
  for (const x of toks) {
    if (x.t === "op" && OPEN[x.v]) depth++;
    if (x.t === "op" && ")]}".includes(x.v)) depth--;
    if (depth === 0 && x.t === "op" && x.v === sep) parts.push([]);
    else parts[parts.length - 1].push(x);
  }
  return parts;
}
const literal = (toks: Tok[]): { value: string | null } | null => {
  if (toks.length !== 1) return null;
  const [x] = toks;
  if (x.t === "str" || x.t === "num") return { value: x.v };
  if (x.t === "id" && /^(?:null|true|false)$/i.test(x.v)) return { value: /^null$/i.test(x.v) ? null : x.v.toLowerCase() };
  return null;
};
function describe(toks: Tok[]): string {
  if (toks.some((x) => x.t === "op" && (x.v === "?" || x.v === "??"))) return "a conditional";
  if (toks.some((x) => x.t === "op" && x.v === ".")) return "a concatenation";
  if (toks.some((x) => x.t === "istr")) return "a string with interpolation";
  const call = toks.findIndex((x, i) => x.t === "id" && toks[i + 1]?.v === "(");
  if (call >= 0) return /^\\?env$/i.test(toks[call].v) ? "env() with an argument that is not a literal" : `${toks[call].v.replace(/^.*\\/, "").slice(0, 40)}()`;
  if (toks[0]?.v.startsWith("$")) return "a variable";
  return toks.length ? "an expression" : "no value";
}

function phpValue(toks: Tok[]): PhpValue {
  const lit = literal(toks);
  if (lit) return { kind: "lit", value: lit.value };
  const last = toks.length - 1;
  const inner = toks[0]?.v === "[" ? 1 : /^array$/i.test(toks[0]?.v ?? "") && toks[1]?.v === "(" ? 2 : 0;
  if (inner && toks[inner - 1].t === "op" && closing(toks, inner - 1) === last) {
    const entries = new Map<string, PhpValue>();
    let dynamic = false;
    for (const el of splitTop(toks.slice(inner, last), ",")) {
      if (el.length === 0) continue;
      const kv = splitTop(el, "=>");
      const key = kv.length === 2 ? literal(kv[0]) : null;
      if (kv.length === 1 && el[0].v !== "...") continue; // a list item: an integer key
      if (!key || key.value === null) { dynamic = true; continue; }
      entries.set(key.value, phpValue(kv[1])); // a later key replaces an earlier one, as in PHP
    }
    return { kind: "array", entries, dynamic };
  }
  if (toks.length >= 4 && /^\\?env$/i.test(toks[0].v) && toks[1].v === "(" && closing(toks, 1) === last) {
    const args = splitTop(toks.slice(2, last), ",");
    const def = args.length === 2 ? literal(args[1]) : { value: null };
    // env('DB_DATABASE', database_path('database.sqlite')): known while DB_DATABASE is set
    if (args[0].length === 1 && args[0][0].t === "str" && args.length <= 2) return { kind: "env", name: args[0][0].v, def: def?.value ?? null, ...(def ? {} : { defWhat: describe(args[1]) }) };
  }
  return { kind: "unsupported", what: describe(toks) };
}

const kw = (x: Tok | undefined, word: string) => x?.t === "id" && x.v.toLowerCase() === word;
// `use A\B[ as C][, ...]` of classes only: `use function`/`use const` may make env() another function
function isUseStatement(s: Tok[]): boolean {
  if (!kw(s[0], "use") || kw(s[1], "function") || kw(s[1], "const")) return false;
  return splitTop(s.slice(1), ",").every((p) => (p.length === 1 || (p.length === 3 && kw(p[1], "as"))) && p.every((x) => x.t === "id"));
}

// What `return [...]` of config/database.php is, read statically. The whole file has to be, at the top level:
// <?php [declare(...);] (use Class[ as Alias][, ...];)* return <array>[;] [?>]
// and nothing else: a function, a class, a condition or any other statement may decide what is really returned, and a
// namespace, `use function` or `use const` may make an unqualified env() another function.
export function parseDatabaseConfig(php: string): PhpValue {
  const toks = phpTokens(php);
  if (!toks) return { kind: "unsupported", what: "config/database.php is not a plain `return [...]`" };
  const body = toks.at(-2)?.v === "?" && toks.at(-1)?.v === ">" ? toks.slice(0, -2) : toks;
  const stmts = splitTop(body, ";");
  if (stmts.length > 1 && stmts.at(-1)!.length === 0) stmts.pop(); // the `;` of the last statement
  let i = 0;
  if (kw(stmts[i]?.[0], "declare") && stmts[i][1]?.v === "(" && closing(stmts[i], 1) === stmts[i].length - 1) i++;
  while (stmts[i] && isUseStatement(stmts[i])) i++;
  if (!kw(stmts[i]?.[0], "return")) return { kind: "unsupported", what: i < stmts.length ? "config/database.php has statements other than `use` before `return`" : "config/database.php is not a plain `return [...]`" };
  if (i !== stmts.length - 1) return { kind: "unsupported", what: "config/database.php has statements after `return`" };
  const value = phpValue(stmts[i].slice(1));
  return value.kind === "array" ? value : { kind: "unsupported", what: `config/database.php returns ${value.kind === "unsupported" ? value.what : "no array"}` };
}
function member(a: PhpValue | undefined, key: string): PhpValue | undefined {
  if (!a) return undefined;
  if (a.kind !== "array") return { kind: "unsupported", what: a.kind === "unsupported" ? a.what : "not an array" };
  return a.dynamic ? { kind: "unsupported", what: "an array with a spread or computed keys" } : a.entries.get(key);
}

// Laravel 11+ may have no config/database.php: the framework's own (vendor/laravel/framework/config/database.php of
// v13.33.0). ponytail: database_path('database.sqlite') is written as the relative path it names.
const FRAMEWORK_DATABASE_PHP = `<?php return ['default' => env('DB_CONNECTION', 'sqlite'), 'connections' => [
  'sqlite' => ['driver' => 'sqlite', 'url' => env('DB_URL'), 'database' => env('DB_DATABASE', 'database/database.sqlite')],
  'mysql' => ['driver' => 'mysql', 'url' => env('DB_URL'), 'host' => env('DB_HOST', '127.0.0.1'), 'port' => env('DB_PORT', '3306'), 'database' => env('DB_DATABASE', 'laravel')],
  'mariadb' => ['driver' => 'mariadb', 'url' => env('DB_URL'), 'host' => env('DB_HOST', '127.0.0.1'), 'port' => env('DB_PORT', '3306'), 'database' => env('DB_DATABASE', 'laravel')],
  'pgsql' => ['driver' => 'pgsql', 'url' => env('DB_URL'), 'host' => env('DB_HOST', '127.0.0.1'), 'port' => env('DB_PORT', '5432'), 'database' => env('DB_DATABASE', 'laravel')],
  'sqlsrv' => ['driver' => 'sqlsrv', 'url' => env('DB_URL'), 'host' => env('DB_HOST', 'localhost'), 'port' => env('DB_PORT', '1433'), 'database' => env('DB_DATABASE', 'laravel')]]];`;

const DRIVER_ALIASES: Record<string, string> = { mssql: "sqlsrv", mysql2: "mysql", postgres: "pgsql", postgresql: "pgsql", sqlite3: "sqlite" };
const decode = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };
// parseStringsToNativeTypes: a JSON text becomes its value ("null" is no value, "5432" the number)
const native = (s: string): string | null => { try { const v = JSON.parse(s) as unknown; return v === null ? null : String(v); } catch { return s; } };

export interface ParsedDbUrl { driver: string | null; host: string | null; port: number | null; database: string | null }

// What Illuminate\Support\ConfigurationUrlParser takes from a database URL (driver, host, port, database; never the
// user or the password), after PHP's parse_url. null: the URL is not understood here (PHP's parse_url fails on it, or
// it is a SQL Server DSN). Compared with the real parser by scripts/laravel-url-crosscheck.mjs.
export function parseDbUrl(raw: string): ParsedDbUrl | null {
  if (/^sqlsrv:(?!\/\/)/i.test(raw)) return null;
  const url = raw.replace(/^(sqlite3?):\/\/\//, "$1://null/");
  const m = /^(?:([A-Za-z][A-Za-z0-9+.-]*):)?(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#.*)?$/.exec(url);
  if (!m || /\s/.test(url) || (m[1] === undefined && /^[^/?#]*:/.test(url) && !url.startsWith("//"))) return null;
  let host: string | null = null;
  let port: number | null = null;
  if (m[2] !== undefined) {
    const hp = m[2].slice(m[2].lastIndexOf("@") + 1);
    const h = /^(\[[^\]]*\]|[^:]*)(?::(\d*))?$/.exec(hp);
    if (!h || (m[2] === "" && m[1] !== undefined)) return null;
    if (h[2]) { port = Number(h[2]); if (port > 65535) return null; }
    host = h[1] === "" ? null : native(decode(h[1]));
  }
  const path = m[3] ? native(decode(m[3])) : null;
  const out: ParsedDbUrl = {
    driver: m[1] ? DRIVER_ALIASES[native(decode(m[1])) ?? ""] ?? native(decode(m[1])) : null,
    host, port, database: path && path !== "/" ? path.slice(1) : null
  };
  // query options are merged over these (parse_str)
  for (const [k, v] of new URLSearchParams(m[4] ?? "")) {
    if (k === "driver" || k === "host" || k === "database") out[k] = native(v);
    if (k === "port") out.port = Number(native(v)) || null;
  }
  return out;
}

const LOCAL = /^(?:127\.0\.0\.1|localhost|::1|\[::1\]|0\.0\.0\.0|mysql|pgsql|postgres|db|database|mariadb)$/i; // compose service names count as local
const DEFAULT_PORTS: Record<string, number> = { mysql: 3306, mariadb: 3306, pgsql: 5432 };

// What the tests of a Laravel project would connect to. Laravel's own precedence: phpunit.xml's force="true" values,
// then a variable of the process, then phpunit.xml's other values (PHPUnit does not replace what the process has), then
// .env.<APP_ENV> when that file exists, else .env (immutable dotenv: never over a variable already set). A database URL
// in effect (the active connection's 'url') replaces its fields. The files are read, config/database.php is not run:
// what it says outside the subset parseDatabaseConfig reads is "unknown", never a guess.
export async function laravelTestDb(root: string, probe: (host: string, port: number) => Promise<boolean> = tcpReachable,
  opts: { env?: Readonly<Record<string, string>>; worktree?: boolean } = {}): Promise<LaravelTestDb> {
  const read = (f: string) => readFile(join(root, f), "utf8").catch(() => null);
  const unit = phpunitEnv((await read("phpunit.xml")) ?? (await read("phpunit.xml.dist")) ?? "");
  const env = opts.env ?? {};
  const early = (k: string) => (unit[k] && (unit[k].force || env[k] === undefined) ? unit[k].value : env[k]);
  // LoadEnvironmentVariables: .env.<APP_ENV> (APP_ENV from phpunit.xml or the process) when it exists
  const appEnv = early("APP_ENV");
  const special = appEnv && /^[A-Za-z0-9_.-]+$/.test(appEnv) ? await read(`.env.${appEnv}`) : null;
  // a fresh worktree has no .env of its own: the preparation copies .env.example
  const base = envFile(special ?? (await read(opts.worktree ? ".env.example" : ".env")) ?? "");
  const baseSource: Source = special !== null ? `.env.${appEnv}` : ".env";
  const pick = (k: string): { value: string; source: Source } | null => {
    const u = unit[k];
    if (u && (u.force || env[k] === undefined)) return { value: u.value, source: "phpunit" };
    if (env[k] !== undefined) return { value: env[k], source: "process" };
    return base[k] !== undefined ? { value: base[k], source: baseSource } : null;
  };
  const forTests = (s: Source | undefined) => s === "phpunit" || s === ".env.testing";

  // Env::get: "null" is null, "empty" is "", quotes are taken off; an unset variable gives env()'s default
  const fromEnv = (name: string): { value: string | null; source: Source } | null => {
    const p = pick(name);
    if (!p) return null;
    const v = p.value.replace(/^(['"])(.*)\1$/, "$2");
    return { value: /^\(?null\)?$/i.test(p.value) ? null : /^\(?empty\)?$/i.test(p.value) ? "" : v, source: p.source };
  };
  const resolve = (x: PhpValue | undefined): { value: string | null; source: Source; variable: string | null } | { what: string } =>
    !x ? { value: null, source: "none", variable: null }
      : x.kind === "lit" ? { value: x.value, source: "none", variable: null }
        : x.kind === "env" ? (pick(x.name) || !x.defWhat ? { value: x.def, source: "none", ...fromEnv(x.name), variable: x.name } : { what: x.defWhat })
          : { what: x.kind === "array" ? "an array" : x.what };

  // Only the active connection counts: 'default', then that entry of 'connections' (its name is not its driver).
  const configPhp = await readFile(join(root, "config", "database.php"), "utf8").catch((e: NodeJS.ErrnoException) => (e.code === "ENOENT" ? null : undefined));
  const config: PhpValue = configPhp === undefined ? { kind: "unsupported", what: "config/database.php could not be read" } : parseDatabaseConfig(configPhp ?? FRAMEWORK_DATABASE_PHP);
  let unknown: LaravelTestDb["unknown"] = null;
  const fail = (field: NonNullable<LaravelTestDb["unknown"]>["field"], what: string) => { unknown ??= { field, what }; };
  const def = resolve(member(config, "default"));
  let connectionName: string | null = null;
  let source: Source = "none";
  if ("what" in def) fail("default", def.what);
  else if (!def.value) fail("default", "no value");
  else { connectionName = def.value; source = def.source; }
  const block = connectionName === null ? undefined : member(member(config, "connections"), connectionName);
  if (connectionName !== null && block?.kind !== "array") fail("connection", block?.kind === "unsupported" ? block.what : `no connection '${connectionName.slice(0, 60)}'`);
  const conf = (k: string) => (block?.kind === "array" ? resolve(member(block, k)) : { what: "" });
  const driver = member(block?.kind === "array" ? block : undefined, "driver");
  if (block?.kind === "array" && (driver?.kind !== "lit" || !driver.value)) fail("driver", driver?.kind === "unsupported" ? driver.what : "not a literal");
  let connection = unknown === null && driver?.kind === "lit" ? driver.value : null;

  // A database URL in effect (Env::get: "null", "false", "empty" and "" are none) replaces what the fields say.
  // Without config/database.php an older project's DATABASE_URL counts too (safe side).
  let url: LaravelTestDb["url"] = null;
  let parsed: ParsedDbUrl | null = null;
  const none = (v: string | null) => !v || v === "0" || /^\(?(?:null|false|empty)\)?$/i.test(v);
  let u = connection === null ? null : conf("url");
  if (u && !("what" in u) && none(u.value) && configPhp === null) u = resolve({ kind: "env", name: "DATABASE_URL", def: null });
  if (u && "what" in u) fail("url", u.what);
  else if (u && !none(u.value)) {
    const v = u.value!;
    parsed = /^\(?true\)?$/i.test(v) || v.includes("${") ? null : parseDbUrl(v);
    url = { variable: u.variable ?? "config/database.php", source: u.source, parsed: parsed !== null };
  }
  if (unknown) connection = null;

  const field = (k: string) => { const r = connection === null ? { what: "" } : conf(k); return "what" in r ? { value: null, source: "none" as Source, what: r.what } : { ...r, what: null }; };
  const db = field("database");
  const h = field("host");
  let database = db.value;
  let host = connection && connection !== "sqlite" ? h.value : null;
  let port = connection && connection !== "sqlite" ? Number(field("port").value ?? 0) || null : null;
  let explicit = forTests(db.source) || (connection === "sqlite" && database === ":memory:");
  if (url) {
    connection = parsed?.driver ?? connection;
    database = parsed?.database ?? database;
    host = parsed?.host ?? host;
    port = parsed?.port ?? port;
    source = url.source;
    explicit = forTests(url.source) || (connection === "sqlite" && database === ":memory:");
  }
  const sqlite = connection === "sqlite";
  if (connection && sqlite && database === null && db.what) fail("database", db.what);
  if (connection && !sqlite && host === null && h.what) fail("host", h.what);
  if (sqlite) { host = null; port = null; }
  else if (connection && port === null) port = DEFAULT_PORTS[connection] ?? null;
  const risky = !explicit && connection !== null && host !== null && !LOCAL.test(host);
  let service: LaravelTestDb["service"] = "not_needed";
  if (connection && !sqlite) {
    // never probed: a host a URL names outside this machine
    service = host && port && /^(?:127\.0\.0\.1|localhost|::1)$/.test(host) ? (await probe(host, port) ? "reachable" : "unreachable") : "unknown";
  }
  return {
    connection, host, port, database, source, explicit, risky,
    configCached: await exists(join(root, "bootstrap", "cache", "config.php")), service, url, connectionName, unknown
  };
}

export function tcpReachable(host: string, port: number, timeoutMs = 700): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect({ host, port });
    const done = (ok: boolean) => { s.destroy(); resolve(ok); };
    s.setTimeout(timeoutMs, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}
