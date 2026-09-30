// Diagnostic for the two M6 timeouts: the same flow as tests/workspaces-main.test.mjs M6 (one run to completed),
// printing every status change and, at the end, the run's last journal events. Temp dirs only.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const REPO = "<REPO>";
const { findGit } = await import(`${REPO}/src/main/services/orchestration/git.ts`);
const { createRunManager } = await import(`${REPO}/src/main/services/orchestration/manager.ts`);
const { createTestAgents, executed, plan, review } = await import(`${REPO}/tests/fixtures/orchestration/test-agents.mjs`);
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "m6-diag-")));
const GIT = findGit(process.env), NODE = fs.realpathSync(process.execPath);
fs.writeFileSync(path.join(TMP, "gitconfig"), "");
const g = (cwd, ...a) => execFileSync(GIT, a, { cwd, encoding: "utf8", env: { PATH: process.env.PATH, HOME: TMP, GIT_CONFIG_GLOBAL: path.join(TMP, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
const src = path.join(TMP, "src");
fs.cpSync(path.join(REPO, "tests/fixtures/orchestration/check-project"), src, { recursive: true });
fs.rmSync(path.join(src, "tests", "broken.test.mjs"));
fs.mkdirSync(path.join(src, "node_modules", "left-pad"), { recursive: true });
fs.writeFileSync(path.join(src, "node_modules", "left-pad", "index.mjs"), "export default (s) => s;\n");
g(src, "init", "-q", "-b", "main"); g(src, "add", "-A"); g(src, "commit", "-q", "-m", "fixture");
const root = path.join(TMP, "orch");
const m = createRunManager({ root, gitPath: () => GIT, launch: () => ({ command: NODE, args: [path.join(REPO, "src/orchestration/supervisor.mjs")], env: {} }), nodePath: () => NODE, stopGraceMs: 2000,
  workspaceOpen: () => true, workspaceKnown: () => true,
  agents: async () => createTestAgents({ plan: { report: plan("only stage") }, execute: { report: executed() }, review: { report: review("accept") }, final_review: { report: review("complete") } }) });
const box = (x) => ({ position: { x, y: 0 }, size: { width: 300, height: 222 } });
const lead = (await m.createAgent({ agentId: randomUUID(), provider: "codex", project: src, bounds: box(0), workspaceId: "common" })).value;
const exec = (await m.createAgent({ agentId: randomUUID(), provider: "claude", project: src, bounds: box(400), workspaceId: "common" })).value;
const link = (await m.createLink({ linkId: randomUUID(), fromAgentId: lead.agentId, toAgentId: exec.agentId })).value;
const runId = randomUUID();
console.log("start", JSON.stringify((await m.startOnLink({ linkId: link.linkId, requestId: runId, goal: { text: "extend sum", criteria: ["sum works"], checks: ["node-test"] } }))));
const seen = [];
const end = Date.now() + 60_000;
let last = null;
while (Date.now() < end) {
  const v = (await m.get(runId)).value?.view;
  const s = v ? `${v.status}${v.reason ? `:${v.reason}` : ""}` : "no view";
  if (s !== last) { seen.push({ t: Date.now(), s }); console.log("status", s); last = s; }
  if (v?.status === "completed" || v?.status === "failed" || v?.status === "stopped") break;
  await new Promise((r) => setTimeout(r, 50));
}
const journal = path.join(root, "runs", runId, "journal.jsonl");
const lines = fs.existsSync(journal) ? fs.readFileSync(journal, "utf8").trim().split("\n") : [];
console.log("journal events:", lines.length);
for (const l of lines.slice(-8)) { try { const e = JSON.parse(l); console.log(" ", e.type, JSON.stringify(e).slice(0, 400)); } catch { console.log("  ?", l.slice(0, 200)); } }
console.log("final", last);
await m.shutdown();
fs.rmSync(TMP, { recursive: true, force: true });
