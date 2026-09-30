// The link gesture of the UI drivers (scripts/link-agents.mjs) with a fake app: every stage's failure keeps its own
// error, the journal is written with what was gathered, the mouse wrapper and the observers are removed.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DUMP, OBSERVE, UNOBSERVE, linkAgents } from "../scripts/link-agents.mjs";

const LEAD = { agentId: "11111111-lead", provider: "codex" };
const EXEC = { agentId: "22222222-exec", provider: "claude" };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cto-link-agents-"));

function fake(fail = {}) {
  const calls = [];
  let links = [];
  const boom = (stage) => { if (fail[stage]) throw new Error(`${stage} failed`); };
  const mouse = async (type) => { calls.push(`mouse:${type}`); };
  const app = {
    mouse,
    async ev(expr) {
      if (expr === OBSERVE) { calls.push("observe"); boom("observe"); return true; }
      if (expr === DUMP) { calls.push("dump"); boom("dump"); return { trace: [] }; }
      if (expr === UNOBSERVE) { calls.push("unobserve"); return true; }
      throw new Error("unexpected expression");
    },
    async pointOn(sel) { calls.push(`pointOn:${sel}`); boom(sel.includes("port") ? "pointOnPort" : "pointOnBody"); return { x: 1, y: 2 }; },
    async drag() { await app.mouse("mousePressed"); boom("drag"); await app.mouse("mouseReleased"); if (!fail.noLink) links = [{ linkId: "l", fromAgentId: LEAD.agentId, toAgentId: fail.otherPair ? "33333333-other" : EXEC.agentId }]; },
    async waitFor(expr, what) { const want = expr.includes(LEAD.agentId) && expr.includes(EXEC.agentId); if (links.some((l) => want && l.toAgentId === EXEC.agentId)) return true; throw new Error(`timeout: ${what} (false)`); },
    async shot(name) { calls.push(`shot:${name}`); }
  };
  const deps = {
    app, dir: "/tmp/p",
    createAgent: async (_a, label) => { calls.push(`create:${label}`); boom(label.includes("лид") ? "createLead" : "createExec"); },
    canvasState: async () => { calls.push("canvas"); boom("canvas"); return { agents: fail.noExec ? [LEAD] : [LEAD, EXEC], links }; },
    card: (id, inner) => `[data-agent-id="${id}"] ${inner}`
  };
  return { app, deps, calls, mouse };
}
const journal = (f) => JSON.parse(fs.readFileSync(f, "utf8"));

test("success: the link of this pair is returned; the journal says linked; wrapper and observers removed", async () => {
  const { app, deps, calls, mouse } = fake();
  const diagFile = path.join(tmp, "ok.json");
  const link = await linkAgents({ ...deps, diagFile });
  assert.equal(link.toAgentId, EXEC.agentId);
  assert.equal(app.mouse, mouse);
  assert.ok(calls.includes("unobserve"));
  const j = journal(diagFile);
  assert.deepEqual([j.ok, j.stage, j.sent.length], [true, "done", 2]);
});

for (const [stage, where] of [["observe", "observe"], ["createLead", "create lead card"], ["createExec", "create executor card"], ["canvas", "read canvas"],
  ["pointOnPort", "point on the lead's port"], ["pointOnBody", "point on the executor"], ["drag", "drag"], ["noLink", "wait for the link"], ["otherPair", "wait for the link"]]) {
  test(`a failure at «${where}» (${stage}) keeps its own error and still writes the journal`, async () => {
    const { app, deps, calls, mouse } = fake({ [stage]: true });
    const diagFile = path.join(tmp, `${stage}.json`);
    await assert.rejects(linkAgents({ ...deps, diagFile }), stage === "noLink" || stage === "otherPair" ? /timeout: link \(false\)/ : new RegExp(`${stage} failed`));
    assert.equal(app.mouse, mouse, "the mouse wrapper is removed");
    if (stage !== "observe") assert.ok(calls.includes("unobserve"), "the observers are removed");
    const j = journal(diagFile);
    assert.equal(j.ok, false);
    assert.equal(j.stage, where);
    if (["observe", "createLead", "createExec", "canvas"].includes(stage)) assert.equal(j.lead, null, "no cards yet: still written");
  });
}

test("no executor card on the canvas is an error of its own, journal written", async () => {
  const { deps } = fake({ noExec: true });
  const diagFile = path.join(tmp, "noexec.json");
  await assert.rejects(linkAgents({ ...deps, diagFile }), /no executor card/);
  assert.equal(journal(diagFile).stage, "read canvas");
});

test("a failure of the diagnostics (dump, write) never replaces the gesture's error", async () => {
  const { deps } = fake({ drag: true, dump: true });
  const diagFile = path.join(tmp, "no-such-dir", "x.json");
  const logged = [];
  await assert.rejects(linkAgents({ ...deps, diagFile, log: (m) => logged.push(m) }), /drag failed/);
  assert.ok(logged.some((m) => m.startsWith("link diagnostics not written")));
});

test("without a journal file nothing is observed or written", async () => {
  const { deps, calls } = fake();
  await linkAgents(deps);
  assert.ok(!calls.includes("observe") && !calls.includes("dump"));
});
