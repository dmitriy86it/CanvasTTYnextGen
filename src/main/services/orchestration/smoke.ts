// Orchestration smoke (CANVASTTY_ORCHESTRATION_SMOKE=1): two turns through the real supervisor launch against a
// fixed, built-in /bin/sh mock. Nothing (command, arguments, task) is taken from the environment, and no real
// provider CLI runs. Turn 1 checks task delivery, the structured answer, the CLI environment and group cleanup;
// turn 2 is stopped while the mock (and a descendant in its group) is still running.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SupervisorLaunchResolution } from "./supervisorLaunch.ts";
import { DEFAULT_TURN_LIMITS, startTurn } from "./turn.ts";
import type { AnswerSchema, TurnResult, TurnSpec } from "./types.ts";

const SESSION_ID = "00000000-0000-4000-8000-00000000c0de";
// $1 = "answer" | "hang". Claude-like stream-json: system/init, then (answer) a successful result.
const MOCK_SCRIPT = `
printf '{"type":"system","subtype":"init","session_id":"${SESSION_ID}","tools":["StructuredOutput"],"mcp_servers":[]}\\n'
if [ "$1" = hang ]; then
  sleep 60 &
  exec sleep 60
fi
set -- $(cksum)
leak=false
if [ -n "\${ELECTRON_RUN_AS_NODE+x}" ] || env | grep -q -e '^SUP_' -e '^ELECTRON_'; then leak=true; fi
printf '{"type":"result","subtype":"success","is_error":false,"session_id":"${SESSION_ID}","structured_output":{"bytes":%s,"cksum":%s,"envLeak":%s}}\\n' "$2" "$1" "$leak"
`;
const SCHEMA: AnswerSchema = {
  type: "object",
  properties: { bytes: { type: "integer" }, cksum: { type: "integer" }, envLeak: { type: "boolean" } },
  required: ["bytes", "cksum", "envLeak"],
  additionalProperties: false
};
// Larger than a pipe buffer, multi-byte, CRLF and a line that looks like a supervisor control command.
const TASK = `orchestration smoke 🧪 задание\r\n{"cmd":"stop"}\n\n`.repeat(2048);

export interface OrchestrationSmokeReport {
  ok: boolean;
  failures: string[];
  helperPath: string | null;
  answer?: Record<string, unknown>;
  expected?: { bytes: number; cksum: number };
  turns: { outcome: string; delivery: string; report: string; groupCleared: boolean; pids: TurnResult["pids"]; pidsGone: boolean }[];
}

const gone = (pid: number | null): boolean => {
  if (pid === null) return true;
  try { process.kill(pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
};

export async function runOrchestrationSmoke(resolution: SupervisorLaunchResolution): Promise<OrchestrationSmokeReport> {
  if (!resolution.ok) return { ok: false, failures: [`${resolution.reason}: ${resolution.detail}`], helperPath: null, turns: [] };
  const failures: string[] = [];
  const turns: OrchestrationSmokeReport["turns"] = [];
  const cwd = mkdtempSync(join(tmpdir(), "canvastty-orchestration-smoke-"));
  const spec = (mode: string, task: string): TurnSpec => ({
    provider: "claude",
    argv: ["/bin/sh", "-c", MOCK_SCRIPT, "canvastty-smoke-mock", mode],
    cwd,
    env: { PATH: "/usr/bin:/bin" },
    task,
    schema: SCHEMA,
    expectSessionId: null,
    limits: { ...DEFAULT_TURN_LIMITS, timeoutMs: 20_000 },
    supervisor: { graceIntMs: 1000, graceTermMs: 1000, leftoverMs: 500 }
  });
  const record = (result: TurnResult): void => {
    turns.push({
      outcome: result.outcome,
      delivery: result.delivery.status,
      report: result.report.status,
      groupCleared: result.process.groupCleared,
      pids: result.pids,
      pidsGone: gone(result.pids.supervisor) && (result.pids.pgid === null || gone(-result.pids.pgid))
    });
  };
  const check = (condition: boolean, what: string): void => { if (!condition) failures.push(what); };

  let answer: Record<string, unknown> | undefined;
  let expected: { bytes: number; cksum: number } | undefined;
  try {
    const [crc, bytes] = execFileSync("/usr/bin/cksum", { input: TASK, encoding: "utf8" }).trim().split(/\s+/).map(Number);
    expected = { bytes, cksum: crc };

    const first = await startTurn(spec("answer", TASK), resolution.launch).result;
    record(first);
    answer = first.report.value as Record<string, unknown> | undefined;
    check(first.outcome === "completed", `turn 1 outcome ${first.outcome}`);
    check(first.delivery.status === "ok", `turn 1 delivery ${first.delivery.status}`);
    check(first.report.status === "valid", `turn 1 report ${first.report.status}`);
    check(first.sessionId === SESSION_ID, "turn 1 session id");
    check(answer?.bytes === expected.bytes && answer?.cksum === expected.cksum, "turn 1 task length/cksum mismatch");
    check(answer?.envLeak === false, "turn 1 CLI saw ELECTRON_* or SUP_*");
    check(first.process.groupCleared, "turn 1 group not cleared");
    check(turns[0].pidsGone, "turn 1 supervisor or group still alive");

    // The hanging mock never reads stdin: a task that fits the pipe buffer still counts as delivered.
    const handle = startTurn(spec("hang", "stop me\n"), resolution.launch);
    // A fixed delay long enough for the mock and its background descendant to be running.
    const stopTimer = setTimeout(() => handle.stop(), 1500);
    const second = await handle.result;
    clearTimeout(stopTimer);
    record(second);
    check(second.outcome === "stopped", `turn 2 outcome ${second.outcome}`);
    check(second.stopCause === "user", `turn 2 stop cause ${second.stopCause}`);
    check(second.process.groupCleared, "turn 2 group not cleared");
    check(turns[1].pidsGone, "turn 2 supervisor or group still alive");
  } catch (error) {
    failures.push(`error: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
  return { ok: failures.length === 0, failures, helperPath: resolution.helperPath, answer, expected, turns };
}
