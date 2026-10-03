# Stage A gate: real series R1–R5, attempt 3 (halted at R1)

Date: 2026-10-03. Source: `main` at ba2243c, with PR #23 (review marks).

Conditions:
- Codex model `gpt-6-sol`;
- development build with `CANVASTTY_JOURNAL_V2=1`;
- a temporary userData and project for each scenario;
- rights «Рабочая папка», a separate copy, autopilot;
- CLIs: codex-cli 0.155.1 and Claude Code 2.1.287.

## Result

R1 paused with `invalid_report` on the reviewer's first stage review. The series halted, and R2–R5 did not start.

| | |
|---|---|
| Model calls | 3 (Codex plan, Claude execute, Codex review) |
| Time | 69 s |
| CLI protocol errors | none; every turn finished with contract `verified` and a schema-valid report |
| Permission prompts | none |
| `~/.codex/config.toml` | unchanged (same sha256 before and after; no entry for the run's copy) |

## What PR #23 changed here

The fix worked:
- the reviewer was offered only C1 and C2 (`R1/review-task.txt`: "give one mark for each of C1, C2 … Do not mark C3");
- it did not mark the check condition C3.

## Diagnosis: a second application defect, in the plan

The lead's plan (`R1/plan.json`) has two `change` conditions:
- C1: "src/clamp.mjs implements … and tests/clamp.test.mjs covers its behavior";
- C2: "tests/clamp.accept.test.mjs remains unchanged".

C2 is a condition of the form "a file does **not** change". A `change` condition is met only by a review naming files the run changed, so no review can ever prove C2. The reviewer answered honestly, "met" with `paths: []` (`R1/review-report.json`). The rule "met without paths" then refused the report, as it must, because such a mark carries no evidence.

The run has no way out of this:
- a "not met" mark keeps the stage open until its rounds run out;
- a "met" mark is refused.

The plan's task and its validation allow such a condition. The task says only "change … is met when the review marks it met, naming the files changed for it".

## Files

- `report.json`, `series.log`: the series report.
- `R1/journal.jsonl`, `R1/activity.jsonl`: the run's journal and activity (user name replaced).
- `R1/plan.json`, `R1/review-task.txt`, `R1/review-report.json`: the plan, the reviewer's task and its report.
