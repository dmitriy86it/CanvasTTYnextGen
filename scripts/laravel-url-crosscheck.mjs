#!/usr/bin/env node
// Compares parseDbUrl (src/main/services/orchestration/prepare.ts) with Laravel's own ConfigurationUrlParser on made-up
// database URLs, and writes what Laravel answered to tests/fixtures/orchestration/laravel-url-cases.json (the node
// test compares against that file without PHP). Nothing connects to a database: only parseConfiguration runs.
//   node scripts/laravel-url-crosscheck.mjs /path/to/laravel-app   (its vendor/ is loaded, never changed)
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseDbUrl } from "../src/main/services/orchestration/prepare.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const app = process.argv[2];
if (!app || !fs.existsSync(path.join(app, "vendor", "autoload.php"))) {
  console.error("usage: node scripts/laravel-url-crosscheck.mjs <laravel project with vendor/>");
  process.exit(2);
}

// made-up addresses only; the passwords are fake and show that they never come out
const URLS = [
  "mysql://test:test@production.invalid/working",
  "mysql://user:s3cr%40t@production.invalid:3307/shop?charset=utf8mb4",
  "mysql://root@127.0.0.1/app_testing",
  "mysql://127.0.0.1:3306/app",
  "mariadb://u:p@db.internal.invalid/app",
  "mysql2://u:p@rds.invalid/app",
  "pgsql://u:p@pg.invalid:5433/app",
  "postgres://u:p@pg.invalid/app",
  "postgresql://u:p@localhost/app_test",
  "postgresql://u:p@[::1]:5432/app",
  "sqlite:///:memory:",
  "sqlite::memory:",
  "sqlite:///var/data/app.sqlite",
  "sqlite3:///database/database.sqlite",
  "sqlite://null/:memory:",
  "mysql://u:p@production.invalid/db?database=other&host=other.invalid",
  "mysql://u:p@production.invalid/?port=4406",
  "mysql://u:p@production.invalid",
  "mysql://u:p@null/app",
  "mysql://u:p@production.invalid/123",
  "mssql://u:p@sql.invalid/app",
  "sqlsrv:server=sql.invalid,1433;database=app",
  "production.invalid/working",
  "//production.invalid/working",
  "mysql://u:p@production.invalid:99999/app",
  "mysql://u:p@production.invalid:abc/app",
  "mysql://",
  "mysql:///app",
  "http://[::1/app",
  "mysql://u:p@production.invalid/app#frag"
];

const php = `<?php
require $argv[1] . '/vendor/autoload.php';
$out = [];
foreach (json_decode(file_get_contents('php://stdin'), true) as $url) {
  try {
    $c = (new Illuminate\\Support\\ConfigurationUrlParser)->parseConfiguration(['url' => $url, 'driver' => 'sqlite', 'database' => ':memory:']);
    $v = fn ($k) => isset($c[$k]) ? (string) $c[$k] : null;
    $out[] = ['url' => $url, 'laravel' => ['driver' => $v('driver'), 'host' => $v('host'), 'port' => isset($c['port']) ? (int) $c['port'] : null, 'database' => $v('database')]];
  } catch (Throwable $e) {
    $out[] = ['url' => $url, 'laravel' => null];
  }
}
echo json_encode($out);
`;
const script = path.join(fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR ?? "/tmp"), "laravel-url-")), "parse.php");
fs.writeFileSync(script, php);
const cases = JSON.parse(execFileSync("php", [script, path.resolve(app)], { input: JSON.stringify(URLS), encoding: "utf8" }));
fs.rmSync(path.dirname(script), { recursive: true, force: true });

// parseDbUrl answers what the URL sets; the config's own driver and database (sqlite, :memory:) stay where it sets none
const ours = (url) => {
  const p = parseDbUrl(url);
  return p && { driver: p.driver ?? "sqlite", host: p.host, port: p.port, database: p.database ?? ":memory:" };
};
// A URL not understood here (null) is never taken as safe (a blocker), so it counts as agreeing, on the safe side.
let same = 0, safeSide = 0;
for (const c of cases) {
  const o = ours(c.url);
  const ok = JSON.stringify(o) === JSON.stringify(c.laravel);
  same += ok ? 1 : 0;
  if (!ok && o === null) { safeSide++; console.log(`not understood here (blocker), Laravel: ${JSON.stringify(c.laravel)}  ${c.url}`); }
  else if (!ok) console.log(`DIFFERS ${c.url}\n  laravel ${JSON.stringify(c.laravel)}\n  ours    ${JSON.stringify(o)}`);
}
const version = JSON.parse(fs.readFileSync(path.join(app, "vendor", "composer", "installed.json"), "utf8")).packages.find((p) => p.name === "laravel/framework")?.version;
const file = path.join(HERE, "..", "tests", "fixtures", "orchestration", "laravel-url-cases.json");
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify({ laravel: version ?? null, config: { driver: "sqlite", database: ":memory:" }, cases }, null, 2) + "\n");
console.log(`${same}/${cases.length} the same as Laravel ${version}, ${safeSide} not understood here (refused); written ${path.relative(process.cwd(), file)}`);
process.exit(same + safeSide === cases.length ? 0 : 1);
