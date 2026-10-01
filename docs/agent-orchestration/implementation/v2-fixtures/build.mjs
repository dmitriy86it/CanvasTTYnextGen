// Journal v2 fixtures of acceptance-review-spec edition 5i (journal-v2-format.md §4). Writes runs/<id>/journal.jsonl
// and runs/<id>/texts/<sha256> next to this file, with the real hash chain and canonical JSON of the application.
//   node docs/agent-orchestration/implementation/v2-fixtures/build.mjs           write the fixtures
//   node docs/agent-orchestration/implementation/v2-fixtures/build.mjs --check   read them with the A0 reader of this tree
// --check reads only: each fixture as written (minReaderVersion 2) and, in memory, the same journal declaring
// minReaderVersion 1, both through parseJournal and newerGoal of src/main/services/orchestration/journal.ts.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonical, newerGoal, parseJournal, sha256Hex } from "../../../../src/main/services/orchestration/journal.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ZERO = "0".repeat(64);
const h = (s, n = 64) => createHash("sha256").update(s).digest("hex").slice(0, n);
const uuid = (s) => { const x = h(`uuid:${s}`, 32); return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`; };
const oid = (s) => h(`oid:${s}`, 40);

// One fixture: records and texts, built in order. min: minReaderVersion of the first record.
const NEW_KINDS = ["checks.proposed", "checks.decided", "finish.confirmed", "review.assessed", "review.discarded", "plan.proposed", "plan.decided", "person.decided"];

// One fixture: records and texts, built in order. min: minReaderVersion of the first record; skippable: mark the new
// kinds skippable (only to see what the A0 reader would do; the format never writes it, journal-v2-format.md §3.3).
function journal(name, min, skippable = false) {
  const runId = uuid(name);
  const lines = [];
  const texts = new Map();
  let prev = null;
  let t = Date.UTC(2026, 9, 1, 9, 0, 0);
  const text = (value) => {
    const body = canonical(value);
    const ref = { sha256: sha256Hex(body), bytes: Buffer.byteLength(body) };
    texts.set(ref.sha256, body);
    return ref;
  };
  const rec = (type, data) => {
    const body = { v: 2, seq: prev ? prev.seq + 1 : 0, ts: new Date(t += 1000).toISOString(), runId, type,
      prevHash: prev ? prev.hash : ZERO, data, ...(prev ? {} : { minReaderVersion: min }), ...(skippable && NEW_KINDS.includes(type) ? { skippable: true } : {}) };
    const full = { ...body, hash: sha256Hex(canonical(body)) };
    lines.push(canonical(full));
    prev = full;
  };
  let n = 0;
  // A finished turn: orch.turn, turn.intent, turn.finished with a valid stored report.
  const turn = ({ purpose, stage = null, round = null, planVersion = null, role, provider, tree = null, report, clar = 0 }) => {
    const turnId = uuid(`${name}:turn:${++n}`);
    rec("orch.turn", { turnId, purpose, stage, round, planVersion, clarificationVersion: clar, tree });
    rec("turn.intent", { turnId, commandId: null, role, provider, mode: "native", sessionId: null, task: text({ task: `${purpose} ${stage ?? ""}`.trim() }) });
    if (report === undefined) return turnId; // left in flight
    rec("turn.finished", { turnId, outcome: "completed", nextTurnAllowed: true, sessionId: `${provider}-session-${n}`,
      contract: { status: "verified", errors: [] }, report: { status: "valid", ref: text(report), storeError: null },
      transport: { outcome: "completed", exitCode: 0, signal: null, groupCleared: true } });
    return turnId;
  };
  const command = (kind, payload, write) => {
    const commandId = uuid(`${name}:command:${kind}:${++n}`);
    rec("command.received", { commandId, kind, payloadHash: sha256Hex(canonical(payload)) });
    write(commandId);
    rec("command.completed", { commandId, result: { status: "accepted", code: null } });
  };
  const ws = { commit: oid(`${name}:base`), tree: oid(`${name}:base-tree`) };
  const start = (goal) => {
    rec("run.created", { goal: text(goal) });
    rec("workspace.created", { sourcePathSha256: h(`${name}:folder`), baseline: { ...ws }, head: ws.commit });
    rec("run.status", { status: "running", reason: null, completion: null });
  };
  const checkpoint = (stage, tree) => {
    const commit = oid(`${name}:cp${stage}`);
    rec("checkpoint.created", { stage, commit, tree, parent: ws.commit });
    ws.commit = commit;
    ws.tree = tree;
  };
  // one check run on `tree`, from the current base of the copy (the baseline or the last checkpoint), passed and assessed
  const check = (checkId, command, stage, round, runKey, checkKey, tree) => {
    const checkRunId = uuid(`${name}:check:${++n}`);
    // checks.ts commandSha256(CheckCommand) of a command line run by the login shell (shellRegistry)
    const commandSha256 = sha256Hex(canonical({ id: checkId, executable: "/bin/zsh", argv: ["-ilc", command], timeoutMs: 30 * 60_000, maxOutputBytes: 65_536 }));
    rec("check.started", { checkRunId, checkId, commandSha256, base: { ...ws }, treeBefore: tree, profileSha256: h("profile") });
    rec("check.finished", { checkRunId, status: "passed", reason: null, exitCode: 0, signal: null, groupCleared: true, treeAfter: tree,
      output: null, outputDropped: 0, evidenceFingerprint: h(`${checkRunId}:evidence`), durationMs: 1200 });
    rec("check.assessed", { checkRunId, stage, round, checkKey, runKey });
    return checkRunId;
  };
  const applied = (report, extra) => ({ report: { sha256: sha256Hex(canonical(report)), bytes: Buffer.byteLength(canonical(report)) },
    conditionsMet: [], opened: [], closed: [], reopened: [], refused: [], disputed: [], unchanged: [], nextFinding: 1, ...extra });
  const review = (turnId, stage, report, extra, runKey) =>
    rec("review.assessed", { turnId, stage, request: report.request, report: text(report), applied: text(applied(report, extra)), clarificationVersion: 0, runKey });
  const complete = (kind, basis) => rec("run.status", { status: "completed", reason: null, completion: { kind, basis: text(basis) } });
  return { runId, rec, text, turn, command, start, checkpoint, check, review, complete, ws, done: () => ({ runId, lines, texts }) };
}

// checkGoal's shape (orchestrationService.ts), with commands: [] (v2 only) and then checks: []
const goal = (extra) => {
  const g = { v: 1, text: "Добавить экспорт отчёта в CSV", criteria: ["Отчёт выгружается в CSV", "Заголовки колонок как в таблице"], checks: [],
    reviewPlan: false, limits: { turns: 40, roundsPerStage: 8, replans: 3, noProgressRounds: 3, runMs: 4 * 3600_000, leadTurnMs: 20 * 60_000, executorTurnMs: 45 * 60_000 },
    createdAt: Date.UTC(2026, 9, 1, 9, 0, 0), commands: [], workMode: "project", mode: "autopilot", ...extra };
  if (g.mode === "steps") g.reviewPlan = true; // step by step always shows the plan first
  return g;
};
const finalReport = (rs) => ({ conditions: [], requirements: rs.map((id) => ({ id, status: "met", note: "проверено по коду" })), findings: [], request: "none", question: null });
// the lead's report carries proposed commands without ids; checks.proposed numbers them (journal-v2-format.md §2.1)
const reported = (proposal) => proposal && { ...proposal, checks: proposal.checks.map(({ id, ...c }) => c) };
const planOf = (conditions, checks) => ({ stages: [{ title: "Экспорт CSV", task: "Добавить выгрузку отчёта в CSV", conditions }],
  dropped: [], dropRequirements: [], question: null, checks });

const FIXTURES = {
  // Empty commands, the lead says why there are none, the autopilot accepts: completed without checks.
  "01-no-checks-autopilot": (j) => {
    j.start(goal());
    const proposal = { checks: [], none: "В проекте нет тестов и линтера: package.json без scripts, конфигураций нет" };
    const p = j.turn({ purpose: "plan", role: "lead", provider: "codex",
      report: planOf([{ text: "Кнопка «CSV» выгружает отчёт с заголовками", covers: ["R1", "R2"], evidence: { kind: "change" } }], reported(proposal)) });
    j.rec("checks.proposed", { turnId: p, proposal: j.text(proposal), count: 0 });
    j.rec("checks.decided", { proposalTurnId: p, decision: "accept", by: "autopilot", commandId: null, checks: j.text({ checks: [] }), count: 0 });
    j.rec("plan.recorded", { turnId: p, version: 1, plan: j.text({ ...planOf([{ id: "C1", text: "Кнопка «CSV» выгружает отчёт с заголовками", covers: ["R1", "R2"], evidence: { kind: "change" } }], null) }), firstStage: 1, stageCount: 1, conditionsAssigned: 1 });
    j.turn({ purpose: "execute", stage: 1, round: 1, planVersion: 1, role: "executor", provider: "claude", report: { summary: "Добавлен экспорт" } });
    const tree = oid("01:after");
    const rep = { conditions: [{ id: "C1", status: "met", paths: ["src/report.ts"], note: "выгрузка и заголовки" }], findings: [], request: "none", question: null };
    const r = j.turn({ purpose: "review", stage: 1, round: 1, planVersion: 1, role: "reviewer", provider: "codex", tree, report: rep });
    j.review(r, 1, rep, { conditionsMet: ["C1"] }, h("01:runKey"));
    j.rec("stage.accepted", { stage: 1, reviewTurnId: r, tree });
    j.checkpoint(1, tree);
    const f = j.turn({ purpose: "final_review", planVersion: 1, role: "reviewer", provider: "codex", tree, report: finalReport(["R1", "R2"]) });
    j.review(f, null, finalReport(["R1", "R2"]), {}, h("01:runKey"));
    j.complete("no_checks", { checks: [], requirements: [{ id: "R1", conditions: ["C1"], met: true }, { id: "R2", conditions: ["C1"], met: true }],
      finalReviewTurnId: f, runKey: h("01:runKey"), checkKeys: {}, finish: {} });
  },
  // The lead proposes two commands, the autopilot accepts, both pass: completed and confirmed.
  "02-proposed-accepted-autopilot": (j) => {
    j.start(goal({ text: "Исправить разбор дат в импорте", criteria: ["Даты ISO 8601 разбираются", "Существующие тесты проходят"] }));
    const proposal = { checks: [{ id: "cmd-1", command: "npm test", why: "package.json: scripts.test запускает node --test", source: ["package.json"] },
      { id: "cmd-2", command: "npm run typecheck", why: "tsconfig.json и scripts.typecheck есть", source: ["package.json", "tsconfig.json"] }], none: null };
    const conditions = [{ text: "Тесты проекта проходят", covers: ["R2"], evidence: { kind: "check", check: "cmd-1" } },
      { text: "Разбор ISO 8601 с часовым поясом", covers: ["R1"], evidence: { kind: "change" } }];
    const p = j.turn({ purpose: "plan", role: "lead", provider: "codex", report: planOf(conditions, reported(proposal)) });
    j.rec("checks.proposed", { turnId: p, proposal: j.text(proposal), count: 2 });
    j.rec("checks.decided", { proposalTurnId: p, decision: "accept", by: "autopilot", commandId: null, count: 2,
      checks: j.text({ checks: proposal.checks.map(({ id, command }) => ({ id, command, origin: "lead" })) }) });
    j.rec("plan.recorded", { turnId: p, version: 1, plan: j.text(planOf(conditions.map((c, i) => ({ id: `C${i + 1}`, ...c })), null)), firstStage: 1, stageCount: 1, conditionsAssigned: 2 });
    j.turn({ purpose: "execute", stage: 1, round: 1, planVersion: 1, role: "executor", provider: "claude", report: { summary: "Разбор дат исправлен" } });
    const tree = oid("02:after");
    const runKey = h("02:runKey");
    const checkKeys = { "cmd-1": h("02:checkKey:cmd-1"), "cmd-2": h("02:checkKey:cmd-2") };
    j.check("cmd-1", "npm test", 1, 1, runKey, checkKeys["cmd-1"], tree);
    j.check("cmd-2", "npm run typecheck", 1, 1, runKey, checkKeys["cmd-2"], tree);
    const rep = { conditions: [{ id: "C2", status: "met", paths: ["src/import/date.ts"], note: "учтён часовой пояс" }], findings: [], request: "none", question: null };
    const r = j.turn({ purpose: "review", stage: 1, round: 1, planVersion: 1, role: "reviewer", provider: "codex", tree, report: rep });
    j.review(r, 1, rep, { conditionsMet: ["C2"] }, runKey);
    j.rec("stage.accepted", { stage: 1, reviewTurnId: r, tree });
    j.checkpoint(1, tree);
    const f = j.turn({ purpose: "final_review", planVersion: 1, role: "reviewer", provider: "codex", tree, report: finalReport(["R1", "R2"]) });
    j.review(f, null, finalReport(["R1", "R2"]), {}, runKey);
    j.complete("confirmed", { checks: ["cmd-1", "cmd-2"], requirements: [{ id: "R1", conditions: ["C2"], met: true }, { id: "R2", conditions: ["C1"], met: true }],
      finalReviewTurnId: f, runKey, checkKeys, finish: {} });
  },
  // Steps: the run waits for the person on the proposal, «Принять», the plan is recorded and shown for review.
  "03-steps-accept": (j) => {
    j.start(goal({ mode: "steps" }));
    const proposal = { checks: [{ id: "cmd-1", command: "make test", why: "Makefile: цель test", source: ["Makefile"] }], none: null };
    const conditions = [{ text: "make test проходит", covers: ["R1", "R2"], evidence: { kind: "check", check: "cmd-1" } }];
    const p = j.turn({ purpose: "plan", role: "lead", provider: "codex", report: planOf(conditions, reported(proposal)) });
    j.rec("checks.proposed", { turnId: p, proposal: j.text(proposal), count: 1 });
    j.rec("run.status", { status: "paused", reason: "awaiting_checks_decision", completion: null });
    const decided = { checks: [{ id: "cmd-1", command: "make test", origin: "lead" }] };
    j.command("checks.decide", { decision: "accept" }, (commandId) =>
      j.rec("checks.decided", { proposalTurnId: p, decision: "accept", by: "person", commandId, checks: j.text(decided), count: 1 }));
    j.rec("run.status", { status: "running", reason: null, completion: null }); // the decision resumes the run (§2.4)
    j.rec("plan.recorded", { turnId: p, version: 1, plan: j.text(planOf([{ id: "C1", ...conditions[0] }], null)), firstStage: 1, stageCount: 1, conditionsAssigned: 1 });
    j.rec("run.status", { status: "paused", reason: "plan_review", completion: null });
  },
  // Steps: «Изменить» replaces a command; the proposing turn's plan is dropped, a new plan turn uses the new commands.
  "04-steps-edit": (j) => {
    j.start(goal({ mode: "steps" }));
    const proposal = { checks: [{ id: "cmd-1", command: "npm test", why: "scripts.test", source: ["package.json"] },
      { id: "cmd-2", command: "npm run e2e", why: "scripts.e2e", source: ["package.json"] }], none: null };
    const p = j.turn({ purpose: "plan", role: "lead", provider: "codex",
      report: planOf([{ text: "Тесты и e2e проходят", covers: ["R1", "R2"], evidence: { kind: "check", check: "cmd-2" } }], reported(proposal)) });
    j.rec("checks.proposed", { turnId: p, proposal: j.text(proposal), count: 2 });
    j.rec("run.status", { status: "paused", reason: "awaiting_checks_decision", completion: null });
    const decided = { checks: [{ id: "cmd-1", command: "npm test", origin: "lead" }, { id: "cmd-2", command: "npm run lint", origin: "person" }] };
    j.command("checks.decide", { decision: "edit", checks: decided.checks.map((c) => c.command) }, (commandId) =>
      j.rec("checks.decided", { proposalTurnId: p, decision: "edit", by: "person", commandId, checks: j.text(decided), count: 2 }));
    j.rec("run.status", { status: "running", reason: null, completion: null });
    const conditions = [{ id: "C1", text: "Тесты проходят", covers: ["R2"], evidence: { kind: "check", check: "cmd-1" } },
      { id: "C2", text: "Выгрузка CSV с заголовками", covers: ["R1", "R2"], evidence: { kind: "change" } }];
    const p2 = j.turn({ purpose: "plan", role: "lead", provider: "codex", report: planOf(conditions.map(({ id, ...c }) => c), null) });
    // numbering continues from nextCondition: the dropped proposal took none (it was never recorded) — C1, C2
    j.rec("plan.recorded", { turnId: p2, version: 1, plan: j.text(planOf(conditions, null)), firstStage: 1, stageCount: 1, conditionsAssigned: 2 });
    j.rec("run.status", { status: "paused", reason: "plan_review", completion: null });
  },
  // The goal has commands (no proposal); the reviewer opens F1 (blocking): the stage goes back to the executor.
  "05-open-blocking": (j) => {
    j.start(goal({ checks: ["cmd-1"], commands: ["npm test"] }));
    const conditions = [{ id: "C1", text: "Выгрузка CSV с заголовками", covers: ["R1", "R2"], evidence: { kind: "change" } }];
    const p = j.turn({ purpose: "plan", role: "lead", provider: "codex", report: planOf(conditions.map(({ id, ...c }) => c), null) });
    j.rec("plan.recorded", { turnId: p, version: 1, plan: j.text(planOf(conditions, null)), firstStage: 1, stageCount: 1, conditionsAssigned: 1 });
    j.turn({ purpose: "execute", stage: 1, round: 1, planVersion: 1, role: "executor", provider: "claude", report: { summary: "Добавлен экспорт" } });
    const tree = oid("05:after");
    const runKey = h("05:runKey");
    j.check("cmd-1", "npm test", 1, 1, runKey, h("05:checkKey:cmd-1"), tree);
    const rep = { conditions: [{ id: "C1", status: "not_met", paths: [], note: "заголовки не экранируются" }],
      findings: [{ id: null, severity: "blocking", condition: "C1", problem: "Запятая в заголовке ломает CSV", evidence: "src/report.ts: join(',') без кавычек",
        closeWhen: "заголовки и значения экранируются по RFC 4180", status: "open", paths: ["src/report.ts"], relation: null }], request: "none", question: null };
    const r = j.turn({ purpose: "review", stage: 1, round: 1, planVersion: 1, role: "reviewer", provider: "codex", tree, report: rep });
    j.review(r, 1, rep, { opened: [{ id: "F1", index: 0, severity: "blocking", condition: "C1", stage: 1, paths: ["src/report.ts"], possibleRepeatOf: null }], nextFinding: 2 }, runKey);
    j.turn({ purpose: "execute", stage: 1, round: 2, planVersion: 1, role: "executor", provider: "claude" }); // in flight
  },
  // No checks; commit done; push and QA wait for the person even in the autopilot.
  "06-no-checks-push-pause": (j) => noChecksToFinish(j, "06"),
  // The same, then push confirmed and QA declined: completed without checks, QA declined by the person.
  "07-no-checks-push-confirmed": (j) => {
    const { tree, commit, finalTurn, runKey } = noChecksToFinish(j, "07");
    j.command("finish.confirm", { tree, commit, push: "confirm", qa: "decline" }, (commandId) =>
      j.rec("finish.confirmed", { commandId, tree, commit, push: "confirm", qa: "decline" }));
    j.rec("run.status", { status: "running", reason: null, completion: null });
    const push = uuid("07:push");
    j.rec("finish.intent", { intentId: push, step: "push", params: j.text({ step: "push", push: { remote: "origin", branch: "feature/csv", commit, tree } }) });
    j.rec("finish.result", { intentId: push, status: "done", established: false, evidence: null, commit, tree });
    j.complete("no_checks", { checks: [], requirements: [{ id: "R1", conditions: ["C1"], met: true }, { id: "R2", conditions: ["C1"], met: true }],
      finalReviewTurnId: finalTurn, runKey, checkKeys: {}, finish: { commit: "done", push: "done", qa: "declined" } });
  },
  // A replan proposes dropping C2: plan.proposed, coverage_lost; the current plan stays.
  "08-coverage-lost": (j) => {
    j.start(goal({ checks: ["cmd-1"], commands: ["npm test"], criteria: ["Отчёт выгружается в CSV", "Отчёт выгружается в XLSX"] }));
    const conditions = [{ id: "C1", text: "Выгрузка CSV", covers: ["R1"], evidence: { kind: "change" } },
      { id: "C2", text: "Выгрузка XLSX", covers: ["R2"], evidence: { kind: "change" } }];
    const p = j.turn({ purpose: "plan", role: "lead", provider: "codex", report: planOf(conditions.map(({ id, ...c }) => c), null) });
    j.rec("plan.recorded", { turnId: p, version: 1, plan: j.text(planOf(conditions, null)), firstStage: 1, stageCount: 1, conditionsAssigned: 2 });
    j.turn({ purpose: "execute", stage: 1, round: 1, planVersion: 1, role: "executor", provider: "claude", report: { summary: "CSV готов, для XLSX нет библиотеки" } });
    const tree = oid("08:after");
    const rep = { conditions: [{ id: "C1", status: "met", paths: ["src/report.ts"], note: "" }, { id: "C2", status: "not_met", paths: [], note: "XLSX нет" }],
      findings: [], request: "replan", question: null };
    const r = j.turn({ purpose: "review", stage: 1, round: 1, planVersion: 1, role: "reviewer", provider: "codex", tree, report: rep });
    j.review(r, 1, rep, { conditionsMet: ["C1"] }, h("08:runKey"));
    const proposal = { stages: [{ title: "Экспорт", task: "Довести CSV", conditions: [{ keep: "C1" }] }],
      dropped: [{ condition: "C2", why: "XLSX требует новой зависимости, её нет в разрешённых" }],
      dropRequirements: [{ requirement: "R2", why: "без XLSX-библиотеки требование не выполнить" }], question: null, checks: null };
    const p2 = j.turn({ purpose: "plan", planVersion: 1, role: "lead", provider: "codex", report: proposal });
    j.rec("plan.proposed", { turnId: p2, plan: j.text(proposal), firstStage: 1, stageCount: 1, conditionsAssigned: 0 });
    j.rec("run.status", { status: "paused", reason: "coverage_lost", completion: null });
  }
};

// 06 and 07: a run without checks up to its pause for push and QA.
function noChecksToFinish(j, tag) {
  j.start(goal({ finish: { commit: { message: "Экспорт отчёта в CSV" }, push: { remote: "origin", branch: "feature/csv", remoteUrl: null },
    qa: { environment: "qa", command: "./deploy-qa.sh", verify: "curl -fsS https://qa.example.test/version", reportsVersion: false } } }));
  const proposal = { checks: [], none: "Тестов в проекте нет" };
  const conditions = [{ text: "Кнопка «CSV» выгружает отчёт с заголовками", covers: ["R1", "R2"], evidence: { kind: "change" } }];
  const p = j.turn({ purpose: "plan", role: "lead", provider: "codex", report: planOf(conditions, reported(proposal)) });
  j.rec("checks.proposed", { turnId: p, proposal: j.text(proposal), count: 0 });
  j.rec("checks.decided", { proposalTurnId: p, decision: "accept", by: "autopilot", commandId: null, checks: j.text({ checks: [] }), count: 0 });
  j.rec("plan.recorded", { turnId: p, version: 1, plan: j.text(planOf([{ id: "C1", ...conditions[0] }], null)), firstStage: 1, stageCount: 1, conditionsAssigned: 1 });
  j.turn({ purpose: "execute", stage: 1, round: 1, planVersion: 1, role: "executor", provider: "claude", report: { summary: "Добавлен экспорт" } });
  const tree = oid(`${tag}:after`);
  const runKey = h(`${tag}:runKey`);
  const rep = { conditions: [{ id: "C1", status: "met", paths: ["src/report.ts"], note: "" }], findings: [], request: "none", question: null };
  const r = j.turn({ purpose: "review", stage: 1, round: 1, planVersion: 1, role: "reviewer", provider: "codex", tree, report: rep });
  j.review(r, 1, rep, { conditionsMet: ["C1"] }, runKey);
  j.rec("stage.accepted", { stage: 1, reviewTurnId: r, tree });
  j.checkpoint(1, tree);
  const finalTurn = j.turn({ purpose: "final_review", planVersion: 1, role: "reviewer", provider: "codex", tree, report: finalReport(["R1", "R2"]) });
  j.review(finalTurn, null, finalReport(["R1", "R2"]), {}, runKey);
  const commit = oid(`${tag}:commit`);
  const intent = uuid(`${tag}:commit`);
  j.rec("finish.intent", { intentId: intent, step: "commit", params: j.text({ step: "commit", commit: { message: "Экспорт отчёта в CSV", paths: null, runId: j.runId, tree } }) });
  j.rec("finish.result", { intentId: intent, status: "done", established: false, evidence: null, commit, tree });
  j.rec("run.status", { status: "paused", reason: "awaiting_finish_confirmation", completion: null });
  return { tree, commit, finalTurn, runKey };
}

const build = (name, min, skippable) => {
  const j = journal(name, min, skippable);
  FIXTURES[name](j);
  return j.done();
};

if (process.argv.includes("--check")) {
  const rows = [];
  for (const name of Object.keys(FIXTURES)) {
    const { runId } = build(name, 2);
    const dir = path.join(HERE, "runs", runId);
    const buf = fs.readFileSync(path.join(dir, "journal.jsonl"));
    const two = parseJournal(buf, runId);
    const ref = newerGoal(two.records);
    const goalText = ref ? JSON.parse(fs.readFileSync(path.join(dir, "texts", ref.sha256), "utf8")).text : null;
    const one = build(name, 1);
    const p1 = parseJournal(Buffer.from(`${one.lines.join("\n")}\n`), runId);
    const d1 = p1.integrity.detail ?? {};
    const sk = build(name, 1, true);
    const ps = parseJournal(Buffer.from(`${sk.lines.join("\n")}\n`), runId);
    const ds = ps.integrity.detail ?? {};
    const lineOf = (k) => JSON.parse(two.records[k - 1] ? JSON.stringify(two.records[k - 1]) : "null")?.type;
    rows.push({ fixture: name, records: two.records.length, v2: `${two.integrity.status} (chain ${two.integrity.detail?.chain?.status}, state ${two.state === null ? "null" : "set"})`,
      goal: goalText,
      min1: d1.fallback ? `fallback at line ${d1.fallback.line} (${lineOf(d1.fallback.line)}): ${d1.fallback.code}` : `${p1.integrity.status}`,
      min1Skippable: ds.fallback ? `fallback at line ${ds.fallback.line} (${lineOf(ds.fallback.line)}): ${ds.fallback.code}` : `${ps.integrity.status}, skipped ${ds.skipped}, status ${ps.state?.status}/${ps.state?.pausedReason}` });
  }
  console.log(JSON.stringify(rows, null, 2));
} else {
  fs.rmSync(path.join(HERE, "runs"), { recursive: true, force: true });
  for (const name of Object.keys(FIXTURES)) {
    const { runId, lines, texts } = build(name, 2);
    const dir = path.join(HERE, "runs", runId);
    fs.mkdirSync(path.join(dir, "texts"), { recursive: true });
    fs.writeFileSync(path.join(dir, "journal.jsonl"), `${lines.join("\n")}\n`);
    for (const [sha, body] of texts) fs.writeFileSync(path.join(dir, "texts", sha), body);
    fs.writeFileSync(path.join(dir, "FIXTURE"), `${name}\n`);
    console.log(`${name}  runs/${runId}  ${lines.length} records`);
  }
}
