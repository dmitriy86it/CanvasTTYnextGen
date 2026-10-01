// Electron UI smoke for stage A, A1 (docs/agent-orchestration/implementation/journal-v2-format.md): journal v2 behind
// the development flag CANVASTTY_JOURNAL_V2=1, on a temporary profile with fake Codex/Claude CLIs.
//   the goal dialog: the check commands field may be left empty (a hint says the lead proposes them), readiness does
//   not block;
//   the run panel: the lead's proposal ("no commands", with why) waits for «Принять» in the autopilot; after it the run
//   completes without checks — the link chip, both cards and the result say so, never "completed";
//   the journal: v 2, the first record with minReaderVersion 2 and formatPreview.
// Needs `npm run build` first. Starts no real model. Usage: node scripts/smoke-v2-checks-ui.mjs [--shots <dir>]
import fs from "node:fs";
import path from "node:path";
import { FIXTURES, NODE, launch as launchApp, openTab, q, runs, startGoal, workspace } from "./orchestration-app-kit.mjs";

const { D, project, script } = workspace("v2-ui-");
const shotsArg = process.argv.indexOf("--shots");
const SHOTS = shotsArg > 0 ? path.resolve(process.argv[shotsArg + 1]) : D("shots");
fs.mkdirSync(SHOTS, { recursive: true });
const PORT = 9800 + Math.floor(Math.random() * 150);
const failures = [];
const passed = [];
const expect = (ok, what, got) => { (ok ? passed : failures).push(ok ? what : `${what}: ${JSON.stringify(got)?.slice(0, 400)}`); };

const projectA = project("project-a");
const verdict = (v) => ({ report: { verdict: v, findings: [], question: null } });
const codexScript = script("codex", [{ report: { stages: [{ title: "Заметка", task: "Add src/note.mjs exporting a constant" }], question: null } }, verdict("accept"), verdict("complete")]);
const claudeScript = script("claude", [{ report: { summary: "note added", done: true }, writes: [["src/note.mjs", "export const note = 'a';\n"]] }]);
fs.mkdirSync(D("mock-state", ".codex"), { recursive: true });
const wrap = (p) => {
  const f = D(`${p}-mock`);
  fs.writeFileSync(f, `#!/bin/sh\nexec "${NODE}" "${path.join(FIXTURES, `mock-${p}.mjs`)}" "$@"\n`, { mode: 0o755 });
  return f;
};
const env = (extra) => ({ HOME: D("mock-state"), MOCK_STATE: D("mock-state"), ...extra });
const providers = D("providers.json");
fs.writeFileSync(providers, JSON.stringify({
  // the lead proposes no command (MOCK_CHECKS, tests/fixtures/orchestration/mock-common.mjs)
  codex: { executable: wrap("codex"), version: "codex-cli 0.155.1", path: `${path.dirname(NODE)}:/usr/bin:/bin`,
    env: env({ MOCK_SCRIPT: codexScript, CODEX_HOME: D("mock-state", ".codex"), MOCK_CHECKS: "none" }) },
  claude: { executable: wrap("claude"), version: "2.1.281 (Claude Code)", path: `${path.dirname(NODE)}:/usr/bin:/bin`,
    env: env({ MOCK_SCRIPT: claudeScript }) }
}));
const userData = D("user-data");
const root = path.join(userData, "orchestration");
const chip = (linkId) => q(`[data-agent-link-id="${linkId}"]`);
const NO_CHECKS = "Завершён без проверок";

let app;
try {
  app = await launchApp({ userData, providers, port: PORT, shots: SHOTS, env: { CANVASTTY_JOURNAL_V2: "1" } });
  const ids = await app.ev(`(async () => {
    const o = window.canvasTTY.orchestration;
    const mk = async (provider, x) => (await o.createAgent({ agentId: crypto.randomUUID(), provider, project: ${JSON.stringify(projectA)}, bounds: { position: { x, y: 80 }, size: { width: 300, height: 176 } }, workspaceId: "common" })).value.agentId;
    const lead = await mk("codex", 40), exec = await mk("claude", 420);
    const link = (await o.createLink({ linkId: crypto.randomUUID(), fromAgentId: lead, toAgentId: exec })).value.linkId;
    return { lead, exec, link };
  })()`);
  expect(!!ids.link, "a link created in main", ids);
  await app.ev("location.reload()");
  await app.waitFor(`${chip(ids.link)} && true`, "the link chip");

  let dialog = null;
  await startGoal(app, ids.link, {
    onDialog: async () => {
      await app.type(q("[data-orch-commands]"), "");
      dialog = await app.ev(`({ hint: !!${q("[data-orch-commands-optional]")}, value: ${q("[data-orch-commands]")}.value })`);
      await app.shot("v2-01-dialog-empty-commands");
    }
  });
  expect(dialog?.hint === true && dialog.value === "", "the dialog: the commands field left empty, with the hint", dialog);

  await app.waitFor(`${q("[data-orch-checks-proposal]")} && true`, "the lead's proposal in the panel", 60_000);
  const proposal = await app.ev(`(() => { const p = ${q("[data-orch-checks-proposal]")}; return {
    none: p.querySelector("[data-orch-checks-none]")?.textContent ?? null, buttons: [...p.querySelectorAll("button")].map((b) => b.textContent.trim()) }; })()`);
  expect(/Лид не нашёл команд проверки/.test(proposal.none ?? "") && proposal.buttons.includes("Принять") && proposal.buttons.includes("Изменить"),
    "the panel: «no commands» with why, «Принять» and «Изменить»", proposal);
  const waiting = (await runs(app))[0];
  expect(waiting?.status === "paused" && waiting.reason === "awaiting_checks_decision", "the autopilot waits for the decision (the network of native checks is open)", waiting);
  const actions = await app.ev(`[...document.querySelectorAll(".orch-panel__actions button")].map((b) => b.textContent.trim())`);
  expect(!actions.some((b) => /Продолжить|Шаг/.test(b)), "no Resume or Step on this pause", actions);
  const board = await app.ev(`${q('[data-board="action"]')}?.textContent ?? null`);
  expect(board === "нужно действие — см. ниже", "the board says the person has to act", board);
  await app.shot("v2-02-proposal");
  await app.clickEl(q("[data-orch-checks-accept]"));
  const runId = (await runs(app))[0].runId;
  await app.waitFor(`window.canvasTTY.orchestration.get(${JSON.stringify(runId)}).then((r) => r.value.view.status === "completed")`, "completed", 120_000);

  await app.waitFor(`${chip(ids.link)}?.querySelector(".agent-link__state")?.textContent === ${JSON.stringify(NO_CHECKS)}`, "the chip says completed without checks");
  const cards = await app.ev(`[${JSON.stringify(ids.lead)}, ${JSON.stringify(ids.exec)}].map((id) => document.querySelector('[data-agent-id="' + id + '"] .agent-card__state')?.textContent ?? null)`);
  expect(cards.every((c) => c === NO_CHECKS), "both cards say completed without checks", cards);
  await openTab(app, "summary");
  await app.waitFor(`${q("[data-sum-outcome]")} && true`, "the result");
  // what says how the run ended: the headline, the result and the checks of the summary, the chip and the cards
  const result = await app.ev(`({ outcome: ${q("[data-sum-outcome]")}.dataset.sumOutcome, noChecks: ${q("[data-sum-no-checks]")}?.textContent ?? null,
    text: [".orch-summary__headline", '[data-sum="outcome"]', '[data-sum="checks"]', "[data-board]", ".agent-link__state", ".agent-card__state"]
      .flatMap((s) => [...document.querySelectorAll(s)].map((el) => el.textContent)).join(" | ") })`);
  expect(result.outcome === "completed_no_checks" && result.noChecks === "Команды проверки не запускались", "the result: without checks, «Команды проверки не запускались»", result);
  // «ничем не подтверждён» is the warning itself; «Завершён в <time>» is when it ended
  expect(!/(?<!не )подтвержд/i.test(result.text) && !/Завершён(?! без проверок| в )/.test(result.text), "nowhere «Подтверждено» or plain «Завершён»", result.text.slice(0, 600));
  await app.shot("v2-03-completed-without-checks");

  const lines = fs.readFileSync(path.join(root, "runs", runId, "journal.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  expect(lines.every((l) => l.v === 2) && lines[0].minReaderVersion === 2 && lines[0].formatPreview === true, "the journal: v 2, minReaderVersion 2 and formatPreview in its first record", lines[0]);
  const last = lines.at(-1);
  expect(last.type === "run.status" && last.data.status === "completed" && last.data.completion?.kind === "no_checks", "the journal: completed, no_checks", last);
  await app.stop();
  app = null;
} catch (error) {
  failures.push(`exception: ${error?.stack ?? error}`);
} finally {
  if (app) await app.stop().catch(() => {});
}
console.log(JSON.stringify({ passed: passed.length, failures, shots: SHOTS }, null, 2));
process.exit(failures.length ? 1 : 0);
