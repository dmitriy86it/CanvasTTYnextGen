// The real series' prompt rule (scripts/answer-rule.mjs): compound read/test commands inside the temporary project are
// answered, anything else stops the series (null).
import assert from "node:assert/strict";
import { test } from "node:test";
import { allowedByAssignment } from "../scripts/answer-rule.mjs";

const DIR = "/tmp/cto-real-auto-x/s3-app";
const bash = (command, extra = {}) => allowedByAssignment({ kind: "tool", tool: "Bash", summary: command, detail: JSON.stringify({ command, ...extra }) }, DIR);
const S3 = "npm test 2>&1 | tail -12; shasum -a 256 tests/duration.accept.test.mjs; git status --short";

test("the earlier S3 compound command is allowed", () => {
  assert.equal(bash(S3), `test/read command inside the project: ${S3}`);
  assert.ok(bash(`/bin/zsh -lc '${S3}'`));
  assert.ok(bash(`cd ${DIR} && ${S3}`));
  assert.ok(bash("cd tests && shasum ../src/sum.mjs"));
});

test("new read commands, each part on its own", () => {
  for (const c of ["sha256sum tests/a.mjs && md5 src/sum.mjs", "grep -rn \"toMs(\" src tests | sort", "diff src/a.mjs src/b.mjs || pwd",
    "git diff --stat", "find . -name '*.mjs' -not -path './node_modules/*'", "npm test 2>/dev/null | tail -n 5", "ls -la; cat package.json | wc -l", "git status;"]) {
    assert.ok(bash(c), c);
  }
});

test("redirections, substitutions, background, unknown or writing parts stop", () => {
  for (const c of [`${S3} > out.txt`, `${S3} >> out.txt`, "sort < x", `${S3}; rm -rf src`, `${S3}; git push`, "shasum /etc/passwd", "cat ../x",
    "cat $(echo x)", "cat `echo x`", "npm test &", "sudo npm test", "curl https://example.com", "wget x", "npm install", "npm publish", "mv a b",
    "git commit -m x", "git checkout .", "git reset --hard", "find . -exec rm {} ;", "find . -delete", "cd .. && ls", "cd /tmp && ls", "cd ~ && ls",
    "cat ~/.ssh/id_rsa", "sort -o src/x a", "tail -f log", "git diff --output=/tmp/x", "grep -r x /etc", "ls --dir=/etc", "echo hi", "diff a b || true",
    "grep 'a;b' x", "grep \"unclosed x", "cat a\\ b", "npm test | ", "ls (x)", "cat $HOME/x", "cat {a,b}", "cd tests && cat ../../x", "cd", "cd tests", "ls && && ls", "; ls"]) {
    assert.equal(bash(c), null, c);
  }
});

test("single commands of the earlier list are allowed as before", () => {
  for (const c of ["npm test", "npm run test", "npm ls", "node --test", "node --test tests/sum.test.mjs", "node scripts/x.mjs", "php artisan test",
    "php artisan route:list --path=health", "vendor/bin/phpunit", "php vendor/bin/pest --filter=Health", "composer dump-autoload", "composer validate",
    "git status", "git diff", "git log --oneline -5", "git show HEAD", "ls", "ls -la src", "cat package.json", "head -n 5 src/sum.mjs", "tail -n 3 x",
    "wc -l src/sum.mjs", "pwd", "npm test 2>&1"]) {
    assert.ok(bash(c), c);
  }
  assert.equal(bash("npm test", { cwd: "/tmp" }), null);
  assert.ok(bash("npm test", { cwd: `${DIR}/tests` }));
});

test("file changes and read tools as before", () => {
  assert.match(allowedByAssignment({ kind: "tool", tool: "Write", detail: JSON.stringify({ file_path: `${DIR}/src/a.mjs` }) }, DIR), /file change inside the project: src\/a\.mjs/);
  assert.equal(allowedByAssignment({ kind: "tool", tool: "Edit", detail: JSON.stringify({ file_path: "/etc/hosts" }) }, DIR), null);
  assert.ok(allowedByAssignment({ kind: "file_change", detail: JSON.stringify({ changes: [{ path: "src/a.mjs" }, { path: "tests/b.mjs" }] }) }, DIR));
  assert.equal(allowedByAssignment({ kind: "file_change", detail: JSON.stringify({ changes: [{ path: "src/a.mjs" }, { path: "../b.mjs" }] }) }, DIR), null);
  assert.equal(allowedByAssignment({ kind: "file_change", detail: "{}" }, DIR), null);
  assert.ok(allowedByAssignment({ kind: "tool", tool: "Read", detail: JSON.stringify({ file_path: `${DIR}/package.json` }) }, DIR));
  assert.equal(allowedByAssignment({ kind: "tool", tool: "Grep", detail: JSON.stringify({ path: "/etc" }) }, DIR), null);
  assert.equal(allowedByAssignment({ kind: "question", detail: "{}" }, DIR), null);
  assert.equal(allowedByAssignment({ kind: "command", tool: "command", summary: "npm test", detail: JSON.stringify({ command: "npm test" }) }, DIR), `test/read command inside the project: npm test`);
});
