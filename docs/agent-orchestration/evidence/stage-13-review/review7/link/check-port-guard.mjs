// launch() refuses a port another DevTools server already answers on (it would drive that window instead).
import http from "node:http"; import assert from "node:assert/strict";
import { launch } from "../../../../../../scripts/orchestration-app-kit.mjs";
const s = http.createServer((q, r) => r.end("{}")).listen(9699);
await new Promise((r) => s.once("listening", r));
await assert.rejects(launch({ userData: "/nonexistent", port: 9699, shots: "/tmp" }), /port 9699 is taken/);
s.close(); console.log("port guard ok");
