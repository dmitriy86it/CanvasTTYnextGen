// The file-based wait for the coordinator's decision on a prompt the series cannot answer by its rule: the request is
// written to pendingDir/<requestId>.json, the coordinator answers with decisionsDir/<requestId>.json
// ({ requestId, decision: "allow_once" | "stop", reason }). A decision file is used once (renamed to .used.json) and a
// requestId already answered is never answered again. Only that exact file is read (a writer's *.tmp is not); a valid
// decision comes back with the parsed file as `record`.
import fs from "node:fs/promises";
import path from "node:path";

const DECISIONS = new Set(["allow_once", "stop"]);

export async function awaitDecision({ request, pendingDir, decisionsDir, stillPending, deadline, decided, pause = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now }) {
  const { requestId } = request;
  // the id names files: no separators or dots that could leave the directories
  if (typeof requestId !== "string" || !/^[\w-]+$/.test(requestId)) throw new Error(`bad requestId: ${requestId}`);
  if (decided.has(requestId)) return { decision: "repeat", reason: "this request was already answered once", waitedMs: 0 };
  const start = now();
  const done = (decision, reason, record) => ({ decision, reason, waitedMs: now() - start, ...(record ? { record } : {}) });
  await fs.mkdir(pendingDir, { recursive: true });
  await fs.mkdir(decisionsDir, { recursive: true });
  await fs.writeFile(path.join(pendingDir, `${requestId}.json`), `${JSON.stringify(request, null, 2)}\n`);
  const file = path.join(decisionsDir, `${requestId}.json`);
  for (;;) {
    if (now() > deadline) return done("timeout", "no decision before the deadline");
    if (!(await stillPending())) return done("stale", "the request is no longer pending");
    let text = null;
    try { text = await fs.readFile(file, "utf8"); } catch (e) { if (e.code !== "ENOENT") throw e; }
    if (text !== null) {
      await fs.rename(file, path.join(decisionsDir, `${requestId}.used.json`));
      let obj = null;
      try { obj = JSON.parse(text); } catch {}
      if (obj?.requestId !== requestId || !DECISIONS.has(obj?.decision) || typeof obj?.reason !== "string" || !obj.reason.trim()) {
        return done("stop", `invalid decision file: ${text.slice(0, 200)}`);
      }
      if (obj.decision === "stop") return done("stop", obj.reason, obj);
      if (!(await stillPending())) return done("stale", "the request is no longer pending");
      decided.add(requestId);
      return done("allow_once", obj.reason, obj);
    }
    await pause(500);
  }
}
