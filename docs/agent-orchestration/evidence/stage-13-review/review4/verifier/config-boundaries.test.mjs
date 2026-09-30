// Independent boundary scenarios for parseDatabaseConfig (config/database.php read statically).
// Dangerous shape: a hidden return of SQLite :memory: while PHP really returns MySQL on production.invalid.
// CTO_SRC: the src/ to test (default: the repository's); used to run the same scenarios on a pre-fix copy.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const SRC = process.env.CTO_SRC ?? new URL('../../../../../../src', import.meta.url).pathname;
const {laravelTestDb} = await import(path.join(SRC, 'main/services/orchestration/prepare.ts'));
const {testDbItem} = await import(path.join(SRC, 'main/services/orchestration/readiness.ts'));

const safe = "['default'=>'sqlite','connections'=>['sqlite'=>['driver'=>'sqlite','database'=>':memory:']]]";
const actual = "['default'=>'mysql','connections'=>['mysql'=>['driver'=>'mysql','host'=>'production.invalid','database'=>'working']]]";
const PW = 'Sup3rS3cretPW';

async function run(php, files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cto-review4-verifier-'));
  try {
    fs.mkdirSync(path.join(root, 'config'));
    fs.writeFileSync(path.join(root, 'config/database.php'), php);
    for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(root, f), text);
    const db = await laravelTestDb(root, async () => { throw new Error('unexpected network probe'); }, {env: {}});
    return {db, item: testDbItem(db)};
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
}

// PHP really returns `actual` (or fails), a first-return reader sees `safe`: must be config_unknown, never ok.
const bad = {
  'function before return': `<?php function unusedConfig() { return ${safe}; } return ${actual};`,
  'if(false){return}': `<?php if (false) { return ${safe}; } return ${actual};`,
  'if(false) return; without braces': `<?php if (false) return ${safe}; return ${actual};`,
  'if: ... endif;': `<?php if (false): return ${safe}; endif; return ${actual};`,
  'else branch': `<?php if (true) { $x = 1; } else { return ${safe}; } return ${actual};`,
  'elseif branch': `<?php if (true) { $x = 1; } elseif (true) { return ${safe}; } return ${actual};`,
  'closure': `<?php $f = function () { return ${safe}; }; return ${actual};`,
  'static closure with use': `<?php $y = 1; $f = static function () use ($y) { return ${safe}; }; return ${actual};`,
  'class method': `<?php class C { public function c() { return ${safe}; } } return ${actual};`,
  'match': `<?php return match (true) { false => ${safe}, default => ${actual} };`,
  'ternary': `<?php return false ? ${safe} : ${actual};`,
  'code after return': `<?php return ${safe}; echo 1;`,
  'two top-level returns': `<?php return ${safe}; return ${actual};`,
  'variable then return $config': `<?php $config = ${safe}; return $config;`,
  'array_merge': `<?php return array_merge(${safe}, ${actual});`,
  'return require': `<?php return require __DIR__ . '/other.php';`,
  'heredoc': `<?php $x = <<<EOT\nreturn ${safe};\nEOT;\nreturn ${actual};`,
  'goto': `<?php goto end; return ${safe}; end: return ${actual};`,
  'switch': `<?php switch (1) { case 0: return ${safe}; } return ${actual};`,
  'while(false)': `<?php while (false) { return ${safe}; } return ${actual};`,
  'try/finally': `<?php try { return ${safe}; } finally { return ${actual}; }`,
  'declare block': `<?php declare(ticks=1) { if (false) { return ${safe}; } } return ${actual};`,
  'braced namespace': `<?php namespace App { function f() { return ${safe}; } } return ${actual};`,
  '__halt_compiler before return': `<?php __halt_compiler(); return ${safe};`,
  'array union (left wins)': `<?php return ${actual} + ${safe};`,
  'inline HTML after ?> mid-file': `<?php ?>\nreturn ${safe};\n<?php return ${actual};`,
  // comment tricks: PHP ends // and # comments at ?> and at a bare \r; the tokenizer only at \n
  '// comment closed by ?>': `<?php // ?><?php return ${actual};\nreturn ${safe};`,
  '# comment closed by ?>': `<?php # ?><?php return ${actual};\nreturn ${safe};`,
  '// comment ended by bare \\r': `<?php // note\rreturn ${actual}; //\nreturn ${safe};`,
  // PHP's open tag is case-insensitive; the tokenizer looks for "<?php" only
  '<?PHP with "<?php" in a string': `<?PHP $x = '<?php'; return ${actual}; //'return ${safe};`,
  // сужено в ревью 4 по замечанию верификатора: env() may be a user function (namespace fallback, use function)
  'namespace + use': `<?php\nnamespace Config;\nuse Illuminate\\Support\\Str;\nreturn ${safe};\n`,
  'declare + namespace + use': `<?php declare(strict_types=1); namespace Config; use Illuminate\\Support\\Str; return ${safe};`,
  'use function X as env': `<?php use function App\\X as env; return ${safe};`,
  'use function (other alias)': `<?php use function env as e, Foo\\bar; return ${safe};`,
  'use const': `<?php use const App\\X; return ${safe};`,
  // open tags (review4 round 2)
  'no <?php at all': `return ${safe};`,
  '<?= before <?php (team-lead case)': `<?= 1; return ${safe}; ?><?php return ${actual};`,
  '<?= before <?php, dangerous order': `<?= ''; return ${actual}; ?>\n<?php return ${safe};`,
  '<? short tag before <?php': `<? return ${actual}; ?>\n<?php return ${safe};`,
  '<?PHP uppercase with a function': `<?PHP function f() { return ${safe}; } return ${actual};`,
  '?> mid-file then <?php return': `<?php ?>\n<?php return ${safe};`,
  '<?phpX is not an open tag': `<?phpreturn ${safe};`,
  // PHP's open tag needs [ \t\n\r] after it; JS \s also takes NBSP, \v, \f. Short tags off: the first "<?php" is
  // text, the second (inside what the tokenizer reads as a comment) runs.
  'NBSP after <?php, real tag in a comment': `<?php\u00A0return ${safe}; // <?php return ${actual};`,
  '\\v after <?php, real tag in a comment': `<?php\vreturn ${safe}; // <?php return ${actual};`,
  '\\f after <?php, real tag in a comment': `<?php\freturn ${safe}; # <?php return ${actual};`,
};
for (const [name, php] of Object.entries(bad)) test(`bad: ${name} -> config_unknown, not ok`, async () => {
  const {db, item} = await run(php);
  assert.notEqual(item.level, 'ok', JSON.stringify({db, item}));
  assert.equal(item.facts.reason, 'config_unknown', JSON.stringify({db, item}));
});

// Laravel 11-style file: must stay ok (sqlite :memory: set in the file itself, no phpunit.xml).
const laravel11 = `<?php

use Illuminate\\Support\\Str;

return [

    /*
    |--------------------------------------------------------------------------
    | Default Database Connection Name
    |--------------------------------------------------------------------------
    | Do not 'return' early here; see "return" docs.
    */

    'default' => env('DB_CONNECTION', 'sqlite'), // return is a keyword

    # 'default' => 'mysql',
    'connections' => [
        'sqlite' => [
            'driver' => 'sqlite',
            'url' => env('DB_URL'),
            'database' => env('DB_DATABASE', ':memory:'),
            'prefix' => '',
            'foreign_key_constraints' => env('DB_FOREIGN_KEYS', true),
        ],
        'mysql' => [
            'driver' => 'mysql',
            'host' => env('DB_HOST', '127.0.0.1'),
            'port' => env('DB_PORT', '3306'),
            'database' => env('DB_DATABASE', 'laravel'),
            'options' => extension_loaded('pdo_mysql') ? array_filter([PDO::MYSQL_ATTR_SSL_CA => env('MYSQL_ATTR_SSL_CA')]) : [],
        ],
    ],
    'migrations' => ['table' => 'migrations', 'update_date_on_publish' => true],
    'redis' => ['client' => env('REDIS_CLIENT', 'phpredis'), 'options' => ['prefix' => env('REDIS_PREFIX', Str::slug(env('APP_NAME', 'laravel'), '_').'_database_')]],
    'note' => 'return [] here is only a string; ?> too',
];
`;
const good = {
  'Laravel 11 style (use, docblocks, //, #, /* */)': laravel11,
  'use class + declare': `<?php declare(strict_types=1); use Illuminate\\Support\\Str; return ${safe};`,
  'declare(strict_types=1)': `<?php\ndeclare(strict_types=1);\n\nreturn ${safe};\n`,
  'trailing ?>': `<?php return ${safe}; ?>`,
  'trailing ?> and newline': `<?php return ${safe};\n?>\n`,
  'return array(...)': `<?php return array('default' => 'sqlite', 'connections' => array('sqlite' => array('driver' => 'sqlite', 'database' => ':memory:')));`,
  "'return' in a value and a comment": `<?php /* return ${actual}; */ // return ${actual};\nreturn ['default'=>'sqlite','connections'=>['sqlite'=>['driver'=>'sqlite','database'=>':memory:','x'=>'return 1; ?>']]];`,
  'no trailing semicolon before ?>': `<?php return ${safe} ?>`,
  '<?PHP uppercase, plain return': `<?PHP return ${safe};`,
  'HTML before <?php': `<!-- not code: return x; -->\n<?php return ${safe};`,
  'BOM before <?php': `\uFEFF<?php return ${safe};`,
};
for (const [name, php] of Object.entries(good)) test(`good: ${name} -> ok`, async () => {
  const {db, item} = await run(php);
  assert.equal(item.level, 'ok', JSON.stringify({db, item}));
  assert.equal(db.connection, 'sqlite');
  assert.equal(db.database, ':memory:');
});

test('actual MySQL on production.invalid (plain file) stays a blocker', async () => {
  const {item} = await run(`<?php return ${actual};`);
  assert.equal(item.level, 'blocker');
  assert.equal(item.facts.reason, 'remote_host');
});

test('no password from a URL or the file reaches the item or the result', async () => {
  const withUrl = `<?php return ['default'=>'mysql','connections'=>['mysql'=>['driver'=>'mysql','url'=>env('DB_URL'),'host'=>'127.0.0.1','password'=>'${PW}']]];`;
  const hidden = `<?php function f() { return ['default'=>'x','connections'=>['x'=>['password'=>'${PW}']]]; } return ['default' => 'mysql', 'connections' => ['mysql' => ['driver' => 'mysql', 'url' => 'mysql://u:${PW}@production.invalid/db', 'password' => '${PW}' . 'x']]];`;
  for (const php of [withUrl, hidden]) {
    const r = await run(php, {'.env': `DB_URL=mysql://root:${PW}@production.invalid:3306/working\n`});
    const text = JSON.stringify(r);
    assert.ok(!text.includes(PW), text);
    assert.notEqual(r.item.level, 'ok', text);
  }
});
