// The series coordinator's side of the handoff (coordinator-decision.mjs): short calls, each under 10 s, instead of a
// watcher. `poll` waits a few seconds for a request with no decision yet and prints it in full; `decide` writes the
// decision atomically. Both log to <out>/coordinator-log.jsonl (detected once per request, decided).
//
//   node scripts/coordinator.mjs poll <out> [--wait <sec, default 8, max 9>] [--log <driver stdout file>]
//   node scripts/coordinator.mjs decide <out> <requestId> <allow_once|stop> <reason>
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ID = /^[\w-]+$/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const logFile = (out) => path.join(out, "coordinator-log.jsonl");
const readLog = (out) => { try { return fs.readFileSync(logFile(out), "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } }); } catch { return []; } };
const appendLog = (out, entry) => fs.appendFileSync(logFile(out), `${JSON.stringify(entry)}\n`);
const ids = (dir, suffix) => { try { return fs.readdirSync(dir).filter((f) => f.endsWith(suffix)).map((f) => f.slice(0, -suffix.length)).filter((id) => ID.test(id)); } catch { return []; } };
const decidedIds = (out) => new Set([...ids(path.join(out, "decisions"), ".used.json"), ...ids(path.join(out, "decisions"), ".json")]);

// Requests with no decision; one still being written (not valid JSON yet) is left for the next look.
function unresolved(out) {
  const done = decidedIds(out);
  return ids(path.join(out, "pending"), ".json").filter((id) => !done.has(id)).flatMap((id) => {
    try { return [JSON.parse(fs.readFileSync(path.join(out, "pending", `${id}.json`), "utf8"))]; } catch { return []; }
  });
}

export async function poll(out, { wait = 8, log } = {}) {
  const end = Date.now() + Math.min(Math.max(Number(wait) || 0, 0), 9) * 1000;
  let found = unresolved(out);
  while (!found.length && Date.now() < end) { await sleep(200); found = unresolved(out); }
  const entries = readLog(out);
  const seen = new Map(entries.filter((e) => e.event === "detected").map((e) => [e.requestId, e.at]));
  for (const r of found) {
    if (!seen.has(r.requestId)) { const at = new Date().toISOString(); appendLog(out, { event: "detected", requestId: r.requestId, at, askedAt: r.askedAt ?? null }); seen.set(r.requestId, at); }
    r.detectedAt = seen.get(r.requestId);
  }
  let driverAlive = false;
  try { driverAlive = execFileSync("pgrep", ["-f", `real-autopilot-series.mjs.*${out}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() !== ""; } catch {}
  let logText = null;
  if (log) try { logText = fs.readFileSync(log, "utf8"); } catch (e) { logText = `(log unreadable: ${e.message})`; }
  const lines = logText?.split("\n") ?? [];
  return {
    unresolved: found, driverAlive, logTail: log ? lines.filter(Boolean).slice(-6) : null,
    resolved: [...decidedIds(out)].map((requestId) => ({ requestId, applied: log ? lines.some((l) => l.includes(`applied ${requestId}`)) : null }))
  };
}

// Returns { ok, error? , file? }; nothing is written when it refuses.
export function decide(out, requestId, decision, reason) {
  if (!ID.test(requestId ?? "")) return { ok: false, error: `bad request id: ${requestId}` };
  if (!["allow_once", "stop"].includes(decision)) return { ok: false, error: `decision must be allow_once or stop: ${decision}` };
  if (!String(reason ?? "").trim()) return { ok: false, error: "empty reason" };
  const dir = path.join(out, "decisions");
  if (!fs.existsSync(path.join(out, "pending", `${requestId}.json`))) return { ok: false, error: `no pending request ${requestId}` };
  for (const f of [`${requestId}.json`, `${requestId}.used.json`]) if (fs.existsSync(path.join(dir, f))) return { ok: false, error: `already decided: ${f}` };
  const detectedAt = readLog(out).find((e) => e.event === "detected" && e.requestId === requestId)?.at ?? null;
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${requestId}.${process.pid}.tmp`), file = path.join(dir, `${requestId}.json`);
  fs.writeFileSync(tmp, `${JSON.stringify({ requestId, decision, reason, detectedAt, writtenAt: new Date().toISOString() }, null, 2)}\n`);
  fs.renameSync(tmp, file);
  appendLog(out, { event: "decided", requestId, decision, at: new Date().toISOString() });
  return { ok: true, file };
}

async function main([cmd, out, ...rest]) {
  const usage = () => { console.error("usage: coordinator.mjs poll <out> [--wait <sec>] [--log <file>] | decide <out> <requestId> <allow_once|stop> <reason>"); process.exit(2); };
  if (!out) usage();
  if (cmd === "decide") {
    const [requestId, decision, ...words] = rest;
    const r = decide(out, requestId, decision, words.join(" "));
    if (!r.ok) { console.error(`refused: ${r.error}`); process.exit(2); }
    console.log(`written ${r.file}`);
    return;
  }
  if (cmd !== "poll") usage();
  const opt = {};
  for (let i = 0; i < rest.length; i += 2) {
    if (rest[i] === "--wait" && /^\d+(\.\d+)?$/.test(rest[i + 1] ?? "")) opt.wait = Number(rest[i + 1]);
    else if (rest[i] === "--log" && rest[i + 1]) opt.log = rest[i + 1];
    else usage();
  }
  const r = await poll(out, opt);
  if (!r.unresolved.length) console.log("no unresolved requests");
  for (const q of r.unresolved) {
    console.log(`=== UNRESOLVED ${q.requestId}`);
    for (const k of ["scenario", "askedAt", "detectedAt", "cwd", "projectDir"]) console.log(`${k}: ${q[k] ?? ""}`);
    console.log(`protectedFiles: ${JSON.stringify(q.protectedFiles ?? [])}`);
    console.log(`writableDirs: ${JSON.stringify(q.writableDirs ?? [])}`);
    console.log(`command:\n${q.command ?? ""}\n--- end of command`);
    console.log(`precheck: ${JSON.stringify(q.precheck ?? null)}`);
  }
  console.log(`driver: ${r.driverAlive ? "alive" : "not running"}`);
  if (r.logTail) console.log(`log tail:\n${r.logTail.join("\n")}`);
  for (const d of r.resolved) console.log(`decided ${d.requestId}: applied ${d.applied === null ? "unknown (no --log)" : d.applied ? "yes" : "not yet"}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) await main(process.argv.slice(2));
