import { test } from "node:test";
import assert from "node:assert/strict";
import { JsonlFramer, TurnCollector, reconcile, nextTurnAllowed, type Frame, type ProcessFacts, type Provider } from "./jsonl.ts";

const run = (chunks: Buffer[], limits = { maxMessageBytes: 1024, maxStreamBytes: 1 << 20 }, end = true) => {
  const out: Frame[] = [];
  const f = new JsonlFramer((x) => out.push(x), limits);
  for (const c of chunks) f.push(c);
  if (end) f.end();
  return out;
};
const b = (s: string) => Buffer.from(s, "utf8");

test("UTF-8 sequence split at every byte boundary", () => {
  const line = b('{"type":"x","t":"привет 🧪"}\n');
  for (let i = 1; i < line.length; i++) {
    const out = run([line.subarray(0, i), line.subarray(i)]);
    assert.equal(out.length, 1);
    assert.equal(out[0].kind, "event");
    assert.equal((out[0] as any).value.t, "привет 🧪");
  }
});

test("one byte per chunk, several lines, CRLF, blank lines", () => {
  const data = b('{"type":"a"}\r\n\n{"type":"b"}\n');
  const out = run([...data].map((x) => Buffer.from([x])));
  assert.deepEqual(out.map((f) => (f as any).type), ["a", "b"]);
});

test("unknown type is kept, not dropped", () => {
  const out = run([b('{"type":"future.event","k":1}\n')]);
  assert.equal(out[0].kind, "event");
  assert.equal((out[0] as any).value.k, 1);
});

test("oversized: reported inside push(), before newline or end(), exactly once; then resync", () => {
  const out: Frame[] = [];
  const f = new JsonlFramer((x) => out.push(x), { maxMessageBytes: 1024, maxStreamBytes: 1 << 20 });
  f.push(b('{"type":"x","s":"' + "a".repeat(1000)));
  assert.equal(out.length, 0);
  f.push(b("a".repeat(100))); // crosses the limit, no '\n' yet
  assert.equal(out.length, 1);
  assert.equal((out[0] as any).code, "oversized");
  assert.equal((out[0] as any).bytes, 1117);
  assert.ok((out[0] as any).head.startsWith('{"type":"x"'));
  for (let i = 0; i < 1000; i++) f.push(b("a".repeat(1000))); // 1 MB more: dropped, still one error
  assert.equal(out.length, 1);
  f.push(b('"}\n{"type":"after"}\n'));
  f.end();
  assert.deepEqual(out.map((x) => (x.kind === "event" ? x.type : x.code)), ["oversized", "after"]);
});

test("oversized tail at EOF: one error, no extra unterminated_tail", () => {
  const out = run([b('{"type":"x","s":"' + "a".repeat(5000))]);
  assert.deepEqual(out.map((x) => (x as any).code), ["oversized"]);
});

test("line exactly at limit is accepted", () => {
  const body = '{"type":"x","s":"' + "a".repeat(1024 - 19) + '"}';
  assert.equal(Buffer.byteLength(body), 1024);
  assert.equal(run([b(body + "\n")])[0].kind, "event");
  assert.equal((run([b(body + "a\n")])[0] as any).code, "oversized");
});

test("1e5 fragments of 1-3 bytes: correct and linear", () => {
  const fragments = (value: string) => {
    const line = b(JSON.stringify({ type: "big", value }) + "\n");
    const out: Buffer[] = [];
    for (let i = 0, n = 0; i < line.length; n++) { const k = 1 + (n % 3); out.push(line.subarray(i, i + k)); i += k; }
    return out;
  };
  const limits = { maxMessageBytes: 1 << 22, maxStreamBytes: 1 << 24 };
  const value = "ж".repeat(60_000) + "x".repeat(80_000); // multi-byte chars get split across fragments
  const frags = fragments(value);
  assert.ok(frags.length >= 1e5, `${frags.length} fragments`);
  const t0 = performance.now();
  const out = run(frags, limits);
  const small = performance.now() - t0;
  assert.equal(out.length, 1);
  assert.equal((out[0] as any).value.value, value);
  // Linearity: 4x the input must not cost ~16x. Generous bound to stay stable on a loaded machine.
  const big4 = fragments(value.repeat(4));
  const t1 = performance.now();
  assert.equal(run(big4, limits).length, 1);
  const large = performance.now() - t1;
  assert.ok(large < small * 10 + 50, `4x input took ${large.toFixed(1)}ms vs ${small.toFixed(1)}ms`);
});

test("unterminated tail is reported, not parsed", () => {
  const out = run([b('{"type":"a"}\n{"type":"result","subtype":"success","is_error":false}')]);
  assert.equal((out[1] as any).code, "unterminated_tail");
});

test("invalid utf8 / invalid json / non-object / no type", () => {
  const out = run([Buffer.from([0x7b, 0xff, 0x7d, 0x0a]), b("{nope\n"), b("[1]\n"), b('{"a":1}\n')]);
  assert.deepEqual(out.map((f) => (f as any).code), ["invalid_utf8", "invalid_json", "not_object", "missing_type"]);
});

test("stream limit stops accumulating", () => {
  const out = run([b('{"type":"a"}\n'.repeat(10))], { maxMessageBytes: 1024, maxStreamBytes: 50 });
  assert.equal((out.at(-1) as any).code, "stream_limit");
});

test("collector: bounded events/errors, counters and one overflow record; terminal still seen", () => {
  const c = new TurnCollector("codex", { maxEvents: 10, maxErrors: 3 });
  const f = new JsonlFramer((x) => c.push(x));
  for (let i = 0; i < 10_000; i++) f.push(b('{"type":"item.completed","i":' + i + "}\n"));
  f.push(b('{"type":"turn.completed"}\n'));
  f.end();
  assert.equal(c.events.length, 10);
  assert.equal(c.droppedEvents, 9_991);
  assert.equal(c.overflowAt, 10);
  assert.equal(c.terminals.length, 1);
  assert.equal(c.terminals[0].index, 10_000);
  assert.equal(reconcile(c, proc).status, "completed");

  const e = new TurnCollector("codex", { maxEvents: 10, maxErrors: 3 });
  for (let i = 0; i < 1000; i++) e.push({ kind: "error", code: "invalid_json", bytes: 1, head: "" });
  assert.equal(e.errors.length, 3);
  assert.equal(e.droppedErrors, 997);
  assert.equal(e.errorCount, 1000);
});

test("collector: byte limit on history is independent of maxEvents; terminal, first error and session survive", () => {
  const c = new TurnCollector("codex", { maxEvents: 1_000_000, maxErrors: 0, maxHistoryBytes: 100_000 });
  const f = new JsonlFramer((x) => c.push(x));
  f.push(b("{nope\n")); // first error is kept even with maxErrors 0
  const big = '{"type":"item.completed","s":"' + "a".repeat(10_000) + '"}\n';
  for (let i = 0; i < 1000; i++) f.push(b(big));
  f.push(b('{"type":"thread.started","thread_id":"late"}\n')); // small, but history is already full: dropped, id still read
  f.push(b('{"type":"turn.completed"}\n'));
  f.end();
  const line = Buffer.byteLength(big) - 1;
  assert.equal(c.events.length, Math.floor(100_000 / line));
  assert.ok(c.historyBytes <= 100_000);
  assert.equal(c.droppedEvents, 1002 - c.events.length);
  assert.equal(c.droppedEventBytes, (1000 - c.events.length) * line + Buffer.byteLength('{"type":"thread.started","thread_id":"late"}') + Buffer.byteLength('{"type":"turn.completed"}'));
  assert.equal(c.errors.length, 1);
  assert.equal(c.terminals[0].type, "turn.completed");
  assert.equal(c.terminals[0].index, 1002);
  assert.equal(c.sessionId, "late");
  assert.deepEqual(c.sessionEvent, { type: "thread.started", thread_id: "late" }, "kept although the history dropped it");
});

test("collector: session ids per provider; later conflicting id is flagged", () => {
  const claude = collect("claude", [ev("system", { subtype: "init", session_id: "S" }), ev("assistant", { session_id: "X" }), ev("result", { subtype: "success", is_error: false, session_id: "S" })]);
  assert.equal(claude.sessionId, "S");
  assert.deepEqual(claude.sessionEvent, { type: "system", subtype: "init", session_id: "S" });
  assert.equal(claude.sessionConflict, false);
  assert.equal(collect("claude", [ev("system", { subtype: "init", session_id: "S" }), ev("result", { session_id: "Z" })]).sessionConflict, true);
  assert.equal(collect("claude", [ev("result", { session_id: "Z" })]).sessionId, null); // only init defines it
  const codex = collect("codex", [ev("thread.started", { thread_id: "T" }), ev("thread.started", { thread_id: "U" })]);
  assert.equal(codex.sessionId, "T");
  assert.equal(codex.sessionConflict, true);
  assert.equal(codex.sessionEvent.thread_id, "T", "the first id's event, not the conflicting one");
});

// ---- reconcile ----

const ev = (type: string, extra = {}) => ({ kind: "event", type, value: { type, ...extra }, bytes: 1 }) as Frame;
const proc: ProcessFacts = { exitCode: 0, signal: null, stdoutEnded: true, stopRequestedAt: null, signalsToLeader: [] };
// frames arrive at t=1,2,3...; stopAt is on the same clock
const collect = (provider: Provider, frames: Frame[]) => {
  const c = new TurnCollector(provider);
  frames.forEach((f, i) => c.push(f, i + 1));
  return c;
};
const R = (frames: Frame[], p: Partial<ProcessFacts> = {}, provider: Provider = "codex") => reconcile(collect(provider, frames), { ...proc, ...p });
const ok = ev("turn.completed");
const fail = ev("turn.failed");
const start = ev("thread.started");

test("reconcile without Stop", () => {
  assert.equal(R([start, ok]).status, "completed");
  assert.equal(R([fail], { exitCode: 1 }).status, "failed");
  assert.equal(R([start]).reason.startsWith("no_terminal_event"), true);
  assert.equal(R([start], { exitCode: 42 }).reason.startsWith("no_terminal_event"), true);
  assert.equal(R([ok], { exitCode: 1 }).status, "failed");
  assert.equal(R([ok], { stdoutEnded: false }).reason, "stdout_held_open");
  assert.equal(R([ok, ev("item.completed")]).reason, "events_after_terminal");
  assert.equal(R([ok, ok]).reason, "multiple_terminal_events");
  const res = ev("result", { subtype: "success", is_error: false, result: "done" });
  assert.equal(R([ev("system"), res], {}, "claude").status, "completed");
  assert.equal(R([ev("result", { subtype: "error_max_turns", is_error: true })], { exitCode: 1 }, "claude").status, "failed");
  assert.equal(R([ev("result", { subtype: "success", is_error: true })], { exitCode: 1 }, "claude").status, "failed");
  assert.equal(R([{ kind: "error", code: "oversized", bytes: 9, head: "" }, res], {}, "claude").status, "protocol_error");
});

test("Stop before any result", () => {
  // our SIGINT killed it
  assert.equal(R([start], { exitCode: null, signal: "SIGINT", stopRequestedAt: 1.5, signalsToLeader: ["SIGINT"] }).status, "stopped");
  // shell-style 130 for our SIGINT
  assert.equal(R([start], { exitCode: 130, stopRequestedAt: 1.5, signalsToLeader: ["SIGINT"] }).status, "stopped");
  // CLI handled the interrupt and quit cleanly without a result
  assert.equal(R([start], { exitCode: 0, stopRequestedAt: 1.5, signalsToLeader: ["SIGINT"] }).status, "stopped");
  // escalated to SIGKILL
  assert.equal(R([], { exitCode: null, signal: "SIGKILL", stopRequestedAt: 0, signalsToLeader: ["SIGINT", "SIGTERM", "SIGKILL"] }, "claude").status, "stopped");
});

test("Stop after the result, process ended by our signal: turn completed", () => {
  const out = R([start, ok], { exitCode: null, signal: "SIGINT", stopRequestedAt: 2.5, signalsToLeader: ["SIGINT"] });
  assert.equal(out.status, "completed");
  assert.equal(nextTurnAllowed(out, true), false); // but the run stops
  assert.equal(nextTurnAllowed(out, false), true);
  assert.equal(R([start, ok], { exitCode: 143, stopRequestedAt: 2.5, signalsToLeader: ["SIGINT", "SIGTERM"] }).status, "completed");
});

test("Stop together with an error is never completed", () => {
  const stop = { stopRequestedAt: 2.5, signalsToLeader: ["SIGINT"] };
  // success event, then exit 42 while Stop was in flight: not our signal
  assert.equal(R([start, ok], { ...stop, exitCode: 42 }).status, "failed");
  // exit 42 without any result
  assert.equal(R([start], { ...stop, exitCode: 42 }).status, "failed");
  // terminal failure + our signal
  assert.equal(R([start, fail], { ...stop, exitCode: null, signal: "SIGINT" }).status, "failed");
  // killed by a signal we did not send
  assert.equal(R([start, ok], { ...stop, exitCode: null, signal: "SIGSEGV" }).status, "failed");
  // result received only after Stop was issued (crossed in flight) + killed: not trusted
  assert.equal(R([start, ok], { stopRequestedAt: 1.5, signalsToLeader: ["SIGINT"], exitCode: null, signal: "SIGINT" }).status, "failed");
  // Stop accepted after the leader already exited (nothing signalled): exit 42 stays a failure
  assert.equal(R([start, ok], { stopRequestedAt: 9, signalsToLeader: [], exitCode: 42 }).status, "failed");
  // same, no result: Stop does not explain anything -> protocol error as without Stop
  assert.equal(R([start], { stopRequestedAt: 9, signalsToLeader: [], exitCode: 0 }).status, "protocol_error");
});

test("run level: any accepted Stop blocks the next turn", () => {
  for (const o of [R([start, ok]), R([fail], { exitCode: 1 }), R([start], { exitCode: null, signal: "SIGINT", stopRequestedAt: 1, signalsToLeader: ["SIGINT"] })]) {
    assert.equal(nextTurnAllowed(o, true), false);
  }
  assert.equal(nextTurnAllowed(R([fail], { exitCode: 1 }), false), false);
});
