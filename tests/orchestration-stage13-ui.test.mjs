// Stage 13 review fixes in the renderer's run model and strings (UX-3, UX-4, UX-5, UX-6, UX-8): pure checks, no Electron.
import assert from "node:assert/strict";
import test from "node:test";
import { agentState, availableActions, board, finishPending, finishStatus, probeText, runHeadline } from "../src/renderer/src/features/orchestration/runModel.ts";
import { t } from "../src/renderer/src/lib/i18n.ts";

const view = (over = {}) => ({ runId: "r", status: "running", reason: null, revision: 3, stage: 1, turns: 1, halted: false, active: { kind: "turn", purpose: "execute" }, ...over });
const perm = (role) => ({ requestId: "q", role, provider: role === "lead" ? "codex" : "claude", kind: "command", tool: "Bash", summary: "x", detail: null, options: ["allow_once", "deny"], questions: [], askedAt: "2026-01-01T00:00:00Z" });
const progress = (finish) => ({ mode: "autopilot", branch: null, access: null, checks: [], prepare: null, grantsApplied: 0,
  finish: [{ step: "commit", asked: true, status: "done", established: false, commit: "a".repeat(40), evidence: null }, ...finish] });

test("UX-4: the card of the role whose CLI waits for the person says so, the other one does not", () => {
  const v = view({ permission: perm("executor") });
  assert.equal(agentState("executor", v), "needs_you");
  assert.equal(agentState("lead", v), "waiting");
  assert.equal(agentState("lead", view({ active: { kind: "turn", purpose: "plan" }, permission: perm("lead") })), "needs_you");
  assert.equal(agentState("executor", view()), "working", "no request: unchanged");
  assert.equal(agentState("executor", view({ status: "stopping", permission: perm("executor") })), "stopping");
  for (const locale of ["ru", "en"]) assert.ok(t(locale, "orchAgentNeedsYou") && t(locale, "orchLinkNeedsYou"));
});

test("UX-3: a failed action after success offers a retry by name; an unconfirmed one only a check", () => {
  const qa = (status) => ({ step: "qa", asked: true, status, established: false, commit: null, evidence: null });
  const failed = view({ status: "paused", reason: "finish_unconfirmed", active: null, progress: progress([qa("failed")]) });
  assert.deepEqual(finishPending(failed), { step: "qa", status: "failed" });
  assert.deepEqual(runHeadline(failed), { headline: "needs_decision", next: "finish_retry" });
  const unknown = view({ status: "paused", reason: "finish_unconfirmed", active: null, progress: progress([qa("unknown")]) });
  assert.deepEqual(runHeadline(unknown), { headline: "needs_decision", next: "finish_check" });
  assert.ok(availableActions(failed).includes("resume"));
  assert.equal(finishPending(view({ progress: progress([]) })), null, "every asked action done: nothing pending");
  for (const locale of ["ru", "en"]) {
    assert.ok(t(locale, "orchNext_finish_retry") && t(locale, "orchFinishRetry"));
    assert.ok(!/не повторит|does not run the action again/.test(t(locale, "orchNext_finish_retry")), "the retry text never says it is not repeated");
    assert.match(t(locale, "orchNext_finish_check"), /не повторит|does not run the action again/);
  }
});

test("UX-5: a run paused because the application closed is not 'by the user' and can be resumed", () => {
  const v = view({ status: "paused", reason: "app_closed", active: null });
  assert.deepEqual(runHeadline(v), { headline: "paused", next: "app_closed" });
  assert.ok(availableActions(v).includes("resume"));
  for (const locale of ["ru", "en"]) assert.ok(t(locale, "orchReason_app_closed") && t(locale, "orchNext_app_closed"));
  assert.doesNotMatch(t("ru", "orchReason_app_closed"), /пользовател/);
});

test("UX-2: the board keeps the rights of the run", () => {
  const b = board(view({ progress: { ...progress([]), access: { claude: "full", codex: "terminal" } } }));
  assert.equal(b.grantsApplied, 0);
  for (const locale of ["ru", "en"]) for (const mode of ["terminal", "acceptEdits", "auto", "workspace", "full"]) assert.ok(t(locale, `orchAccess_${mode}`), mode);
});

test("UX-6/UX-8: the dynamic keys the panel builds exist in both languages", () => {
  const keys = [
    ...["model", "permissionMode", "approvalPolicy", "sandbox", "mcp", "skills", "plugins", "agents", "instructionSources", "toolCount", "slashCommands", "outputStyle"].map((k) => `orchEnvKey_${k}`),
    ...["started", "blocked", "establishing"].map((k) => `orchFinishPhase_${k}`),
    ...["done", "failed", "not_done", "unknown", "outcome_unknown"].map((k) => `orchFinishStatus_${k}`),
    // an interrupted turn's outcome falls back to orchOutcome_* when there is no orchPhaseWhy_*
    ...["stopped", "failed", "timeout", "delivery_failed", "protocol_error"].map((k) => `orchOutcome_${k}`),
    "orchUnitSec", "orchUnitMin", "orchUnitHour", "orchPermAlwaysAsk", "orchFinishStatus_qa_confirmed", "orchFinishStatus_qa_unverified", "orchFinishStatus_qa_mismatch", "orchFinishStatus_qa_not_reported", "orchFinishStatus_qa_invalid", "orchFinishObserved", "orchFinishExpected", "orchNext_review_qa_unverified", "orchSettingsQaReportsVersion", "orchSettingsQaUnverified", "orchBoardAccess", "orchRights",
    "orchReady_permissions_access", "orchSettingsErrQa", "orchSettingsErrBranch", "orchAccessMapsNone"
  ];
  for (const locale of ["ru", "en"]) for (const k of keys) assert.ok(t(locale, k), `${locale}: ${k}`);
  assert.doesNotMatch(t("ru", "orchBoardGrants"), /^сохранённых/, "no '1 сохранённых …' agreement problem: the number follows the label");
});

test("RT-6: the probe's English patterns are said in the person's language, anything else as sent", () => {
  assert.equal(probeText("ru", "found 5, enabled 3: a, b"), "найдено 5, включено 3: a, b");
  assert.equal(probeText("ru", "3: a, b, c"), "3: a, b, c", "all found are enabled: the old form");
  assert.equal(probeText("ru", "2 could not be loaded"), "2 не удалось загрузить");
  assert.equal(probeText("ru", "the list is incomplete"), "список неполный");
  assert.equal(probeText("ru", "(none)"), "(нет)");
  assert.equal(probeText("ru", "on-request (default)"), "on-request (по умолчанию)");
  assert.equal(probeText("en", "found 5, enabled 3: a"), "found 5, enabled 3: a");
  assert.equal(probeText("ru", "mock-mcp (connected)"), "mock-mcp (connected)");
});

test("RT-6: the probe and rights-mismatch strings exist in both languages", () => {
  for (const locale of ["ru", "en"]) {
    for (const k of ["orchProbe_found", "orchProbe_enabled", "orchProbe_notLoaded", "orchProbe_incomplete", "orchProbe_none", "orchProbe_default",
      "orchAct_accessMismatch", "orchAct_accessAsked", "orchAct_accessReported", "orchAccessMismatchWarn", "orchAct_codexPlan", "orchReason_app_closed"]) assert.ok(t(locale, k), `${locale}: ${k}`);
    assert.match(t(locale, "orchEnvProbeHint"), locale === "ru" ? /Найденное не значит использованное/ : /Found is not used/);
  }
});

test("the test database readiness has a line for each level main sends, and the confirm level an acknowledgement", () => {
  for (const locale of ["ru", "en"]) {
    for (const level of ["ok", "info", "confirm", "warning", "blocker"]) assert.ok(t(locale, `orchReady_testdb_${level}`), `${locale}: orchReady_testdb_${level}`);
    for (const level of ["confirm", "warning", "blocker"]) assert.ok(t(locale, `orchReadyFix_testdb_${level}`), `${locale}: orchReadyFix_testdb_${level}`);
    assert.ok(t(locale, "orchReadyAck_testdb"));
    for (const code of ["access_unsupported", "test_database_unsafe"]) assert.ok(t(locale, `orchError_${code}`), `${locale}: orchError_${code}`);
  }
  assert.doesNotMatch(t("ru", "orchReady_testdb_blocker"), /из \.env/, "the blocker is not only about .env (also the cached configuration)");
});

test("QA version (review 2): a passing check confirms a version only through the version contract; each case is said apart", () => {
  const qa = (status, version, observed = null) => ({ step: "qa", asked: true, status, established: false, commit: "a".repeat(40), evidence: null, version, observed });
  // no contract (an older or plain verification, a comment with $CANVASTTY_COMMIT, an echo of the expected sha)
  assert.equal(finishStatus(qa("done", "not_checked")), "qa_unverified");
  // a journal from before the contract (bound true meant only "the command mentions the variable"): never confirmed
  assert.equal(finishStatus({ ...qa("done", undefined), bound: true }), "qa_unverified");
  assert.equal(finishStatus(qa("done", "confirmed", "a".repeat(40))), "qa_confirmed");
  assert.equal(finishStatus(qa("unknown", "mismatch", "b".repeat(40))), "qa_mismatch");
  assert.equal(finishStatus(qa("unknown", "not_reported")), "qa_not_reported");
  assert.equal(finishStatus(qa("unknown", "invalid")), "qa_invalid");
  assert.equal(finishStatus(qa("unknown", undefined)), "unknown", "verification failed: the version is not the question");
  assert.equal(finishStatus(qa("failed", undefined)), "failed");
  assert.equal(finishStatus({ step: "commit", status: "done" }), "done", "only QA has a version");
  const completed = (f) => view({ status: "completed", active: null, workMode: "project", progress: progress([f]) });
  assert.equal(runHeadline(completed(qa("done", "not_checked"))).next, "review_qa_unverified");
  assert.equal(runHeadline(completed(qa("done", "confirmed", "a".repeat(40)))).next, "review_committed");
  const paused = (f) => view({ status: "paused", reason: "finish_unconfirmed", active: null, progress: progress([f]) });
  for (const v of ["mismatch", "not_reported", "invalid"]) assert.equal(runHeadline(paused(qa("unknown", v))).next, "finish_check", `${v}: resume only checks again`);
  for (const locale of ["ru", "en"]) {
    for (const k of ["qa_unverified", "qa_mismatch", "qa_not_reported", "qa_invalid"]) {
      assert.doesNotMatch(t(locale, `orchFinishStatus_${k}`).replace(/не подтвержд\S*|not confirmed/gi, ""), /подтвержд|confirm/i, `${locale} ${k} never claims a confirmed version`);
    }
    assert.match(t(locale, "orchFinishStatus_qa_confirmed"), /подтвержд|confirm/i);
    assert.doesNotMatch(t(locale, "orchNext_review_qa_unverified").replace(/не подтвержд\S*|not confirmed/gi, ""), /подтвержд|confirm/i);
  }
});

test("test database (review 2): every reason main sends for a URL or an unknown configuration has a line in both languages", () => {
  for (const locale of ["ru", "en"]) {
    for (const reason of ["url_overrides", "url_unparsed"]) {
      const s = t(locale, `orchReadyWhy_testdb_${reason}`);
      assert.ok(s && s.includes("{variable}") && s.includes('force="true"'), `${locale} ${reason}: names the variable and how to override it`);
    }
    const unknown = t(locale, "orchReadyWhy_testdb_config_unknown");
    assert.ok(unknown?.includes("config/database.php") && unknown.includes("{unknown}") && unknown.includes("{connection}") && unknown.includes('force="true"'), `${locale} config_unknown names the field, the connection and the fix`);
    assert.match(t(locale, "orchError_test_database_unsafe"), /DB_URL\/DATABASE_URL/);
  }
});
