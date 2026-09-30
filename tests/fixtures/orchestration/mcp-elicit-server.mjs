// A local MCP server for the stage 13 real series S4 (stdio, newline-delimited JSON-RPC 2.0, no dependencies). One
// tool, `release_ticket`, asks the person a form through the client (elicitation/create) and logs everything to the
// JSON-lines file MCP_ELICIT_LOG:
//   {type:"initialize", client, protocolVersion, elicitation}  — a CLI started the server (it is loaded, not used)
//   {type:"call", client, component, nonce, action, content, valid, errors} — the tool was called and the form answered
//   {type:"call_failed", client, component, nonce, error}       — the client refused or does not support the form
// Proof of use is a "call" line whose nonce the agent wrote into the project: the nonce is made at call time and only
// the tool's result carries it. The server validates the answer against its own schema independently of the client.
//   node mcp-elicit-server.mjs               the server
//   node mcp-elicit-server.mjs --self-check  runs itself under a tiny client: accept, decline, an invalid answer
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SCHEMA = {
  type: "object",
  required: ["ticket", "env"],
  properties: {
    ticket: { type: "string", title: "Ticket", description: "At least 4 characters, e.g. REL-42", minLength: 4, maxLength: 20 },
    env: { type: "string", title: "Environment", enum: ["qa", "stage"] },
    reviewers: { type: "integer", title: "Reviewers", minimum: 1, maximum: 5 },
    urgent: { type: "boolean", title: "Urgent", default: false }
  }
};

export function validate(content) {
  const errors = {};
  const c = content && typeof content === "object" ? content : {};
  for (const k of Object.keys(c)) if (!SCHEMA.properties[k]) errors[k] = "unknown";
  for (const k of SCHEMA.required) if (c[k] === undefined || c[k] === "") errors[k] = "required";
  if (c.ticket !== undefined && (typeof c.ticket !== "string" || c.ticket.length < 4 || c.ticket.length > 20)) errors.ticket = "4..20 characters";
  if (c.env !== undefined && !SCHEMA.properties.env.enum.includes(c.env)) errors.env = "qa or stage";
  if (c.reviewers !== undefined && !(Number.isInteger(c.reviewers) && c.reviewers >= 1 && c.reviewers <= 5)) errors.reviewers = "integer 1..5";
  if (c.urgent !== undefined && typeof c.urgent !== "boolean") errors.urgent = "boolean";
  return errors;
}

function server() {
  const logFile = process.env.MCP_ELICIT_LOG;
  const log = (o) => { if (logFile) fs.appendFileSync(logFile, `${JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, ...o })}\n`); };
  const send = (o) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...o })}\n`);
  let client = null, protocolVersion = "2025-06-18", elicitation = false, nextId = 1;
  const waiting = new Map();
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => {
    buf += d;
    for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.method === undefined && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); continue; }
      void handle(m);
    }
  });
  process.stdin.on("end", () => process.exit(0));
  const ask = (method, params) => { const id = `srv-${nextId++}`; return { id, reply: new Promise((resolve) => { waiting.set(id, resolve); send({ id, method, params }); }) }; };

  async function handle(m) {
    const reply = (result) => send({ id: m.id, result });
    switch (m.method) {
      case "initialize":
        client = m.params?.clientInfo ?? null;
        protocolVersion = typeof m.params?.protocolVersion === "string" ? m.params.protocolVersion : protocolVersion;
        elicitation = !!m.params?.capabilities?.elicitation;
        log({ type: "initialize", client, protocolVersion, elicitation });
        return reply({ protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "release-form", version: "1.0.0" } });
      case "ping": return reply({});
      case "tools/list":
        return reply({ tools: [{ name: "release_ticket", description: "Asks the person for the release ticket of a component (a form) and returns a receipt with a nonce.",
          inputSchema: { type: "object", required: ["component"], properties: { component: { type: "string" } } } }] });
      case "tools/call": {
        const component = String(m.params?.arguments?.component ?? "");
        const nonce = randomBytes(6).toString("hex");
        if (m.params?.name !== "release_ticket") return send({ id: m.id, error: { code: -32602, message: "unknown tool" } });
        // asked even when the client did not announce the capability: the log shows what the client then does. The
        // call's nonce is in the form's message: the form the person sees is tied to this call exactly.
        const q = ask("elicitation/create", { message: `Release ticket for ${component || "the change"} (call ${nonce})`, requestedSchema: SCHEMA,
          ...(protocolVersion >= "2025-11-25" ? { mode: "form" } : {}) });
        const elicitId = q.id;
        const r = await q.reply;
        if (r.error || !r.result) {
          const text = `RELEASE-FORM nonce=${nonce} error=${r.error?.message ?? "no result"}`;
          log({ type: "call_failed", client, component, nonce, elicitId, elicitationAnnounced: elicitation, error: r.error ?? "no result", text });
          return reply({ content: [{ type: "text", text }], isError: true });
        }
        const { action, content = null } = r.result;
        const errors = action === "accept" ? validate(content) : {};
        const valid = Object.keys(errors).length === 0;
        const text = action === "accept"
          ? `RELEASE-FORM nonce=${nonce} component=${component} action=accept ticket=${content?.ticket} env=${content?.env}${valid ? "" : " INVALID"}`
          : `RELEASE-FORM nonce=${nonce} component=${component} action=${action}`;
        // text: the tool's result line exactly as returned (receipts are compared with it whole)
        log({ type: "call", client, component, nonce, elicitId, elicitationAnnounced: elicitation, action, content, valid, errors, text });
        return reply({ content: [{ type: "text", text }], isError: !valid });
      }
      default:
        if (m.id !== undefined) send({ id: m.id, error: { code: -32601, message: `release-form: ${m.method}` } });
    }
  }
}

// A tiny client: the server as the CLIs start it; each answer given to the form in turn.
async function selfCheck() {
  const logFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mcp-elicit-")), "log.jsonl");
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], { env: { ...process.env, MCP_ELICIT_LOG: logFile }, stdio: ["pipe", "pipe", "inherit"] });
  const answers = [{ action: "accept", content: { ticket: "REL-42", env: "qa", reviewers: 2 } }, { action: "decline" }, { action: "accept", content: { ticket: "R", env: "prod" } }];
  const pending = new Map();
  let buf = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (d) => {
    buf += d;
    for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
      const m = JSON.parse(buf.slice(0, nl)); buf = buf.slice(nl + 1);
      if (m.method === "elicitation/create") child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: m.id, result: answers.shift() })}\n`);
      else pending.get(m.id)?.(m);
    }
  });
  let id = 0;
  const call = (method, params) => new Promise((resolve) => { pending.set(++id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`); });
  const init = await call("initialize", { protocolVersion: "2025-06-18", capabilities: { elicitation: {} }, clientInfo: { name: "self-check", version: "0" } });
  const texts = [];
  for (const component of ["api", "web", "cli"]) texts.push((await call("tools/call", { name: "release_ticket", arguments: { component } })).result.content[0].text);
  child.stdin.end();
  await new Promise((r) => child.once("exit", r));
  const lines = fs.readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const calls = lines.filter((l) => l.type === "call");
  const ok = init.result.serverInfo.name === "release-form" && lines[0].type === "initialize" && lines[0].elicitation === true
    && calls.length === 3 && calls[0].action === "accept" && calls[0].valid && calls[1].action === "decline" && calls[2].valid === false
    && calls.every((c, i) => texts[i].includes(`nonce=${c.nonce}`));
  process.stdout.write(`${JSON.stringify({ ok, texts, log: lines }, null, 2)}\n`);
  process.exitCode = ok ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--self-check")) await selfCheck(); else server();
}
