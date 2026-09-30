// Child process for tests/orchestration-store-lock.test.mjs, started with fork() and driven over IPC.
// Requests (one at a time): {op:"open"|"delete", root, runId, barrier}, {op:"append", count}, {op:"close"}, {op:"release"}.
// Replies: {event:"ok", ...} or {event:"error", code, message}. With barrier, the lock claim first stops in
// hooks.beforeLockClaim, sends {event:"at_claim"} and waits for {op:"release"}.
import { randomUUID } from "node:crypto";
import { deleteRun, openRun } from "../../../src/main/services/orchestration/store.ts";

let writer = null;
let releaseClaim = null;
const send = (msg) => process.send(msg);
const hooks = {
  beforeLockClaim: () => new Promise((resolve) => {
    releaseClaim = resolve;
    send({ event: "at_claim" });
  })
};
const reply = async (fn) => {
  try {
    send({ event: "ok", ...(await fn()) });
  } catch (err) {
    send({ event: "error", code: err?.code ?? null, message: String(err?.message ?? err) });
  }
};

process.on("message", (msg) => {
  const options = msg.barrier ? { hooks } : {};
  if (msg.op === "open") {
    reply(async () => {
      writer = await openRun(msg.root, msg.runId, options);
      return { staleLock: writer.staleLock ?? null };
    });
  } else if (msg.op === "delete") {
    reply(async () => {
      await deleteRun(msg.root, msg.runId, options);
      return {};
    });
  } else if (msg.op === "release") {
    const release = releaseClaim;
    releaseClaim = null;
    release();
  } else if (msg.op === "append") {
    reply(async () => {
      const acked = [];
      for (let i = 0; i < msg.count; i += 1) {
        const commandId = randomUUID();
        await writer.recordCommand(commandId, "lock.probe", { i, pid: process.pid });
        acked.push({ commandId, seq: writer.state().lastSeq });
      }
      return { acked };
    });
  } else if (msg.op === "close") {
    reply(async () => {
      await writer.close();
      return {};
    });
  }
});
send({ event: "spawned", pid: process.pid });
