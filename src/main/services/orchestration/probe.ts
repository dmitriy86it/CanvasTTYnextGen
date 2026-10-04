// Stage 13: "Environment" — what each CLI itself says it loaded for the project, asked through its own protocol
// without a model turn (no user message is sent). Started only by the person (a button), never by a run or a test of
// the application: the CLIs start the user's MCP servers and hooks as they do in a terminal. What a CLI does not say
// is reported as not confirmed; the absence of narrowing flags is never presented as proof of equality.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import type { OrchestrationCodexModels, OrchestrationEnvironmentItem, OrchestrationListIncomplete, OrchestrationMcpReadiness, OrchestrationMcpServer, OrchestrationProbeOutcome, OrchestrationProbeTiming } from "../../../shared/orchestration.ts";

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const s = (v: unknown): string => (typeof v === "string" ? v : "");
// A CLI's own error text shown to the person: credentials in it are masked (auth headers, key=value, user:pass@ in
// addresses, long token-like runs), and it is cut short. The CLI's stderr is never shown: it is raw output.
export function cliText(v: unknown): string {
  return s(v)
    .replace(/\b(Bearer|Basic|Token)\s+\S+/gi, "$1 <hidden>")
    .replace(/\b([\w-]*(?:token|key|secret|password|passwd|auth|credential|cookie)[\w-]*)(\s*["']?\s*[:=]\s*["']?)[^\s"',;&]+/gi, "$1$2<hidden>")
    .replace(/(\/\/)[^\s/@:]+:[^\s/@]+@/g, "$1<hidden>@")
    .replace(/[A-Za-z0-9_\-+/=.~]{24,}/g, (m) => (/^[~/][\w./~-]*$/.test(m) ? m : "<hidden>")) // an absolute path stays
    .slice(0, 200);
}
const names = (list: unknown[], key = "name", max = 30): string => {
  const n = list.map((x) => s(rec(x)[key]) || s(x)).filter(Boolean);
  return n.length ? `${n.length}: ${n.slice(0, max).join(", ")}${n.length > max ? ", …" : ""}` : "0";
};

// "found N, enabled M: names of the enabled", with the load errors the CLI reported.
function found(list: unknown[], enabled: (x: Record<string, unknown>) => boolean, key: string, errors: number): { value: string; note?: string } {
  const on = list.filter((x) => enabled(rec(x)));
  const value = list.length === on.length ? names(on, key) : `found ${list.length}, enabled ${on.length}${on.length ? `: ${names(on, key).replace(/^\d+: /, "")}` : ""}`;
  return { value, ...(errors ? { note: `${errors} could not be loaded` } : {}) };
}

export interface ProbeInput { executable: string; args?: string[]; cwd: string; env: Record<string, string>; timeoutMs?: number }
export interface ProbeResult { ok: boolean; error: string | null; items: OrchestrationEnvironmentItem[]; readiness?: OrchestrationMcpReadiness; timing: OrchestrationProbeTiming[]; limitMs: number }

// One deadline for a whole probe of one CLI (every request and page gets what is left of it), measured on a monotonic
// clock. CLEANUP_MS only bounds the ending of the CLI's processes after it: no request is sent in it.
// PROBE_MS, measured on the person's project (2026-09-27, Codex 0.155.1, 11 MCP servers): the whole Codex probe took
// 5.2 s, of it mcpServerStatus/list 3.8 s and everything else under 1.3 s; in the first real S7 the same list gave no
// answer within the 15 s it was then given (half of 30 s), the cause not established. 60 s is four times that window.
// PROBE_MS counts from the CLI's start; before it the app may wait for the CLIs' versions (20 s), the login shell (15 s)
// and direnv (2 × 15 s): at worst 20 + 15 + 30 + 60 + CLEANUP_MS = 130 s, under the series driver's 150 s wait.
export const PROBE_MS = 60_000;
export const CLEANUP_MS = 5_000;
const now = () => performance.now();
type Ended = Exclude<OrchestrationProbeOutcome, "answered" | "protocol_error">;
// Why a request gave no usable answer: the CLI refused it, or one of the ends of its time (see OrchestrationProbeTiming).
type Failed = { ok: false; error: string; why: "refused" | Ended };
// late: an answer handled at the deadline itself (a wait ends at the deadline, so an answer that comes later finds no
// waiter and is wait_expired: whether it would have come is not known).
const ENDED: Record<Ended, string> = { wait_expired: "no answer in time", late: "answered after the deadline", cli_exited: "the CLI exited", not_sent: "not asked: the time was up" };

// Tool names as a CLI lists them: an array of {name} or of names, or an object keyed by name.
const toolNames = (v: unknown): string[] => (Array.isArray(v) ? v.map((t) => s(rec(t).name) || s(t)).filter(Boolean) : Object.keys(rec(v)));
// Codex mcpServerStatus/list entries. runtimeStatus exists only inside a thread; authStatus is sign-in ("unsupported":
// the server has none) and is never taken for the connection.
export const codexMcpServers = (list: unknown[]): OrchestrationMcpServer[] => list.map((x) => {
  const r = rec(x);
  return { name: s(r.name), connection: s(r.runtimeStatus) || null, auth: s(r.authStatus) || null, tools: toolNames(r.tools) };
});
// The project layer of config/read {includeLayers} for this folder: its <cwd>/.codex, and why Codex left it off.
// Any disabledReason Codex gives (not only a string) leaves the layer off: never taken for a loaded one.
export function codexProjectLayer(layers: unknown[], cwd: string): { state: "enabled" | "disabled" | "absent"; disabledReason: string | null; mcpServers: string[] } {
  const l = layers.map(rec).find((x) => s(rec(x.name).type) === "project" && resolve(s(rec(x.name).dotCodexFolder)) === resolve(cwd, ".codex"));
  if (!l) return { state: "absent", disabledReason: null, mcpServers: [] };
  const off = l.disabledReason !== undefined && l.disabledReason !== null && l.disabledReason !== false;
  const why = off ? cliText(typeof l.disabledReason === "string" ? l.disabledReason : JSON.stringify(l.disabledReason)) || "disabled" : null;
  return { state: off ? "disabled" : "enabled", disabledReason: why, mcpServers: Object.keys(rec(rec(l.config).mcp_servers)) };
}
const RUNTIME_SETTLED = new Set(["connected", "failed", "authenticationRequired", "disabled"]);

// A JSON-lines conversation with a child, under the probe's one deadline: send, and wait for a matching reply line.
function conversation(input: ProbeInput, argv: string[]) {
  const t0 = now();
  const limitMs = input.timeoutMs ?? PROBE_MS;
  const until = t0 + limitMs;
  // spent: a wait bounded by the deadline has ended, so the deadline has come. Node's timers count whole milliseconds of
  // a cached clock and may fire up to ~2 ms before performance.now() reaches `until`; that sliver is not time to ask in.
  let spent = false;
  const left = () => (spent ? 0 : until - now());
  const timing: OrchestrationProbeTiming[] = [];
  const child = spawn(input.executable, argv, { cwd: input.cwd, env: input.env, stdio: ["pipe", "pipe", "pipe"], detached: true });
  const waiters: { match: (m: Record<string, unknown>) => boolean; resolve: (m: Record<string, unknown>) => void }[] = [];
  let buf = "";
  let exited = false;
  const closed = new Promise<void>((resolve) => child.on("close", () => { exited = true; for (const w of waiters.splice(0)) w.resolve({ __closed: true }); resolve(); }));
  child.on("error", () => { exited = true; for (const w of waiters.splice(0)) w.resolve({ __closed: true }); });
  child.stderr!.resume(); // drained, never kept: raw output
  child.stdout!.on("data", (d: Buffer) => {
    buf += d.toString("utf8");
    for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      let m: Record<string, unknown>;
      try { m = JSON.parse(line); } catch { continue; }
      const i = waiters.findIndex((w) => w.match(m));
      if (i >= 0) waiters.splice(i, 1)[0].resolve(m);
    }
  });
  child.stdin!.on("error", () => {});
  const kill = () => { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* gone */ } };
  const hardStop = setTimeout(kill, limitMs + CLEANUP_MS);
  const wait = (match: (m: Record<string, unknown>) => boolean, ms: number) => new Promise<Record<string, unknown> | "expired" | "exited">((resolve) => {
    if (exited) return resolve("exited");
    const t = setTimeout(() => { const i = waiters.findIndex((w) => w.resolve === done); if (i >= 0) waiters.splice(i, 1); resolve("expired"); }, ms);
    const done = (m: Record<string, unknown>) => { clearTimeout(t); resolve(m.__closed ? "exited" : m); };
    waiters.push({ match, resolve: done });
  });
  const ms = (v: number) => Math.max(0, Math.round(v));
  return {
    limitMs, timing, left, until,
    send: (m: unknown) => { if (!exited) child.stdin!.write(`${JSON.stringify(m)}\n`); },
    // One timed request: sent only while time is left, waits at most `max` and never past the deadline; an answer at or
    // after the deadline is not used. refused(m): the CLI answered with an error.
    async request(method: string, page: number | null, send: () => void, match: (m: Record<string, unknown>) => boolean,
      refused: (m: Record<string, unknown>) => boolean, max = Infinity): Promise<{ m: Record<string, unknown> } | { end: Ended }> {
      const start = now();
      const rest = left();
      const allotted = Math.min(max, rest); // the callers' `max` is the deadline's remainder taken a moment earlier: >= rest
      const done = <T>(outcome: OrchestrationProbeOutcome, r: T): T => {
        timing.push({ method, page, startMs: ms(start - t0), durationMs: ms(now() - start), allottedMs: ms(allotted), leftMs: ms(left()), outcome });
        return r;
      };
      if (allotted <= 0) return done("not_sent", { end: "not_sent" as const });
      send();
      const m = await wait(match, allotted);
      if (m === "expired") {
        if (max >= rest) spent = true; // this wait was the deadline's own
        return done("wait_expired", { end: "wait_expired" as const });
      }
      if (m === "exited") return done("cli_exited", { end: "cli_exited" as const });
      if (left() <= 0) return done("late", { end: "late" as const });
      return done(refused(m) ? "protocol_error" : "answered", { m });
    },
    async end() {
      clearTimeout(hardStop);
      child.stdin!.end();
      await Promise.race([closed, new Promise((r) => setTimeout(r, CLEANUP_MS))]);
      kill();
    }
  };
}
const failed = (r: { end: Ended }): Failed => ({ ok: false, error: ENDED[r.end], why: r.end });
// The list's code when a request gave nothing usable: the time, the CLI's exit, or its refusal.
const listCode = (why: Failed["why"], refused: OrchestrationListIncomplete): OrchestrationListIncomplete =>
  (why === "refused" ? refused : why === "cli_exited" ? "cli_exited" : "timeout");

// Claude: `initialize` and `mcp_status` of the host control protocol; no user message, so no model turn.
export async function probeClaude(input: ProbeInput): Promise<ProbeResult> {
  const c = conversation(input, ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
    "--permission-prompt-tool", "stdio", ...(input.args ?? [])]);
  const items: OrchestrationEnvironmentItem[] = [];
  const ask = async (subtype: string): Promise<{ ok: true; value: Record<string, unknown> } | Failed> => {
    const id = randomUUID();
    const r = await c.request(subtype, null, () => c.send({ type: "control_request", request_id: id, request: { subtype } }),
      (x) => x.type === "control_response" && rec(x.response).request_id === id, (x) => rec(x.response).subtype !== "success");
    if ("end" in r) return failed(r);
    const a = rec(r.m.response);
    return a.subtype === "success" ? { ok: true, value: rec(a.response) } : { ok: false, error: cliText(a.error) || "refused", why: "refused" };
  };
  const done = (r: Omit<ProbeResult, "timing" | "limitMs">): ProbeResult => ({ ...r, timing: c.timing, limitMs: c.limitMs });
  try {
    const init = await ask("initialize");
    if (!init.ok) return done({ ok: false, error: `initialize: ${init.error}`, items });
    const v = init.value;
    items.push({ id: "commands", value: names(arr(v.commands)), confirmed: true });
    items.push({ id: "agents", value: names(arr(v.agents)), confirmed: true });
    items.push({ id: "models", value: String(arr(v.models).length), confirmed: true });
    const acct = rec(v.account);
    const kind = s(acct.subscriptionType) || s(acct.apiKeySource) || s(acct.tokenSource);
    items.push(kind ? { id: "account", value: kind, confirmed: true } : { id: "account", value: "", confirmed: false, note: "the CLI did not report its account kind" });
    const mcp = await ask("mcp_status");
    // a list only when the answer has one: a missing or broken field is not an empty list
    if (mcp.ok && !Array.isArray(mcp.value.mcpServers)) items.push({ id: "mcp", value: "", confirmed: false, complete: false, incomplete: "no_list" });
    else if (mcp.ok) {
      const servers = arr(mcp.value.mcpServers);
      items.push({ id: "mcp", value: servers.length ? servers.map((x) => `${s(rec(x).name)} (${s(rec(x).status)})`).join(", ") : "0", confirmed: true, complete: true,
        servers: servers.map((x) => ({ name: s(rec(x).name), connection: s(rec(x).status) || null, auth: null, tools: toolNames(rec(x).tools) })) });
      const auth = servers.filter((x) => /auth/i.test(s(rec(x).status))).map((x) => s(rec(x).name));
      if (auth.length) items.push({ id: "mcp_auth", value: auth.join(", "), confirmed: true, note: "needs sign-in: /mcp in a terminal" });
    } else items.push({ id: "mcp", value: "", confirmed: false, complete: false, incomplete: listCode(mcp.why, "request_failed"), note: mcp.error });
    items.push({ id: "skills", value: "", confirmed: false, note: "listed by the CLI at session start (system init), not here" });
    return done({ ok: true, error: null, items });
  } finally {
    await c.end();
  }
}

// Codex: app-server lists — config, skills, plugins, MCP servers, hooks, account — without a thread or a turn.
// ready: also check that this project MCP server connects (see codexReadiness).
export async function probeCodex(input: ProbeInput, ready?: string): Promise<ProbeResult> {
  const c = conversation(input, ["app-server"]);
  const items: OrchestrationEnvironmentItem[] = [];
  let next = 1;
  // ms: at most this long (never past the probe's deadline); page: the page of a list, for the timing only
  const call: Call = async (method, params, ms, page = null) => {
    const id = next++;
    const r = await c.request(method, page, () => c.send({ id, method, params }), (x) => x.id === id && !("method" in x), (x) => x.error !== undefined, ms);
    if ("end" in r) return failed(r);
    return r.m.error !== undefined ? { ok: false, error: cliText(rec(r.m.error).message) || "refused", why: "refused" } : { ok: true, value: rec(r.m.result) };
  };
  const done = (r: Omit<ProbeResult, "timing" | "limitMs">): ProbeResult => ({ ...r, timing: c.timing, limitMs: c.limitMs });
  const until = c.until;
  try {
    const init = await call("initialize", { clientInfo: { name: "canvastty", title: "Raoden Loom", version: "probe" }, capabilities: null });
    if (!init.ok) return done({ ok: false, error: `initialize: ${init.error}`, items });
    c.send({ method: "initialized" });
    const cfg = await call("config/read", { includeLayers: false, cwd: input.cwd });
    if (cfg.ok) {
      const conf = rec(cfg.value.config);
      items.push({ id: "model", value: s(conf.model) || "(default)", confirmed: true });
      items.push({ id: "approval", value: s(conf.approval_policy) || (conf.approval_policy ? JSON.stringify(conf.approval_policy).slice(0, 200) : "(default)"), confirmed: true });
      items.push({ id: "sandbox", value: s(conf.sandbox_mode) || "(default)", confirmed: true });
      if (s(conf.profile)) items.push({ id: "profile", value: s(conf.profile), confirmed: true });
    } else items.push({ id: "model", value: "", confirmed: false, note: cfg.error });
    // Found is not loaded: a disabled skill or plugin, and a hook that is disabled or not trusted, do not run.
    const lists: [string, string, unknown, (v: Record<string, unknown>) => { value: string; note?: string }][] = [
      ["skills", "skills/list", { cwds: [input.cwd] }, (v) => found(arr(v.data).flatMap((e) => arr(rec(e).skills)), (x) => x.enabled !== false, "name",
        arr(v.data).flatMap((e) => arr(rec(e).errors)).length)],
      ["plugins", "plugin/installed", { cwds: [input.cwd] }, (v) => found(arr(v.marketplaces).flatMap((m) => arr(rec(m).plugins)).filter((p) => rec(p).installed === true),
        (x) => x.enabled !== false, "name", arr(v.marketplaceLoadErrors).length)],
      ["hooks", "hooks/list", { cwds: [input.cwd] }, (v) => found(arr(v.data).flatMap((e) => arr(rec(e).hooks)),
        (x) => x.enabled !== false && x.trustStatus !== "untrusted" && x.trustStatus !== "modified", "eventName", arr(v.data).flatMap((e) => arr(rec(e).errors)).length)],
      ["account", "account/read", {}, (v) => ({ value: s(rec(v.account).type) + (s(rec(v.account).planType) ? ` (${s(rec(v.account).planType)})` : "") })]
    ];
    for (const [id, method, params, show] of lists) {
      const r = await call(method, params);
      if (!r.ok) { items.push({ id, value: "", confirmed: false, note: r.error }); continue; }
      const shown = show(r.value);
      items.push({ id, value: shown.value || "(none)", confirmed: true, ...(shown.note ? { note: shown.note } : {}) });
    }
    // MCP servers: every page of the list, not only the first.
    const list = await codexMcpList(call, {}, until);
    const mcp = codexMcpServers(list.servers);
    // complete: the CLI's whole list; a partial one is shown, never taken for the whole (incomplete: why, as a code)
    items.splice(items.findIndex((x) => x.id === "hooks"), 0, list.incomplete !== null && list.servers.length === 0
      ? { id: "mcp", value: "", confirmed: false, complete: false, incomplete: list.incomplete, note: list.error ?? undefined }
      : { id: "mcp", value: mcp.map((x) => `${x.name} (${x.connection ?? "connection not checked"})`).join(", ") || "0", confirmed: true, servers: mcp,
        complete: list.incomplete === null, ...(list.incomplete !== null ? { incomplete: list.incomplete, note: "the list is incomplete" } : {}) });
    return done({ ok: true, error: null, items, ...(ready ? { readiness: await codexReadiness(call, input.cwd, ready, until) } : {}) });
  } finally {
    await c.end();
  }
}

// Does Codex connect the project's MCP server `server`? Only in a folder whose project layer Codex loads (a trusted
// one): there an ephemeral thread without a turn starts its MCP servers, and the thread's list says how each is. In an
// untrusted folder no thread is started — Codex would write the folder's trust into the person's config by itself.
// Every page of mcpServerStatus/list: at most MCP_PAGES pages, until `until`; a repeated cursor, a failed page, the
// page limit or the time ends it with an error (the servers read so far are kept for display only).
const MCP_PAGES = 20;
// `until`: the probe's deadline on the monotonic clock (performance.now()). Every request waits at most its remainder,
// checked before it is sent and again after its answer: an answer at or after the deadline is not used, and nothing is
// asked once the time is up. The error says which end it was: no answer in time, an answer after the deadline, the
// CLI's exit — never one taken for another.
type ListResult = { servers: unknown[]; error: string | null; incomplete: OrchestrationListIncomplete | null };
export async function codexMcpList(call: Call, params: Record<string, unknown>, until: number): Promise<ListResult> {
  const servers: unknown[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  const stop = (incomplete: OrchestrationListIncomplete, error: string): ListResult => ({ servers, error, incomplete });
  for (let page = 0; page < MCP_PAGES; page++) {
    const n = page + 1;
    const left = until - now();
    if (left <= 0) return stop("timeout", `timeout: page ${n} not asked`);
    const r = await call("mcpServerStatus/list", cursor ? { ...params, cursor } : params, left, n);
    const why = r.ok ? (now() >= until ? "late" : null) : r.why;
    if (why === "late") return stop("timeout", `timeout: page ${n} answered after the deadline`);
    if (why === "not_sent") return stop("timeout", `timeout: page ${n} not asked`);
    if (why === "wait_expired") return stop("timeout", `timeout: page ${n} got no answer in time`);
    if (why === "cli_exited") return stop("cli_exited", `the CLI exited before page ${n} was answered`);
    if (!r.ok) return stop(page ? "page_failed" : "request_failed", page ? `page ${n}: ${r.error}` : r.error);
    if (!Array.isArray(r.value.data)) return stop("no_list", `page ${n}: no list`);
    servers.push(...r.value.data);
    const nextCursor = r.value.nextCursor;
    if (nextCursor === undefined || nextCursor === null || nextCursor === "") return { servers, error: null, incomplete: null };
    if (typeof nextCursor !== "string") return stop("cursor_unreadable", `page ${n}: an unreadable cursor`);
    cursor = nextCursor;
    if (seen.has(cursor)) return stop("cursor_repeats", "the cursor repeats"); // the CLI's cursor itself is never shown
    seen.add(cursor);
  }
  return stop("page_limit", `more than ${MCP_PAGES} pages`);
}
type Call = (method: string, params: unknown, ms?: number, page?: number | null) => Promise<{ ok: true; value: Record<string, unknown> } | Failed>;
async function codexReadiness(call: Call, cwd: string, server: string, until: number): Promise<OrchestrationMcpReadiness> {
  const out: OrchestrationMcpReadiness = { server, projectLayer: "absent", disabledReason: null, inProjectLayer: false, inConfig: false, threadStarted: false, status: null, error: null };
  // the probe's one deadline: no request is sent after it, no answer after it is used, no readiness without time
  const left = () => until - now();
  const late = (step: string, r?: { ok: boolean; why?: string }) =>
    ({ ...out, error: `timeout: ${step} ${!r || (!r.ok && r.why === "not_sent") ? "not asked" : r.ok ? "answered after the deadline" : r.why === "cli_exited" ? "not answered: the CLI exited" : "got no answer in time"}` });
  if (left() <= 0) return late("config/read");
  const cfg = await call("config/read", { includeLayers: true, cwd }, left());
  if (left() <= 0 || (!cfg.ok && cfg.why !== "refused")) return late("config/read", cfg);
  if (!cfg.ok) return { ...out, error: `config/read: ${cfg.error}` };
  const layer = codexProjectLayer(arr(cfg.value.layers), cwd);
  out.projectLayer = layer.state;
  out.disabledReason = layer.disabledReason;
  out.inProjectLayer = layer.mcpServers.includes(server);
  out.inConfig = Object.hasOwn(rec(rec(cfg.value.config).mcp_servers), server);
  // every page (inside the thread: with its threadId on each); an incomplete list is an error, never a result
  const own = async (params: Record<string, unknown>): Promise<{ error: string } | { found: OrchestrationMcpServer | null }> => {
    const r = await codexMcpList(call, params, until);
    if (r.error !== null) return { error: r.incomplete === "timeout" ? r.error : `mcpServerStatus/list: ${r.error}` };
    const found = codexMcpServers(r.servers).filter((x) => x.name === server);
    return found.length > 1 ? { error: `${server} is listed ${found.length} times` } : { found: found[0] ?? null };
  };
  const first = await own({});
  if ("error" in first) return { ...out, error: first.error };
  out.status = first.found;
  if (layer.state !== "enabled" || !out.inProjectLayer || !out.inConfig || !first.found) return out;
  if (left() <= 0) return late("thread/start");
  const t = await call("thread/start", { cwd, ephemeral: true }, left());
  if (left() <= 0 || (!t.ok && t.why !== "refused")) return { ...late("thread/start", t), threadStarted: t.ok };
  const threadId = t.ok ? s(rec(t.value.thread).id) : "";
  if (!threadId) return { ...out, error: `thread/start: ${t.ok ? "no thread id" : t.error}` };
  out.threadStarted = true;
  for (;;) {
    const r = await own({ threadId });
    if ("error" in r) return { ...out, error: r.error };
    out.status = r.found;
    if (RUNTIME_SETTLED.has(r.found?.connection ?? "")) return out;
    if (left() <= 250) return { ...out, error: "timeout: the server's connection did not settle" };
    await new Promise((res) => setTimeout(res, 250));
  }
}

// The models Codex offers this account (model/list, every page, hidden ones included) and the model its configuration
// names for the folder (config/read). No thread, no turn: nothing is asked of a model and nothing is written.
const MODEL_PAGES = 10;
export async function codexModels(input: ProbeInput): Promise<OrchestrationCodexModels> {
  const c = conversation(input, ["app-server"]);
  let next = 1;
  const out = (r: Partial<OrchestrationCodexModels>): OrchestrationCodexModels =>
    ({ ok: false, error: null, ids: [], shown: [], configModel: null, checkedAt: new Date().toISOString(), ...r });
  const call = async (method: string, params: unknown) => {
    const id = next++;
    const r = await c.request(method, null, () => c.send({ id, method, params }), (x) => x.id === id && !("method" in x), (x) => x.error !== undefined);
    if ("end" in r) return { ok: false as const, error: `${method}: ${ENDED[r.end]}` };
    return r.m.error !== undefined ? { ok: false as const, error: `${method}: ${cliText(rec(r.m.error).message) || "refused"}` } : { ok: true as const, value: rec(r.m.result) };
  };
  try {
    const init = await call("initialize", { clientInfo: { name: "canvastty", title: "Raoden Loom", version: "models" }, capabilities: null });
    if (!init.ok) return out({ error: init.error });
    c.send({ method: "initialized" });
    const ids: string[] = [], shown: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; ; page++) {
      if (page === MODEL_PAGES) return out({ error: `model/list: more than ${MODEL_PAGES} pages` });
      const r = await call("model/list", { includeHidden: true, ...(cursor ? { cursor } : {}) });
      if (!r.ok) return out({ error: r.error });
      for (const m of arr(r.value.data).map(rec)) {
        const id = s(m.id) || s(m.model);
        if (!id || ids.includes(id)) continue;
        ids.push(id);
        if (m.hidden !== true) shown.push(id);
      }
      const nc = r.value.nextCursor;
      if (typeof nc !== "string" || nc === "" || nc === cursor) break;
      cursor = nc;
    }
    const cfg = await call("config/read", { includeLayers: false, cwd: input.cwd });
    return out({ ok: true, ids, shown, configModel: cfg.ok ? s(rec(cfg.value.config).model) || null : null, ...(cfg.ok ? {} : { error: cfg.error }) });
  } finally {
    await c.end();
  }
}
