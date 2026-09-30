// Child process for tests/orchestration-store-recovery.test.mjs; the parent kills it with SIGKILL.
// Modes:
//   loop <root> <runId>    createRun, then append commands forever; prints each confirmed seq on its own line
//   hold <root> <runId>    openRun and keep the writer (and writer.lock) until killed; prints "ready"
//   intent <root> <runId> <turnId>   openRun, record a turn intent, keep the writer; prints "intent"
import { randomUUID } from "node:crypto";
import { createRun, openRun } from "../../../src/main/services/orchestration/store.ts";

const [mode, root, runId, turnId] = process.argv.slice(2);
const out = (line) => process.stdout.write(`${line}\n`);
const keepAlive = () => setInterval(() => {}, 1_000);

if (mode === "loop") {
  const writer = await createRun(root, runId, { goal: "crash loop" });
  out(writer.state().lastSeq);
  for (let i = 0; ; i += 1) {
    await writer.recordCommand(randomUUID(), "crash.loop", { i, pad: "x".repeat(i % 200) });
    out(writer.state().lastSeq);
  }
} else if (mode === "hold") {
  await openRun(root, runId);
  out("ready");
  keepAlive();
} else if (mode === "intent") {
  const writer = await openRun(root, runId);
  await writer.recordTurnIntent({
    turnId, commandId: null, role: "executor", provider: "codex", mode: "structured-readonly", sessionId: null, task: "crashing task"
  });
  out("intent");
  keepAlive();
} else {
  throw new Error(`unknown mode ${mode}`);
}
