// Electron UI smoke for stage A, A1 and A1.1 (docs/agent-orchestration/implementation/journal-v2-format.md): journal v2
// behind the development flag CANVASTTY_JOURNAL_V2=1, on temporary profiles with fake Codex/Claude CLIs.
//   none:    the goal dialog leaves the check commands empty (a hint says the lead proposes them), readiness does not
//            block; the lead proposes none and the autopilot goes on by itself (A1.1 Q1) — the run completes without
//            checks: the link chip, both cards and the result say so, never "completed"; the journal is v 2 with
//            minReaderVersion 2 and formatPreview in its first record;
//   refused: the lead proposes a command that writes outside the work folder; the autopilot accepts it (it runs in the
//            check profile, A1.1 Q2) and the sandbox refuses it — the panel says «Проверке нужно больше прав» with
//            «Запустить без песочницы» and «Изменить команду», no Resume; the autopilot waits; «Запустить без
//            песочницы» runs it in the person's shell and the run completes, confirmed.
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

const verdict = (v) => ({ report: { verdict: v, findings: [], question: null } });
const wrap = (p) => {
  const f = D(`${p}-mock`);
  if (!fs.existsSync(f)) fs.writeFileSync(f, `#!/bin/sh\nexec "${NODE}" "${path.join(FIXTURES, `mock-${p}.mjs`)}" "$@"\n`, { mode: 0o755 });
  return f;
};
const chip = (linkId) => q(`[data-agent-link-id="${linkId}"]`);
const NO_CHECKS = "Завершён без проверок";

// One scenario: its own user data, project, scripts and fake CLIs (MOCK_CHECKS, tests/fixtures/orchestration/mock-common.mjs).
async function scenario(name, port, checks, body) {
  const dir = D(name);
  fs.mkdirSync(path.join(dir, "mock-state", ".codex"), { recursive: true });
  const projectA = project(`${name}-project`);
  const codexScript = script(`${name}-codex`, [{ report: { stages: [{ title: "Заметка", task: "Add src/note.mjs exporting a constant" }], question: null } }, verdict("accept"), verdict("complete")]);
  const claudeScript = script(`${name}-claude`, [{ report: { summary: "note added", done: true }, writes: [["src/note.mjs", "export const note = 'a';\n"]] }]);
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
  await scenario("none", 9800 + Math.floor(Math.random() * 100), { MOCK_CHECKS: "none" }, async (app, ids, root) => {
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
    const lines = fs.readFileSync(path.join(root, "runs", runId, "journal.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.every((l) => l.v === 2) && lines[0].minReaderVersion === 2 && lines[0].formatPreview === true, "none: the journal is v 2, minReaderVersion 2 and formatPreview in its first record", lines[0]);
    expect(!lines.some((l) => l.type === "run.status" && l.data.reason === "awaiting_checks_decision"), "none: the autopilot did not wait (A1.1 Q1)", null);
    const last = lines.at(-1);
    expect(last.type === "run.status" && last.data.status === "completed" && last.data.completion?.kind === "no_checks", "none: the journal says completed, no_checks", last);
  });

  // =============== refused: a lead's check the sandbox refuses ===============
  const outside = D("outside-marker");
  await scenario("refused", 9900 + Math.floor(Math.random() * 90), { MOCK_CHECKS: "proposed", MOCK_CHECK_COMMAND: `test -f src/note.mjs && touch ${outside}` }, async (app, ids) => {
    await startGoal(app, ids.link, { onDialog: () => app.type(q("[data-orch-commands]"), "") });
    await app.waitFor(`${q("[data-orch-check-refused]")} && true`, "«Проверке нужно больше прав»", 120_000);
    const panel = await app.ev(`(() => { const p = ${q("[data-orch-check-refused]")}; return { id: p.dataset.orchCheckRefused, title: p.querySelector("h4").textContent,
      buttons: [...p.querySelectorAll("button")].map((b) => b.textContent.trim()), actions: [...document.querySelectorAll(".orch-panel__actions button")].map((b) => b.textContent.trim()),
      headline: document.querySelector(".orch-summary__headline")?.textContent ?? "" }; })()`);
    expect(panel.id === "cmd-1" && panel.title === "Проверке нужно больше прав" && panel.buttons.includes("Запустить без песочницы") && panel.buttons.includes("Изменить команду"),
      "refused: the panel offers «Запустить без песочницы» and «Изменить команду»", panel);
    expect(!panel.actions.some((b) => /Продолжить|Шаг/.test(b)) && /больше прав/.test(panel.headline), "refused: no Resume or Step, the headline says so", panel);
    expect(!fs.existsSync(outside), "refused: nothing was written outside the work folder", null);
    const runId = (await runs(app))[0].runId;
    await new Promise((r) => setTimeout(r, 1000));
    const still = await app.ev(`window.canvasTTY.orchestration.get(${JSON.stringify(runId)}).then((r) => r.value.view.reason)`);
    expect(still === "check_needs_permissions", "refused: the autopilot waits for the person", still);
    await app.shot("v2-03-check-needs-permissions");
    await app.clickEl(q("[data-orch-check-unsandbox]"));
    await app.waitFor(`window.canvasTTY.orchestration.get(${JSON.stringify(runId)}).then((r) => r.value.view.status === "completed")`, "completed", 120_000);
    const done = await app.ev(`window.canvasTTY.orchestration.get(${JSON.stringify(runId)}).then((r) => r.value.view.progress.completion)`);
    expect(done === "confirmed" && fs.existsSync(outside), "refused: run without the sandbox, the check passed and the run completed, confirmed", done);
    await app.shot("v2-04-completed-after-unsandbox");
  });
} catch (error) {
  failures.push(`exception: ${error?.stack ?? error}`);
}
console.log(JSON.stringify({ passed: passed.length, failures, shots: SHOTS }, null, 2));
process.exit(failures.length ? 1 : 0);
