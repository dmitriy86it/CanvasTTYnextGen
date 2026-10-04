// Readiness of a goal before any model turn (stages 11–12). Facts only, read from the project folder, the user's login
// shell environment and the installed CLIs: where the agents will work, what the checks will run, whether the programs
// of those commands are on the user's PATH, which stack the project is. It never starts a model, writes nothing, and
// never presents a missing check as readiness.
import { execFile } from "node:child_process";
import { access, constants, lstat, readFile, readdir } from "node:fs/promises";
import { delimiter, isAbsolute, join, relative } from "node:path";
import { promisify } from "node:util";
import { orchestrationAvailable } from "../../../shared/orchestration.ts";
import type { OrchestrationCodexModels, OrchestrationReadiness, OrchestrationReadinessItem, OrchestrationRoleModels } from "../../../shared/orchestration.ts";
import { laravelTestDb, neededSteps, worktreeSteps } from "./prepare.ts";
import { parseCliVersion } from "./providers.ts";
import type { LaravelTestDb, PrepareStep } from "./prepare.ts";

const run = promisify(execFile);

// What `node --test` finds with no arguments (Node 22+ default patterns), outside node_modules and hidden folders.
const NODE_TEST_FILE = /(?:^|\/)(?:test|tests)\/.*\.(?:[cm]?js)$|(?:^|\/)[^/]*[.\-_]test\.(?:[cm]?js)$|(?:^|\/)test\.(?:[cm]?js)$|(?:^|\/)test-[^/]*\.(?:[cm]?js)$/;
const PHP_TEST_FILE = /(?:^|\/)tests\/.*Test\.php$/;
const SCAN_LIMIT = 20_000; // entries read while looking for test files

async function exists(p: string): Promise<boolean> {
  return lstat(p).then(() => true, () => false);
}

// Test files matching `pattern`, counted up to `limit` (a fact for the user, not a proof of anything).
export async function countTestFiles(root: string, pattern: RegExp = NODE_TEST_FILE, limit = 50): Promise<{ count: number; complete: boolean }> {
  let count = 0, scanned = 0;
  const stack = [root];
  while (stack.length && count < limit) {
    const dir = stack.pop()!;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (++scanned > SCAN_LIMIT) return { count, complete: false };
      if (e.name.startsWith(".") || e.name === "node_modules" || e.name === "vendor") continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile() && pattern.test(relative(root, p))) { if (++count >= limit) break; }
    }
  }
  return { count, complete: true };
}

// Commands a project's own files suggest; never chosen silently, only offered to the user.
export async function suggestCommands(root: string): Promise<{ stack: string; commands: string[]; laravel: boolean }> {
  const json = async (f: string) => JSON.parse(await readFile(join(root, f), "utf8").catch(() => "null")) as Record<string, unknown> | null;
  const laravel = await exists(join(root, "artisan")) && await exists(join(root, "composer.json"));
  if (laravel) return { stack: "laravel", commands: ["php artisan test"], laravel };
  const composer = await json("composer.json").catch(() => null);
  if (composer) {
    const scripts = (composer.scripts ?? {}) as Record<string, unknown>;
    return { stack: "php", commands: scripts.test ? ["composer test"] : ["vendor/bin/phpunit"], laravel };
  }
  const pkg = await json("package.json").catch(() => null);
  if (pkg) {
    const scripts = (pkg.scripts ?? {}) as Record<string, unknown>;
    const pm = await exists(join(root, "pnpm-lock.yaml")) ? "pnpm" : await exists(join(root, "yarn.lock")) ? "yarn" : "npm";
    return { stack: "node", commands: typeof scripts.test === "string" && !/no test specified/.test(scripts.test) ? [`${pm} test`] : ["node --test"], laravel };
  }
  if (await exists(join(root, "pyproject.toml")) || await exists(join(root, "pytest.ini"))) return { stack: "python", commands: ["pytest"], laravel };
  if (await exists(join(root, "go.mod"))) return { stack: "go", commands: ["go test ./..."], laravel };
  if (await exists(join(root, "Cargo.toml"))) return { stack: "rust", commands: ["cargo test"], laravel };
  if (await exists(join(root, "Gemfile"))) return { stack: "ruby", commands: ["bundle exec rake test"], laravel };
  return { stack: "unknown", commands: [], laravel };
}

// The program a command line starts: its first word, or a path relative to the project. A shell keyword, a variable
// assignment or a compound line is not resolved (said as "not checked", never as found). Aliases and functions of the
// user's rc files are not seen here: such a word is reported as missing with that caveat.
export async function findCommandProgram(word: string, root: string, env: Readonly<Record<string, string>>): Promise<"found" | "missing" | "unchecked"> {
  if (!word || /[=$`|;&(<>]/.test(word) || ["if", "for", "while", "cd", "export", "source", ".", "env", "time", "exec"].includes(word)) return "unchecked";
  const executable = (p: string) => access(p, constants.X_OK).then(() => true, () => false);
  if (word.includes("/")) return (await executable(isAbsolute(word) ? word : join(root, word))) ? "found" : "missing";
  for (const dir of (env.PATH ?? "").split(delimiter)) if (dir && await executable(join(dir, word))) return "found";
  return "missing";
}

// The readiness item of a Laravel project's test database (also checked again by main when a run is created or
// resumed). facts.reason says why (the renderer's words): config_cached, url_unparsed, url_overrides (a database URL
// replaces DB_*), remote_host, config_unknown (facts.unknown: the field not known), not_for_tests, unreachable, for_tests. Never a URL's
// credentials: only the variable, driver, host, port and database.
export function testDbItem(db: LaravelTestDb): OrchestrationReadinessItem {
  const hostPort = `${db.host ?? ""}${db.port ? `:${db.port}` : ""}`;
  const base = { source: db.source, connection: db.connection ?? "", connectionName: db.connectionName ?? "", host: hostPort, database: db.database ?? "", variable: db.url?.variable ?? "", unknown: db.unknown?.field ?? "" };
  const item = (level: OrchestrationReadinessItem["level"], reason: string, detail: string): OrchestrationReadinessItem =>
    ({ id: "testdb", level, detail, facts: { ...base, reason } });
  const from = db.source === "process" ? "the login shell's environment" : db.source === "none" ? "config/database.php" : db.source;
  const url = db.url ? `${db.url.variable} (from ${db.url.source === "process" ? "the login shell's environment" : db.url.source})` : "";
  const fix = db.url && /^[A-Za-z0-9_]+$/.test(db.url.variable) ? `set a test database in phpunit.xml, e.g. <env name="${db.url.variable}" value="" force="true"/> with DB_CONNECTION/DB_DATABASE` : "set a test database in phpunit.xml or .env.testing";
  if (db.configCached) return item("blocker", "config_cached", "bootstrap/cache/config.php exists: the tests would use the cached configuration, not phpunit.xml; run php artisan config:clear");
  if (db.url && !db.url.parsed) return item("blocker", "url_unparsed", `the database URL in ${url} is not understood: the tests may connect anywhere; ${fix}`);
  if (db.risky) return db.url
    ? item("blocker", "url_overrides", `the database URL in ${url} replaces DB_*: the tests would use ${db.connection} ${db.database ?? ""} on ${hostPort}; ${fix}`)
    : item("blocker", "remote_host", `the tests would use the database of ${from} on ${db.host}: ${fix}`);
  if (db.unknown) {
    const where = db.unknown.field === "default" ? "the default connection" : db.unknown.field === "connection" ? `the connection '${db.connectionName}'` : `'${db.unknown.field}' of the connection '${db.connectionName}'`;
    return item("confirm", "config_unknown", `config/database.php: ${where} is not known (${db.unknown.what}): which database the tests use is not known; set DB_CONNECTION and DB_DATABASE for the tests in phpunit.xml`);
  }
  if (!db.explicit) return db.url
    ? item("confirm", "url_overrides", `the database URL in ${url} replaces DB_*: the tests would use ${db.connection} ${db.database ?? ""}${db.host ? ` on ${hostPort}` : ""}; it may be your working database; ${fix}`)
    : item("confirm", "not_for_tests", `the tests would use ${db.connection} ${db.database ?? ""} on ${db.host ?? "?"} from ${from}: it may be your working database; nothing sets a test database (phpunit.xml or .env.testing)`);
  if (db.service === "unreachable") return item("warning", "unreachable", `the test database ${db.host}:${db.port} does not answer: start the service`);
  return item("ok", "for_tests", `${db.connection} from ${db.url ? url : from}`);
}

export interface ReadinessInput {
  project: string; // the lead card's project (absolute, real)
  commands: readonly string[]; // the check commands the user entered
  optionalChecks?: boolean; // journal v2 (development flag): no command — the lead proposes them, the person decides
  workMode: "project" | "copy" | "worktree";
  // Stage 13: the profile's preparation (steps the autopilot runs itself when auto).
  prepare?: { steps: readonly PrepareStep[]; auto: boolean };
  dbProbe?: (host: string, port: number) => Promise<boolean>; // tests
  platform: string; // process.platform
  gitPath: string | null;
  // The measured runtime, or why it could not be measured (the CLIs, the login shell).
  runtime: { ok: true; versions: Record<"codex" | "claude", string>; env: Readonly<Record<string, string>>; shell: string; direnv?: string; executables?: Record<"codex" | "claude", string>; codexEnv?: Readonly<Record<string, string>> } | { ok: false; code: string; detail: string };
  checkedVersions: Readonly<Record<"codex" | "claude", readonly string[]>>; // protocol shapes compared with these
  busy: boolean; // another run of this application works in this folder now
}

// The one platform item: a blocker wherever orchestrationAvailable() is false (project checks need macOS Seatbelt).
export function platformItem(platform: string): OrchestrationReadinessItem {
  return orchestrationAvailable(platform)
    ? { id: "platform", level: "ok", detail: platform }
    : { id: "platform", level: "blocker", detail: `project checks run only in the macOS Seatbelt sandbox, not on ${platform}`, facts: { code: "unsupported_platform" } };
}

export async function assessReadiness(input: ReadinessInput): Promise<OrchestrationReadiness> {
  const items: OrchestrationReadinessItem[] = [];
  const add = (item: OrchestrationReadinessItem) => items.push(item);
  const root = input.project;

  add(platformItem(input.platform));

  const rt = input.runtime;
  if (!rt.ok) add({ id: rt.code === "environment_error" ? "env" : "clis", level: "blocker", detail: rt.detail.slice(0, 300), facts: { code: rt.code } });
  else {
    const versions = Object.fromEntries((["codex", "claude"] as const).map((p) => [p, rt.versions[p].slice(0, 60)]));
    // the exact version: "0.155.10" is not "0.155.1"
    const unchecked = (["codex", "claude"] as const).filter((p) => !input.checkedVersions[p].includes(parseCliVersion(p, rt.versions[p]) ?? rt.versions[p].trim()));
    add(unchecked.length
      ? { id: "clis", level: "warning", detail: `protocol not compared with this version of ${unchecked.join(", ")}`, facts: { ...versions, unchecked: unchecked.join(", ") } }
      : { id: "clis", level: "ok", detail: "installed CLIs", facts: versions });
    add({ id: "env", level: "ok", detail: "login shell environment", facts: { shell: rt.shell, variables: Object.keys(rt.env).length, pathEntries: (rt.env.PATH ?? "").split(delimiter).filter(Boolean).length, ...(rt.direnv ? { direnv: rt.direnv } : {}) } });
    if (rt.direnv === "not_allowed") add({ id: "direnv", level: "warning", detail: ".envrc is not allowed: run `direnv allow` in a terminal if it is yours; CanvasTTY never allows it" });
  }

  // Snapshots of the work folder are Git objects: the project must be the top level of a Git repository.
  const git = await exists(join(root, ".git"));
  if (!git) add({ id: "git", level: "blocker", detail: "not the top level of a Git repository" });
  else if (input.gitPath) {
    const dirty = await run(input.gitPath, ["-C", root, "status", "--porcelain", "--untracked-files=normal"], { timeout: 20_000, maxBuffer: 8 * 1024 * 1024 })
      .then((r) => r.stdout.split("\n").filter(Boolean).length, () => null);
    add({ id: "git", level: dirty ? "info" : "ok", detail: dirty ? "uncommitted changes are kept" : "clean working tree", facts: { changed: dirty } });
  }

  add(input.workMode === "project"
    ? { id: "workdir", level: "info", detail: "the agents work in the project folder and change its files directly", facts: { path: root } }
    : input.workMode === "worktree"
      ? { id: "workdir", level: "info", detail: "a separate Git worktree on its own branch: node_modules/ and vendor/ are cloned from the project when their lock files match, the rest is prepared in it", facts: { path: root, mode: "worktree" } }
      : { id: "workdir", level: "warning", detail: "a separate copy: node_modules/ and vendor/ are cloned from the project when their lock files match, the rest is prepared in it; .env is not in it", facts: { path: root } });
  if (input.busy) add({ id: "busy", level: "blocker", detail: "another run works in this folder now" });

  const s = await suggestCommands(root);
  add({ id: "stack", level: s.stack === "unknown" ? "info" : "ok", detail: s.stack, facts: { stack: s.stack, suggest: s.commands.join("\n"), laravel: s.laravel } });
  // Preparation: what the profile's steps would do now. In a copy or a worktree everything ignored is missing at the
  // start (the dependency folders cloned from the project then need no step; that is known only once they are).
  const fresh = input.workMode !== "project";
  const prep = input.prepare && fresh ? { ...input.prepare, steps: await worktreeSteps(root, input.prepare.steps) } : input.prepare;
  const needed = prep ? (fresh ? prep.steps.map((step, index) => ({ step, index })) : await neededSteps(root, prep.steps)) : [];
  if (prep && needed.length) {
    add({
      id: "prepare", level: prep.auto ? "info" : "warning",
      detail: prep.auto ? "prepared automatically before the work" : "needed, but automatic preparation is off",
      facts: { steps: needed.map((n) => n.step.command).join("\n") }
    });
  }
  const prepared = (path: string) => needed.some((n) => n.step.unless !== null && path.startsWith(n.step.unless.split("/")[0]));
  if (s.laravel) {
    const vendor = await exists(join(root, "vendor", "autoload.php"));
    add({
      id: "laravel", level: vendor || (prep?.auto && prepared("vendor/")) ? "ok" : "warning",
      detail: vendor ? "vendor/ installed" : prep?.auto && prepared("vendor/") ? "vendor/ is prepared automatically (composer install)" : "vendor/ is missing: run composer install",
      facts: { vendor, envFile: await exists(join(root, ".env")), prepared: !vendor && prep?.auto === true && prepared("vendor/") }
    });
    // Never the production database for the tests, and never "ok" for a database nothing sets for the tests: a local
    // one from .env or from the environment may be the person's working database.
    add(testDbItem(await laravelTestDb(root, input.dbProbe, { env: rt.ok ? rt.env : undefined, worktree: input.workMode === "worktree" })));
  }

  if (input.commands.length === 0) {
    add(input.optionalChecks ? { id: "commands", level: "info", detail: "no check command: the lead proposes them, you accept or edit them" }
      : { id: "commands", level: "blocker", detail: "no check command: nothing would verify the result" });
  }
  else if (rt.ok) {
    for (const [i, line] of input.commands.entries()) {
      const word = line.trim().split(/\s+/)[0] ?? "";
      const found = await findCommandProgram(word, root, rt.env);
      const later = found === "missing" && prep?.auto === true && prepared(word);
      add({
        id: `command_${i + 1}`, level: later ? "info" : found === "missing" ? "warning" : found === "found" ? "ok" : "info",
        detail: later ? `${word} appears after preparation` : found === "missing" ? `${word} is not on the login shell's PATH` : found === "found" ? `${word} found` : "not resolved",
        facts: { command: line.slice(0, 200), program: word.slice(0, 100), found, later }
      });
    }
  }
  const tests = s.laravel || s.stack === "php" ? await countTestFiles(root, PHP_TEST_FILE) : s.stack === "node" ? await countTestFiles(root) : null;
  if (tests && tests.count === 0 && tests.complete) add({ id: "tests", level: "confirm", detail: "no test file found: a check may pass without testing anything", facts: { testFiles: 0 } });
  else if (tests) add({ id: "tests", level: "ok", detail: "test files", facts: { testFiles: tests.count >= 50 ? "50+" : tests.count } });

  add({ id: "permissions", level: "info", detail: "the CLIs' own settings decide; their prompts come to this panel" });
  return { ready: !items.some((i) => i.level === "blocker"), items };
}

// The models of the roles before any model turn. Codex: the model a role would run with (the chosen one, else the one its
// configuration names) must be in what model/list offers this account; otherwise a blocker. Claude has no such list
// without a model turn: its choice is shown, never checked. codexRoles: the roles Codex plays in this run.
export function modelItem(list: OrchestrationCodexModels, chosen: OrchestrationRoleModels, codexRoles: readonly ("lead" | "executor" | "reviewer")[]): OrchestrationReadinessItem {
  const roles = { lead: chosen.lead ?? "cli", executor: chosen.executor ?? "cli", reviewer: chosen.reviewer ?? "cli" };
  if (!list.ok) return { id: "model", level: "warning", detail: `the models Codex offers could not be read: ${list.error ?? "no answer"}`, facts: { code: "model_list_failed", ...roles } };
  const missing = codexRoles.map((role) => ({ role, model: chosen[role] ?? list.configModel, chosen: chosen[role] !== null }))
    .filter((x) => x.model !== null && !list.ids.includes(x.model));
  if (missing.length) {
    const model = missing[0].model!;
    return {
      id: "model", level: "blocker", detail: `Codex: model ${model} is not available to your account`,
      facts: { code: "model_unavailable", provider: "codex", model, roles: missing.filter((x) => x.model === model).map((x) => x.role).join(", "), source: missing[0].chosen ? "chosen" : "config", ...roles }
    };
  }
  return { id: "model", level: "ok", detail: "models", facts: { ...roles, ...(list.configModel ? { config: list.configModel } : {}) } };
}
