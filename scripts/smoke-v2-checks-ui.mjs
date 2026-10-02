// Electron UI smoke for stage A, A1, A1.1 and A2 (docs/agent-orchestration/implementation/journal-v2-format.md): journal v2
// behind the development flag CANVASTTY_JOURNAL_V2=1, on temporary profiles with fake Codex/Claude CLIs.
//   none:    the goal dialog leaves the check commands empty (a hint says the lead proposes them), readiness does not
//            block; the lead proposes none and the autopilot goes on by itself (A1.1 Q1) — the run completes without
//            checks: the link chip, both cards and the result say so, never "completed"; the journal is v 2 with
//            minReaderVersion 2 and formatPreview in its first record;
//   refused: the lead proposes a command that writes outside the work folder; the autopilot accepts it (it runs in the
//            check profile, A1.1 Q2) and the sandbox refuses it — the panel says «Проверке нужно больше прав» with
//            «Изменить команду» only (no «Запустить без песочницы» for a lead's command, owner's decision on S1-4), no
//            Resume; the autopilot waits; the editor holds the whole command and says it will run as the person's;
//            saved unchanged, it runs in the person's shell and the run completes, confirmed.
//   A2:      both plans state readiness conditions over the goal's criteria R1, R2 — the cards say «N из M условий
//            выполнено», the result's «Условия» lists each requirement with its conditions, their status and evidence
//            (the reviewer's marks with the files, or the check run with its output).
//   A3:      the reviewer (Codex, a new session per review) opens a blocking finding and a wish; the executor fixes; a
//            repeated review closes the blocking one on the changed tree — the cards and the result say «Открыто
//            блокирующих: 0», the result's «Замечания» lists F1 closed with its history and F2 an open wish, the
//            participants list the reviewer.
// Needs `npm run build` first; macOS (Seatbelt). Starts no real model. Usage: node scripts/smoke-v2-checks-ui.mjs [--shots <dir>]
import fs from "node:fs";
import path from "node:path";
import { FIXTURES, NODE, launch as launchApp, openTab, q, runs, startGoal, workspace } from "./orchestration-app-kit.mjs";

const { D, project, script } = workspace("v2-ui-");
const shotsArg = process.argv.indexOf("--shots");
const SHOTS = shotsArg > 0 ? path.resolve(process.argv[shotsArg + 1]) : D("shots");
fs.mkdirSync(SHOTS, { recursive: true });
const failures = [];
const passed = [];
const expect = (ok, what, got) => { (ok ? passed : failures).push(ok ? what : `${what}: ${JSON.stringify(got)?.slice(0, 400)}`); };

// A2 (journal-v2-format.md §2.7): the goal's two criteria are R1, R2; the plan's conditions cover them, the review marks
// the "change" ones met on src/note.mjs, the final review marks both requirements met
const change = (text, covers) => ({ keep: null, text, covers, evidence: { kind: "change", check: null } });
const byCheck = (text, covers, check) => ({ keep: null, text, covers, evidence: { kind: "check", check } });
const plan = (conditions) => ({ report: { stages: [{ title: "Заметка", task: "Add src/note.mjs exporting a constant", conditions }], dropped: [], dropRequirements: [], question: null } });
// A3: the reviewer answers the reviews (journal-v2-format.md §2.8)
const review = (ids, findings = []) => ({ report: { conditions: ids.map((id) => ({ id, status: "met", paths: ["src/note.mjs"], note: "src/note.mjs exports note" })), findings, request: "none", question: null } });
const final = { report: { conditions: [], findings: [], request: "none", question: null, requirements: ["R1", "R2"].map((id) => ({ id, status: "met", note: "done" })) } };
const finding = (over) => ({ id: null, severity: "blocking", condition: null, problem: "note is not documented", evidence: "src/note.mjs has no comment", closeWhen: "the note is explained",
  status: "open", paths: ["src/note.mjs"], relation: null, ...over });
const wrap = (p) => {
  const f = D(`${p}-mock`);
  if (!fs.existsSync(f)) fs.writeFileSync(f, `#!/bin/sh\nexec "${NODE}" "${path.join(FIXTURES, `mock-${p}.mjs`)}" "$@"\n`, { mode: 0o755 });
  return f;
};
const chip = (linkId) => q(`[data-agent-link-id="${linkId}"]`);
const NO_CHECKS = "Завершён без проверок";

// One scenario: its own user data, project, scripts and fake CLIs (MOCK_CHECKS, tests/fixtures/orchestration/mock-common.mjs).
async function scenario(name, port, checks, conditions, body, scripts = null) {
  const dir = D(name);
  fs.mkdirSync(path.join(dir, "mock-state", ".codex"), { recursive: true });
  const projectA = project(`${name}-project`);
  const changes = conditions.map((c, i) => (c.evidence.kind === "change" ? `C${i + 1}` : null)).filter(Boolean);
  const codexScript = script(`${name}-codex`, scripts?.codex ?? [plan(conditions), review(changes), final]);
  const claudeScript = script(`${name}-claude`, scripts?.claude ?? [{ report: { summary: "note added", done: true }, writes: [["src/note.mjs", "export const note = 'a';\n"]] }]);
  const env = (extra) => ({ HOME: path.join(dir, "mock-state"), MOCK_STATE: path.join(dir, "mock-state"), ...extra });
  const providers = path.join(dir, "providers.json");
  fs.writeFileSync(providers, JSON.stringify({
    codex: { executable: wrap("codex"), version: "codex-cli 0.155.1", path: `${path.dirname(NODE)}:/usr/bin:/bin`,
      env: env({ MOCK_SCRIPT: codexScript, CODEX_HOME: path.join(dir, "mock-state", ".codex"), ...checks }) },
    claude: { executable: wrap("claude"), version: "2.1.281 (Claude Code)", path: `${path.dirname(NODE)}:/usr/bin:/bin`,
      env: env({ MOCK_SCRIPT: claudeScript }) }
  }));
  const userData = path.join(dir, "user-data");
  const app = await launchApp({ userData, providers, port, shots: SHOTS, env: { CANVASTTY_JOURNAL_V2: "1" } });
  try {
    const ids = await app.ev(`(async () => {
      const o = window.canvasTTY.orchestration;
      const mk = async (provider, x) => (await o.createAgent({ agentId: crypto.randomUUID(), provider, project: ${JSON.stringify(projectA)}, bounds: { position: { x, y: 80 }, size: { width: 300, height: 176 } }, workspaceId: "common" })).value.agentId;
      const lead = await mk("codex", 40), exec = await mk("claude", 420);
      const link = (await o.createLink({ linkId: crypto.randomUUID(), fromAgentId: lead, toAgentId: exec })).value.linkId;
      return { lead, exec, link };
    })()`);
    expect(!!ids.link, `${name}: a link created in main`, ids);
    await app.ev("location.reload()");
    await app.waitFor(`${chip(ids.link)} && true`, "the link chip");
    await body(app, ids, path.join(userData, "orchestration"));
  } finally {
    await app.stop().catch(() => {});
  }
}

try {
  // =============== none: the autopilot goes on without checks ===============
  await scenario("none", 9800 + Math.floor(Math.random() * 100), { MOCK_CHECKS: "none" }, [change("src/note.mjs exists", ["R1", "R2"])], async (app, ids, root) => {
    let dialog = null;
    await startGoal(app, ids.link, {
      onDialog: async () => {
        await app.type(q("[data-orch-commands]"), "");
        dialog = await app.ev(`({ hint: !!${q("[data-orch-commands-optional]")}, value: ${q("[data-orch-commands]")}.value })`);
        await app.shot("v2-01-dialog-empty-commands");
      }
    });
    expect(dialog?.hint === true && dialog.value === "", "none: the commands field left empty, with the hint", dialog);
    const runId = (await runs(app))[0].runId;
    await app.waitFor(`window.canvasTTY.orchestration.get(${JSON.stringify(runId)}).then((r) => r.value.view.status === "completed")`, "completed", 120_000);
    await app.waitFor(`${chip(ids.link)}?.querySelector(".agent-link__state")?.textContent === ${JSON.stringify(NO_CHECKS)}`, "the chip says completed without checks");
    const cards = await app.ev(`[${JSON.stringify(ids.lead)}, ${JSON.stringify(ids.exec)}].map((id) => document.querySelector('[data-agent-id="' + id + '"] .agent-card__state')?.textContent ?? null)`);
    expect(cards.every((c) => c === NO_CHECKS), "none: both cards say completed without checks", cards);
    const cardConds = await app.ev(`[...document.querySelectorAll("[data-agent-conditions]")].map((e) => e.textContent)`);
    expect(cardConds.length === 2 && cardConds.every((c) => c === "1 из 1 условий выполнено"), "none (A2): both cards say 1 of 1 conditions met", cardConds);
    await app.clickEl(`[...document.querySelectorAll('[data-agent-link-id="${ids.link}"] button')].find((b) => b.textContent.trim() === "Открыть запуск")`);
    await app.waitFor(`${q(".orch-panel")} && true`, "the run panel");
    await openTab(app, "summary");
    await app.waitFor(`${q("[data-sum-outcome]")} && true`, "the result");
    // what says how the run ended: the headline, the result and the checks of the summary, the chip and the cards
    const result = await app.ev(`({ outcome: ${q("[data-sum-outcome]")}.dataset.sumOutcome, noChecks: ${q("[data-sum-no-checks]")}?.textContent ?? null,
      text: [".orch-summary__headline", '[data-sum="outcome"]', '[data-sum="checks"]', "[data-board]", ".agent-link__state", ".agent-card__state"]
        .flatMap((s) => [...document.querySelectorAll(s)].map((el) => el.textContent)).join(" | ") })`);
    expect(result.outcome === "completed_no_checks" && result.noChecks === "Команды проверки не запускались", "none: the result says without checks", result);
    // «ничем не подтверждён» is the warning itself; «Завершён в <time>» is when it ended
    expect(!/(?<!не )подтвержд/i.test(result.text) && !/Завершён(?! без проверок| в )/.test(result.text), "none: nowhere «Подтверждено» or plain «Завершён»", result.text.slice(0, 600));
    await app.shot("v2-02-completed-without-checks");
    const conds = await app.ev(`({ count: ${q("[data-sum-conditions-count]")}?.textContent ?? null,
      reqs: [...document.querySelectorAll("[data-requirement]")].map((e) => e.dataset.requirement + ":" + e.dataset.requirementStatus),
      conds: [...document.querySelectorAll('[data-requirement="R1"] [data-condition]')].map((e) => e.dataset.condition + ":" + e.dataset.conditionStatus),
      proof: ${q('[data-condition-proof="review"]')}?.textContent ?? null })`);
    expect(conds.count === "1 из 1 условий выполнено" && conds.reqs.join() === "R1:met,R2:met" && conds.conds.join() === "C1:met" && /src\/note\.mjs/.test(conds.proof ?? ""),
      "none (A2): «Условия» — R1, R2 met by C1, its evidence the lead's review on src/note.mjs", conds);
    await app.ev(`${q('[data-sum="conditions"]')}?.scrollIntoView()`);
    await app.shot("v2-02b-conditions");
    const lines = fs.readFileSync(path.join(root, "runs", runId, "journal.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.every((l) => l.v === 2) && lines[0].minReaderVersion === 2 && lines[0].formatPreview === true, "none: the journal is v 2, minReaderVersion 2 and formatPreview in its first record", lines[0]);
    expect(!lines.some((l) => l.type === "run.status" && l.data.reason === "awaiting_checks_decision"), "none: the autopilot did not wait (A1.1 Q1)", null);
    const last = lines.at(-1);
    expect(last.type === "run.status" && last.data.status === "completed" && last.data.completion?.kind === "no_checks", "none: the journal says completed, no_checks", last);
  });

  // =============== refused: a lead's check the sandbox refuses ===============
  const outside = D("outside-marker");
  await scenario("refused", 9900 + Math.floor(Math.random() * 90), { MOCK_CHECKS: "proposed", MOCK_CHECK_COMMAND: `test -f src/note.mjs && touch ${outside}` },
    [change("src/note.mjs exists", ["R1"]), byCheck("the proposed check passes", ["R2"], "cmd-1")], async (app, ids) => {
    await startGoal(app, ids.link, { onDialog: () => app.type(q("[data-orch-commands]"), "") });
    await app.waitFor(`${q("[data-orch-check-refused]")} && true`, "«Проверке нужно больше прав»", 120_000);
    const panel = await app.ev(`(() => { const p = ${q("[data-orch-check-refused]")}; return { id: p.dataset.orchCheckRefused, title: p.querySelector("h4").textContent,
      buttons: [...p.querySelectorAll("button")].map((b) => b.textContent.trim()), actions: [...document.querySelectorAll(".orch-panel__actions button")].map((b) => b.textContent.trim()),
      headline: document.querySelector(".orch-summary__headline")?.textContent ?? "" }; })()`);
    expect(panel.id === "cmd-1" && panel.title === "Проверке нужно больше прав" && panel.buttons.join("|") === "Изменить команду",
      "refused: the panel offers «Изменить команду» only — no «Запустить без песочницы»", panel);
    expect(!panel.actions.some((b) => /Продолжить|Шаг/.test(b)) && /больше прав/.test(panel.headline), "refused: no Resume or Step, the headline says so", panel);
    expect(!fs.existsSync(outside), "refused: nothing was written outside the work folder", null);
    const runId = (await runs(app))[0].runId;
    await new Promise((r) => setTimeout(r, 1000));
    const still = await app.ev(`window.canvasTTY.orchestration.get(${JSON.stringify(runId)}).then((r) => r.value.view.reason)`);
    expect(still === "check_needs_permissions", "refused: the autopilot waits for the person", still);
    await app.shot("v2-03-check-needs-permissions");
    await app.clickEl(q("[data-orch-check-edit-open]"));
    await app.waitFor(`${q("[data-orch-check-refused-line]")} && true`, "the editor");
    const editor = await app.ev(`(() => { const e = ${q("[data-orch-check-refused-line]")}; return { value: e.value, hint: e.parentElement.querySelector("small").textContent }; })()`);
    expect(editor.value === `test -f src/note.mjs && touch ${outside}` && editor.hint === "Команду предложил лид. После сохранения она будет выполняться как ваша — без песочницы.",
      "refused: the editor holds the whole command and says it runs as the person's", editor);
    await app.shot("v2-04-edit-lead-command");
    await app.clickEl(q("[data-orch-check-edit-save]"));
    await app.waitFor(`window.canvasTTY.orchestration.get(${JSON.stringify(runId)}).then((r) => r.value.view.status === "completed")`, "completed", 120_000);
    const done = await app.ev(`window.canvasTTY.orchestration.get(${JSON.stringify(runId)}).then((r) => r.value.view.progress.completion)`);
    expect(done === "confirmed" && fs.existsSync(outside), "refused: saved unchanged — run as the person's, without the sandbox; the run completed, confirmed", done);
    await openTab(app, "summary");
    await app.waitFor(`${q("[data-sum-conditions-count]")} && true`, "«Условия»");
    const conds = await app.ev(`({ count: ${q("[data-sum-conditions-count]")}.textContent,
      c2: (() => { const e = ${q('[data-condition="C2"]')}; return e ? { status: e.dataset.conditionStatus, proof: !!e.querySelector('[data-condition-proof="run"]'), text: e.textContent } : null; })() })`);
    expect(conds.count === "2 из 2 условий выполнено" && conds.c2?.status === "met" && conds.c2.proof && conds.c2.text.includes("test -f src/note.mjs"),
      "refused (A2): 2 of 2 conditions met; C2's evidence is the check run of the command as saved", conds);
    await app.ev(`${q('[data-condition-proof="run"]')}.open = true; ${q('[data-sum="conditions"]')}.scrollIntoView()`);
    await app.shot("v2-06-conditions-check-evidence");
    await app.shot("v2-05-completed-as-person-command");
  });

  // =============== A3: findings of the reviewer ===============
  const C = [change("src/note.mjs exists", ["R1", "R2"])];
  await scenario("findings", 9700 + Math.floor(Math.random() * 90), { MOCK_CHECKS: "none" }, C, async (app, ids) => {
    await startGoal(app, ids.link, { onDialog: () => app.type(q("[data-orch-commands]"), "") });
    const runId = (await runs(app))[0].runId;
    await app.waitFor(`window.canvasTTY.orchestration.get(${JSON.stringify(runId)}).then((r) => r.value.view.status === "completed")`, "completed", 120_000);
    const cardLines = await app.ev(`[...document.querySelectorAll("[data-agent-findings]")].map((e) => e.textContent)`);
    expect(cardLines.length === 2 && cardLines.every((c) => c === "Открыто блокирующих: 0"), "findings (A3): both cards say «Открыто блокирующих: 0»", cardLines);
    await app.clickEl(`[...document.querySelectorAll('[data-agent-link-id="${ids.link}"] button')].find((b) => b.textContent.trim() === "Открыть запуск")`);
    await app.waitFor(`${q(".orch-panel")} && true`, "the run panel");
    await openTab(app, "summary");
    await app.waitFor(`${q("[data-sum-findings-open]")} && true`, "«Замечания»");
    const f = await app.ev(`({ line: ${q("[data-sum-findings-open]")}.textContent,
      items: [...document.querySelectorAll("[data-finding]")].map((e) => [e.dataset.finding, e.dataset.findingSeverity, e.dataset.findingStatus].join(":")),
      history: [...document.querySelectorAll('[data-finding="F1"] [data-finding-event]')].map((e) => e.dataset.findingEvent + ":" + (e.dataset.findingTree.length === 40)) })`);
    expect(f.line === "Открыто блокирующих: 0" && f.items.join() === "F1:blocking:closed,F2:wish:open" && f.history.join() === "opened:true,closed:true",
      "findings (A3): «Замечания» — F1 closed with its history (opened, closed, each on its tree), F2 an open wish", f);
    const words = await app.ev(`({ stages: ${q("[data-sum-stage-count]")}?.textContent ?? null, text: ${q(".orch-summary-view")}.textContent })`);
    expect(words.stages === "1 из 1 приняты" && words.text.includes("Заключение проверяющего") && !/лидом|Заключение лида/.test(words.text),
      "findings (A3): the result names the reviewer, not the lead, as the one who reviews", words.stages);
    await app.ev(`document.querySelectorAll("[data-finding-history]").forEach((d) => { d.open = true; }); ${q('[data-sum="findings"]')}?.scrollIntoView()`);
    await app.shot("v2-07-findings");
    await openTab(app, "overview");
    const people = await app.ev(`[...document.querySelectorAll("[data-participant]")].map((e) => e.dataset.participant + ":" + e.querySelector("strong").textContent)`);
    expect(people.join() === "lead:Codex · Лид,executor:Claude · Исполнитель,reviewer:Codex · Проверяющий", "findings (A3): the reviewer is its own participant", people);
  }, {
    codex: [plan(C), review(["C1"], [finding(), finding({ severity: "wish", paths: [], problem: "name the constant better" })]),
      review(["C1"], [finding({ id: "F1", status: "closed", paths: ["src/note.md"] }), finding({ id: "F2", severity: "wish", paths: [], problem: "name the constant better" })]), final],
    claude: [{ report: { summary: "note added", done: true }, writes: [["src/note.mjs", "export const note = 'a';\n"]] },
      { report: { summary: "documented", done: true }, writes: [["src/note.md", "The note.\n"]] }]
  });
} catch (error) {
  failures.push(`exception: ${error?.stack ?? error}`);
}
console.log(JSON.stringify({ passed: passed.length, failures, shots: SHOTS }, null, 2));
process.exit(failures.length ? 1 : 0);
