// Stand-in for a CLI under the supervisor. Usage: node mock-cli.mjs <mode> CTTYEXP-xxxx
// Prints JSONL to stdout: {"type":"mock.ready"} at start, then after stdin EOF
// {"type":"mock.stdin", len, sha256, text (if short), env flags}. Env: names/flags only, never values.
// Env MOCK_LEDGER (optional): appends one JSON line {pid,label} per process it starts, its own pid included.
// Modes: exit0 | exit42 | sleep | ignore-int | exit-now (no stdin read)
//        spawn / spawn-exit: start a descendant in our process group, then sleep / exit 0 after stdin EOF
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";

const [mode, mark] = process.argv.slice(2);
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const hold = () => setInterval(() => {}, 1e3);
const ledger = (pid, label) => { if (process.env.MOCK_LEDGER) fs.appendFileSync(process.env.MOCK_LEDGER, JSON.stringify({ pid, label }) + "\n"); };
ledger(process.pid, "mock-cli");

if (mode === "exit-now") process.exit(0);
if (mode === "ignore-int") process.on("SIGINT", () => out({ type: "mock.sigint_ignored" }));
if (mode.startsWith("spawn")) {
  const d = spawn(process.execPath, ["-e", "setInterval(()=>{},1e3)", `${mark}-descendant`], { stdio: "ignore" });
  ledger(d.pid, "mock-cli-descendant");
  out({ type: "mock.descendant", pid: d.pid });
}
out({ type: "mock.ready", pid: process.pid });

const hash = createHash("sha256");
const head = [];
let len = 0;
process.stdin.on("data", (d) => { hash.update(d); len += d.length; if (len <= 4096) head.push(d); });
process.stdin.on("end", () => {
  out({
    type: "mock.stdin",
    eof: true,
    len,
    sha256: hash.digest("hex"),
    text: len <= 4096 ? Buffer.concat(head).toString("utf8") : null,
    hasElectronRunAsNode: "ELECTRON_RUN_AS_NODE" in process.env,
    supVars: Object.keys(process.env).filter((k) => k.startsWith("SUP_")),
    hasAnthropicKey: process.env.ANTHROPIC_API_KEY === "fake-test-value",
  });
  if (mode === "exit0" || mode === "spawn-exit") process.exit(0);
  if (mode === "exit42") process.exit(42);
});
if (mode === "sleep" || mode === "ignore-int" || mode === "spawn") hold();
