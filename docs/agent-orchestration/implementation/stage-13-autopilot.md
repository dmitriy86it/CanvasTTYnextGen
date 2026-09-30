# Stage 13: autopilot, project settings, environment preparation

Status: implemented 2026-09-24. Independent team review and fixes on 2026-09-24/25: 33 defects found and fixed
(see [evidence/stage-13-review/REVIEW.md](../evidence/stage-13-review/REVIEW.md)). Locally everything passes on fake
CLIs and programs. A limited real series of two scenarios (N: Node, L: Laravel) completed on the installed CLIs
([evidence/real-stage-13/](../evidence/real-stage-13/README.md)). No push, deploy or real QA was made. S3–S7 were not
run. Terminal parity is **not proven**: one successful task per stack shows that the basic path works and nothing
more.

A second external review (2026-09-25) confirmed N and L from their journals and reproduced two defects. Both are
fixed:
- a database URL (`DB_URL` / `DATABASE_URL`) overriding a «safe» SQLite;
- QA version proof by the mention of `$CANVASTTY_COMMIT`.

See «Review 2» in [REVIEW.md](../evidence/stage-13-review/REVIEW.md). A third review found that the URL of an
inactive connection could hide the active one; it is fixed («Review 3»). The accepted QA version contract and the
real N and L stay as proven results. A fourth review found that the parser took the first `return` of the file
wherever it stood; the whole file's structure is checked now («Review 4»). The stage is not accepted yet.

## Goal

The person picks a project, writes a task and gets a checked result with as few manual steps as possible. Agents keep
the rights of ordinary terminal Claude/Codex. CanvasTTY organises the work and makes it visible.

## 1. Automation is separate from rights

The goal dialog has two modes (`OrchestrationGoalInput.mode`):

- **Автопилот (autopilot).** It explores, plans and runs stages by itself. It prepares the environment and runs the
  checks. It fixes and re-checks. It runs the actions after success that were asked for. It stops only in these cases:
  - a question of the agent;
  - a permission outside the granted rights;
  - an unprepared environment it could not fix;
  - an outside failure;
  - a limit.
- **По шагам (steps).** The plan is shown (`plan_review`). The run pauses with `stage_done` after each accepted stage.

Rights are a separate, per-project setting (`profile.access`, `access.ts`). Each choice is turned into exactly one
thing for each CLI, and the settings dialog shows it:

| Mode | Claude (argv) | Codex (`thread/start`, `thread/resume` params) |
|---|---|---|
| `terminal` «Как в моём терминале» (default) | nothing (the user's settings) | nothing (the user's `config.toml`) |
| `acceptEdits` | `--permission-mode acceptEdits` | — |
| `auto` | `--permission-mode auto` | — |
| `workspace` | — | `sandbox: workspace-write`, `approvalPolicy: on-request` |
| `full` «Полный доступ» | `--dangerously-skip-permissions` | `sandbox: danger-full-access`, `approvalPolicy: never` |

- The list comes from the installed CLI:
  - Claude: the `--permission-mode` choices in its own `--help`, read only when the settings dialog opens;
  - Codex: the protocol versions whose types were compared (0.155.1); any other version gets only `terminal`.
- `full` is never a default. Choosing it shows a warning.
- The semantics of the two CLIs are not promised to be equal. Only the mapping is shown.
- No global config is written. The parameters apply to the one thread or process.
- The chosen rights are shown in the goal dialog, in readiness and on the run's board (review UX-2).
- At the start main checks the mode again against the installed CLI (Claude `--help`, the exact Codex version). A mode
  it does not offer is refused with `access_unsupported`, never narrowed silently (review RT-9, RT-7).
- What the CLI reports (`system/init.permissionMode`, `thread/start` `approvalPolicy`/`sandbox`) is compared with the
  chosen mode. A difference is a warning in the feed and the summary (RT-8). For `terminal` nothing is compared.

## 2. Project settings (profile)

A profile is saved once per project under `<userData>/orchestration/profiles/<sha256(project)>.json` (`profile.ts`).
It never goes into the project or a global config. It is filled from repository facts (`suggestProfile`), shown to
the person to edit, and validated in main (`validateProfile`). The goal dialog starts from it. The first autopilot
start of a project with no profile saves the suggestion, so that decisions have a place.

- **Up front:**
  - where the agents work (project folder or a separate worktree);
  - the check commands;
  - automatic preparation;
  - the rights of each CLI.
- **«Дополнительно»:**
  - the preparation steps (`command | path that appears after it`);
  - direnv;
  - whether to offer a commit by default;
  - push: a remote of the project and the branch on it (the remote's URL is read by main, never taken from the
    renderer; a changed URL stops the push);
  - QA: the environment name, the deploy command and the verification command;
  - the saved permissions (remove only);
  - the environment check.

Push and QA run only when this goal ticks them and the profile has them set up. Otherwise the start is refused with
`finish_not_configured`. CanvasTTY never guesses a server, branch or remote.

### Saved permissions (grants)

The panel offers «До конца запуска» (`allow_run`) and «Всегда в этом проекте» (`allow_project`) next to the CLI's own
options. Only kinds that are real permissions (command, file change, tool, permissions) get them. A question, a plan
and a form never do.

- **Fingerprint.** sha256 of the canonical `{provider, kind, tool, input}`. Only the top-level volatile fields of the
  request are removed: ids, `startedAtMs`, the description and reason of the request. Nested fields of the tool input,
  a nested `description` among them, stay (review RT-1). A decision applies only to the same provider, tool and
  parameters: for a command also `cwd`; for a Codex file change the paths taken from `item/started` (RT-4).
- **Never saved or applied** (`alwaysAsk`):
  - a Claude request that a user ask rule or a safety check forces on the person (`matched_ask_rule`,
    `decision_reason_type` rule/safetyCheck, `requires_user_interaction`; RT-2);
  - a Codex file change whose paths are unknown.

  Such a request offers neither «до конца запуска» nor «всегда в проекте», and the panel says «CLI требует
  спрашивать каждый раз».
- **«Разрешить на сессию» (Claude)** sends the CLI's own suggested rules with `destination: "session"`. They are never
  written to the project's `.claude/settings.local.json` (RT-3).
- **Codex execpolicy.** Codex 0.155.1 does not say whether its prompt came from a user execpolicy rule. Such a prompt
  can be answered by a saved decision for the same command and `cwd`. This is a known limit.
- **Where it is kept:**
  - run scope: in the journal (`permission.granted`);
  - project scope: also in this project's profile. Another project never sees it.
- **When it applies.** The CLI is answered "allow once". The journal gets `permission.applied`, the feed gets
  «Применено сохранённое разрешение», and no dialog is shown.

## 3. Environment preparation

`prepare.ts` suggests steps from lock files (install, never update):

| Condition | Step | Done when |
|---|---|---|
| `composer.json` | `composer install --no-interaction --no-progress` | `vendor/autoload.php` |
| Laravel without `.env` / `.env.testing`, with `.env.example` (always in a worktree) | `[ -f .env ] \|\| cp .env.example .env; grep -Eq '^APP_KEY="?[^"[:space:]]' .env \|\| php artisan key:generate --no-interaction` | `.env` with a key |
| `pnpm-lock.yaml` | `pnpm install --frozen-lockfile` | `node_modules/.modules.yaml` |
| `yarn.lock` (+`.yarnrc.yml`) | `yarn install --immutable` / `--frozen-lockfile` | yarn state file |
| `package-lock.json` (with packages besides the root) | `npm ci` | `node_modules/.package-lock.json` |
| `package.json` only | `npm install` | `node_modules` |

- **When it runs.** Before the first model turn (stage «Подготовка среды»: `prepare.started` / `prepare.finished`).
  The steps run in the user's login shell in the work folder. Afterwards readiness is checked again: a step whose
  path is still missing is a failure. Dependencies are never installed inside a check; preparation, checking and
  fixing are separate.
- **Which steps are needed.** A marker alone does not prove the install matches the lock file (review LC-5):
  - `prepare.finished` records the sha256 of each lock file;
  - a step is needed when its marker is missing or its lock file changed since;
  - with no record yet, a step is also needed when the lock file is newer than the marker.
- **Not in the separate copy.** Its dependencies are linked for the checks (LC-12).
- **Stopped preparation.** One stopped by quitting the application or by the deadline runs again after «Продолжить» (LC-4).
- **Changes made by preparation.** Paths the preparation changed (for example a lock file written by `npm install`)
  are left out of the commit (LC-10).
- **Failures are classified** (`classifyFailure`):
  - code: everything else;
  - environment: a missing program (exit 127), `vendor/autoload.php`, a missing module, no app key, a database
    that does not answer;
  - outside: DNS, network, TLS, 429, 502, 503, package download errors.
- **What happens after a failed check:**
  - environment: preparation runs once more (at most once per executor turn, LC-11), then the check again. No
    executor round is spent on it;
  - outside: the run pauses (`external_failure`). Fixes are not repeated while the network is down;
  - an unfixable environment pauses with `needs_user_action`, with one concrete message.
- **Laravel test database** (`laravelTestDb`, review LC-1…LC-3). What the tests would really use:
  - commented-out `<env>` lines of `phpunit.xml` do not count;
  - a `<env>` without `force="true"` does not override a variable of the process (the login shell, direnv), and
    `.env.testing` / `.env` never do;
  - `force="true"` wins;
  - the precedence, checked against the installed Laravel (review 2): `phpunit.xml` `force="true"` → a variable of
    the process → `phpunit.xml` without `force` → `.env.<APP_ENV>` when that file exists (so `.env.testing` only with
    `APP_ENV=testing`), else `.env`;
  - **only the active connection counts** (review 3). `config/database.php` is read statically, never run.
    - Its `'default'` gives the active connection's name. The name may differ from the driver: `'testing'`,
      `'reporting'`.
    - Only that connection's block is used: `driver`, `url`, `host`, `port`, `database`.
    - URLs of other connections are ignored, and the order of the connections does not matter.
    - Without the file: the framework's own configuration (Laravel 11+, `DB_URL`; when it is empty, `DATABASE_URL`
      of older versions is still counted).
    - The Laravel 11+ merge of the framework's connections with the application's is not modelled. A missing
      `'default'` or an active connection absent from the file is «unknown», never a guess.
  - **the supported subset of `config/database.php`**, read by a small tokenizer with bracket matching, not by
    regular expressions:
    - the whole file, at the top level (review 4), and nothing else:
      `<?php [declare(...);] (use Class[ as Alias][, ...];)* return <array>[;] [?>]`.
      - `<?php` in any case followed by a space, tab, `\n` or `\r` (as in PHP 8). Text before it must hold no other
        `<?`: no `<?=` or short tag. No `<?php` at all is unsupported.
      - Comments `//` and `#` end at `\n`, `\r` or `?>`, as in PHP. `?>` anywhere but at the end is unsupported.
      - Whitespace is only space, tab, `\n`, `\r`; any other character (NBSP, `\v`, `\f`, `\u2028`) is unsupported.
      - A `return` inside a function, a class, a closure or a condition (with or without braces), a statement
        before `return` other than `declare`/`use Class`, or anything after `return` makes the file unsupported:
        what the file really returns would depend on running it.
      - `namespace`, `use function` and `use const` are unsupported: they can make an unqualified `env()` another
        function.
    - `return [...]` / `array(...)` with string keys;
    - values: literals, `env('NAME')`, `env('NAME', literal)`;
    - `env('NAME', <anything>)` is known while `NAME` is set, as in `env('DB_DATABASE', database_path(...))`;
    - anything else (a function, a concatenation, a variable, a conditional, interpolation, a spread or computed
      key, a heredoc, an attribute) is «unknown». The field and the kind of construct are named, never its text.

    An unknown default, active connection, driver, url, host (non-SQLite) or database (SQLite) is `confirm`
    `config_unknown` with the field. It is never a safe SQLite;
  - **a connection URL replaces `DB_*`** (review 2) for the active connection: its `'url' => env('NAME')` —
    `DB_URL` in Laravel 11+, `DATABASE_URL` in older projects, or any other name.
    A URL in effect is read the way `Illuminate\Support\ConfigurationUrlParser` reads it: scheme → driver (with its
    aliases), host, port, database, query options. `scripts/laravel-url-crosscheck.mjs` compares this with the real
    parser on made-up addresses, with no connection: Laravel v13.33.0, 30 cases, 28 the same, 2 (a SQL Server DSN, a
    broken URL) not understood here and refused. The fixture is `tests/fixtures/orchestration/laravel-url-cases.json`;
  - the user and password of a URL are never read. Only the variable, driver, host, port and database name reach
    the interface, the refusal and the journal. A host a URL names is never probed.

  The levels:
  - `ok` — only when the database is set for the tests (`phpunit.xml` or `.env.testing`, in effect) or is SQLite
    `:memory:`. A SQLite file set for the tests in `phpunit.xml` and in effect by the precedence counts as a configured
    test database (review 4 decision). It is not a guarantee that the file is separate or holds no data;
  - `confirm` — the person must acknowledge: a database from `.env` or the environment, local or not a server
    (a local database can be the working one);
  - nothing set anywhere is now `confirm`: the framework default is a SQLite file, which can be the working database
    (review 3; it was `info`);
  - blocker — a non-local server (also from a URL), a URL that cannot be read (`url_unparsed`), or a Laravel
    configuration cache `bootstrap/cache/config.php` (it ignores the test environment);
  - a URL on a local host or a SQLite file is `confirm` (`url_overrides`); a configuration that cannot be read is
    `confirm` (`config_unknown`). Each says the reason and how to set a separate test connection, for example
    `<env name="DB_URL" value="" force="true"/>` in `phpunit.xml`;
  - a URL set in `phpunit.xml` or `.env.testing` counts as set for the tests, like `DB_DATABASE` there.

  The check is repeated in main when the run is created and again before a resume (`test_database_unsafe`): the
  refusal comes before any turn, check or preparation. It is not only a warning in the dialog. In a
  worktree the database is read from `.env.example`. Where it cannot be known, the interface never says the working
  database is protected.
- **direnv** (`applyDirenv`). An `.envrc` the user already allowed (`direnv status --json`) is applied on top of the
  login-shell environment (`direnv export json`). An `.envrc` that is not allowed is reported and not applied.
  CanvasTTY never runs `direnv allow`.
  - In a worktree direnv runs in the worktree folder. The project's allowance is not carried over (RT-10.4).
  - A variable of the person with a supervisor name (`SUP_*`, `ELECTRON_RUN_AS_NODE`) is left out of what reaches
    the CLI, and the feed says so. It no longer fails the turn (RT-10.3).

## 4. Full sessions

### Integration: the direct control protocol, not the Claude Agent SDK

Reconsidered in P13. The SDK's defaults are configurable (`settingSources`, the `claude_code` system prompt preset,
`pathToClaudeCodeExecutable`, `spawnClaudeCodeProcess`, `onElicitation`), so completeness is no longer an argument
against it. It still runs the same stdio control protocol that CanvasTTY speaks directly. We keep the direct protocol:

- the supervisor keeps owning the process group, stop, the deadline hold and crash cleanup;
- no second copy of the CLI and no new dependency in the packaged app;
- the missing subtypes were added instead.

We would switch if the protocol starts to need SDK-only behaviour.

### What is handled now

| | Claude (`control_request`) | Codex (app-server) |
|---|---|---|
| Permission | `can_use_tool` | `item/*/requestApproval`, `item/permissions/requestApproval` |
| Question | `can_use_tool AskUserQuestion` | `item/tool/requestUserInput` |
| Plan exit | `can_use_tool ExitPlanMode` → plan block (accept, or send back with notes as `message`) | the `plan` item in the feed («План Codex», RT-5) |
| MCP form | `elicitation` → `{action, content}` | `mcpServer/elicitation/request` → `{action, content, _meta}` |
| Sub-agents | `Task`/`Agent` tool use + messages with `parent_tool_use_id` | `collabAgentToolCall` items |
| What was loaded | `system/init`: model, permission mode, tools, `mcp_servers`, skills, plugins, slash commands, agents, output style | the `thread/start` reply: model, `approvalPolicy`, `sandbox`, `instructionSources`, cwd |

**MCP forms** (`forms.ts`):

- Supported fields are the flat MCP form schema: string (email, uri, date, date-time, lengths), number and integer
  (bounds), boolean, single choice (`enum`, `oneOf`, `enumNames`) and multiple choice.
- A server default is the only pre-filled value. Nothing personal is filled in.
- The answer is validated in main (`invalid_form`) before it goes to the CLI.
- A URL form shows the link to open by hand and a «Готово» button.
- A form with unsupported fields can only be declined.

**Environment check** («Проверить окружение», `probe.ts`). The person starts it from the settings. The CLIs are asked
without a user message, so no model turn happens:

- Claude: `initialize` and `mcp_status`;
- Codex: `config/read`, `skills/list`, `plugin/installed`, `mcpServerStatus/list`, `hooks/list`, `account/read`.

Items a CLI did not report are marked «не подтверждено». The panel's «Что сообщили CLI в этом запуске» shows the
session facts listed above. The absence of narrowing flags is never shown as proof of parity.

Found is not loaded or used (review RT-6):
- skills, plugins and hooks are shown as «найдено N, включено M»; disabled ones and untrusted or modified hooks are
  not counted as enabled;
- load errors are shown;
- every page of `mcpServerStatus/list` is read, and an incomplete list is marked;
- a Claude `system/init` list is what the CLI found at the start of the session: an MCP server can be `pending` or
  `failed`, and whether a skill or plugin was used is not known from it.

## 5. Observation

The panel keeps its stage-11 layout. The pinned summary adds a board:

- the mode;
- the stage;
- the preparation state;
- the checks passed out of the total, with the class of each failure;
- «От вас» — whether the person has to act;
- the number of saved permissions applied.

«Кто работает» names:

- the lead or the executor with its turn;
- «CanvasTTY готовит среду» during preparation;
- «CanvasTTY выполняет: коммит / push / деплой на QA» during an action after success.

Permission, question, plan and form are separate blocks. The result block lists:

- each check with its status and class;
- where the changes are (folder, or worktree branch and path);
- commit, push and QA, each with its status, the commit id and whether it was established after a restart.

Also shown (review UX-1…UX-5):
- the rights;
- a card and link chip say «Ждёт вашего решения» even when the panel is closed;
- the request is scrolled into view with its buttons visible at 1280×800;
- a pause after the application closed is `app_closed`, not «по запросу пользователя».

An action is «выполнено и подтверждено» only after its own check:

- commit: the id from the commit command;
- push: `git ls-remote` shows the branch at that commit;
- QA: three facts are kept apart (review 2):
  1. the verification command ran and exited 0;
  2. it reported the version it observed;
  3. the observed version equals the expected commit.

  **The version contract** (`profile.finish.qa.reportsVersion`, a checkbox in the settings). For each run of the
  verification CanvasTTY:
  - creates a new empty file (0600, in the run's folder in userData, never in the project) and passes its path in
    `$CANVASTTY_QA_RESULT`, with the expected commit in `$CANVASTTY_COMMIT`;
  - after exit 0 reads the file (at most 4 KB, a plain file only, no symlink). The first non-empty line must be a
    full commit id (40 or 64 hex), and CanvasTTY compares it with the expected one;
  - records the result as `version` with the observed id and the basis in the evidence:
    - `confirmed` — the expected id;
    - `mismatch` — another id;
    - `not_reported` — nothing;
    - `invalid` — not a commit id;
  - deletes the file.

  Without the contract (`not_checked`), the text and output of the command are not read at all: a mention of
  `$CANVASTTY_COMMIT`, a comment or an echo of the expected SHA proves nothing. Such a result reads «проверка
  прошла; версия не подтверждена». An older journal's `bound` also reads so.

  `confirmed` means only that the verification the person declared as following the contract reported that id.
  CanvasTTY does not prove what the script does.

An agent's report never counts. A result that is not confirmed is never shown as done.

## 6. Actions after success, recovery and limits

- Commit, push and QA are CanvasTTY's own steps (`finish.ts`), run with the user's git and deploy command in the login
  shell (their identity, hooks, signing, credentials). The agents are told not to commit, push or deploy themselves.
- **Commit in the project folder:**
  - only the paths the run changed are committed (`git commit --only -- <paths>`);
  - if one of them had the person's own uncommitted changes at the start, the run stops with `needs_user_action`.
    Nothing is committed on a guess.
- **Commit in a worktree:** the run's paths on the branch `canvastty/<run8>`.
- **The commit must hold the checked content** (LC-7):
  - after the commit its paths are compared with the checked tree (a hook can change them), and a difference makes
    the commit fail;
  - a confirmed commit of an older tree does not count for the current one;
  - push and QA deliver only the commit of the checked tree.
- **QA needs the commit.** A profile or goal with QA and no commit is refused, as for push.
- **The trailer.** Every commit carries `CanvasTTY-Run: <runId>`.
- **Before and after each action.** An intent (`finish.intent`) is journaled before the action and the result
  (`finish.result`) after it.
- **After an unknown outcome** (stop, crash or quit during the action), only the confirmation runs, never the action:
  - `git log --grep` for the trailer, and the commit's content must match (LC-7);
  - `git ls-remote`;
  - the QA verification. It is the person's command and is not known to be read-only, so it runs only after the
    person presses «Продолжить» on the `finish_unconfirmed` pause that says so (LC-8).

  If it cannot be confirmed, the run pauses with `finish_unconfirmed`.
- **A deploy that exited 0 with a failing verification** is «развёрнуто, не подтверждено». «Продолжить» runs only
  the verification again (UX-3). So does a verification that passed with `mismatch`, `not_reported` or `invalid`
  (status `unknown`, pause `finish_unconfirmed`). A new result file is made each time, so an old report cannot
  confirm a new check. A deploy that failed offers «Повторить: деплой на QA» by name.
- **The remote's address** is compared through `git remote get-url --all` and `--push --all` (with `pushInsteadOf`).
  A `pushurl` elsewhere stops the push before anything is sent (LC-9).
- **After a restart:**
  - the run is paused with `app_closed`;
  - a preparation that was in flight or stopped by the quit runs again (review 5):
    - quitting waits for the running operation's result for at most `stopGraceMs` + 1 s (20 + 1 s in the application,
      more than the whole stop sequence of the supervisor, INT → TERM → KILL, about 10 s). A step that ended in time
      is recorded as `stopped`. A step that did not (the process was killed without a quit, or the tree snapshot
      after the step took too long) has no end in the journal and is `interrupted` after the restart. Both lead to
      the same preparation again after «Продолжить», before the first model turn;
    - once shutdown has begun, no new process starts: the next step of an operation already under way (the
      verification after a QA deploy, `ls-remote` after a push, the address check before a push) is not started.
      A deploy that succeeds inside that window leaves its result unknown: after the restart it is
      `finish_unconfirmed`, and only the verification runs, never the deploy;
    - a result that arrives after the journal is closed writes nothing (neither the journal nor the activity file),
      continues nothing and starts no process;
    - the journal stays whole when read again after such a restart (`integrity: ok`). Before review 5 it could become
      `corrupt`: a new preparation or an established QA result conflicted with an entry the earlier process left in
      flight;
  - a waiting permission request belonged to the old process and is gone. The next turn asks again;
  - nothing starts by itself.
- **One rule admits every command of a compound operation** (review 6). A preparation step, the remote address
  check, commit, push, `ls-remote`, the QA deploy, its verification and a check after a restart all start through
  `admit()`. It refuses a start when:
  - the journal is closed;
  - the application is quitting;
  - the run is stopping or stopped;
  - the operation was aborted, or the run's time is over by the service's clock;
  - the run is not running.

  A refusal is an expected stop (`not_admitted`), never an environment or store error:
  - the run pauses with the reason that stopped it (`limit_reached`, `app_closed`) or becomes `stopped`;
  - a late successful answer does not change that reason;
  - a deploy or push that finished while its confirmation was refused is recorded as done with an unknown result
    (`unknown`, not established): the fact is kept, nothing is claimed confirmed;
  - an action refused after its intent is `not_done`;
  - a refused preparation step ends the preparation as `stopped`, and it runs again after «Продолжить».

  After a deadline a plain «Продолжить» is refused and the run stays on `limit_reached`. After the limit is raised,
  «Продолжить» shows `finish_unconfirmed`; the next one runs only the confirmation of the action already done
  (verification or `ls-remote`). The deploy and the push are never repeated by themselves. The deadline timer reads
  the same clock as `admit()`: when it fires before that clock has reached the deadline it waits for the rest, so
  setting the system clock back does not pause a run early.
- **Limits.** Stop, the time and turn limits and no-progress detection stay as they were. Autopilot is not an endless
  retry loop.

## Correction of P12 wording

In project-folder mode the agents change the folder's files, including files with the person's uncommitted
changes. The baseline snapshot at the start is for comparing and for telling the run's own changes from the
person's. It does not keep those files unchanged and reverts nothing. The UI texts (`orchWorkMode_projectHint`,
`orchReady_git_info`) and the docs are corrected.

## Acceptance (local, fake CLIs and programs)

**`tests/orchestration-autopilot.test.mjs`, 22 tests:**

- the rights mapping, and Claude's modes from `--help`;
- preparation steps, needed steps and the failure classes;
- the Laravel test database;
- readiness: preparation instead of «go to a terminal», a blocking production database, direnv not allowed;
- MCP form parsing and validation;
- the profile store and grant fingerprints;
- direnv applied and not allowed;
- the finish helpers;
- the activity mapping: session facts and sub-agents of both CLIs;
- the drivers: forms and plan;
- IPC validation;
- Node autopilot: `npm ci` prepared, a failing test fixed, one permission saved for the project and not asked
  again (also in the next run), while another project is asked;
- Laravel autopilot from the suggested profile: composer, `.env` and key, the test fixed;
- an environment failure of a check prepared once, with no extra executor round;
- MCP form (a wrong answer refused), plan exit sent back with notes, sub-agents of both CLIs, session facts;
- rights modes reach both CLIs; the environment probe of both CLIs with no model turn;
- worktree: commit and push to a bare remote, QA confirmed by its verification, the project folder untouched;
- push and QA refused when not configured;
- a QA deploy interrupted by quitting the application is not run again, and its verification completes the run;
- step-by-step pauses;
- stop during preparation; after a restart a waiting prompt is not carried over and nothing runs by itself;
- the board model;
- a commit in the project folder takes only the run's files.

**`scripts/smoke-autopilot-ui.mjs`** (real window 1280×800, screenshots in `evidence/ui-stage-13/`), 30 checks:

- the settings: modes from `--help`, the full-access warning, the mapping, QA, the environment probe;
- readiness: automatic preparation, a safe test database;
- the autopilot run: preparation, a permission saved once, the MCP form with a too-short value refused, the plan
  exit, a sub-agent, the failing test fixed, commit and QA confirmed;
- the result block;
- a reload.

**Regression:**

- the stage-12 smoke (`smoke-native-ui`), 20 checks;
- the targeted `tests/orchestration-*.test.mjs` files and `browser-ipc-security`;
- typecheck and build.

**After the review (2026-09-25).** Details are in [evidence/stage-13-review/](../evidence/stage-13-review/REVIEW.md).

- New regressions:
  - `tests/orchestration-stage13-runtime.test.mjs`, 7;
  - `tests/orchestration-stage13-lifecycle.test.mjs`, 16;
  - `tests/orchestration-stage13-ui.test.mjs`, 9.
- Full `npm test`: 1162/1162 (before the review 1130/1130).
- UI smoke: stage 13 — 40/40, stage 12 — 21/21, stage 11 — 46/46.
- E2E stage 9 (stop and recovery): 38/38.
- `smoke-orchestration`, `-ipc`, `smoke-check-sandbox`: pass.
- Build and typecheck: pass.

## Limited real series

**Done 2026-09-25: N and L** (`scripts/real-autopilot-series.mjs --real`,
[evidence/real-stage-13/](../evidence/real-stage-13/README.md)).

The conditions:
- a development build and a separate userData, new temporary projects;
- rights «Как в моём терминале», autopilot, no commit, push or QA;
- limits: 8 turns and 20 minutes per scenario, 16 turns and 50 minutes per series.

| # | Project | Result |
|---|---|---|
| N | Node, `package-lock.json`, no `node_modules` | `completed` in 83 s, 4 turns (Codex 3 / Claude 1). `npm ci` preparation; `npm test` passed; checked independently in the shell afterwards |
| L | `laravel/laravel` without `vendor/` and `.env`, SQLite `:memory:` forced in `phpunit.xml` | `completed` in 85 s, 4 turns. Preparation: composer, the `.env` step with the key, `npm install`; `php artisan test` passed; checked independently |

- **Interventions:** 0. The CLIs sent no permission prompts.
- **Known cost:** $0.5085 as Claude CLI reported it. Codex reports tokens only, so its cost is unknown (not zero).
- **Finding F-1 (open, minor).** The Laravel skeleton has no JS lock file. The suggested `npm install` is not needed
  for the tests, and it writes `package-lock.json` into the project.

**Not run on the real CLIs yet:** the table below from S3 on. Their branches are checked locally only. The prepared
series, rehearsed on the fake CLIs (review 5), is [S3-S7-PLAN.md](../evidence/real-stage-13/S3-S7-PLAN.md).

| # | Project | Mode, rights | What it confirms |
|---|---|---|---|
| S1 | small Node repo, `node_modules` removed | autopilot, `terminal` | `npm ci` preparation, a failing test fixed, Claude and Codex session facts in the panel |
| S2 | Laravel repo, `vendor/` and `.env` removed, sqlite in phpunit.xml | autopilot, `terminal` | composer and key preparation, `php artisan test`, test database guard |
| S3 | same as S1 | steps, Claude `acceptEdits` / Codex `workspace` | the mapped flags on the real CLIs (`system/init.permissionMode`, the `thread/start` reply), stage pauses |
| S4 | a repo with one MCP server that asks a form (a local test server) | autopilot | real `elicitation` on both CLIs, validation, decline |
| S5 | S1 with a task that makes Claude plan first | autopilot, Claude `--permission-mode plan` set in its own settings | a real ExitPlanMode through `can_use_tool` |
| S6 | S1 in a worktree | autopilot + commit + push to a bare repo + QA script | commit trailer, `ls-remote` confirmation, QA verification. Then quit during QA and restart: the QA command must not run again |
| S7 | «Проверить окружение» on the person's usual project | — | the lists both CLIs report compared by the person with what they see in a terminal (`/mcp`, `/skills`) |

S1 and S2 were done as N and L above, in a narrower form: new temporary projects, not copies of the person's projects.
Terminal parity may be claimed only for what the real runs actually showed.

## Known limits

- Codex plan-mode exit has no approval request in the protocol; the `plan` item is shown in the feed only.
- A URL form is completed by hand in a browser; CanvasTTY does not open links from agents.
- The restricted modes of stages 4–11 still exist for runs created before P12.
- `laravelTestDb` reads `phpunit.xml`, `.env.testing`, `.env`, the environment and the configuration cache. It does
  not evaluate `config/database.php`.
- Codex 0.155.1 does not mark a prompt that its execpolicy rule forced. A saved decision can answer it for the same
  command and `cwd`.
- Some feed texts come from main in English, among them «verification: exit N», «established: …» and the step
  results of preparation.
- The preparation freshness of pnpm and yarn is by marker and lock-file fingerprint only. An empty lock file of those
  managers is not recognised.
- F-1: `npm install` without a lock file writes one into the project.
