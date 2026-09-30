// Diagnostic only: no model call, no run, no environment check. Two agent cards and a link, as the series does.
import fs from "node:fs"; import path from "node:path"; import { execFileSync } from "node:child_process";
import { canvasState, card, createAgent, launch, workspace } from "../../../../../../../scripts/orchestration-app-kit.mjs";
const { D } = workspace("cto-diag-link-");
const shots = D("shots"); fs.mkdirSync(shots, { recursive: true });
const tmpProj = D("proj"); fs.mkdirSync(tmpProj); execFileSync("git", ["init", "-q"], { cwd: tmpProj });
const app = await launch({ userData: D("userData"), port: 9795, shots });
const out = {};
try {
  for (const [tag, dir] of [["tmp", fs.realpathSync(tmpProj)], ["repo", "<repo>"]]) {
    await createAgent(app, "Агент Codex (лид)", dir);
    await createAgent(app, "Агент Claude (исполнитель)", dir);
    const c = await canvasState(app);
    const lead = c.agents.filter((a) => a.provider === "codex").at(-1), exec = c.agents.filter((a) => a.provider === "claude").at(-1);
    const from = await app.center(card(lead.agentId, ".agent-card__port")), to = await app.center(card(exec.agentId, ".agent-card__body"));
    await app.drag(from, to, 20);
    await new Promise((r) => setTimeout(r, 2000));
    const after = await canvasState(app);
    out[tag] = { agents: after.agents.map((a) => ({ provider: a.provider, role: a.role, same: a.project === lead.project })), linksBefore: c.links.length, linksAfter: after.links.length, from, to };
    if (after.links.length === c.links.length) out[tag].api = await app.ev(`window.canvasTTY.orchestration.createLink({ requestId: crypto.randomUUID(), fromAgentId: ${JSON.stringify(lead.agentId)}, toAgentId: ${JSON.stringify(exec.agentId)} })`);
    await app.shot(`diag-${tag}`);
  }
} catch (e) { out.error = String(e?.stack ?? e); await app.shot("diag-error").catch(() => {}); }
finally { console.log(JSON.stringify(out, null, 1)); await app.close?.(); }
process.exit(0);
