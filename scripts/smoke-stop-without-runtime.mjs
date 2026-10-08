// Electron smoke: a run paused by closing the application stays stoppable after a restart with CLIs of a version the
// application does not run, and its cards can then be deleted the usual way (tests/orchestration-stop-without-runtime).
// Two launches on one temporary user-data directory, fake Codex/Claude CLIs (tests/fixtures/orchestration/mock-*.mjs):
//   first:   two cards, a link, a stage 4–11 run (check node-test); the application quits while the executor works;
//   restart: the fake CLIs now report other versions. Resume is refused (unsupported_version), Stop in the run panel
//            stops the run, the link and the cards are deleted from the canvas, the run and its history stay.
// Needs `npm run build` first. Starts no real model.
// --app <…/Raoden Loom.app>: the restart is the packaged build. A packaged build ignores the fake CLIs, so it meets the
// CLIs installed on this Mac (found, or not, as for a user) with a temporary HOME; Resume is not sent there (with a
// matching version it would start a real model), Stop and the deletion are. The first launch stays the development
// build: only it can drive fake CLIs into a paused run.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { FIXTURES, NODE, byText, canvasState, card, cardText, createAgent, launch as launchApp, q, runs, workspace } from "./orchestration-app-kit.mjs";

const { TMP, D, project, script } = workspace("cto-stopnr-");
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? path.resolve(process.argv[i + 1]) : null; };
const SHOTS = arg("--shots") ?? D("shots");
const APP = arg("--app");
const packaged = APP ? path.join(APP, "Contents", "MacOS", path.basename(APP, ".app")) : undefined;
fs.mkdirSync(SHOTS, { recursive: true });
const PORT = 9400 + Math.floor(Math.random() * 400);
const failures = [];
const passed = [];
const expect = (ok, what, got) => { (ok ? passed : failures).push(ok ? what : `${what}: ${JSON.stringify(got)?.slice(0, 400)}`); };

const src = project("project");
const codexScript = script("codex", [{ report: { stages: [{ title: "Заметка", task: "Add src/note.mjs" }], question: null } }]);
const claudeScript = script("claude", [{ report: { summary: "note added", done: true }, writes: [["src/note.mjs", "export const note = 1;\n"]] }]);
fs.mkdirSync(D("mock-state", ".codex"), { recursive: true });
const ledger = D("ledger.jsonl");
const HOLD = D("hold-executor");
fs.writeFileSync(HOLD, "");
const wrap = (p) => {
  const f = D(`${p}-mock`);
  const hold = p === "claude" ? `case "$*" in *--json-schema*) while [ -e "${HOLD}" ]; do sleep 0.1; done ;; esac\n` : "";
  fs.writeFileSync(f, `#!/bin/sh\n${hold}exec "${NODE}" "${path.join(FIXTURES, `mock-${p}.mjs`)}" "$@"\n`, { mode: 0o755 });
  return f;
};
const env = (extra) => ({ HOME: D("mock-state"), MOCK_STATE: D("mock-state"), MOCK_LEDGER: ledger, ...extra });
const providers = (codex, claude) => {
  const file = D(`providers-${codex}.json`);
  fs.writeFileSync(file, JSON.stringify({
    codex: { executable: wrap("codex"), version: `codex-cli ${codex}`, path: `${path.dirname(NODE)}:/usr/bin:/bin`,
      env: env({ MOCK_SCRIPT: codexScript, CODEX_HOME: D("mock-state", ".codex") }) },
    claude: { executable: wrap("claude"), version: `${claude} (Claude Code)`, path: `${path.dirname(NODE)}:/usr/bin:/bin`, env: env({ MOCK_SCRIPT: claudeScript }) }
  }));
  return file;
};
const ledgerCount = () => (fs.existsSync(ledger) ? fs.readFileSync(ledger, "utf8").split("\n").filter(Boolean).length : 0);
const userData = D("user-data");
const launch = (file) => launchApp({ userData, providers: file, port: PORT, shots: SHOTS });
const launchPackaged = () => launchApp({ userData, port: PORT, shots: SHOTS, executable: packaged,
  env: { HOME: D("home"), SHELL: "/bin/sh", PATH: "/usr/bin:/bin:/usr/sbin:/sbin", CANVASTTY_ORCHESTRATION_TEST_PROVIDERS: "" } });
fs.mkdirSync(D("home"), { recursive: true });

let app;
try {
  // =============== first launch: the versions the application runs ===============
  app = await launch(providers("0.155.1", "2.1.281"));
  await createAgent(app, "Агент Codex (лид)", src);
  await createAgent(app, "Агент Claude (исполнитель)", src);
  let c = await canvasState(app);
  const lead = c.agents.find((a) => a.provider === "codex");
  const exec = c.agents.find((a) => a.provider === "claude");
  const linkId = randomUUID();
  const made = await app.ev(`window.canvasTTY.orchestration.createLink(${JSON.stringify({ linkId, fromAgentId: lead.agentId, toAgentId: exec.agentId })})`);
  expect(made?.ok, "first: link created", made);
  const runId = randomUUID();
  const started = await app.ev(`window.canvasTTY.orchestration.startOnLink(${JSON.stringify({ linkId, requestId: runId, goal: { text: "add a note", criteria: ["src/note.mjs exists"], checks: ["node-test"] } })})`);
  expect(started?.ok, "first: a stage 4–11 run started on the link", started);
  await app.waitFor(`window.canvasTTY.orchestration.get(${JSON.stringify(runId)}).then((r) => r.value?.view.active?.purpose === "execute")`, "executor working", 60_000);
  await app.shot("01-executor-working");
  const quit1 = await app.quit(); // the application closes during the turn
  fs.rmSync(HOLD, { force: true });
  const ledgerAfterFirst = ledgerCount();

  // =============== restart: CLIs of another version ===============
  app = packaged ? await launchPackaged() : await launch(providers("0.160.0", "2.1.290"));
  if (packaged) {
    const pid = execFileSync("lsof", ["-nP", `-iTCP:${PORT}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" }).trim().split("\n")[0];
    const exe = execFileSync("ps", ["-o", "comm=", "-p", pid], { encoding: "utf8" }).trim();
    expect(exe === packaged, "restart: the window is the packaged build", exe);
    const version = await app.ev("window.canvasTTY.appVersion()");
    expect(version === JSON.parse(fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "..", "package.json"), "utf8")).version, "restart: the packaged build's version", version);
  }
  await app.waitFor(`document.querySelectorAll("[data-agent-id]").length === 2 && ${q(".agent-link__chip")} && true`, "cards after restart");
  const r0 = (await runs(app)).find((r) => r.runId === runId);
  expect(r0?.status === "paused", "restart: the run is paused", r0);
  await app.clickEl(byText(`[data-agent-link-id="${linkId}"] button`, "Открыть запуск"));
  await app.waitFor(`${q(".orch-panel__actions")} && true`, "run panel");
  await app.shot("02-paused-after-restart");

  // resume still needs the CLIs the run was made with (fake CLIs only: see --app)
  if (!packaged) {
    const view = (await app.ev(`window.canvasTTY.orchestration.get(${JSON.stringify(runId)})`)).value.view;
    const resume = await app.ev(`window.canvasTTY.orchestration.command(${JSON.stringify({ runId, commandId: randomUUID(), expectedRevision: view.revision, command: { kind: "resume" } })})`);
    expect(resume?.ok === false && resume.code === "unsupported_version", "restart: resume is refused for the CLI version", resume);
  }

  // deleting the link needs the stop first: no delete on the chip, and main refuses it
  expect(await app.ev(`!${q(`[data-agent-link-id="${linkId}"] .agent-link__delete`)}`), "restart: the chip of a paused run offers no delete", null);
  const refused = await app.ev(`window.canvasTTY.orchestration.deleteLink(${JSON.stringify(linkId)})`);
  expect(refused?.ok === false && refused.code === "link_active_run" && (await canvasState(app)).links.length === 1, "restart: main keeps the link of a paused run", refused);

  await app.clickEl(byText(".orch-panel__actions button", "Стоп"));
  await app.waitFor(`${q(".orch-panel__status--stopped")} && true`, "stopped", 30_000);
  expect((await runs(app)).find((r) => r.runId === runId)?.status === "stopped", "Stop in the run panel stops the restored run", await runs(app));
  expect((await cardText(app, exec.agentId, ".agent-card__state")) === "Запуск остановлен", "the cards show the run stopped", await cardText(app, exec.agentId, ".agent-card__state"));
  await app.shot("03-stopped");

  await app.clickEl(q(".orch-panel__close"));
  await app.clickEl(q(`[data-agent-link-id="${linkId}"] .agent-link__delete`));
  await app.waitFor(`!${q(".agent-link__chip")}`, "link removed");
  for (const a of [lead, exec]) {
    await app.clickEl(card(a.agentId, ".agent-card__close"));
    await app.waitFor(`!${card(a.agentId)}`, "card removed");
  }
  c = await canvasState(app);
  expect(c.links.length === 0 && c.agents.length === 0, "the link and both cards are deleted", c);
  expect((await runs(app)).find((r) => r.runId === runId)?.status === "stopped", "the run stays in the history", await runs(app));
  const hist = await app.ev(`window.canvasTTY.orchestration.history(${JSON.stringify(runId)}, 0, 200).then((r) => r.ok && r.value.records.length)`);
  expect(hist > 5, "its journal is readable", hist);
  expect(ledgerCount() === ledgerAfterFirst, "restart: no CLI process was started", [ledgerCount(), ledgerAfterFirst]);
  await app.shot("04-deleted");
  const quit2 = await app.quit();

  const summary = { ok: failures.length === 0, passed: passed.length, failures, fakeCliProcesses: ledgerCount(), shots: SHOTS, work: TMP, exits: [quit1, quit2] };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  process.exitCode = failures.length ? 1 : 0;
} catch (error) {
  await app?.shot?.("error").catch(() => {});
  process.stdout.write(`${JSON.stringify({ ok: false, passed: passed.length, failures, error: String(error?.stack ?? error), work: TMP }, null, 2)}\n`);
  await app?.stop?.();
  process.exitCode = 1;
}
