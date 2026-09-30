# ADR: Orchestrated Agents Run as the User's Own CLI Sessions

**Date:** 2026-09-24
**Scope / Component:** agent orchestration (lead → executor): provider turns, environment, work folder, checks, permissions
**Risk/Strictness Profile:** Production
**Status:** Accepted (implemented; not yet verified with a real model run)

**Related:** [stage 12 design](../agent-orchestration/implementation/stage-12-native-sessions.md),
[ADR: packaged fuses keep runAsNode](./ADR-20260913-packaged-fuses-keep-run-as-node.md)
**Implementation:** [`sessions.ts`](../../src/main/services/orchestration/sessions.ts),
[`providers.ts`](../../src/main/services/orchestration/providers.ts) (`buildNativeTurn`),
[`loginEnv.ts`](../../src/main/services/orchestration/loginEnv.ts),
[`userCheck.ts`](../../src/main/services/orchestration/userCheck.ts),
[`workspace.ts`](../../src/main/services/orchestration/workspace.ts) (`mode: "project"`),
[`readiness.ts`](../../src/main/services/orchestration/readiness.ts),
[`RunPanel.tsx`](../../src/renderer/src/features/orchestration/RunPanel.tsx) (`PermissionBlock`, `Differences`)

## Context and Problem Statement

Stages 1–11 ran the lead and the executor in restricted modes:

- Codex: `exec --ignore-user-config --ignore-rules -s read-only`, no approvals.
- Claude: `--safe-mode --restricted --tools Read,Edit,Write,Glob,Grep --permission-prompts none`.
- A reduced environment and a managed copy of the project in userData.
- Checks limited to `node --test` in a Seatbelt sandbox without network.

A Laravel project could not be checked at all, and the agents did not have the user's skills, MCP servers, hooks,
instructions or shell. The owner's requirement of 2026-09-24 takes priority: Claude and Codex in CanvasTTY work as
when the user runs them in a terminal of the project. CanvasTTY adds no bans of its own. The CLI's own permission
prompts reach the user and are never answered automatically.

## Decision

1. **Codex speaks `codex app-server`** (stdio JSON-RPC, the protocol of the Codex IDE extension).
   - `thread/start {cwd}` is sent without approval, sandbox or config overrides, so `config.toml`, the profile,
     AGENTS.md, skills, plugins, MCP and hooks load as in the TUI.
   - The role's thread continues with `thread/resume`.
2. **Claude runs `claude -p` with the host control protocol**:
   `--input-format stream-json --output-format stream-json --verbose --permission-prompt-tool stdio --json-schema …`.
   - No flag narrows the settings, tools or permission mode.
   - `can_use_tool` requests are the CLI's own prompts.
   - The Agent SDK is not used: it defaults to no setting sources.
3. **Environment = the user's interactive login shell in the project folder** (`$SHELL -ilc 'env -0'`, 15 s timeout,
   based on the terminal environment of CanvasTTY).
   - The supervisor passes it whole to the CLI (`SUP_CHILD_ENV`).
   - If it cannot be measured, the run does not start.
4. **Work place: the project folder by default.**
   - Snapshots, baseline and checkpoints are Git objects in the application's `control.git`, built with a temporary
     index. The source repository gains only the create-only refs `refs/canvastty/<runId>/…` and their objects; the
     user's branch, index and uncommitted files are not touched.
   - Nothing is reset automatically, and reset to a checkpoint is refused in this mode.
   - The old managed copy stays as an explicit option ("separate copy").
   - One active run per project folder (`folder_busy`); lead and executor take turns.
5. **Checks are the user's own commands** (`php artisan test`, `composer test`, `npm test`, …).
   - They run in the same login shell and folder, without a sandbox, under the supervisor (stop, timeout, group
     cleanup).
   - A check that changes tracked files is `not_verified(tree_changed)`.
6. **Permission prompts are shown in the run panel**; the person answers:
   - allow once, allow for the session, deny;
   - answers to questions.
   While a prompt waits, the turn's deadline is held. A stop withdraws the prompt and interrupts the turn through
   the protocol.
7. **Readiness is computed before any model turn**, from facts only:
   - the stack and the suggested commands;
   - `vendor/` for Laravel;
   - whether the program of each command is on the login PATH;
   - Git state, work place, CLI versions against the protocol shapes compared.
8. **The remaining differences are listed in the goal dialog and the run panel** (`orchDiff_*`), not hidden.

## Consequences

- An agent can do in CanvasTTY what it can do in the terminal, including destructive actions the user's own settings
  allow without a prompt. The work place line ("works directly in your files") is shown on every run panel.
- Runs created before this change (goals without `commands`) keep the restricted runtime. They are not migrated or
  resumed silently.
- The native protocols are experimental or undocumented in part (Codex app-server is `[experimental]` in 0.155.1).
  Readiness warns when a CLI version differs from the versions the shapes were compared with (codex 0.155.1, claude
  2.1.280–2.1.281).
- Pending prompts live in memory: after an application restart, the CLI process is gone and the turn is recovered
  like any interrupted turn.

## Not verified

- No real model was run for this change: only fake CLIs that speak both protocols (`tests/orchestration-native.test.mjs`,
  `scripts/smoke-native-ui.mjs`).
- Parity of loaded skills, MCP and plugins is by construction (no narrowing flags), not by a diagnostic run.
- Claude's AskUserQuestion and plan-mode exit over the host protocol follow the SDK's documented shape; they were not
  observed with the real CLI.

## Alternatives Considered

- **Managed PTY of the TUI.** Rejected: its screen output is not a machine-readable report, and permission prompts
  would have to be scraped.
- **Agent SDK.** Rejected here because of its defaults (no setting sources, its own system prompt). **Reconsidered
  in P13** ([stage-13-autopilot.md](../agent-orchestration/implementation/stage-13-autopilot.md) §4): the defaults are
  configurable, so parity is not the reason any more. The direct control protocol is kept because the SDK speaks
  the same protocol over a CLI it spawns, and the supervisor keeps owning the process group, stop and crash cleanup.
  No new dependency is needed. The missing subtypes (elicitation, ExitPlanMode) were added to the direct client.
- **Keep the restricted modes and add allow-lists.** Rejected: it is still a CanvasTTY ban that the terminal does
  not have.
