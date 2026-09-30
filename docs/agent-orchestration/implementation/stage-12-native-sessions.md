# Stage 12: agents run in the user's own environment

Status: implemented 2026-09-24 (fake CLIs only; no real model run). It replaces the restricted modes of stages 1–11
(`structured-readonly`, `structured-edit`, the managed copy and the Seatbelt check sandbox) as the default. Decision
record: [ADR-20260924](../../adr/ADR-20260924-orchestration-native-sessions.md). Where the result differs from this
design, see "As implemented" at the end.

## Requirement

Codex and Claude on the canvas behave as when the user starts them in a terminal in the chosen project:

- the same account and auth;
- the same settings, model and permission mode;
- the same skills, plugins, MCP servers, hooks, custom agents, project instructions and memory;
- the same shell, PATH and environment;
- the same access to files, network, Git and outside services.

CanvasTTY adds no bans of its own. The CLI's own permission prompts stay. They are delivered to the user and never
answered automatically or bypassed. Roles (lead, executor) are duties written into the task, not removed tools.

Acceptance: the same task in the same project with the same settings has the same capabilities in the CLI and in
CanvasTTY. Every remaining difference is listed in the interface.

## What stages 1–11 did (facts from the code)

| Area | Before | Conflict |
|------|--------|----------|
| Codex | `codex exec --json --ignore-user-config --ignore-rules -s read-only -c approval_policy="never"` | ignores config, rules, MCP; no approvals; read-only |
| Claude | `claude -p --safe-mode --restricted --tools Read,Edit,Write,Glob,Grep --strict-mcp-config --permission-mode dontAsk --permission-prompts none` | no CLAUDE.md, skills, plugins, hooks, MCP, shell; prompts denied |
| Environment | `HOME, USER, LOGNAME, LANG, PATH (registry), CODEX_HOME` only | no login-shell PATH or variables |
| Folder | a managed copy (`control.git` snapshot) in userData | not the project folder |
| Checks | `node --test` only, in a Seatbelt sandbox without network | cannot check PHP/Laravel; no network |

## Integration chosen

### Codex: `codex app-server` (stdio JSON-RPC)

This is the protocol of the Codex IDE extension. It was checked on 0.155.1 with `generate-ts` only; no model was run.

- It loads `~/.codex/config.toml`, the profile, AGENTS.md, skills, plugins, MCP and hooks like the TUI does.
- `thread/start {cwd}` is sent without `approvalPolicy`, `sandbox` or `config` overrides, so the user's own settings
  decide.
- `thread/resume` continues the role's thread.
- `turn/start {input, outputSchema}` asks for the structured answer; `turn/interrupt` stops a turn.
- Approvals arrive as server requests and are shown to the user; the user's decision is sent back:
  - `item/commandExecution/requestApproval`
  - `item/fileChange/requestApproval`
  - `item/permissions/requestApproval`
  - `item/tool/requestUserInput`
  - `mcpServer/elicitation/request`
- Notifications feed the activity view: `item/started`, `item/completed`, deltas, `turn/completed`, errors.
- Difference: the command is marked `[experimental]` in 0.155.1.

### Claude: `claude -p` with the host control protocol

Claude runs with `--input-format stream-json --output-format stream-json --verbose --permission-prompt-tool stdio
--json-schema … --session-id|--resume`. These are the same flags the official Agent SDK uses, but the SDK is not
used: it defaults to no setting sources and no Claude Code system prompt.

- No `--safe-mode`, `--restricted`, `--bare`, `--tools`, `--setting-sources`, `--strict-mcp-config`,
  `--permission-mode` or `--permission-prompts none`. User, project and local settings, CLAUDE.md, skills, plugins,
  hooks, MCP and the configured `defaultMode` apply as in the terminal.
- A tool that would prompt sends `control_request {subtype: "can_use_tool"}`. CanvasTTY shows it and answers with
  the user's allow or deny, never on its own.
- A stop sends `control_request {subtype: "interrupt"}`, then the supervisor ends the process group.

### Environment

The environment is that of an interactive login shell in the project folder: `$SHELL -ilc 'env -0'`. It is measured
once per run start with a timeout and without secrets in logs. CanvasTTY's own variables are removed as for terminals
(`terminalEnvironment`). If the measurement fails, the run does not start; the user sees why.

### Where the agent works

- **Project folder (default).** The card and the panel say: "Works directly in <path>: changes land in your files."
  The agents change the folder's files, including files with the user's uncommitted changes (corrected in P13: the
  baseline below is for comparison; it does not keep those files unchanged). What CanvasTTY itself guarantees:
  - at the start, a baseline commit object of the whole working tree is made with a temporary index (tracked and
    untracked, `.gitignore` honoured), and the user's files and index are not touched;
  - "Changes" is the difference from that baseline;
  - nothing is ever reset automatically; "reset to checkpoint" does not exist in this mode.
- **Separate worktree (explicit option).** `git worktree add <path> -b canvastty/<run>` is visible in `git worktree
  list`, and the path is shown. It is chosen in the goal dialog, never silently.
- **Order.** One turn at a time per project folder, across all links and runs (a folder lock in main). The lead and
  the executor never run at the same time.

### Checks

Checks are the project's own commands, entered or confirmed by the user in the goal dialog, for example:

- `php artisan test`
- `composer test`
- `vendor/bin/phpunit`
- `npm test`

They run in the project folder through the same login-shell environment, without a sandbox. Readiness proposes
commands from the project's files (composer.json scripts, artisan, package.json scripts) and never presents a missing
check as success.

### Differences that remain (shown in the interface)

| Provider | Difference | Status |
|----------|-----------|--------|
| both | Interactive TUI-only features (slash commands typed by the user, status line, TUI keybindings) are not available in a managed turn | by design of print/app-server modes |
| both | Prompt-time shell hooks (direnv, precmd) do not run for `-ilc`; variables they set are missing unless set in rc files | measured difference |
| Codex | app-server is experimental in 0.155.1 | CLI status |
| Claude | behaviour of AskUserQuestion and plan-mode exits over the host protocol | not verified without a model run |
| both | Parity of loaded skills/MCP/plugins | checked by the "Environment" diagnostic, not by a model run |

The "Environment" diagnostic lists what each CLI loaded without calling a model:

- Claude: the `initialize` control response (commands, agents, models, account kind);
- Codex: `skills/list`, `plugin/installed`, `mcpServerStatus/list`, `hooks/list`.

It is started by the user and is not run by local tests.

## Stages

1. Environment capture, folder lock, direct-folder baseline and changes (git plumbing with a temporary index).
2. Codex app-server client (JSON-RPC over the supervisor's stdio), approvals as run pauses of kind `awaiting_permission`.
3. Claude host protocol (can_use_tool, interrupt), the same pause kind.
4. Checks as the user's commands. Readiness rewritten: stack → proposed commands; no sandbox or "no shell" claims.
5. UI:
   - the permission request block in the pinned summary;
   - "where it works" on cards and panel;
   - the worktree option in the goal dialog;
   - the differences list.
6. Mocks of both protocols, tests, UI smoke. Remove the restricted modes, the copy and the check sandbox with their
   tests.
7. Docs: ROADMAP, VALIDATION-MATRIX, TROUBLESHOOTING, FIRST-USE, ADR.

Not done by local tests: real model runs, outside actions, changes to global settings or the installed app. The
user's existing run `1b88a002…` is not resumed or changed.

## As implemented (2026-09-24)

Deviations from the design above:

| Design | Implemented | Why |
|--------|-------------|-----|
| Separate `git worktree` as the option | the old managed copy (`clone --shared` in userData), labelled "separate copy" | it already existed with snapshots and recovery; a worktree would add a second path to review |
| Permission prompts as journaled pauses `awaiting_permission` | prompts held in memory while the run stays `running`; the turn deadline is held; the headline says "awaiting your permission" | the CLI process holds the prompt; after a restart the process is gone, so a journaled prompt could not be answered anyway |
| "Environment" diagnostic (skills, MCP, plugins, hooks each CLI loaded) | **not done** | needs a separate user-started call; parity is by construction (no narrowing flags) |
| Remove the restricted modes, the copy and the check sandbox with their tests | **not done**: kept for runs created before stage 12 (goals without `commands`) | the user's existing runs must stay readable and recoverable; removal after review |
| Folder lock across links | one active run per project folder (`folder_busy`, checked in `canvasStore.startOnLink` and in readiness) | turns inside one run are already sequential |

Differences listed in the interface (`orchDiff_*`): tui, rcHooks, codexExperimental, claudeQuestions, elicitation
(MCP forms can only be declined), snapshots (the project must be a Git root; submodules and untracked nested
repositories unsupported), sequential (one run per folder).

Verification (local, fake CLIs speaking both protocols):

- `tests/orchestration-native.test.mjs`, 11 tests:
  - the drivers;
  - argv without narrowing flags;
  - allow and deny prompts;
  - a stop that withdraws a prompt;
  - a failing user command that sends the stage back;
  - the project work place keeps uncommitted work;
  - the login environment;
  - Laravel readiness;
  - IPC.
- All 38 `tests/orchestration-*.test.mjs` files, plus `browser-ipc-security` and `packaging-fuses`.
- `scripts/smoke-native-ui.mjs`: the real window at 1280×800, 20 checks, screenshots.
- `scripts/smoke-orchestration-ui.mjs`: 45 checks.
- `scripts/e2e-orchestration.mjs` in copy mode: 38 checks.
