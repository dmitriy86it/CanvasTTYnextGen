// S5 criteria of the real series (scripts/s5-criteria.mjs): plan mode, a plan sent back with a remark, the second
// plan approved, no task files changed before an answer.
import assert from "node:assert/strict";
import { test } from "node:test";
import { feedbackTestProves, isExecutorPlanPrompt, s5Verdict, splitChanges } from "../scripts/s5-criteria.mjs";

const FEEDBACK = "Also add tests/clamp-feedback.test.mjs that checks clamp(5, 5, 5) === 5. Then present the plan again.";
const clean = { implementation: [], other: [] };
const plan = (requestId, text, extra = {}) => ({ requestId, provider: "claude", role: "executor", tool: "ExitPlanMode", kind: "plan", text, answer: null,
  feedback: null, shownInPanel: true, changesBefore: clean, ...extra });
const FIRST = plan("p1", "1. Add clamp to src/clamp.mjs\n2. Run npm test", { answer: "deny", feedback: FEEDBACK });
const SECOND = plan("p2", "1. Add clamp\n2. Add tests/clamp-feedback.test.mjs checking clamp(5, 5, 5)\n3. Run npm test", { answer: "allow_once" });
const FILE = "import assert from \"node:assert/strict\";\nimport { clamp } from \"../src/clamp.mjs\";\nassert.equal(clamp(5, 5, 5), 5);\n";
const facts = (extra = {}) => ({ sessions: [{ provider: "claude", permissionMode: "plan" }], claudeArgv: ["(no permission flag)"], plans: [FIRST, SECOND],
  feedbackText: FEEDBACK, finalChecksPassed: true, acceptUnchanged: true, feedbackFile: FILE, ...extra });
const failed = (f) => s5Verdict(f).filter((r) => !r.ok).map((r) => r.what);

test("full success", () => {
  const rows = s5Verdict(facts());
  assert.equal(rows.length, 9);
  assert.deepEqual(rows.filter((r) => !r.ok), []);
});

test("only the Claude executor's ExitPlanMode prompts with a new requestId are counted", () => {
  assert.equal(isExecutorPlanPrompt(FIRST), true);
  for (const p of [{ ...FIRST, provider: "codex" }, { ...FIRST, role: "lead" }, { ...FIRST, kind: "tool" }, { ...FIRST, tool: "Bash" }, null]) assert.equal(isExecutorPlanPrompt(p), false);
  assert.ok(failed(facts({ plans: [FIRST, { ...SECOND, provider: "codex" }] })).some((w) => /two executor plan/.test(w)));
  assert.ok(failed(facts({ plans: [FIRST, { ...SECOND, role: "lead" }] })).some((w) => /second plan/.test(w)));
  // a foreign plan in between is ignored
  assert.deepEqual(failed(facts({ plans: [FIRST, { ...SECOND, requestId: "x", role: "lead", answer: "deny" }, SECOND] })), []);
  // a repeated requestId is not a second plan
  const f = failed(facts({ plans: [FIRST, { ...SECOND, requestId: "p1" }] }));
  assert.ok(f.some((w) => /two executor plan/.test(w)) && f.some((w) => /second plan/.test(w)));
  // "ExitPlanMode" in a message is not a plan prompt
  assert.equal(failed(facts({ plans: [{ ...FIRST, kind: "message", tool: null, text: "calling ExitPlanMode" }] })).length, 4);
});

test("the remark, the order of answers and the session facts", () => {
  assert.ok(failed(facts({ plans: [FIRST, { ...SECOND, text: "1. Add clamp\n2. Run npm test" }] })).some((w) => /second plan/.test(w)));
  assert.ok(failed(facts({ plans: [FIRST, { ...SECOND, text: FIRST.text }] })).some((w) => /second plan/.test(w)));
  assert.ok(failed(facts({ plans: [{ ...FIRST, feedback: "other" }, SECOND] })).some((w) => /first plan/.test(w)));
  assert.ok(failed(facts({ plans: [{ ...FIRST, shownInPanel: false }, SECOND] })).some((w) => /first plan/.test(w)));
  assert.ok(failed(facts({ plans: [FIRST, { ...SECOND, answer: "deny" }] })).some((w) => /second plan/.test(w)));
  assert.deepEqual(failed(facts({ sessions: [{ provider: "claude", permissionMode: "default" }], claudeArgv: ["--permission-mode plan"], finalChecksPassed: false,
    acceptUnchanged: false, feedbackFile: null })).length, 5);
});

test("src/ or tests/ changed before an answer fails; service files only are fine", () => {
  const src = splitChanges(" M src/clamp.mjs\n?? .claude/settings.local.json\n");
  assert.deepEqual(src, { implementation: ["src/clamp.mjs"], other: [".claude/settings.local.json"] });
  assert.deepEqual(failed(facts({ plans: [FIRST, { ...SECOND, changesBefore: src }] })), ["nothing in src/ or tests/ changed before a plan was answered"]);
  const service = splitChanges("?? .claude/settings.local.json\n M package-lock.json\n");
  const rows = s5Verdict(facts({ plans: [{ ...FIRST, changesBefore: service }, SECOND] }));
  assert.ok(rows.every((r) => r.ok));
  assert.deepEqual(rows[5].got[0].other, [".claude/settings.local.json", "package-lock.json"]);
  assert.deepEqual(splitChanges("R  src/a.mjs -> lib/a.mjs\nA  \"tests/a b.mjs\"\n"), { implementation: ["src/a.mjs", "tests/a b.mjs"], other: ["lib/a.mjs"] });
});

test("the feedback test must assert clamp(5, 5, 5) === 5 in code", () => {
  for (const t of [FILE, "assert.strictEqual( clamp(5,5,5) , 5 );", "assert.deepEqual(clamp(5, 5, 5), 5, \"same\")", "assert.ok(clamp(5, 5, 5) === 5)"]) assert.equal(feedbackTestProves(t), true, t);
  for (const t of ["// assert.equal(clamp(5, 5, 5), 5);", "/* assert.equal(clamp(5, 5, 5), 5); */", "clamp(5, 5, 5) === 5", "assert.equal(clamp(5, 5, 5), 6);",
    "assert.equal(clamp(5, 5, 4), 5);", "", null]) assert.equal(feedbackTestProves(t), false, t);
  assert.ok(failed(facts({ feedbackFile: "// assert.equal(clamp(5, 5, 5), 5);\n" })).some((w) => /clamp-feedback/.test(w)));
});
