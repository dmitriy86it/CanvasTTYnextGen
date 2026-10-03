# Stage A gate: real series R1–R5, attempt 1 (halted at R1)

Date: 2026-10-03. Source: `main` at cf078e9, development build, `CANVASTTY_JOURNAL_V2=1`. Each scenario gets a temporary userData and project. Rights: «Рабочая папка» (the default). R1 ran in a separate copy, autopilot.
Script: `node scripts/real-a-gate-series.mjs --real`. CLIs: codex-cli 0.155.1, Claude Code 2.1.287.

## Result

R1 stopped at its first model turn: the Codex lead's plan turn. The run paused with `environment_error`, and the series halted. R2–R5 did not start.

| | |
|---|---|
| Model calls | 1 (the Codex plan turn; Claude was not called) |
| Time | 10 s |
| CLI protocol errors | none (contract `verified`, turn `failed`, exit code 0) |
| Permission prompts | none |

## Diagnosis

The Codex turn failed on the service side with HTTP 400 (`R1/activity.jsonl`):

```
The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account.
```

- The application passes no model. Codex takes it from the person's `~/.codex/config.toml` (`model = "gpt-6.1-sol"`). The same CLI in a terminal fails the same way.
- The application did the right thing: the run paused with `environment_error`, with no next turn and no false completion.
- Codex's own warning in the same feed: `Model metadata for gpt-6.1-sol not found`.

## Side effect on the person's files

During the turn Codex appended a trust entry for the run's working copy to `~/.codex/config.toml`:

```
[projects."/private/tmp/cto-a-gate-…/R1/user-data/orchestration/runs/…/workspace/repo"]
```

This is Codex's own behaviour, already recorded in the earlier series. The application writes nothing to that file.

## Files

- `report.json`, `series.log`: the series report (attempt 1).
- `R1/journal.jsonl`, `R1/activity.jsonl`: the run's journal and activity (paths shortened).
