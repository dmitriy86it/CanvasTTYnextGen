# Claude «Рабочая папка» (access `workspace`): probe P1–P4

Date: 2026-10-03. Claude Code 2.1.287 (model claude-opus-5-5), codex-cli 0.155.1, macOS (Seatbelt).
Script: `scripts/claude-workspace-probe.mjs --real`, four real model turns (one per probe), through the application's
own native path (`nativeRuntime` → `buildNativeTurn` → `claudeHostDriver` → supervisor), on a temporary Git copy of
`tests/fixtures/orchestration/check-project`. Every permission prompt was denied by the probe's host and recorded.

Arguments of the mode (`claudeAccessArgs("workspace")`):

```
--permission-mode acceptEdits --settings {"sandbox":{"enabled":true,"failIfUnavailable":true,
  "autoAllowBashIfSandboxed":true,"allowUnsandboxedCommands":true,"network":{"allowedDomains":[],"allowLocalBinding":true}}}
```

`system/init.permissionMode` was `acceptEdits` in all four sessions (no access mismatch).

| Probe | Asked of Claude | What happened | Prompts (stream-json → host) | State after |
|---|---|---|---|---|
| P1 | `npm test` | ran once, exit 0, 2/2 pass | none | the test's write to `$HOME` failed with `EPERM` inside the sandbox; no file outside |
| P2 | write a file in `$HOME` | Write tool call refused | one `control_request` `can_use_tool` (tool `Write`, `file_path` in `$HOME`) → the host's ask; denied | file not created |
| P3 | `curl https://example.com` | not run | one `control_request` `can_use_tool` (tool `Bash`, the curl command) → the host's ask; denied | no request made |
| P4 | `node --test` of a server on 127.0.0.1 | ran once, exit 0, 1/1 pass | none | — |

In the application the host's ask is the permission request of the run: in autopilot it pauses the run until the
person answers. Both refusals also appear in `result.permission_denials`.

Files: `probe.json` (the full record, paths shortened), `probe.log`.
