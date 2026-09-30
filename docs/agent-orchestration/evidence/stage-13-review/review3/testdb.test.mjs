import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { laravelTestDb } from "../../../../../src/main/services/orchestration/prepare.ts";
import { testDbItem } from "../../../../../src/main/services/orchestration/readiness.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_DB = fs.readFileSync(path.join(HERE, "app-database.php"), "utf8");
const FW_DB = fs.readFileSync(path.join(HERE, "framework-database.php"), "utf8");
const APP_UNIT = fs.readFileSync(path.join(HERE, "app-phpunit.xml"), "utf8");
const SECRET = "S3cr3tPa55w0rd";
const PROD = `mysql://produser:${SECRET}@production.invalid:3306/working`;

// files: {relpath: content}; returns {db, item, json}
async function run(files, env = {}, probe = async () => true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cto-verifier-testdb-"));
  try {
    for (const [f, c] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
      fs.writeFileSync(path.join(root, f), c);
    }
    const db = await laravelTestDb(root, probe, { env });
    const item = testDbItem(db);
    const json = JSON.stringify({ db, item });
    assert.ok(!json.includes(SECRET) && !json.includes("produser"), `credentials leaked: ${json}`);
    return { db, item, json };
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
const unit = (envs) => `<phpunit><php>${Object.entries(envs).map(([k, v]) => {
  const force = !k.endsWith("?");
  return `<env name="${k.replace("?", "")}" value="${v}"${force ? ' force="true"' : ""}/>`;
}).join("")}</php></phpunit>`;
const cfg = (def, conns) => `<?php return ['default' => ${def}, 'connections' => [${conns}]];`;
const SQLITE_C = `'sqlite' => ['driver' => 'sqlite', 'url' => env('SQLITE_URL'), 'database' => env('DB_DATABASE', ':memory:')]`;
const MYSQL_C = `'mysql' => ['driver' => 'mysql', 'url' => env('DATABASE_URL'), 'host' => env('DB_HOST', '127.0.0.1'), 'port' => env('DB_PORT', '3306'), 'database' => env('DB_DATABASE', 'forge')]`;
const notOk = (r) => assert.notEqual(r.item.level, "ok", r.json);
const isOk = (r) => assert.equal(r.item.level, "ok", r.json);
const blocker = (r) => assert.equal(r.item.level, "blocker", r.json);
const unknown = (r, word) => {
  notOk(r);
  assert.equal(r.item.facts?.reason, "config_unknown", r.json);
  if (word) assert.ok(r.item.detail.includes(word), `detail should name '${word}': ${r.json}`);
};

// 1 review 3 exactly
test("01 review3: inactive sqlite URL must not hide active mysql production URL", async () => {
  const r = await run({ "config/database.php": cfg(`env('DB_CONNECTION', 'mysql')`, `${SQLITE_C}, ${MYSQL_C}`),
    "phpunit.xml": unit({ "APP_ENV?": "testing", DB_CONNECTION: "mysql", DB_DATABASE: "app_testing" }) },
  { SQLITE_URL: "sqlite:///:memory:", DATABASE_URL: PROD });
  notOk(r); blocker(r);
});

test("02 reversed connection order", async () => {
  const r = await run({ "config/database.php": cfg(`env('DB_CONNECTION', 'mysql')`, `${MYSQL_C}, ${SQLITE_C}`),
    "phpunit.xml": unit({ "APP_ENV?": "testing", DB_CONNECTION: "mysql", DB_DATABASE: "app_testing" }) },
  { SQLITE_URL: "sqlite:///:memory:", DATABASE_URL: PROD });
  blocker(r);
});

const NAMED = `'testing' => ['driver' => 'mysql', 'url' => env('TESTING_URL'), 'host' => env('DB_HOST', '127.0.0.1'), 'database' => env('DB_DATABASE', 'x')], 'reporting' => ['driver' => 'sqlite', 'url' => env('REPORT_URL'), 'database' => ':memory:']`;
test("03a connection names testing/reporting: default 'testing' (mysql) with production URL -> blocker", async () => {
  const r = await run({ "config/database.php": cfg(`env('DB_CONNECTION', 'testing')`, NAMED), "phpunit.xml": unit({ DB_DATABASE: "app_testing" }) },
    { REPORT_URL: "sqlite:///:memory:", TESTING_URL: PROD });
  blocker(r);
});
test("03b connection names: DB_CONNECTION=reporting (sqlite :memory:) forced, testing has production URL -> ok", async () => {
  const r = await run({ "config/database.php": cfg(`env('DB_CONNECTION', 'testing')`, NAMED), "phpunit.xml": unit({ DB_CONNECTION: "reporting" }) },
    { REPORT_URL: "sqlite:///:memory:", TESTING_URL: PROD });
  isOk(r);
});
test("03c name != driver: 'main' => pgsql with production URL -> blocker", async () => {
  const r = await run({ "config/database.php": cfg(`env('DB_CONNECTION', 'main')`, `'main' => ['driver' => 'pgsql', 'url' => env('MAIN_URL'), 'host' => '127.0.0.1', 'database' => env('DB_DATABASE', 'x')]`),
    "phpunit.xml": unit({ DB_DATABASE: "app_testing" }) }, { MAIN_URL: `pgsql://produser:${SECRET}@db.production.invalid/app` });
  blocker(r);
});

test("04 active sqlite :memory:, inactive mysql with production URL -> ok", async () => {
  const r = await run({ "config/database.php": cfg(`env('DB_CONNECTION', 'mysql')`, `${SQLITE_C}, ${MYSQL_C}`),
    "phpunit.xml": unit({ DB_CONNECTION: "sqlite", DB_DATABASE: ":memory:" }) }, { DATABASE_URL: PROD });
  isOk(r);
});

test("05 default fallback of env('DB_CONNECTION', 'mysql') when nothing sets it -> mysql URL counts", async () => {
  const r = await run({ "config/database.php": cfg(`env('DB_CONNECTION', 'mysql')`, `${SQLITE_C}, ${MYSQL_C}`) },
    { SQLITE_URL: "sqlite:///:memory:", DATABASE_URL: PROD });
  blocker(r);
});
test("06 precedence: process DB_CONNECTION beats phpunit non-force sqlite", async () => {
  const r = await run({ "config/database.php": cfg(`env('DB_CONNECTION', 'sqlite')`, `${SQLITE_C}, ${MYSQL_C}`),
    "phpunit.xml": unit({ "DB_CONNECTION?": "sqlite", "DB_DATABASE?": ":memory:" }) }, { DB_CONNECTION: "mysql", DATABASE_URL: PROD });
  blocker(r);
});
test("07 precedence: phpunit force sqlite beats process mysql", async () => {
  const r = await run({ "config/database.php": cfg(`env('DB_CONNECTION', 'mysql')`, `${SQLITE_C}, ${MYSQL_C}`),
    "phpunit.xml": unit({ DB_CONNECTION: "sqlite", DB_DATABASE: ":memory:" }) }, { DB_CONNECTION: "mysql", DATABASE_URL: PROD });
  isOk(r);
});
test("08 precedence: .env.testing DB_CONNECTION=mysql when phpunit sets APP_ENV=testing", async () => {
  const r = await run({ "config/database.php": cfg(`env('DB_CONNECTION', 'sqlite')`, `${SQLITE_C}, ${MYSQL_C}`),
    "phpunit.xml": unit({ "APP_ENV?": "testing" }), ".env": "DB_CONNECTION=sqlite\n", ".env.testing": "DB_CONNECTION=mysql\n" }, { DATABASE_URL: PROD });
  blocker(r);
});

for (const [name, conf] of [["app", APP_DB], ["framework", FW_DB]]) {
  test(`09-${name} laravel 11+ config: DB_URL production, phpunit forces mysql -> blocker`, async () => {
    const r = await run({ "config/database.php": conf, "phpunit.xml": unit({ DB_CONNECTION: "mysql", DB_DATABASE: "app_testing" }) }, { DB_URL: PROD });
    blocker(r);
  });
  test(`10-${name} laravel 11+ config: DB_URL="" forced -> DB_* decide (local mysql app_testing) -> ok`, async () => {
    const r = await run({ "config/database.php": conf, "phpunit.xml": unit({ DB_CONNECTION: "mysql", DB_DATABASE: "app_testing", DB_URL: "", DB_HOST: "127.0.0.1" }) }, { DB_URL: PROD });
    isOk(r);
  });
  test(`11-${name} laravel 11+ stock phpunit.xml (sqlite :memory:, DB_URL="") with production DB_URL -> ok`, async () => {
    const r = await run({ "config/database.php": conf, "phpunit.xml": APP_UNIT }, { DB_URL: PROD });
    isOk(r);
  });
  test(`12-${name} laravel 11+ config: DB_URL="" forced, DB_HOST remote from process -> blocker`, async () => {
    const r = await run({ "config/database.php": conf, "phpunit.xml": unit({ DB_CONNECTION: "mysql", DB_URL: "" }) }, { DB_HOST: "production.invalid", DB_DATABASE: "working" });
    blocker(r);
  });
}

test("13a no config/database.php: DB_URL production -> blocker", async () => {
  blocker(await run({ "phpunit.xml": unit({ DB_CONNECTION: "mysql", DB_DATABASE: "app_testing" }) }, { DB_URL: PROD }));
});
test("13b no config/database.php: DATABASE_URL production -> not ok (conservative)", async () => {
  notOk(await run({ "phpunit.xml": unit({ DB_CONNECTION: "mysql", DB_DATABASE: "app_testing" }) }, { DATABASE_URL: PROD }));
});
test("13c no config/database.php: sqlite :memory: forced, no URL -> ok", async () => {
  isOk(await run({ "phpunit.xml": unit({ DB_CONNECTION: "sqlite", DB_DATABASE: ":memory:" }) }, {}));
});

test("14 default => $x -> config_unknown", async () => {
  unknown(await run({ "config/database.php": `<?php $x = 'sqlite'; return ['default' => $x, 'connections' => [${SQLITE_C}, ${MYSQL_C}]];`,
    "phpunit.xml": unit({ DB_CONNECTION: "sqlite", DB_DATABASE: ":memory:" }) }, { DATABASE_URL: PROD }), "default");
});
test("15 default => config(...) -> config_unknown", async () => {
  unknown(await run({ "config/database.php": cfg(`config('app.db', 'sqlite')`, `${SQLITE_C}, ${MYSQL_C}`),
    "phpunit.xml": unit({ DB_CONNECTION: "sqlite", DB_DATABASE: ":memory:" }) }, { DATABASE_URL: PROD }), "default");
});
test("16 active driver via function -> config_unknown", async () => {
  unknown(await run({ "config/database.php": cfg(`env('DB_CONNECTION', 'main')`, `'main' => ['driver' => strtolower('SQLITE'), 'url' => env('MAIN_URL'), 'database' => env('DB_DATABASE', ':memory:')]`),
    "phpunit.xml": unit({ DB_DATABASE: ":memory:" }) }, {}), "driver");
});
test("17 active url => $url -> config_unknown", async () => {
  unknown(await run({ "config/database.php": `<?php $url = getenv('X'); return ['default' => env('DB_CONNECTION', 'mysql'), 'connections' => ['mysql' => ['driver' => 'mysql', 'url' => $url, 'host' => '127.0.0.1', 'database' => env('DB_DATABASE', 'x')]]];`,
    // review 4: the statement before `return` rejects the whole file, so the field named is "default", not "url"
    "phpunit.xml": unit({ DB_DATABASE: "app_testing" }) }, {}), "default");
});
test("18 active sqlite database => database_path('x.sqlite') -> config_unknown", async () => {
  unknown(await run({ "config/database.php": cfg(`env('DB_CONNECTION', 'sqlite')`, `'sqlite' => ['driver' => 'sqlite', 'url' => env('DB_URL'), 'database' => database_path('x.sqlite')], ${MYSQL_C}`),
    "phpunit.xml": unit({ DB_CONNECTION: "sqlite" }) }, {}), "database");
});
test("19 function in INACTIVE connection's url is tolerated (active sqlite :memory: -> ok)", async () => {
  isOk(await run({ "config/database.php": cfg(`env('DB_CONNECTION', 'sqlite')`, `${SQLITE_C}, 'mysql' => ['driver' => 'mysql', 'url' => getenv('X') ?: null, 'host' => 'h']`),
    "phpunit.xml": unit({ DB_CONNECTION: "sqlite", DB_DATABASE: ":memory:" }) }, {}));
});

// Review 4 decision: a SQLite file set for tests in phpunit.xml (force) and in effect is a configured test database: ok.
// Not a guarantee that it is separate or empty. The first run expected not ok: verifier-after.tap (history).
test("20 sqlite file forced in phpunit -> ok (configured test database)", async () => {
  isOk(await run({ "config/database.php": cfg(`env('DB_CONNECTION', 'sqlite')`, SQLITE_C), "phpunit.xml": unit({ DB_CONNECTION: "sqlite", DB_DATABASE: "/var/app/database.sqlite" }) }, {}));
});
test("21 unknown database (mysql, nothing sets DB_DATABASE, no default) -> not ok", async () => {
  notOk(await run({ "config/database.php": cfg(`env('DB_CONNECTION', 'mysql')`, `'mysql' => ['driver' => 'mysql', 'url' => env('DATABASE_URL'), 'host' => '127.0.0.1', 'database' => env('DB_DATABASE')]`),
    "phpunit.xml": unit({ DB_CONNECTION: "mysql" }) }, {}));
});

test("22 password in DATABASE_URL and DB_URL never in result (active production URL)", async () => {
  const r = await run({ "config/database.php": APP_DB, "phpunit.xml": unit({ DB_CONNECTION: "mysql" }) },
    { DB_URL: PROD, DATABASE_URL: PROD });
  blocker(r);
  assert.ok(!r.item.detail.includes(SECRET));
});
test("23 password in URL of the review config (blocker path) never in result", async () => {
  const r = await run({ "config/database.php": cfg(`env('DB_CONNECTION', 'mysql')`, `${SQLITE_C}, ${MYSQL_C}`), "phpunit.xml": unit({ DB_CONNECTION: "mysql" }) },
    { DATABASE_URL: PROD, SQLITE_URL: `sqlite://produser:${SECRET}@x/:memory:` });
  notOk(r);
});
