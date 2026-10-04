// Journal v2, A1 (docs/agent-orchestration/implementation/journal-v2-format.md): the envelope and its first record, the
// version taken from the first record, the reader of 1.5.7 (A0) against a v2 journal, the A1 records' schemas, the
// fixtures of the format document. Pure: no CLI, no service.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import {
  JOURNAL_V2_BY_DEFAULT, MAX_JOURNAL_VERSION, PAUSED_REASONS_V2, READER_VERSION, V2_MIN_READER_VERSION, buildRecord, canonical, isValidEventData, newerGoal, newerVersion, parseJournal, sha256Hex
} from "../src/main/services/orchestration/journal.ts";
import { createRun, openRun, readRun } from "../src/main/services/orchestration/store.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, "..", "docs", "agent-orchestration", "implementation", "v2-fixtures", "runs");
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "canvastty-v2j-")));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const GOAL = { sha256: "a".repeat(64), bytes: 1 };
const A0 = { maxVersion: 1, readerVersion: 1 }; // the reader of 1.5.7: v1 is its own, READER_VERSION 1

// Records as this build writes a v2 journal: v 2, the first record with minReaderVersion 2 (A4's final form; A1–A3
// development builds added formatPreview: true).
const PREVIEW = { minReaderVersion: 2, formatPreview: true };
function lines(runId, events, { version = 2, head = { minReaderVersion: 2 } } = {}) {
  const out = [];
  let prev = null;
  for (const [i, [type, data, extra]] of events.entries()) {
    const { record, line } = buildRecord(prev, runId, `2026-10-01T10:00:0${i % 10}.000Z`, type, data, version, i === 0 ? head : null);
    if (extra) { // a record as some other writer made it: re-hashed with the extra envelope keys
      const body = { ...record, ...extra };
      delete body.hash;
      const hash = sha256Hex(canonical(body));
      out.push(Buffer.from(`${canonical({ ...body, hash })}\n`));
      prev = { seq: record.seq, hash };
      continue;
    }
    out.push(line);
    prev = record;
  }
  return Buffer.concat(out);
}
const RUNNING = ["run.status", { status: "running", reason: null, completion: null }];

test("a v2 journal of this build (A4's final form): the first record declares minReaderVersion 2 and no formatPreview, no other record a head key; replayed as v2", async () => {
  assert.deepEqual([MAX_JOURNAL_VERSION, READER_VERSION, V2_MIN_READER_VERSION], [2, 2, 2]);
  const root = path.join(TMP, "write");
  const runId = randomUUID();
  const w = await createRun(root, runId, { goal: "{}", version: 2 });
  await w.setRunStatus("running", null);
  await w.setRunStatus("paused", "awaiting_checks_decision");
  await w.close();
  const buf = fs.readFileSync(path.join(root, "runs", runId, "journal.jsonl"));
  const recs = buf.toString().trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(recs.map((r) => r.v), [2, 2, 2]);
  assert.deepEqual([recs[0].minReaderVersion, "formatPreview" in recs[0]], [2, false]);
  assert.ok(recs.slice(1).every((r) => !("minReaderVersion" in r) && !("formatPreview" in r)));
  assert.deepEqual(recs[1].data, { status: "running", reason: null, completion: null }, "run.status v2 carries completion");
  const p = parseJournal(buf, runId);
  assert.equal(p.integrity.status, "ok");
  assert.deepEqual([p.state.version, p.state.preview, p.state.status, p.state.pausedReason], [2, false, "paused", "awaiting_checks_decision"]);
  // the reader of this build reads it whole, and the run is continued (A0 view only for newer journals)
  const read = await readRun(root, runId);
  assert.deepEqual([read.integrity.status, read.canContinue], ["ok", true]);
  const again = await openRun(root, runId);
  assert.equal(again.state().version, 2);
  await again.setRunStatus("running", null); // the writer continues in v2
  await again.close();
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "runs", runId, "journal.jsonl"), "utf8").trim().split("\n").at(-1)).v, 2);
});

test("v2 is the default (1.5.8): the one switch is on; a journal of an A1–A3 development build (formatPreview) is read only — it went on only while the switch was off", async () => {
  assert.equal(JOURNAL_V2_BY_DEFAULT, true, "v2 is the person's after the real series (evidence/real-a-gate/attempt-5)");
  const root = path.join(TMP, "preview");
  const runId = randomUUID();
  fs.mkdirSync(path.join(root, "runs", runId, "texts"), { recursive: true });
  const file = path.join(root, "runs", runId, "journal.jsonl");
  fs.writeFileSync(file, lines(runId, [["run.created", { goal: GOAL }], RUNNING, ["run.status", { status: "paused", reason: "user_request", completion: null }]], { head: PREVIEW }));
  const buf = fs.readFileSync(file);
  // the switch off (as under the development flag before 1.5.8): replayed and continued
  const p = parseJournal(buf, runId, { previewReadOnly: false });
  assert.deepEqual([p.integrity.status, p.state.version, p.state.preview], ["ok", 2, true]);
  // v2 on (the default): shown read only — the records as they are, no state, said as a development build's; never
  // continued: opening it for writing is refused and the file stays as it was
  const on = parseJournal(buf, runId);
  assert.deepEqual([on.integrity.status, on.integrity.detail.preview, on.state, on.records.length], ["newer_version", true, null, 3]);
  assert.equal(newerVersion(buf), 2);
  await assert.rejects(openRun(root, runId));
  assert.deepEqual(fs.readFileSync(file), buf);
  // the final form is this build's own either way
  assert.equal(parseJournal(lines(runId, [["run.created", { goal: GOAL }], RUNNING]), runId, { previewReadOnly: true }).integrity.status, "ok");
  // the reader of 1.5.7: either is newer, never "a development build's" (it does not know)
  assert.deepEqual(parseJournal(buf, runId, A0).integrity, { status: "newer_version", detail: { version: 2, chain: { status: "ok" } } });
});

test("1.5.7 (the A0 reader, READER_VERSION 1): a v2 journal with minReaderVersion 2 is read only — goal and raw records, no state", () => {
  const runId = randomUUID();
  const buf = lines(runId, [["run.created", { goal: GOAL }], RUNNING]);
  const old = parseJournal(buf, runId, A0);
  assert.equal(newerVersion(buf, 1), 2);
  assert.deepEqual(old.integrity, { status: "newer_version", detail: { version: 2, chain: { status: "ok" } } });
  assert.equal(old.state, null, "never a state it would get wrong");
  assert.deepEqual(newerGoal(old.records), GOAL);
  // this build: its own version
  assert.equal(newerVersion(buf), null);
  assert.equal(parseJournal(buf, runId).integrity.status, "ok");
});

test("the version is the first record's: another v later, a head key on a later record, a v2 first record without its head — invalid_event", () => {
  const runId = randomUUID();
  const created = ["run.created", { goal: GOAL }];
  const at = (buf) => { const p = parseJournal(buf, runId); return [p.integrity.status, p.integrity.detail?.line, p.integrity.detail?.code]; };
  assert.deepEqual(at(lines(runId, [created, ["run.status", { status: "running", reason: null }, { v: 1 }]])), ["corrupt", 2, "invalid_event"]);
  assert.deepEqual(at(lines(runId, [created, ["run.status", { status: "running", reason: null, completion: null }, { minReaderVersion: 2 }]])), ["corrupt", 2, "invalid_event"]);
  // a development build's head is checked where it is replayed (the switch off); with v2 on it is only shown read only
  const preview = lines(runId, [created, RUNNING], { head: { minReaderVersion: 2, formatPreview: true, extra: 1 } });
  const replayed = parseJournal(preview, runId, { previewReadOnly: false });
  assert.deepEqual([replayed.integrity.status, replayed.integrity.detail?.line, replayed.integrity.detail?.code], ["corrupt", 1, "invalid_event"]);
  assert.deepEqual([parseJournal(preview, runId).integrity.status, parseJournal(preview, runId).state], ["newer_version", null]);
  assert.deepEqual(at(lines(runId, [created, RUNNING], { head: { minReaderVersion: 2, formatPreview: false } })), ["corrupt", 1, "invalid_event"]);
  // the first record of v2 declares minReaderVersion 2, exactly (A4's final form; A1.1 Q3)
  assert.deepEqual(at(lines(runId, [created, RUNNING], { head: { minReaderVersion: 1 } })), ["corrupt", 1, "invalid_event"]);
  assert.deepEqual(at(lines(runId, [created, RUNNING], { head: null })), ["corrupt", 1, "invalid_event"]);
  // run.status of v1 shape in v2 (no completion), and v2 shape in v1
  assert.deepEqual(at(lines(runId, [created, ["run.status", { status: "running", reason: null }]])), ["corrupt", 2, "invalid_event"]);
  assert.deepEqual(at(lines(runId, [created, RUNNING], { version: 1, head: null })), ["corrupt", 2, "invalid_event"]);
  // a v1 journal is v1 to the end, as before
  assert.equal(parseJournal(lines(runId, [created, ["run.status", { status: "running", reason: null }]], { version: 1, head: null }), runId).integrity.status, "ok");
});

test("A1 and A4 records: schemas of checks.proposed, checks.decided, finish.confirmed, run.status.completion, plan.proposed, plan.decided, person.decided; none of them in v1", () => {
  const uuid = randomUUID();
  const ok = [
    ["checks.proposed", { turnId: uuid, proposal: GOAL, count: 0, sandboxNetwork: "open" }],
    ["checks.decided", { proposalTurnId: uuid, decision: "edit", by: "person", commandId: uuid, checks: GOAL, count: 16 }],
    ["checks.decided", { proposalTurnId: uuid, decision: "accept", by: "autopilot", commandId: null, checks: GOAL, count: 1 }],
    ["finish.confirmed", { commandId: uuid, tree: "b".repeat(40), commit: null, push: null, qa: "decline" }],
    ["run.status", { status: "completed", reason: null, completion: { kind: "no_checks", basis: GOAL } }],
    ["run.status", { status: "paused", reason: "awaiting_finish_confirmation", completion: null }],
    // A4's records
    ["plan.proposed", { turnId: uuid, plan: GOAL, firstStage: 1, stageCount: 1, conditionsAssigned: 1 }],
    ["plan.decided", { commandId: uuid, proposalTurnId: uuid, decision: "accept", version: 2, choices: GOAL, note: null, runKey: "a".repeat(64), tree: "b".repeat(40) }],
    ["plan.decided", { commandId: uuid, proposalTurnId: uuid, decision: "return", version: null, choices: GOAL, note: GOAL, runKey: "a".repeat(64), tree: "b".repeat(40) }],
    ["person.decided", { commandId: uuid, subject: "finding", target: "F1", decision: "to_wish", finding: null, reopened: null, runKey: "a".repeat(64), tree: "b".repeat(40) }],
    ["person.decided", { commandId: uuid, subject: "disputed", target: { reviewTurnId: uuid, index: 0 }, decision: "repeat", finding: "F1", reopened: true, runKey: "a".repeat(64), tree: "b".repeat(40) }],
    ["person.decided", { commandId: uuid, subject: "condition", target: "C1", decision: "met", finding: null, reopened: null, runKey: "a".repeat(64), tree: "b".repeat(40) }],
    ["run.status", { status: "paused", reason: "coverage_lost", completion: null }]
  ];
  for (const [type, data] of ok) {
    assert.equal(isValidEventData(type, data, 2), true, `${type} ${JSON.stringify(data)}`);
    if (type !== "run.status") assert.equal(isValidEventData(type, data, 1), false, `${type} is not v1`);
  }
  const bad = [
    ["checks.proposed", { turnId: uuid, proposal: GOAL, count: 17, sandboxNetwork: "open" }],
    ["checks.proposed", { turnId: uuid, proposal: GOAL, count: 1 }],
    ["checks.decided", { proposalTurnId: uuid, decision: "drop", by: "person", commandId: uuid, checks: GOAL, count: 1 }],
    ["finish.confirmed", { commandId: uuid, tree: "b".repeat(40), commit: null, push: null, qa: null }],
    ["run.status", { status: "completed", reason: null, completion: null }],
    ["run.status", { status: "running", reason: null, completion: { kind: "confirmed", basis: GOAL } }],
    ["review.assessed", { turnId: uuid, stage: 1, request: "none", report: GOAL, applied: GOAL, clarificationVersion: 0, runKey: "k" }],
    // A4: plan.decided and person.decided say who saw what (runKey, tree), and nothing else
    ["plan.decided", { commandId: uuid, proposalTurnId: uuid, decision: "accept", version: null, choices: GOAL, note: null, runKey: "a".repeat(64), tree: "b".repeat(40) }],
    ["plan.decided", { commandId: uuid, proposalTurnId: uuid, decision: "return", version: null, choices: GOAL, note: null, runKey: "a".repeat(64) }],
    ["person.decided", { commandId: uuid, subject: "finding", target: "F1", decision: "close", finding: null, reopened: null, runKey: "a".repeat(64), tree: "b".repeat(40), by: "person" }],
    ["person.decided", { commandId: uuid, subject: "disputed", target: { reviewTurnId: uuid, index: 0 }, decision: "repeat", finding: null, reopened: false, runKey: "a".repeat(64), tree: "b".repeat(40) }],
    ["person.decided", { commandId: uuid, subject: "condition", target: "C1", decision: "close", finding: null, reopened: null, runKey: "a".repeat(64), tree: "b".repeat(40) }]
  ];
  for (const [type, data] of bad) assert.equal(isValidEventData(type, data, 2), false, `${type} ${JSON.stringify(data)}`);
});

test("A1 replay rules on the records: a proposal belongs to the last plan turn, the autopilot accepts only when the network is denied", () => {
  const runId = randomUUID();
  const created = ["run.created", { goal: GOAL }];
  const turnId = randomUUID();
  const at = (events) => { const p = parseJournal(lines(runId, events), runId); return [p.integrity.status, p.integrity.detail?.code, p.integrity.detail?.line]; };
  // a proposal of a turn that is not a completed plan turn
  assert.deepEqual(at([created, RUNNING, ["checks.proposed", { turnId, proposal: GOAL, count: 0, sandboxNetwork: "open" }]]), ["corrupt", "replay_conflict", 3]);
  // a decision without a proposal
  assert.deepEqual(at([created, RUNNING, ["checks.decided", { proposalTurnId: turnId, decision: "accept", by: "autopilot", commandId: null, checks: GOAL, count: 0 }]]), ["corrupt", "replay_conflict", 3]);
  // completed with nothing behind it: not allowed by the completion function
  assert.deepEqual(at([created, RUNNING, ["run.status", { status: "completed", reason: null, completion: { kind: "no_checks", basis: GOAL } }]]), ["corrupt", "replay_conflict", 3]);
});

test("the fixtures of the format (A4's final form): this build replays them whole, texts included; the reader of 1.5.7 shows them read only", async () => {
  const dirs = fs.readdirSync(FIXTURES);
  assert.equal(dirs.length, 8);
  const expected = {
    "01-no-checks-autopilot": ["completed", null, "no_checks"], "02-proposed-accepted-autopilot": ["completed", null, "confirmed"],
    "03-steps-accept": ["paused", "plan_review", null], "04-steps-edit": ["paused", "plan_review", null], "05-open-blocking": ["running", null, null],
    "06-no-checks-push-pause": ["paused", "awaiting_finish_confirmation", null], "07-no-checks-push-confirmed": ["completed", null, "no_checks"],
    "08-coverage-lost": ["paused", "coverage_lost", null]
  };
  for (const id of dirs) {
    const name = fs.readFileSync(path.join(FIXTURES, id, "FIXTURE"), "utf8").trim();
    const buf = fs.readFileSync(path.join(FIXTURES, id, "journal.jsonl"));
    // this build: replayed, its texts by the rules (A2–A4), the state the README table says
    const own = await readRun(path.dirname(FIXTURES), id);
    assert.deepEqual([own.integrity.status, own.state.status, own.state.pausedReason, own.state.completion?.kind ?? null], ["ok", ...expected[name]], name);
    const p = parseJournal(buf, id, A0);
    assert.equal(p.integrity.detail.chain.status, "ok", name);
    assert.deepEqual(newerGoal(p.records), JSON.parse(buf.toString().split("\n")[0]).data.goal, name);
    assert.deepEqual([p.integrity.status, p.state, p.integrity.detail.fallback, p.records.length], ["newer_version", null, undefined, buf.toString().trim().split("\n").length], name);
    // the reader of 1.5.7: the same read-only view, no fallback (minReaderVersion 2 is above it)
    assert.deepEqual(parseJournal(buf, id, A0).integrity, { status: "newer_version", detail: { version: 2, chain: { status: "ok" } } }, name);
    // A1's records in them match A1's schemas (the document and the code agree)
    for (const r of p.records.filter((x) => ["checks.proposed", "checks.decided", "finish.confirmed"].includes(x.type))) {
      assert.equal(isValidEventData(r.type, r.data, 2), true, `${name}: ${r.type}`);
    }
    // run.status: valid, or paused for a reason of A2–A4 (not A1's)
    for (const r of p.records.filter((x) => x.type === "run.status")) {
      if (!isValidEventData(r.type, r.data, 2)) assert.ok(!PAUSED_REASONS_V2.includes(r.data.reason), `${name}: run.status ${JSON.stringify(r.data)}`);
    }
  }
});

// §2.1 «Поле checks отчёта плана»: in a v2 journal every plan turn but the proposing one answers checks: null; a v1
// journal keeps its plan schema (I1-10).
test("the plan report of v2: checks null in every plan turn but the proposing one; a proposal there is invalid", async () => {
  const { PLAN_V2_SCHEMA, PLAN_PROPOSAL_SCHEMA, REPORT_SCHEMAS } = await import("../src/main/services/orchestration/orchestrationService.ts");
  const { validateAnswer } = await import("../src/main/services/orchestration/schema.ts");
  // A2 (§2.7): a v2 plan states its conditions, and its dropped and dropRequirements
  const v1 = { stages: [{ title: "t", task: "x" }], question: null };
  const plan = { stages: [{ ...v1.stages[0], conditions: [{ keep: null, text: "t", covers: ["R1"], evidence: { kind: "change", check: null } }] }], dropped: [], dropRequirements: [], question: null };
  assert.deepEqual(validateAnswer(PLAN_V2_SCHEMA, { ...plan, checks: null }), []);
  assert.notDeepEqual(validateAnswer(PLAN_V2_SCHEMA, { ...v1, checks: null }), [], "a v2 plan without conditions");
  assert.notDeepEqual(validateAnswer(PLAN_V2_SCHEMA, plan), [], "checks is required");
  assert.notDeepEqual(validateAnswer(PLAN_V2_SCHEMA, { ...plan, checks: { checks: [], none: "x" } }), [], "a proposal outside the proposing turn");
  assert.deepEqual(validateAnswer(PLAN_PROPOSAL_SCHEMA, { ...plan, checks: { checks: [], none: "x" } }), []);
  assert.deepEqual(validateAnswer(REPORT_SCHEMAS.plan, v1), [], "v1 unchanged");
  assert.notDeepEqual(validateAnswer(REPORT_SCHEMAS.plan, { ...v1, checks: null }), []);
  assert.notDeepEqual(validateAnswer(REPORT_SCHEMAS.plan, plan), [], "no conditions in v1");
});
