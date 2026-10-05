// UX audit helper (docs/ux-audit): one real journal-v2 run on fake CLIs, paused for its plan review, then shown once for
// every pause reason of the journal — the last run.status record is rewritten to that reason (hash chain rebuilt) and the
// app reopened on it: the canvas (cards, link chip), the run panel and its activity tab are captured. No real model.
// Needs `npm run build` first; macOS. Usage: node scripts/ux-pause-gallery.mjs --shots <dir> [--only r1,r2]
import fs from "node:fs";
import path from "node:path";
import { FIXTURES, NODE, byText, launch as launchApp, q, startGoal, workspace } from "./orchestration-app-kit.mjs";
import { PAUSED_REASONS_V2, buildRecord } from "../src/main/services/orchestration/journal.ts";

const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null; };
const SHOTS = path.resolve(arg("--shots") ?? "ux-shots");
const ONLY = arg("--only")?.split(",") ?? null; // "none": only the settings and the readiness
fs.mkdirSync(SHOTS, { recursive: true });
const { D, project, script } = workspace("ux-pause-");
const dir = D("run");
fs.mkdirSync(path.join(dir, "mock-state", ".codex"), { recursive: true });
const src = project("app");
const change = (text, covers) => ({ keep: null, text, covers, evidence: { kind: "change", check: null } });
const byCheck = (text, covers) => ({ keep: null, text, covers, evidence: { kind: "check", check: "cmd-1" } });
const plan = { report: { stages: [{ title: "Заметка", task: "Add src/note.mjs exporting a constant",
  conditions: [change("src/note.mjs exists", ["R1"]), byCheck("node --test passes", ["R2"])] }], dropped: [], dropRequirements: [], question: null } };
const wrap = (p) => { const f = D(`${p}-mock`); fs.writeFileSync(f, `#!/bin/sh\nexec "${NODE}" "${path.join(FIXTURES, `mock-${p}.mjs`)}" "$@"\n`, { mode: 0o755 }); return f; };
const env = (extra) => ({ HOME: path.join(dir, "mock-state"), MOCK_STATE: path.join(dir, "mock-state"), ...extra });
const providers = path.join(dir, "providers.json");
fs.writeFileSync(providers, JSON.stringify({
  codex: { executable: wrap("codex"), version: "codex-cli 0.155.1", path: `${path.dirname(NODE)}:/usr/bin:/bin`,
    env: env({ MOCK_SCRIPT: script("codex", [plan, plan, plan]), CODEX_HOME: path.join(dir, "mock-state", ".codex") }) },
  claude: { executable: wrap("claude"), version: "2.1.281 (Claude Code)", path: `${path.dirname(NODE)}:/usr/bin:/bin`,
    env: env({ MOCK_SCRIPT: script("claude", [{ report: { summary: "note added", done: true }, writes: [["src/note.mjs", "export const note = 'a';\n"]] }]) }) }
}));
const userData = path.join(dir, "user-data");
const port = () => 9400 + Math.floor(Math.random() * 300);
const result = { shots: SHOTS, reasons: {} };

// 1. the real run, paused for its plan review
let app = await launchApp({ userData, providers, port: port(), shots: SHOTS });
let ids;
try {
  ids = await app.ev(`(async () => {
    const o = window.canvasTTY.orchestration;
    const mk = async (provider, x) => (await o.createAgent({ agentId: crypto.randomUUID(), provider, project: ${JSON.stringify(src)}, bounds: { position: { x, y: 80 }, size: { width: 300, height: 176 } }, workspaceId: "common" })).value.agentId;
    const lead = await mk("codex", 40), exec = await mk("claude", 420);
    return { lead, exec, link: (await o.createLink({ linkId: crypto.randomUUID(), fromAgentId: lead, toAgentId: exec })).value.linkId };
  })()`);
  await app.ev("location.reload()");
  await app.waitFor(`${q(`[data-agent-link-id="${ids.link}"]`)} && true`, "the link chip");
  // the project settings and the goal dialog with a Codex model the account is not offered (a readiness blocker)
  await app.clickEl(byText(`[data-agent-link-id="${ids.link}"] button`, "Новая цель"));
  await app.waitFor(`${q("[data-orch-open-settings]")} && true`, "goal dialog");
  await app.clickEl(q("[data-orch-open-settings]"));
  await new Promise((r) => setTimeout(r, 800));
  await app.shot("settings-1-project");
  await app.ev(`document.querySelector(".orch-dialog [data-orch-settings]")?.scrollTo?.(0, 99999)`);
  await app.shot("settings-2-project-bottom");
  await app.key("Escape", "Escape", 27); await app.key("Escape", "Escape", 27);
  await app.ev(`(async () => { const o = window.canvasTTY.orchestration; const info = (await o.profile(${JSON.stringify(ids.link)})).value;
    return o.saveProfile(${JSON.stringify(ids.link)}, { ...info.profile, models: { lead: "gpt-not-offered", executor: null, reviewer: null } }); })()`);
  await app.clickEl(byText(`[data-agent-link-id="${ids.link}"] button`, "Новая цель"));
  await app.waitFor(`["ready", "confirm", "blocked", "error"].includes(${q("[data-orch-readiness]")}?.dataset.orchReadiness)`, "readiness", 20_000);
  await app.ev(`${q('[data-ready-id="model"]')}?.scrollIntoView({ block: "center" })`);
  await app.shot("readiness-model-unavailable");
  result.modelBlocker = await app.ev(`${q('[data-ready-id="model"]')}?.innerText`);
  await app.key("Escape", "Escape", 27);
  await app.ev(`(async () => { const o = window.canvasTTY.orchestration; const info = (await o.profile(${JSON.stringify(ids.link)})).value;
    return o.saveProfile(${JSON.stringify(ids.link)}, { ...info.profile, models: { lead: null, executor: null, reviewer: null } }); })()`);
  await startGoal(app, ids.link, { reviewPlan: true, commands: ["node --test"] });
  await app.waitFor(`window.canvasTTY.orchestration.list().then((r) => r.value.some((s) => s.view.status === "paused"))`, "paused for the plan review", 60_000);
} finally { await app.stop().catch(() => {}); }

const runsDir = path.join(userData, "orchestration", "runs");
const runId = fs.readdirSync(runsDir)[0];
const file = path.join(runsDir, runId, "journal.jsonl");
const original = fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const last = original.findLastIndex((r) => r.type === "run.status");
const head = Object.fromEntries(["minReaderVersion", "formatPreview"].filter((k) => k in original[0]).map((k) => [k, original[0][k]]));

// 2. every reason of the journal
for (const reason of PAUSED_REASONS_V2) {
  if (ONLY && !ONLY.includes(reason)) continue;
  const recs = original.slice(0, last + 1).map((r, i) => (i === last ? { ...r, data: { ...r.data, status: "paused", reason } } : r));
  let prev = null;
  fs.writeFileSync(file, Buffer.concat(recs.map((r) => { const b = buildRecord(prev, runId, r.ts, r.type, r.data, r.v, prev ? null : head); prev = b.record; return b.line; })));
  const out = { };
  app = await launchApp({ userData, providers, port: port(), shots: SHOTS });
  try {
    await app.waitFor(`${q(`[data-agent-link-id="${ids.link}"]`)} && true`, "the link chip", 30_000);
    await new Promise((r) => setTimeout(r, 800));
    const s = (await app.ev(`window.canvasTTY.orchestration.list()`)).value.find((x) => x.view.runId === runId);
    out.status = s?.view.status; out.reason = s?.view.reason; out.integrity = s?.integrity;
    out.chip = await app.ev(`${q(`[data-agent-link-id="${ids.link}"]`)}?.innerText`);
    out.cards = await app.ev(`[...document.querySelectorAll("[data-agent-id]")].map((c) => c.innerText.replace(/\\s+/g, " ").slice(0, 300))`);
    await app.shot(`pause-${reason}-1-canvas`);
    await app.clickEl(byText(`[data-agent-link-id="${ids.link}"] button`, "Открыть запуск"));
    await app.waitFor(`${q(".orch-panel")} && true`, "the run panel");
    await new Promise((r) => setTimeout(r, 600));
    out.panel = await app.ev(`${q(".orch-panel")}.innerText.slice(0, 1500)`);
    await app.shot(`pause-${reason}-2-panel`);
    const tab = await app.ev(`[...document.querySelectorAll(".orch-panel [role=tab], .orch-panel .orch-tabs button")].find((b) => b.textContent.trim() === "Действия") ? true : false`);
    if (tab) {
      await app.clickEl(byText(".orch-panel [role=tab], .orch-panel .orch-tabs button", "Действия"));
      await new Promise((r) => setTimeout(r, 400));
      await app.shot(`pause-${reason}-3-activity`);
    }
  } catch (e) { out.error = String(e?.message ?? e); }
  finally { await app.stop().catch(() => {}); }
  result.reasons[reason] = out;
  console.log(reason, out.status, out.reason, out.error ?? "");
}
fs.writeFileSync(path.join(SHOTS, "pause-gallery.json"), JSON.stringify(result, null, 2));
