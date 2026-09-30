// Escapee maker for the sandbox-sweep tests: a setsid'ed (detached) /bin/sh that execs /bin/sleep — outside the
// target's process group and a platform binary, so no group signal and no env search can reach it.
// Usage: node reaper-escapee.mjs <escapee pid file> [<own pid file> | -] [ignored marker...]
// Writes the escapee's pid atomically; then exits 0, or with an own pid file writes its own pid there and stays.
import { spawn } from "node:child_process";
import fs from "node:fs";

const [pidFile, selfFile] = process.argv.slice(2);
spawn("/bin/sh", ["-c", 'echo $$ > "$0.tmp" && mv "$0.tmp" "$0"; exec /bin/sleep 30', pidFile], { stdio: "ignore", detached: true }).unref();
const t = setInterval(() => {
  if (!fs.existsSync(pidFile)) return;
  clearInterval(t);
  if (selfFile && selfFile !== "-") {
    fs.writeFileSync(selfFile, String(process.pid));
    setInterval(() => {}, 1000);
  } else process.exit(0);
}, 20);
