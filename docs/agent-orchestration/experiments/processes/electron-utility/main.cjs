// Electron main: fork a utilityProcess supervisor, print pids, then wait to be SIGKILLed by the harness.
const { app, utilityProcess } = require("electron");
const path = require("node:path");
const MARK = process.argv.find((a) => a.startsWith("CTTYEXP-"));
app.dock?.hide();
app.whenReady().then(() => {
  if (process.env.MODE === "runasnode") {
    // Supervisor as a plain Node process from the same binary; fd0 is its lifeline, fd4 = empty task.
    const { spawn } = require("node:child_process");
    const sup = path.join(__dirname, "..", "supervisor.mjs");
    const v = spawn(process.execPath, [sup, "sh", "-c", `node -e 'setInterval(()=>{},1e3)' ${MARK} & wait`, MARK],
      { stdio: ["pipe", "ignore", "ignore", "pipe", "ignore"], detached: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", SUP_ENV_ALLOW: "PATH,HOME", SUP_GRACE_INT_MS: "500", SUP_GRACE_TERM_MS: "500" } });
    v.stdio[3].on("data", (d) => { const m = JSON.parse(d.toString().split("\n")[0]); console.log(JSON.stringify({ main: process.pid, utility: v.pid, groupLeader: m.pgid })); });
    return;
  }
  const u = utilityProcess.fork(path.join(__dirname, "util.cjs"), [MARK], { stdio: "pipe", serviceName: "ctty-exp-supervisor" });
  u.stdout.on("data", (d) => process.stdout.write("util: " + d));
  u.on("spawn", () => console.log(JSON.stringify({ main: process.pid, utility: u.pid })));
});
