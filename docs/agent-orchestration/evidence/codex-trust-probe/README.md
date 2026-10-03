# Codex trust entries: probe (codex-cli 0.155.1, 2026-10-03)

No model request: `codex app-server` with a temporary `CODEX_HOME` whose `config.toml` holds one line, `initialize`, then
one `thread/start` in a new Git folder (`probe.mjs <cwd> [app-server args]`; `NOACCESS=1` sends `{cwd}` only, `EXTRA`
adds thread parameters as JSON). After each, `config.toml` is read.

| thread/start | Trust entry written to config.toml |
|---|---|
| `{cwd}` (no rights parameters; the config has no `sandbox_mode`) | no |
| `{cwd, sandbox: "workspace-write", approvalPolicy: "on-request"}` | **yes**: `[projects."<cwd>"] trust_level = "trusted"` |
| the same, app-server started with `-c 'projects."<cwd>".trust_level="trusted"'` | **yes** |
| `{cwd}`, app-server started with `-c sandbox_mode="workspace-write" -c approval_policy="on-request"` | **yes** |
| `{cwd, sandbox, approvalPolicy, ephemeral: true}` | **yes** |
| `{cwd, sandbox, approvalPolicy, config: {projects: {"<cwd>": {trust_level: "trusted"}}}}` | **no**; the thread reports `approvalPolicy: on-request`, `sandbox: workspaceWrite` |

Codex persists the trust of a folder it does not know as soon as a thread there runs with a workspace-write sandbox; a
command-line override does not stop it, the thread's own `config` does (`thread/resume` takes `config` too). The
application passes that per-thread trust for the run's own copy or worktree only (`sessions.ts` `trustCwd`); in the
project folder nothing is passed, as before.
