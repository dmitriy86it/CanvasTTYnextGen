// Stage 13 review: the database a Laravel project's tests would use when a database URL (DB_URL, DATABASE_URL) is in
// effect. Laravel's ConfigurationUrlParser replaces driver, host, port and database with the URL's, whatever DB_* say.
// Made-up addresses only; nothing connects to a database. A URL's password never shows in what the app says or keeps.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { findGit } from "../src/main/services/orchestration/git.ts";
import { createRunManager, testNativeRuntime } from "../src/main/services/orchestration/manager.ts";
import { laravelTestDb, parseDatabaseConfig, parseDbUrl } from "../src/main/services/orchestration/prepare.ts";
import { createProfileStore, suggestProfile } from "../src/main/services/orchestration/profile.ts";
import { testDbItem } from "../src/main/services/orchestration/readiness.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GIT = findGit(process.env);
const NODE = fs.realpathSync(process.execPath);
const LAUNCH = { command: NODE, args: [path.join(HERE, "..", "src", "orchestration", "supervisor.mjs")], env: {} };
const OPTS = { skip: process.platform === "win32" && "orchestration runs on macOS and Linux", timeout: 120_000 };
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "canvastty-testdb-")));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
fs.writeFileSync(path.join(TMP, "gitconfig"), "");
const GIT_ENV = { PATH: process.env.PATH, HOME: TMP, GIT_CONFIG_GLOBAL: path.join(TMP, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const SECRET = "s3cr3t-Pa55";
const PROD = `mysql://app:${SECRET}@production.invalid:3307/working`;
const SAFE_UNIT = '<phpunit><php><env name="APP_ENV" value="testing"/><env name="DB_CONNECTION" value="sqlite" force="true"/><env name="DB_DATABASE" value=":memory:" force="true"/></php></phpunit>';
// Stage 13 review 3: config/database.php now has to name the default connection and each driver (as laravel/laravel's does)
const L11 = "<?php\nreturn ['default' => env('DB_CONNECTION', 'sqlite'), 'connections' => [\n  'sqlite' => ['driver' => 'sqlite', 'url' => env('DB_URL'), 'database' => env('DB_DATABASE', database_path('database.sqlite'))],\n  'mysql' => ['driver' => 'mysql', 'url' => env('DB_URL'), 'host' => env('DB_HOST', '127.0.0.1'), 'database' => env('DB_DATABASE', 'laravel')],\n],\n  'redis' => ['default' => ['url' => env('REDIS_URL')]]];\n";
const L10 = L11.replaceAll("env('DB_URL')", "env('DATABASE_URL')");

let n = 0;
function dir(files) {
  const d = path.join(TMP, `p-${++n}`);
  for (const [f, text] of Object.entries({ artisan: "", "composer.json": "{}", ...files })) {
    fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true });
    fs.writeFileSync(path.join(d, f), text);
  }
  return d;
}
const judge = async (files, env) => { const db = await laravelTestDb(dir(files), async () => true, { env }); return { db, item: testDbItem(db) }; };
const noSecret = (x) => assert.ok(!JSON.stringify(x).includes(SECRET), `the password shows: ${JSON.stringify(x)}`);

// The external review's reproduction, as it was reported.
test("inherited DB_URL must not be declared safe SQLite by readiness", async () => {
  const root = fs.mkdtempSync(path.join(TMP, "cto-dburl-review-"));
  fs.writeFileSync(path.join(root, "phpunit.xml"), '<phpunit><php><env name="DB_CONNECTION" value="sqlite" force="true"/><env name="DB_DATABASE" value=":memory:" force="true"/></php></phpunit>');
  const db = await laravelTestDb(root, async () => false, { env: { DB_URL: "mysql://test:test@production.invalid/working" } });
  const item = testDbItem(db);
  assert.notEqual(item.level, "ok", JSON.stringify({ db, item }));
});

test("the URL parse agrees with Laravel's ConfigurationUrlParser (fixture from scripts/laravel-url-crosscheck.mjs)", () => {
  const { config, cases } = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures", "orchestration", "laravel-url-cases.json"), "utf8"));
  assert.ok(cases.length >= 25);
  for (const c of cases) {
    const p = parseDbUrl(c.url);
    // not understood here: refused (blocker), never taken as safe
    if (p === null) continue;
    assert.deepEqual({ driver: p.driver ?? config.driver, host: p.host, port: p.port, database: p.database ?? config.database }, c.laravel, c.url);
    noSecret(p);
  }
  assert.equal(parseDbUrl("sqlsrv:server=sql.invalid,1433;database=app"), null);
});

test("config/database.php is read as a bounded subset of a PHP array, never as a guess", () => {
  const conf = (php) => { const v = parseDatabaseConfig(php); return v.kind === "array" ? Object.fromEntries(v.entries) : v; };
  const c = conf(`<?php
use Illuminate\\Support\\Str;
// 'default' => 'mysql',
# 'default' => 'pgsql',
/* 'default' => 'sqlsrv', */
return array(
  'default' => env("DB_CONNECTION", 'sqlite'), // a comment ] ) ,
  'connections' => ['a' => ['driver' => 'mysql', 'host' => 'db.invalid', 'port' => 3306, 'url' => null, 'x' => '//not a comment'],
                    'a' => ['driver' => 'pgsql']],
);`);
  assert.deepEqual(c.default, { kind: "env", name: "DB_CONNECTION", def: "sqlite" });
  assert.deepEqual(Object.fromEntries(c.connections.entries.get("a").entries), { driver: { kind: "lit", value: "pgsql" } }, "a later key replaces an earlier one");
  const x = conf("<?php return ['a' => env('X') ?: 'y', 'b' => 'p'.'q', 'c' => $x, 'd' => Str::slug('x'), 'e' => env('X', env('Y')), 'f' => \"u$v\", 'g' => env('X', database_path('d'))];");
  assert.deepEqual(Object.values(x).map((v) => v.what ?? v.defWhat), ["a conditional", "a concatenation", "a variable", "slug()", "env() with an argument that is not a literal", "a string with interpolation", "database_path()"]);
  assert.equal(conf("<?php return array_merge(['default' => 'mysql'], []);").kind, "unsupported");
  assert.equal(conf("<?php return <<<X\n'default' => 'mysql'\nX;").kind, "unsupported", "a heredoc");
  assert.equal(parseDatabaseConfig("<?php return [...$base, 'default' => 'mysql'];").dynamic, true);
});

test("DB_URL (Laravel 11+) and DATABASE_URL (older): the name config/database.php reads", async () => {
  for (const [config, name, other] of [[L11, "DB_URL", "DATABASE_URL"], [L10, "DATABASE_URL", "DB_URL"]]) {
    const { db, item } = await judge({ "phpunit.xml": SAFE_UNIT, "config/database.php": config }, { [name]: PROD });
    assert.deepEqual([db.connection, db.host, db.port, db.database, db.source], ["mysql", "production.invalid", 3307, "working", "process"]);
    assert.deepEqual([item.level, item.facts.reason, item.facts.variable, item.facts.host], ["blocker", "url_overrides", name, "production.invalid:3307"]);
    noSecret({ db, item });
    // the other name is not read by this project
    assert.equal((await judge({ "phpunit.xml": SAFE_UNIT, "config/database.php": config }, { [other]: PROD })).item.level, "ok");
  }
  // no config/database.php (Laravel 11+ may have none): both names count
  for (const name of ["DB_URL", "DATABASE_URL"]) assert.equal((await judge({ "phpunit.xml": SAFE_UNIT }, { [name]: PROD })).item.level, "blocker", name);
  // 'url' that is not env(NAME): not known, never "ok"
  const unknown = await judge({ "phpunit.xml": SAFE_UNIT, "config/database.php": "<?php return ['default' => 'sqlite', 'connections' => ['sqlite' => ['driver' => 'sqlite', 'url' => config('x')]]];" });
  assert.deepEqual([unknown.item.level, unknown.item.facts.reason, unknown.item.facts.unknown], ["confirm", "config_unknown", "url"]);
});

test("where the URL comes from and which wins: phpunit force > process > phpunit > .env.<APP_ENV> or .env", async () => {
  const files = { "phpunit.xml": SAFE_UNIT, "config/database.php": L11 };
  // .env and .env.testing (APP_ENV=testing from phpunit.xml) as dotenv reads them
  for (const f of [".env", ".env.testing"]) {
    const { db, item } = await judge({ ...files, [f]: `DB_URL="${PROD}"\n` });
    assert.deepEqual([db.source, item.level], [f, f === ".env" ? "blocker" : "ok"], f);
  }
  // .env.testing is not read when APP_ENV is not testing: .env is (LoadEnvironmentVariables)
  const noAppEnv = await judge({ "phpunit.xml": SAFE_UNIT.replace('<env name="APP_ENV" value="testing"/>', ""), "config/database.php": L11, ".env": `DB_URL=${PROD}\n`, ".env.testing": "DB_URL=\n" });
  assert.equal(noAppEnv.item.level, "blocker");
  // an empty .env.testing value is set: dotenv does not fall back to .env
  assert.equal((await judge({ ...files, ".env": `DB_URL=${PROD}\n`, ".env.testing": "DB_URL=\n" })).item.level, "ok");
  // dotenv never replaces a variable of the process
  assert.equal((await judge({ ...files, ".env": "DB_URL=\n" }, { DB_URL: PROD })).item.level, "blocker");
  // phpunit.xml without force does not replace the process; with force it does
  const unit = (attrs) => ({ "config/database.php": L11, "phpunit.xml": SAFE_UNIT.replace("</php>", `<env name="DB_URL" value="" ${attrs}/></php>`) });
  assert.equal((await judge(unit(""), { DB_URL: PROD })).item.level, "blocker");
  const forced = await judge(unit('force="true"'), { DB_URL: PROD });
  assert.deepEqual([forced.db.url, forced.db.connection, forced.db.database, forced.item.level], [null, "sqlite", ":memory:", "ok"], "the explicit override");
  assert.equal((await judge(unit(""), {})).item.level, "ok", "phpunit.xml's empty value over .env");
  // Env::get: null/false/empty are no URL
  for (const v of ["null", "(null)", "false", "empty", "\"\""]) assert.equal((await judge(files, { DB_URL: v })).item.level, "ok", v);
});

test("what the URL points at decides the level", async () => {
  const files = { "phpunit.xml": SAFE_UNIT, "config/database.php": L11 };
  const at = async (url) => (await judge(files, { DB_URL: url })).item;
  assert.equal((await at("sqlite:///:memory:")).level, "ok", "sqlite in memory");
  assert.equal((await at("sqlite://null/:memory:")).level, "ok");
  const file = await at("sqlite:///var/data/app.sqlite");
  assert.deepEqual([file.level, file.facts.reason, file.facts.database], ["confirm", "url_overrides", "var/data/app.sqlite"]);
  const local = await at(`mysql://root:${SECRET}@127.0.0.1/app_dev`);
  assert.deepEqual([local.level, local.facts.reason], ["confirm", "url_overrides"]);
  assert.equal((await at("postgresql://u:p@[::1]:5432/app")).level, "confirm");
  for (const url of ["postgres://u:p@pg.invalid/app", `pgsql://u:${SECRET}@pg.invalid:5433/app?sslmode=require`, "mysql://u:p@127.0.0.1/app?host=production.invalid"]) {
    const item = await at(url);
    assert.deepEqual([item.level, item.facts.reason], ["blocker", "url_overrides"], url);
    noSecret(item);
  }
  for (const url of ["mysql://u:p@production.invalid:abc/app", "sqlsrv:server=sql.invalid,1433;database=app", "${OTHER_URL}", "true"]) {
    const item = await at(url);
    assert.deepEqual([item.level, item.facts.reason], ["blocker", "url_unparsed"], url);
  }
  noSecret(await at(`mysql://u:${SECRET}@production.invalid:99999/app`));
  // a URL set for the tests (phpunit.xml force) on a local server is the tests' own database
  const own = await judge({ "config/database.php": L11, "phpunit.xml": SAFE_UNIT.replace("</php>", '<env name="DB_URL" value="mysql://root@127.0.0.1/app_testing" force="true"/></php>') });
  assert.deepEqual([own.db.explicit, own.item.level, own.item.facts.source], [true, "ok", "phpunit"]);
  // the host of a URL is never probed
  let probed = 0;
  await laravelTestDb(dir(files), async () => { probed++; return true; }, { env: { DB_URL: PROD } });
  assert.equal(probed, 0);
});

// ---------------- review 3: only the active connection's URL counts ----------------

const TWO = (order) => `<?php return ['default' => env('DB_CONNECTION', 'mysql'), 'connections' => [${order.map((c) => ({
  sqlite: "'sqlite' => ['driver' => 'sqlite', 'url' => env('SQLITE_URL'), 'database' => env('DB_DATABASE', database_path('database.sqlite'))]",
  mysql: "'mysql' => ['driver' => 'mysql', 'url' => env('DATABASE_URL'), 'host' => env('DB_HOST', '127.0.0.1'), 'database' => env('DB_DATABASE', 'forge')]"
})[c]).join(", ")}]];`;
const MYSQL_UNIT = '<phpunit><php><env name="APP_ENV" value="testing"/><env name="DB_CONNECTION" value="mysql" force="true"/><env name="DB_DATABASE" value="app_testing" force="true"/></php></phpunit>';
const REVIEW_ENV = { SQLITE_URL: "sqlite:///:memory:", DATABASE_URL: `mysql://test:${SECRET}@production.invalid/working` };

test("review 3: the URL of an inactive SQLite connection does not hide the active MySQL connection's URL, in any order", async () => {
  for (const order of [["sqlite", "mysql"], ["mysql", "sqlite"]]) {
    const { db, item } = await judge({ "config/database.php": TWO(order), "phpunit.xml": MYSQL_UNIT }, REVIEW_ENV);
    assert.deepEqual([db.connectionName, db.connection, db.host, db.database, db.unknown], ["mysql", "mysql", "production.invalid", "working", null], order.join());
    assert.deepEqual([item.level, item.facts.reason, item.facts.variable, item.facts.connectionName], ["blocker", "url_overrides", "DATABASE_URL", "mysql"], order.join());
    noSecret({ db, item });
  }
  // the active SQLite in memory: the inactive MySQL's production URL does not matter
  const lite = await judge({ "config/database.php": TWO(["mysql", "sqlite"]), "phpunit.xml": SAFE_UNIT }, { DATABASE_URL: PROD });
  assert.deepEqual([lite.db.connectionName, lite.db.url, lite.item.level], ["sqlite", null, "ok"]);
});

test("review 3: a connection's name is not its driver", async () => {
  const config = `<?php return ['default' => env('DB_CONNECTION', 'mysql'), 'connections' => [
    'mysql' => ['driver' => 'mysql', 'url' => env('DB_URL'), 'host' => env('DB_HOST', '127.0.0.1')],
    'testing' => ['driver' => 'sqlite', 'database' => ':memory:'],
    'reporting' => ['driver' => 'mysql', 'url' => env('REPORTING_URL'), 'host' => 'reports.invalid', 'database' => 'reports'],
  ]];`;
  const unit = (name) => `<phpunit><php><env name="DB_CONNECTION" value="${name}" force="true"/></php></phpunit>`;
  const testing = await judge({ "config/database.php": config, "phpunit.xml": unit("testing") }, { DB_URL: PROD, REPORTING_URL: PROD });
  assert.deepEqual([testing.db.connectionName, testing.db.connection, testing.db.database, testing.item.level], ["testing", "sqlite", ":memory:", "ok"]);
  const reporting = await judge({ "config/database.php": config, "phpunit.xml": unit("reporting") }, {});
  assert.deepEqual([reporting.db.connectionName, reporting.db.connection, reporting.item.level, reporting.item.facts.reason], ["reporting", "mysql", "blocker", "remote_host"]);
  const url = await judge({ "config/database.php": config, "phpunit.xml": unit("reporting") }, { REPORTING_URL: PROD });
  assert.deepEqual([url.item.level, url.item.facts.variable, url.item.facts.host], ["blocker", "REPORTING_URL", "production.invalid:3307"]);
  noSecret(url);
  // "sqlite" named by DB_CONNECTION but not among the connections: not known, whatever the driver names say
  const missing = await judge({ "config/database.php": config, "phpunit.xml": SAFE_UNIT });
  assert.deepEqual([missing.item.level, missing.item.facts.reason, missing.item.facts.unknown], ["confirm", "config_unknown", "connection"]);
});

test("review 3: the standard configuration, with or without config/database.php (Laravel 11+: one DB_URL)", async () => {
  for (const files of [{ "config/database.php": L11 }, {}]) {
    const has = Object.keys(files).length ? "file" : "no file";
    assert.equal((await judge({ ...files, "phpunit.xml": SAFE_UNIT }, { DB_URL: "sqlite:///:memory:" })).item.level, "ok", has);
    const prod = await judge({ ...files, "phpunit.xml": SAFE_UNIT }, { DB_URL: PROD });
    assert.deepEqual([prod.db.connectionName, prod.item.level, prod.item.facts.variable], ["sqlite", "blocker", "DB_URL"], has);
    // DB_CONNECTION=mysql from .env: the framework's defaults (127.0.0.1:3306, database "laravel") are a local database
    const local = await judge({ ...files, ".env": "DB_CONNECTION=mysql\n" });
    assert.deepEqual([local.db.connection, local.db.host, local.db.port, local.item.level, local.item.facts.reason], ["mysql", "127.0.0.1", 3306, "confirm", "not_for_tests"], has);
  }
  // nothing set, no file: the framework's sqlite file (database/database.sqlite) is not the tests' own
  const none = await judge({});
  assert.deepEqual([none.db.connectionName, none.db.database, none.item.level], ["sqlite", "database/database.sqlite", "confirm"]);
});

test("review 3: an active connection outside the subset is not known, with the field and the construct", async () => {
  const unit = SAFE_UNIT.replace('<env name="DB_DATABASE" value=":memory:" force="true"/>', "");
  const cases = [
    ["<?php return ['default' => config('app.db'), 'connections' => ['sqlite' => ['driver' => 'sqlite', 'database' => ':memory:']]];", SAFE_UNIT, "default", "config()"],
    ["<?php return ['default' => 'mysql', 'connections' => ['sqlite' => ['driver' => 'sqlite', 'database' => ':memory:']]];", "", "connection", "no connection 'mysql'"],
    ["<?php return ['default' => 'main', 'connections' => ['main' => ['driver' => env('DB_DRIVER', 'sqlite'), 'database' => ':memory:']]];", "", "driver", "not a literal"],
    ["<?php return ['default' => 'main', 'connections' => ['main' => ['driver' => 'sqlite', 'url' => $secrets->url(), 'database' => ':memory:']]];", "", "url", "url()"],
    ["<?php return ['default' => 'sqlite', 'connections' => ['sqlite' => ['driver' => 'sqlite', 'database' => database_path('database.sqlite')]]];", unit, "database", "database_path()"],
    ["<?php return ['default' => 'mysql', 'connections' => ['mysql' => ['driver' => 'mysql', 'host' => gethostname(), 'database' => ':memory:']]];", "", "host", "gethostname()"],
    ["<?php return ['default' => 'sqlite', 'connections' => [...$base, 'sqlite' => ['driver' => 'sqlite', 'database' => ':memory:']]];", "", "connection", "an array with a spread or computed keys"],
    ["<?php return <<<PHP\n[]\nPHP;", "", "default", "not a plain"]
  ];
  for (const [config, phpunit, field, what] of cases) {
    const { db, item } = await judge({ "config/database.php": config, ...(phpunit ? { "phpunit.xml": phpunit } : {}) }, { DB_URL: PROD });
    assert.deepEqual([item.level, item.facts.reason, item.facts.unknown], ["confirm", "config_unknown", field], config);
    assert.ok(item.detail.includes(what), `${item.detail} / ${what}`);
    assert.equal(db.url, null, "no URL taken from a connection that is not known");
    noSecret({ db, item });
  }
  // laravel/laravel's own sqlite: env('DB_DATABASE', database_path(...)) is not known while DB_DATABASE is unset, known when set
  assert.equal((await judge({ "config/database.php": L11, "phpunit.xml": unit })).item.facts.unknown, "database");
  assert.equal((await judge({ "config/database.php": L11, "phpunit.xml": SAFE_UNIT })).item.level, "ok");
});

// ---------------- review 4: the whole file is a plain `return [...]` ----------------

test("review 4: a return that may not be the one PHP runs makes the configuration unknown, never SQLite", async () => {
  const safe = "['default' => 'sqlite', 'connections' => ['sqlite' => ['driver' => 'sqlite', 'database' => ':memory:']]]";
  const actual = `['default' => 'mysql', 'connections' => ['mysql' => ['driver' => 'mysql', 'host' => 'production.invalid', 'url' => env('DB_URL'), 'database' => 'working']]]`;
  const cases = [
    [`<?php function unusedConfig() { return ${safe}; } return ${actual};`, "before"],
    [`<?php if (false) { return ${safe}; } return ${actual};`, "before"],
    [`<?php if (false) return ${safe}; return ${actual};`, "before"],
    [`<?php if (false) return ${safe}; else return ${actual};`, "before"],
    [`<?php class Cfg { public function get() { return ${safe}; } } return ${actual};`, "before"],
    [`<?php $f = function () { return ${safe}; }; return ${actual};`, "before"],
    [`<?php $x = 1; return ${safe};`, "before"],
    [`<?php return ${safe}; return ${actual};`, "after"],
    [`<?php return ${safe}; exit;`, "after"],
    [`<?php use Foo; return ${safe}; ?>\n<?php return ${actual};`, "after"]
  ];
  for (const [config, where] of cases) {
    const v = parseDatabaseConfig(config);
    assert.equal(v.kind, "unsupported", config);
    assert.ok(v.what.includes(`${where} \`return\``), `${v.what} / ${config}`);
    assert.ok(!v.what.includes("production.invalid"), "no text of the file");
    const { db, item } = await judge({ "config/database.php": config }, { DB_URL: PROD });
    assert.deepEqual([item.level, item.facts.reason], ["confirm", "config_unknown"], config);
    noSecret({ db, item });
  }
});

test("review 4: the supported top level: <?php, comments, declare, use of a class, one return, ?>", async () => {
  const body = "['default' => env('DB_CONNECTION', 'sqlite'), 'connections' => ['sqlite' => ['driver' => 'sqlite', 'database' => ':memory:']]]";
  for (const config of [
    `<?php\n/**\n * Docblock\n */\n// line\n# hash\n/* block */\nuse Illuminate\\Support\\Str;\n\nreturn ${body};\n`,
    `<?php\ndeclare(strict_types=1);\nuse Illuminate\\Support\\Str, Foo\\Bar as Baz;\nuse Foo\\Qux;\nreturn ${body};\n?>\n`,
    `<?php return ${body}`
  ]) {
    assert.equal(parseDatabaseConfig(config).kind, "array", config);
    assert.equal((await judge({ "config/database.php": config })).item.level, "ok", config);
  }
  // a namespace, `use function` or `use const` may make the unqualified env() another function: not known
  for (const head of ["namespace Config;", "namespace App\\Config;", "use function App\\X as env;", "use function App\\env;", "use const App\\X;", "use function;", "USE FUNCTION App\\env;"]) {
    const config = `<?php\ndeclare(strict_types=1);\n${head}\nuse Illuminate\\Support\\Str;\nreturn ${body};\n`;
    assert.equal(parseDatabaseConfig(config).kind, "unsupported", head);
    const { db, item } = await judge({ "config/database.php": config }, { DB_URL: PROD });
    assert.deepEqual([item.level, item.facts.reason], ["confirm", "config_unknown"], head);
    noSecret({ db, item });
  }
  // no config/database.php: the framework's own is read as an array (the file is unchanged by this rule)
  assert.equal((await judge({ "phpunit.xml": SAFE_UNIT })).item.level, "ok");
  assert.equal(parseDatabaseConfig(L11).kind, "array");
});

test("review 4: a line comment ends at a newline, \r or ?>, and the code opens at the first <?php", async () => {
  const mysql = "['default' => 'mysql', 'connections' => ['mysql' => ['driver' => 'mysql', 'host' => 'production.invalid', 'url' => env('DB_URL'), 'database' => 'working']]]";
  const sqlite = "['default' => 'sqlite', 'connections' => ['sqlite' => ['driver' => 'sqlite', 'database' => ':memory:']]]";
  for (const config of [
    `<?php // ?><?php return ${mysql};\nreturn ${sqlite};`,
    `<?php # ?><?php return ${mysql};\nreturn ${sqlite};`,
    `<?php // note\rreturn ${mysql}; //\nreturn ${sqlite};`,
    `<?php # note\rreturn ${mysql}; #\nreturn ${sqlite};`,
    `return ${sqlite};`, // no open tag: PHP prints it
    `<?= 1; return ${mysql}; ?>\n<?php return ${sqlite};`,
    `<? return ${mysql}; ?>\n<?php return ${sqlite};`,
    `<?phpx return ${sqlite};`,
    // PHP's whitespace is space, \t, \n, \r: after NBSP, \v or \f the tag is not one (short_open_tag=Off), the later one is
    ...["\u00a0", "\v", "\f"].map((ws) => `<?php${ws}return ${sqlite}; // <?php return ${mysql};`),
    `<?php return ${sqlite};\u2028`
  ]) {
    assert.equal(parseDatabaseConfig(config).kind, "unsupported", config);
    const { db, item } = await judge({ "config/database.php": config }, { DB_URL: PROD });
    assert.deepEqual([item.level, item.facts.reason], ["confirm", "config_unknown"], config);
    noSecret({ db, item });
  }
  for (const config of [`<?PHP return ${sqlite};`, `<?php return ${sqlite}; // x ?>`, `text before\n<?php\nreturn ${sqlite};`]) {
    assert.equal(parseDatabaseConfig(config).kind, "array", config);
    assert.equal((await judge({ "config/database.php": config })).item.level, "ok", config);
  }
});

// Accepted rule: an SQLite file named for the tests in phpunit.xml with force="true", and in effect by precedence, is a
// configured test database (ok). It does not promise the file is separate from other data or empty.
test("review 4: an SQLite file set for the tests in phpunit.xml (force) is the tests' configured database", async () => {
  const unit = SAFE_UNIT.replace('value=":memory:"', 'value="database/testing.sqlite"');
  const { db, item } = await judge({ "config/database.php": L11, "phpunit.xml": unit }, { DB_DATABASE: "database/database.sqlite" });
  assert.deepEqual([db.connection, db.database, item.level], ["sqlite", "database/testing.sqlite", "ok"]);
});

// ---------------- main refuses: create and resume ----------------

function repo(files) {
  const d = dir({ ".gitignore": "node_modules/\nvendor/\n.env\ntests-ran\n", ...files });
  const g = (...a) => execFileSync(GIT, a, { cwd: d, env: GIT_ENV });
  g("init", "-q", "-b", "main"); g("add", "-A"); g("commit", "-q", "-m", "init");
  return d;
}
function manager(checkEnv, root = path.join(TMP, `root-${++n}`)) {
  const script = fs.mkdtempSync(path.join(TMP, "script-"));
  [{ stages: [{ title: "fix", task: "t" }], question: null }, { summary: "done", done: true }, { verdict: "accept", findings: [], question: null }, { verdict: "complete", findings: [], question: null }]
    .forEach((a, i) => fs.writeFileSync(path.join(script, `${i + 1}.json`), JSON.stringify(a)));
  const wrapper = (name) => { const f = path.join(TMP, name); fs.writeFileSync(f, `#!/bin/sh\nexec "${NODE}" "${path.join(HERE, "fixtures", "orchestration", `mock-${name}.mjs`)}" "$@"\n`, { mode: 0o755 }); return f; };
  const shell = path.join(TMP, "test-shell");
  fs.writeFileSync(shell, `#!/bin/sh\n[ "$1" = "-ilc" ] && shift\nexec /bin/sh -c "$1"\n`, { mode: 0o755 });
  const p = { path: `${TMP}:/usr/bin:/bin`, env: { HOME: TMP, MOCK_STATE: fs.mkdtempSync(path.join(TMP, "state-")), MOCK_SCRIPT: script } };
  const file = path.join(TMP, `providers-${++n}.json`);
  fs.writeFileSync(file, JSON.stringify({ codex: { executable: wrapper("codex"), version: "codex-cli 0.155.1", ...p }, claude: { executable: wrapper("claude"), version: "2.1.281 (Claude Code)", ...p },
    shell, checkEnv: { ...GIT_ENV, PATH: `/usr/bin:/bin:${path.dirname(GIT)}`, ...checkEnv } }));
  const m = createRunManager({ root, gitPath: () => GIT, launch: () => LAUNCH, nodePath: () => NODE, stopGraceMs: 2000,
    agents: async () => { throw new Error("not used"); }, native: testNativeRuntime(file, () => LAUNCH) });
  m.root = root;
  return m;
}
const view = async (m, runId) => (await m.get(runId)).value.view;
async function until(fn, what, ms = 60_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 50)); }
  throw new Error(`timed out waiting for ${what}`);
}
const everythingKept = (root) => fs.readdirSync(root, { recursive: true }).map((f) => path.join(root, f)).filter((f) => fs.statSync(f).isFile()).map((f) => fs.readFileSync(f, "utf8")).join("\n");

test("main refuses a run whose tests would follow a URL to a server, before any test command, without the password", OPTS, async () => {
  const src = repo({ "phpunit.xml": SAFE_UNIT, "config/database.php": L11 });
  const m = manager({ DB_URL: PROD });
  for (const goal of [{ mode: "autopilot" }, { workMode: "project" }]) {
    const r = await m.create({ requestId: randomUUID(), source: src, goal: { text: "x", criteria: ["c"], checks: [], commands: ["touch tests-ran"], ...goal } });
    assert.equal(r.code, "test_database_unsafe", JSON.stringify(r));
    noSecret(r);
  }
  assert.ok(!fs.existsSync(path.join(src, "tests-ran")), "the test command never ran");
  if (fs.existsSync(m.root)) assert.ok(!everythingKept(m.root).includes(SECRET), "nothing kept has the password");
  await m.shutdown();
  // the same with the explicit override in phpunit.xml: created
  const fixed = repo({ "config/database.php": L11, "phpunit.xml": SAFE_UNIT.replace("</php>", '<env name="DB_URL" value="" force="true"/></php>') });
  const m2 = manager({ DB_URL: PROD });
  const ok = await m2.create({ requestId: randomUUID(), source: fixed, goal: { text: "x", criteria: ["c"], checks: [], commands: ["true"], mode: "autopilot" } });
  assert.ok(ok.ok, JSON.stringify(ok));
  await m2.shutdown();
});

test("resume checks the test database again: a URL added while the run waited stops it before the next step", OPTS, async () => {
  const src = repo({ "phpunit.xml": SAFE_UNIT, "config/database.php": L11 });
  const root = path.join(TMP, `root-${++n}`);
  const quick = path.join(TMP, `quick-${++n}`);
  await createProfileStore(root).save(src, { ...(await suggestProfile(src)), workMode: "project", checks: ["touch tests-ran"],
    prepare: { steps: [{ command: `[ -f ${quick} ] || sleep 30; touch prepared.txt`, unless: "prepared.txt" }], auto: true } });
  const m = manager({}, root);
  const runId = randomUUID();
  const r = await m.create({ requestId: runId, source: src, goal: { text: "x", criteria: ["c"], checks: [], mode: "autopilot" } });
  assert.ok(r.ok, JSON.stringify(r));
  await until(async () => (await view(m, runId)).active?.kind === "prepare", "preparing");
  await m.shutdown();
  fs.writeFileSync(quick, "");
  fs.writeFileSync(path.join(src, ".env"), `DB_URL=${PROD}\n`); // the person's .env changed meanwhile
  const m2 = manager({}, root);
  const v = await view(m2, runId);
  assert.equal(v.status, "paused");
  const res = await m2.command(runId, { commandId: randomUUID(), expectedRevision: v.revision, command: { kind: "resume" } });
  assert.equal(res.code, "test_database_unsafe", JSON.stringify(res));
  noSecret(res);
  assert.equal((await view(m2, runId)).status, "paused", "not resumed");
  assert.ok(!fs.existsSync(path.join(src, "tests-ran")) && !fs.existsSync(path.join(src, "prepared.txt")), "nothing ran after the refusal");
  assert.ok(!everythingKept(root).includes(SECRET), "nothing kept has the password");
  // fixed in phpunit.xml: resumes
  fs.writeFileSync(path.join(src, "phpunit.xml"), SAFE_UNIT.replace("</php>", '<env name="DB_URL" value="" force="true"/></php>'));
  const v2 = await view(m2, runId);
  assert.ok((await m2.command(runId, { commandId: randomUUID(), expectedRevision: v2.revision, command: { kind: "resume" } })).ok);
  await m2.shutdown();
});

test("review 3: main refuses the active connection's production URL before any preparation step or test command", OPTS, async () => {
  const src = repo({ "config/database.php": TWO(["sqlite", "mysql"]), "phpunit.xml": MYSQL_UNIT });
  const root = path.join(TMP, `root-${++n}`);
  await createProfileStore(root).save(src, { ...(await suggestProfile(src)), workMode: "project", checks: ["touch tests-ran"],
    prepare: { steps: [{ command: "touch prepared.txt", unless: "prepared.txt" }], auto: true } });
  const m = manager(REVIEW_ENV, root);
  const r = await m.create({ requestId: randomUUID(), source: src, goal: { text: "x", criteria: ["c"], checks: [], mode: "autopilot" } });
  assert.equal(r.code, "test_database_unsafe", JSON.stringify(r));
  noSecret(r);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.ok(!fs.existsSync(path.join(src, "prepared.txt")) && !fs.existsSync(path.join(src, "tests-ran")), "neither the preparation nor the test command ran");
  assert.ok(!everythingKept(root).includes(SECRET), "nothing kept has the password");
  await m.shutdown();
});
