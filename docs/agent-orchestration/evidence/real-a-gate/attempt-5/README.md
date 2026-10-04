# Stage A gate: real series R1–R5, attempt 5 (passed)

Date: 2026-10-04. Source: `main` at a5dec06, with:
- #26: a model per role;
- #28: git in the check sandbox;
- #29: smokes in v2, and the executor waiting for the reviewer.

Conditions, the same as attempt 4:
- models through the project setting: Codex lead and reviewer `gpt-6-sol`, Claude executor «Как в CLI»;
- development build with `CANVASTTY_JOURNAL_V2=1`;
- a temporary userData and project for each scenario;
- rights «Рабочая папка», a separate copy (R3: a worktree), autopilot;
- CLIs: codex-cli 0.155.1 and Claude Code 2.1.287;
- budget: the 22 calls left after attempt 4, and 90 minutes.

Command: `node scripts/real-a-gate-series.mjs --real --codex-model gpt-6-sol --calls 22 --minutes 90 --out docs/agent-orchestration/evidence/real-a-gate/attempt-5`.

## Result

| | Expected | Status | Calls | Protocol errors | Prompts | Models (reported by the CLI) |
|---|---|---|---|---|---|---|
| R1 | the goal's commands → confirmed | completed, **confirmed**; 3/3 conditions, R1 and R2 met | 4 | none | 0 | lead/reviewer `gpt-6-sol`, executor `claude-opus-5-5` |
| R2 | empty commands → the lead proposes, the autopilot accepts → confirmed | completed, **confirmed**; 2 proposed checks passed in the check sandbox (`checksFrom: proposal`); 3/3 conditions | 4 | none | 0 | the same |
| R3 | no tests → «Завершено без проверок», no push | completed, **no_checks**; push waited for the person and was declined; the remote had no refs before the decision or at the end | 4 | none | 0 | the same |
| R4 | «Стоп» during a Claude turn | **stopped**; the turn ended `stopped`; no process of the run left | 2 | none | 0 | lead `gpt-6-sol`; the executor was stopped before it reported a model |
| R5 | «Пауза после хода», then «Продолжить» | paused `user_request` after the Claude turn completed, then completed, **confirmed** | 4 | none | 0 | lead/reviewer `gpt-6-sol`, executor `claude-opus-5-5` |

Total: 18 of the 22 calls, 6.3 minutes. No completion without evidence: each `confirmed` has every condition met. R3 is `no_checks`, with no command run.

The global files were the same before and after:
- `~/.codex/config.toml` sha256 `47430266bb3012f4bf86940f5769301ff1a4f2fbe8a6919876cb1ae9353bf74c`;
- `~/.claude/settings.json` sha256 `3532624114b65856efab2f330a7372752b9405e8a84d4b5ad3d8126c606e5738`.

## About the fix of attempt 4

In R2 this time the lead proposed `node --test tests/clamp.accept.test.mjs` and `node --test tests/*.test.mjs`, with no git command. So the series did not exercise #28 (git in the check sandbox). That fix is proven by its test under a real `sandbox-exec`, not by this series.
