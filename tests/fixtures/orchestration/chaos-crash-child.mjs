// Child process for tests/orchestration-service-races.test.mjs; the parent kills it with SIGKILL mid-operation.
// argv[2] is a JSON config: { mode, root, src, git, node, supervisor, registry, deps, checks }
//   mode "turn":  the executor turn holds forever; the parent kills the child once turn.intent is in the journal
//   mode "check": the executor finishes, the first required check runs; the parent kills the child during it
// Prints the runId on its own line once createRun returned.
import { createOrchestrationService } from "../../../src/main/services/orchestration/orchestrationService.ts";
import { checkPreparedDeps, createRegistry } from "../../../src/main/services/orchestration/checks.ts";
import { createTestAgents, executed, plan, review } from "./test-agents.mjs";

const cfg = JSON.parse(process.argv[2]);
setInterval(() => {}, 1_000); // a held turn is only a promise: keep the process alive until the parent kills it

const agents = createTestAgents({
  plan: { report: plan("one") },
  execute: cfg.mode === "turn" ? { hold: new Promise(() => {}) } : { report: executed() },
  review: { report: review("accept") },
  final_review: { report: review("complete") }
});
const svc = createOrchestrationService({
  root: cfg.root, gitPath: cfg.git, agents,
  checks: { registry: createRegistry(cfg.registry), deps: checkPreparedDeps(cfg.deps),
    launch: { command: cfg.node, args: [cfg.supervisor], env: {} } }
});
const run = await svc.createRun({ source: cfg.src, goal: { text: `crash during ${cfg.mode}`, criteria: ["survives"], checks: cfg.checks } });
process.stdout.write(`${run.runId}\n`);
