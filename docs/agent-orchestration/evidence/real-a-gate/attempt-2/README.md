# Stage A gate: real series R1–R5, attempt 2 (halted at R1)

Date: 2026-10-03. Source: `main` at 5df7ed2 (with PR #22). Codex model `gpt-6-sol`, changed by the owner's permission.

Conditions:
- development build, `CANVASTTY_JOURNAL_V2=1`;
- a temporary userData and project for each scenario;
- rights «Рабочая папка», a separate copy, autopilot;
- CLIs: codex-cli 0.155.1, Claude Code 2.1.287.

## Result

R1 paused with `invalid_report` on the reviewer's first stage review. The series halted, and R2–R5 did not start.

| | |
|---|---|
| Model calls | 3 (Codex plan, Claude execute, Codex review) |
| Time | 79 s |
| CLI protocol errors | none: every turn finished with contract `verified` and a schema-valid report |
| Permission prompts | none |
| `~/.codex/config.toml` | unchanged (same sha256 before and after; no entry for the run's copy) |

The run itself had gone well up to that point:
- plan v1 had conditions C1, C2 (`change`) and C3 (`check cmd-1`);
- the executor wrote `src/clamp.mjs` and `tests/clamp.test.mjs`;
- `node --test` passed on the tree.

## Diagnosis: an application defect

The reviewer's report (`R1/review-report.json`) marks C1, C2 **and C3**. The application accepts marks only for the stage's `change` conditions (`stageMarksProblems`): "C3 is not a change condition of this stage". So it refused the whole report.

The reviewer was led into this by two things:
- **The task.** It lists all three conditions, C3 with its status "met" (`R1/review-task.txt`, lines 59–62). The instruction "one mark for every change condition" sits two lines below.
- **The schema.** It accepts any condition id.

Whether a model marks a `check` condition decides whether a correct review is refused.

## Files

- `report.json`, `series.log`: the series report.
- `R1/journal.jsonl`, `R1/activity.jsonl`: the run's journal and activity (paths shortened).
- `R1/plan.json`, `R1/review-task.txt`, `R1/review-report.json`: the plan, the reviewer's task and its report.
