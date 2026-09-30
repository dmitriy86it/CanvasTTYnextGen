// utilityProcess: start a detached group; clean it up if the parent goes away.
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const MARK = process.argv.find((a) => a.startsWith("CTTYEXP-"));
const c = spawn("sh", ["-c", `node -e 'setInterval(()=>{},1e3)' ${MARK} & wait`, MARK], { detached: true, stdio: "ignore" });
console.log(JSON.stringify({ groupLeader: c.pid, ppid: process.ppid }));
const log = (m) => fs.appendFileSync(process.env.UTIL_LOG, `${Date.now()} ${m}\n`);
const killGroup = (why) => { log(`cleanup: ${why}`); try { process.kill(-c.pid, "SIGKILL"); } catch (e) { log(e.code); } };
process.parentPort.on("close", () => killGroup("parentPort close"));  // may not exist in this version
process.on("exit", () => killGroup("process exit"));
const ppid0 = process.ppid;
setInterval(() => { if (process.ppid !== ppid0) { killGroup(`ppid changed ${ppid0}->${process.ppid}`); process.exit(0); } }, 100);
log("util started");
