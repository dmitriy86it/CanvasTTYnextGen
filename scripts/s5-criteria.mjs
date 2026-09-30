// S5 of the real series (scripts/real-autopilot-series.mjs): Claude starts in plan mode from the project's settings,
// the first plan is sent back with a remark, the second (mentioning the remark) is approved, and nothing in src/ or
// tests/ changes before an answer. Pure checks over the facts the driver collected; each criterion is its own row.

// A plan prompt of the app: only can_use_tool ExitPlanMode of the Claude executor becomes kind "plan".
export function isExecutorPlanPrompt(p) {
  return p?.kind === "plan" && p.tool === "ExitPlanMode" && p.provider === "claude" && p.role === "executor";
}

// `git status --porcelain --untracked-files=all` split into the task's files (src/, tests/) and the rest (service
// files); a rename counts both sides.
export function splitChanges(porcelain) {
  const implementation = [], other = [];
  for (const line of String(porcelain ?? "").split("\n")) {
    if (line.length < 4) continue;
    for (const f of line.slice(3).split(" -> ")) {
      const file = f.replace(/^"(.*)"$/, "$1");
      (/^(?:src|tests)\//.test(file) ? implementation : other).push(file);
    }
  }
  return { implementation, other };
}

// The feedback test asserts clamp(5, 5, 5) === 5; a mention in a comment does not count.
const CLAMP = String.raw`clamp\(\s*5\s*,\s*5\s*,\s*5\s*\)`;
export function feedbackTestProves(text) {
  const code = String(text ?? "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  return new RegExp(String.raw`assert\.(?:equal|strictEqual|deepEqual|deepStrictEqual)\(\s*${CLAMP}\s*,\s*5\s*[,)]`).test(code)
    || new RegExp(String.raw`assert\.ok\(\s*${CLAMP}\s*===\s*5\s*[,)]`).test(code);
}

export function s5Verdict(f) {
  const rows = [];
  const row = (ok, what, got) => rows.push({ ok: Boolean(ok), what, got });
  const first = (f.sessions ?? []).find((s) => s.provider === "claude");
  row(first?.permissionMode === "plan", "the first Claude session reported permissionMode plan", first?.permissionMode ?? null);
  const argv = f.claudeArgv ?? [];
  row(argv.length > 0 && argv.every((a) => a === "(no permission flag)"), "Claude started with no permission flag", argv);
  // other roles' or providers' plans and a repeated requestId are not counted
  const seen = new Set();
  const plans = (f.plans ?? []).filter((p) => isExecutorPlanPrompt(p) && !seen.has(p.requestId) && seen.add(p.requestId));
  row(plans.length === 2, "two executor plan prompts (ExitPlanMode, distinct requestId) were counted", plans.map((p) => p.requestId));
  const [a, b] = plans;
  row(a?.shownInPanel && a.answer === "deny" && a.feedback === f.feedbackText, "the first plan was shown in the panel and sent back with the remark",
    a ? { shownInPanel: a.shownInPanel, answer: a.answer, feedback: a.feedback } : null);
  const mentions = new RegExp(`clamp-feedback|${CLAMP}`).test(b?.text ?? "");
  row(b && mentions && b.text !== a.text && b.answer === "allow_once", "the second plan mentions the remark, differs from the first and was approved",
    b ? { requestId: b.requestId, mentions, differs: b.text !== a.text, answer: b.answer } : null);
  row(plans.length > 0 && plans.every((p) => !p.changesBefore?.implementation?.length), "nothing in src/ or tests/ changed before a plan was answered",
    plans.map((p) => ({ requestId: p.requestId, implementation: p.changesBefore?.implementation ?? [], other: p.changesBefore?.other ?? [] })));
  row(f.finalChecksPassed === true, "the final checks passed", f.finalChecksPassed);
  row(f.acceptUnchanged === true, "the acceptance test is unchanged", f.acceptUnchanged);
  row(typeof f.feedbackFile === "string" && feedbackTestProves(f.feedbackFile), "tests/clamp-feedback.test.mjs exists and asserts clamp(5, 5, 5) === 5",
    f.feedbackFile === null || f.feedbackFile === undefined ? "missing" : "present");
  return rows;
}
