# Stage A gate: real series R1–R5, attempt 4 (halted at R2)

Date: 2026-10-04. Source: `main` at da0b86f (PR #26, model per role).

Conditions:
- models through the new project setting, not `config.toml`: Codex lead and reviewer `gpt-6-sol`, Claude executor «Как в CLI»;
- development build with `CANVASTTY_JOURNAL_V2=1`;
- a temporary userData and project for each scenario;
- rights «Рабочая папка», a separate copy (R3: a worktree), autopilot;
- CLIs: codex-cli 0.155.1 and Claude Code 2.1.287;
- budget: 28 model calls, 90 minutes.

Command: `node scripts/real-a-gate-series.mjs --real --codex-model gpt-6-sol --calls 28 --minutes 90 --out docs/agent-orchestration/evidence/real-a-gate/attempt-4`.

## Result

| | Status | Calls | CLI protocol errors | Permission prompts | Models (reported by the CLI at start) |
|---|---|---|---|---|---|
| R1 | **completed, confirmed**: 3 of 3 conditions met, R1 and R2 met | 4 (lead, executor, reviewer ×2) | none | none | lead `gpt-6-sol`, executor `claude-opus-5-5`, reviewer `gpt-6-sol` |
| R2 | **paused `check_needs_permissions`** | 2 (lead, executor) | none | none | lead `gpt-6-sol`, executor `claude-opus-5-5` |
| R3–R5 | not started (the series halts at the first failure) | — | — | — | — |

Total: 6 model calls, 2.6 minutes.

The global files were the same before and after (sha256):
- `~/.codex/config.toml` `9d413be3…`;
- `~/.claude/settings.json` `35326241…`.

The Codex model was passed per thread. `config.toml` still names `gpt-6.1-sol`, and every Codex turn reported `gpt-6-sol`.

## Diagnosis: git cannot run in the check sandbox

In R2 the lead proposed three checks (`R2/checks-proposal.json`). The autopilot accepted them, because the checks' network is denied:
1. `node --test tests/clamp.accept.test.mjs`: passed;
2. `git diff HEAD --exit-code -- tests/clamp.accept.test.mjs`: **exit 128**, classified `sandbox`;
3. `node --test`: not run.

The output of check 2 (`R2/check-cmd-2-output.txt`): `fatal: unable to access '~/.gitconfig': Operation not permitted`.

The check profile (`sandbox.ts`, `buildCheckProfile`) denies reading `~/.gitconfig` and `~/.config/git`, on purpose: they are on the credential list. git treats a global config it may not read as a fatal error. So **every git command** the lead proposes fails in the sandbox, whatever it does. The run then pauses for the person, as A1.1 decided: a check the sandbox refused waits, even in the autopilot.

The lead will propose a command like check 2 often. Since PR #25 the lead is told that "a file stays unchanged" is a check command, not a `change` condition, and `git diff --exit-code` is the natural one.

## Proposed fix (not made here)

In the environment of a check that runs in the check profile, set `GIT_CONFIG_GLOBAL=/dev/null`. git then does not read the global config at all (neither `~/.gitconfig` nor `$XDG_CONFIG_HOME/git/config`), and the deny list stays as it is.

The cost: the person's global git settings (aliases, `core.autocrlf` and the like) do not apply to the lead's sandboxed checks. The person's own commands keep running in their shell, unchanged.

Test: a sandboxed check `git diff --exit-code` on a clean copy passes under a real `sandbox-exec` with a `~/.gitconfig` present. It goes red without the fix. A self-test item is worth adding as well.

After the fix: attempt 5, with the 22 calls left.
