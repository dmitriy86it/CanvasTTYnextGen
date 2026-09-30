# processes-and-protocol experiments

Only toy processes (node/sh/perl, `mock-cli.mjs`) tagged with a random `CTTYEXP-xxxx` marker in argv and env.
Cleanup kills only processes carrying the run's marker or pids captured from its own tree.
Node >= 23.6 (type stripping). Tested on macOS 27.0, Node 26.8.1, Electron 43.2.0.

| File | What |
|------|------|
| `jsonl.ts` | Byte-level JSONL framer, `TurnCollector` (bounded), `reconcile()`, `nextTurnAllowed()` |
| `jsonl.test.ts` | `node --test jsonl.test.ts` |
| `mem-check.ts` | `node --expose-gc mem-check.ts` — memory of framer + collector on two 200 MB inputs |
| `supervisor.mjs` | Per-run supervisor prototype (channels below) |
| `mock-cli.mjs` | Fake CLI for supervisor tests: reports stdin length/sha256/text and env flags (never values) |
| `supervisor.test.mjs` | `node --test supervisor.test.mjs` — supervisor regressions on `mock-cli.mjs` |
| `stop-exp.mjs` | `node stop-exp.mjs [a\|b\|c\|c2\|d\|e\|env\|all]` |
| `electron-utility/run.mjs` | `node electron-utility/run.mjs "$(node -p "require('electron')")"` (utilityProcess) and `MODE=runasnode ...` (ELECTRON_RUN_AS_NODE supervisor). Run from a dir where `electron` resolves. |
| `turn.mjs` | `runTurn(spec)`: one CLI turn end to end — supervisor in `spec.cwd`, task on fd4, control/lifeline fd0, status fd3, stdout framer, bounded stderr, timeout/Stop, `reconcile`, structured answer check. Contract: `turn-contract.md` |
| `schema.mjs` | Minimal JSON Schema subset validator for the structured answer |
| `turn-limits.test.mjs` | Harness limits on inline tiny CLIs (stderr, history bytes/count, report size, stream limit, timeout, 50 MB output, EPIPE, preflight) |
| `mock-codex.mjs`, `mock-claude.mjs` | Fake providers with realistic event shapes; modes via `MOCK_MODE`; session state in `MOCK_STATE`; pids in `MOCK_LEDGER` |
| `turn.test.mjs` | End-to-end `runTurn` on the mocks (both providers). Mock continuation proves the harness only, not compatibility of the real CLIs |
| `proc-ledger.mjs` | Cleanup checks on pids the test created (`kill(pid,0)`: ESRCH gone / alive / EPERM unverifiable); `ps` by marker is an optional extra that reports "unavailable" instead of success |
| `probe-plan.mjs` | Single source of the four real 0B probes (`buildPlan`); CLI prints it, `--check` verifies every flag against the installed `--help`. Never sends a prompt |
| `probe-series.mjs` | Runs B1 → B2 → K1 → K2 (or `--series K1,K2`) through `runTurn`: mock by default, `--dry-run`, `--real` (needs env `CANVASTTY_REAL_PROBES` equal to the chosen series). Stops at the first failure, no retries; report in `series-report.json` |
| `probe-series.test.mjs` | Series on mocks: all ok, stop after B1/B2 failure, wrong token/session, Claude tools, both review repros, no real CLI can be spawned |
| `turn-contract.md` | Contract between harness and tests |
| `results.txt` | Sanitized output of all of the above |

**All checks, one command** (from this directory): `node --test`. Mock series: `node probe-series.mjs`; dry-run: `node probe-series.mjs --dry-run --real` (node 26.8.1 finds `*.test.ts` and `*.test.mjs`; fixed set: `node --test jsonl.test.ts supervisor.test.mjs turn-limits.test.mjs turn.test.mjs`).

Cleanup is verified on pids the tests created themselves. A global `ps` search is an extra: if `ps` fails (EPERM in restricted environments), the test prints `global check unavailable` and does not count it as clean; `EPERM` from `kill(pid,0)` is printed as `UNVERIFIABLE`.

## Supervisor channels

`node supervisor.mjs <cmd> [args...]`, spawned by main with 5 fds:

| fd | Direction | Content |
|----|-----------|---------|
| 0 | main → sup | Lifeline + control. One JSON command per line; only a whole line `{"cmd":"stop"}` stops (`\r\n` tolerated). Anything else → `control_ignored`. Lines > 4 KiB are dropped. **EOF = main is gone → stop.** |
| 1, 2 | target → main | Inherited by the target directly, no copying. |
| 3 | sup → main | Status JSON lines: `started{pgid, env:[names]}`, `task_eof`, `task_write_error{code}`, `stop_requested{reason}`, `leader_exit{code,signal}`, `done{...}` (exactly once). |
| 4 | main → target | Task bytes, piped as-is into the target's stdin; EOF on fd4 closes the target's stdin. **EOF here is not a stop.** Required: a pipe, or `"ignore"` (/dev/null) for an empty task. |

Why separate fds: the task is arbitrary user text, so it can contain `stop` or `{"cmd":"stop"}`; on its own
channel it is never parsed. Closing the task (normal, the CLI needs stdin EOF) and losing main (abnormal)
are different events, so they need different EOFs. fd4 is mandatory because without it libuv's own
descriptors could occupy fd 4 in the supervisor.

Env: the target gets only names in `SUP_ENV_ALLOW` (comma-separated; default
`PATH,HOME,USER,LOGNAME,SHELL,TMPDIR,LANG,LC_ALL,LC_CTYPE,TERM,TZ`), minus `ELECTRON_RUN_AS_NODE` and `SUP_*`
even if listed. Main lists the CLI's auth/config names explicitly (`ANTHROPIC_API_KEY`, `CODEX_HOME`,
`OPENAI_API_KEY`, ...). An allow-list rather than a deny-list so nothing from Electron main's env
(`ELECTRON_*`, `NODE_OPTIONS`, ...) reaches the CLI by accident. Status carries names only.

Termination is one path (`run()`); the `exit`, `stop` and `lifeline` handlers only record facts and wake it:

1. wait for leader exit, spawn error, or Stop;
2. Stop while the leader runs: leader pid gets SIGINT (command) / SIGTERM (lifeline), wait `SUP_GRACE_INT_MS`;
   natural exit: wait `SUP_LEFTOVER_MS` for the rest of the group (a Stop cuts this short);
3. group SIGTERM, wait `SUP_GRACE_TERM_MS`; group SIGKILL, wait 1 s;
4. `done` once: `{leaderExit, stopRequested, stopReason, stopRequestedAt, stopAfterLeaderExit, signalsToLeader, signals, groupCleared}`, exit 0 (1 on spawn error, 2 if fd4 is missing).

The leader pid is signalled only while unreaped, the group only while `kill(-pgid, 0)` succeeds.
`signalsToLeader` = signals sent before the leader was reaped; `reconcile()` uses it.

Races fixed vs the previous version: the exit handler called `process.exit(0)` while `stop()` was still
escalating; stop and exit ran two independent wait/signal loops (a Stop during the leftover wait started a
second escalation); the group was signalled after it was already empty; ENOENT and EPIPE
were unhandled; stdin was `"ignore"` so the task never reached the CLI; the target inherited
`ELECTRON_RUN_AS_NODE` and `SUP_*`; a `stop\n` substring anywhere on fd0 stopped the run.

## Turn outcome model (`jsonl.ts`)

Three separate things: **agent result** (terminal event on stdout), **process end** (exit code/signal +
stdout EOF, and whether the signal was ours), **run decision** (after an accepted Stop no next turn starts,
`nextTurnAllowed(outcome, stopAccepted)`, whatever the turn outcome). Order: terminal event → process end → run decision.

`TurnCollector.push(frame, at)` records each frame with main's clock; `ProcessFacts.stopRequestedAt` uses the
same clock. A terminal event counts as "before Stop" only if main received it strictly before issuing Stop.

| Terminal event | Exit | Stop | Outcome |
|---|---|---|---|
| any framing error / 2 terminals / stdout held open / events after terminal | — | — | `protocol_error` |
| ok | 0 | any | `completed` |
| ok | our signal (or 128+n of it) | after the result | `completed` (run still stops) |
| ok | our signal | before the result | `failed` |
| ok | other non-zero (e.g. 42), foreign signal | any | `failed` |
| fail | any | any | `failed` |
| none | our signal, or 0 | leader was signalled | `stopped` |
| none | other (e.g. 42) | requested | `failed` (`exit_during_stop`) |
| none | any | none, or Stop only after exit | `protocol_error` |

Decision for exit 42 during Stop without a result: `failed`, not `stopped` — the CLI ended with its own error
code, not from our signal or a clean interrupt, and we cannot tell whether the error preceded the Stop.

Framer limits: an oversized line is reported once inside `push()` as soon as it crosses `maxMessageBytes`
(`bytes` = size seen at that moment), then dropped by counting until `\n`, where parsing resyncs. The line
buffer is one growing Buffer (doubling, capped at the limit), so tiny fragments cost no per-fragment
objects. `TurnCollector` keeps the first `maxEvents` events and `maxErrors` errors, counts the rest, and
records one `overflowAt`; terminal events and the last index are tracked exactly regardless.

## mem-check method

`gc()` twice → baseline; `process.memoryUsage()` sampled every 16 × 64 KiB chunks (per-field peak);
`gc()` twice → after. Printed: heapUsed, arrayBuffers, external as deltas, rss absolute + delta.
Limits: sampling can miss spikes between samples; arrayBuffers/external include buffers not yet collected
(peak ~2× the line limit in case A comes from doubling + GC lag); rss includes code pages and allocator slack
and is not returned to the OS promptly; one run on one machine; it measures the framer/collector only,
not the product, and is no proof of absence of leaks.

## Limitations

- Only processes that stay in the target's process group are controlled. Descendants that call `setsid()`
  or are spawned `detached` leave the group and survive (see `stop-exp.mjs e`); no guarantee for them.
- The lifeline relies on the supervisor itself staying alive; a SIGKILL of the supervisor leaves the group
  running (it is a separate process group by design).
- `kill(-pgid)` after the `kill(-pgid, 0)` check has a tiny pid-reuse window if the group empties in between.
- Stop ordering vs terminal event is only as good as main's own receive order; a result crossing the Stop
  in flight is treated as "after Stop".
- Supervisor tests use a mock CLI; real `claude`/`codex` stdin/SIGINT behaviour was not exercised here.
