// What the installed CLIs can do now, probed without a model call — never a list of versions to keep up to date (CLIs
// update all the time; a new version with the same switches and protocol works as the old one did).
//   Claude: its own --help (the switches a run passes) and, for «Рабочая папка», a session started with exactly those
//     switches that answers the control protocol's initialize (no user message: no model call).
//   Codex: the JSON Schema of its app-server protocol (`codex app-server generate-json-schema`, written to a temporary
//     folder): the methods, thread parameters, sandbox modes and approval policies a run uses. No thread is started:
//     thread/start writes the folder's trust into config.toml.
// A rights mode the CLI does not offer is never replaced by another on the quiet: start and readiness refuse it by the
// same rule (startProblems), naming the CLI, its version and what is missing.
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile, mkdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import readline from "node:readline";
import type { OrchestrationReadinessItem } from "../../../shared/orchestration.ts";
import { claudeAccessArgs, claudeModesFromHelp } from "./access.ts";
import type { AgentAccess, ClaudeAccess, CodexAccess } from "./access.ts";
import { parseCliVersion } from "./providers.ts";

// Why a mode or a feature is not offered (the renderer says it in words by this code):
// no_choice — --help lists no such --permission-mode choice; no_settings — no --settings switch; no_skip — no
// --dangerously-skip-permissions; init_refused — a session with the mode's switches did not start (detail: what the CLI
// said); schema_unavailable — the protocol schema could not be read; schema_missing — the schema lacks it (detail: what);
// no_model — the model cannot be passed.
export type CapabilityWhy = "no_choice" | "no_settings" | "no_skip" | "init_refused" | "schema_unavailable" | "schema_missing" | "no_model";
export interface CliCapability {
  provider: "codex" | "claude";
  version: string; // the version as parsed from --version ("0.160.0"), else the line
  modes: string[]; // the rights modes offered now ("terminal" always: it passes nothing)
  missing: Record<string, { why: CapabilityWhy; detail: string }>; // per mode not offered, and "model"
  model: boolean; // a role's model can be passed (Codex thread `model`, claude --model)
  differences: string[]; // what the application relies on and this version changed (English, short): the warning
}
export type Capabilities = Record<"codex" | "claude", CliCapability>;

// ---------- Claude ----------

// The switches a run of Claude passes (providers.ts buildNativeTurn): -p with stream-json in and out, the host's
// permission prompts, the report's JSON schema, its own session id.
const CLAUDE_SWITCHES = ["--input-format", "--output-format", "--verbose", "--permission-prompt-tool", "--json-schema", "--session-id", "--resume"];
const MODE_NEEDS: Record<ClaudeAccess, CapabilityWhy> = { terminal: "no_choice", workspace: "no_settings", acceptEdits: "no_choice", auto: "no_choice", full: "no_skip" };

export type ClaudeInit = (args: string[]) => Promise<{ ok: true } | { ok: false; error: string }>;
export async function probeClaude(input: { version: string; help: string; init: ClaudeInit }): Promise<CliCapability> {
  const version = parseCliVersion("claude", input.version) ?? input.version.trim().slice(0, 60);
  const has = (flag: string) => new RegExp(`(?:^|[\\s,])${flag.replace(/[-]/g, "\\-")}\\b`, "m").test(input.help);
  const offered = claudeModesFromHelp(input.help);
  const missing: CliCapability["missing"] = {};
  for (const m of ["workspace", "acceptEdits", "auto", "full"] as ClaudeAccess[]) {
    if (!offered.includes(m)) missing[m] = { why: m === "workspace" && /choices:[^)]*"acceptEdits"/.test(input.help) ? "no_settings" : MODE_NEEDS[m], detail: m === "full" ? "--dangerously-skip-permissions" : m === "workspace" ? "--settings" : `--permission-mode ${m}` };
  }
  // «Рабочая папка» is offered only when a session with its switches (acceptEdits, the sandbox settings) really starts
  if (offered.includes("workspace")) {
    const r = await input.init(claudeAccessArgs("workspace"));
    if (!r.ok) missing.workspace = { why: "init_refused", detail: r.error.slice(0, 200) };
  }
  const model = has("--model");
  if (!model) missing.model = { why: "no_model", detail: "--model" };
  return {
    provider: "claude", version, modes: offered.filter((m) => !missing[m]), missing, model,
    differences: CLAUDE_SWITCHES.filter((f) => !has(f)).map((f) => `no ${f} in --help`)
  };
}

// The control protocol's initialize in a session started with `args` (no user message, so no model call), in an empty
// folder: the project's own settings and hooks are not involved.
export function claudeInit(executable: string, env: Readonly<Record<string, string>>, timeoutMs = 30_000): ClaudeInit {
  return async (args) => {
    const cwd = await mkdtemp(join(tmpdir(), "canvastty-claude-probe-"));
    try {
      const p = spawn(executable, ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--permission-prompt-tool", "stdio", ...args],
        { cwd, env: { ...env }, stdio: ["pipe", "pipe", "pipe"] });
      let err = "";
      p.stderr.setEncoding("utf8").on("data", (d: string) => { if (err.length < 4000) err += d; });
      p.stdin.on("error", () => {});
      const answer = await new Promise<{ ok: true } | { ok: false; error: string }>((resolve) => {
        const timer = setTimeout(() => resolve({ ok: false, error: "no answer to initialize" }), timeoutMs);
        const done = (r: { ok: true } | { ok: false; error: string }) => { clearTimeout(timer); resolve(r); };
        readline.createInterface({ input: p.stdout }).on("line", (line) => {
          let m: { type?: unknown; response?: { subtype?: unknown; request_id?: unknown; error?: unknown } };
          try { m = JSON.parse(line); } catch { return; }
          if (m.type === "control_response" && m.response?.request_id === "capability-probe") {
            done(m.response.subtype === "success" ? { ok: true } : { ok: false, error: String(m.response.error ?? "refused") });
          }
        });
        p.once("error", (e) => done({ ok: false, error: e.message }));
        p.once("exit", (code) => done({ ok: false, error: (err.trim().split("\n")[0] || `exited ${code}`) }));
        p.stdin.write(`${JSON.stringify({ type: "control_request", request_id: "capability-probe", request: { subtype: "initialize" } })}\n`);
      });
      p.stdin.end();
      const killer = setTimeout(() => p.kill("SIGKILL"), 5_000);
      await new Promise((r) => { if (p.exitCode !== null || p.signalCode !== null) r(null); else p.once("exit", r); });
      clearTimeout(killer);
      return answer;
    } finally {
      await rm(cwd, { recursive: true, force: true }).catch(() => {});
    }
  };
}

// ---------- Codex ----------

// What a run of Codex uses of the app-server protocol (sessions.ts, probe.ts).
const CODEX_METHODS = ["initialize", "thread/start", "thread/resume", "turn/start", "model/list", "config/read"];
const CODEX_NOTIFICATIONS = ["thread/started", "turn/completed", "item/started", "item/completed"];
const CODEX_REQUESTS = ["item/commandExecution/requestApproval", "item/fileChange/requestApproval"];
const THREAD_PARAMS = ["cwd", "sandbox", "approvalPolicy", "model", "config"];
const TURN_PARAMS = ["threadId", "input", "outputSchema"];

export type CodexSchema = (dir: string) => Promise<{ ok: true } | { ok: false; error: string }>;
export function codexSchema(executable: string, env: Readonly<Record<string, string>>): CodexSchema {
  return (dir) => new Promise((resolve) => {
    execFile(executable, ["app-server", "generate-json-schema", "--out", dir], { env: { ...env }, timeout: 30_000, maxBuffer: 1024 * 1024 }, (error, _out, stderr) => {
      resolve(error ? { ok: false, error: (String(stderr).trim().split("\n")[0] || error.message).slice(0, 200) } : { ok: true });
    });
  });
}

export async function probeCodex(input: { version: string; schema: CodexSchema }): Promise<CliCapability> {
  const version = parseCliVersion("codex", input.version) ?? input.version.trim().slice(0, 60);
  const dir = await mkdtemp(join(tmpdir(), "canvastty-codex-schema-"));
  const no = (why: CapabilityWhy, detail: string): CliCapability => ({
    provider: "codex", version, modes: ["terminal"], model: false, differences: [`the app-server protocol could not be read: ${detail}`],
    missing: { workspace: { why, detail }, full: { why, detail }, model: { why, detail } }
  });
  try {
    const made = await input.schema(dir);
    if (!made.ok) return no("schema_unavailable", made.error);
    const json = async (rel: string): Promise<unknown> => JSON.parse(await readFile(join(dir, rel), "utf8"));
    const text = async (rel: string): Promise<string> => readFile(join(dir, rel), "utf8").catch(() => "");
    let start: Record<string, unknown>, resume: Record<string, unknown>, turn: Record<string, unknown>;
    try {
      [start, resume, turn] = await Promise.all(["v2/ThreadStartParams.json", "v2/ThreadResumeParams.json", "v2/TurnStartParams.json"].map((f) => json(f) as Promise<Record<string, unknown>>));
    } catch (e) {
      return no("schema_unavailable", `v2 thread schema: ${String((e as Error).message).slice(0, 120)}`);
    }
    const props = (s: Record<string, unknown>) => Object.keys((s.properties ?? {}) as object);
    const defs = JSON.stringify(start.definitions ?? start.$defs ?? {});
    const values = (name: string) => new RegExp(`"${name}":\\{[^}]*?"enum":\\[([^\\]]*)\\]`).exec(defs)?.[1] ?? "";
    const sandbox = values("SandboxMode"), approval = values("AskForApproval");
    const named = async (rel: string, names: readonly string[]) => { const t = await text(rel); return names.filter((n) => !t.includes(`"${n}"`)); };
    const differences = [
      ...(await named("ClientRequest.json", CODEX_METHODS)).map((m) => `no ${m} request`),
      ...(await named("ServerNotification.json", CODEX_NOTIFICATIONS)).map((m) => `no ${m} notification`),
      ...(await named("ServerRequest.json", CODEX_REQUESTS)).map((m) => `no ${m} request from the server`),
      ...THREAD_PARAMS.filter((p) => !props(start).includes(p)).map((p) => `thread/start has no ${p}`),
      ...THREAD_PARAMS.filter((p) => !props(resume).includes(p)).map((p) => `thread/resume has no ${p}`),
      ...TURN_PARAMS.filter((p) => !props(turn).includes(p)).map((p) => `turn/start has no ${p}`)
    ];
    const missing: CliCapability["missing"] = {};
    const lacks = (needs: [string, boolean][]) => needs.filter(([, ok]) => !ok).map(([what]) => what);
    const threadRights = props(start).includes("sandbox") && props(start).includes("approvalPolicy") && props(resume).includes("sandbox") && props(resume).includes("approvalPolicy");
    const ws = lacks([["thread sandbox and approvalPolicy", threadRights], ["sandbox workspace-write", sandbox.includes('"workspace-write"')], ["approvalPolicy on-request", approval.includes('"on-request"')]]);
    const full = lacks([["thread sandbox and approvalPolicy", threadRights], ["sandbox danger-full-access", sandbox.includes('"danger-full-access"')], ["approvalPolicy never", approval.includes('"never"')]]);
    if (ws.length) missing.workspace = { why: "schema_missing", detail: ws.join(", ") };
    if (full.length) missing.full = { why: "schema_missing", detail: full.join(", ") };
    const model = props(start).includes("model") && props(resume).includes("model");
    if (!model) missing.model = { why: "no_model", detail: "thread model" };
    const modes: CodexAccess[] = ["terminal", ...(ws.length ? [] : ["workspace" as const]), ...(full.length ? [] : ["full" as const])];
    return { provider: "codex", version, modes, missing, model, differences };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------- the cache: per program, version and modification time ----------

// Kept in the application's data (one small JSON file) so a CLI is probed once per version, not on every readiness
// check: a new version or a replaced program (another mtime) is probed again at the next readiness check by itself.
export interface CapabilityKey { provider: "codex" | "claude"; executable: string; version: string }
export function createCapabilityCache(file: string, keep = 16) {
  let mem: { key: string; at: string; value: CliCapability }[] | null = null;
  const load = async () => (mem ??= await readFile(file, "utf8").then((t) => {
    const v = JSON.parse(t) as { v?: number; entries?: unknown };
    return v.v === 1 && Array.isArray(v.entries) ? v.entries as typeof mem & object : [];
  }, () => []));
  const keyOf = async (k: CapabilityKey) => {
    const real = await realpath(k.executable).catch(() => k.executable);
    const st = await stat(real).catch(() => null);
    return JSON.stringify([k.provider, real, k.version.trim(), st ? Math.round(st.mtimeMs) : 0]);
  };
  const inFlight = new Map<string, Promise<CliCapability>>();
  return {
    async get(k: CapabilityKey, probe: () => Promise<CliCapability>): Promise<CliCapability> {
      const key = await keyOf(k);
      const entries = await load();
      const hit = entries.find((e) => e.key === key);
      if (hit) return hit.value;
      const running = inFlight.get(key);
      if (running) return running;
      const p = probe().then(async (value) => {
        // a probe that could not get an answer (a timeout, an unreadable schema) is asked again next time: kept, it
        // would block every start until the next version
        if (Object.values(value.missing).some((m) => m.why === "init_refused" || m.why === "schema_unavailable")) return value;
        mem = [{ key, at: new Date().toISOString(), value }, ...(mem ?? []).filter((e) => e.key !== key)].slice(0, keep);
        await mkdir(dirname(file), { recursive: true }).catch(() => {});
        await writeFile(file, JSON.stringify({ v: 1, entries: mem })).catch(() => {});
        return value;
      }).finally(() => inFlight.delete(key));
      inFlight.set(key, p);
      return p;
    }
  };
}

// ---------- one rule for readiness and start ----------

// What would refuse the start: a rights mode of the project (or this goal's one-run choice) the CLI does not offer, a
// role's model the CLI cannot be given. Readiness shows each as a blocker; the start refuses with the same item.
export function startProblems(caps: Capabilities, access: AgentAccess | null, models: Partial<Record<"lead" | "executor" | "reviewer", string | null>>, codexRoles: readonly string[]): OrchestrationReadinessItem[] {
  const out: OrchestrationReadinessItem[] = [];
  const name = (p: "codex" | "claude") => (p === "codex" ? "Codex" : "Claude");
  for (const p of ["claude", "codex"] as const) {
    const mode = access?.[p];
    if (!mode || caps[p].modes.includes(mode)) continue;
    const m = caps[p].missing[mode] ?? { why: "no_choice" as const, detail: mode };
    out.push({
      id: `access_${p}`, level: "blocker",
      detail: `${name(p)} ${caps[p].version}: the rights mode ${mode} is not available (${m.why}: ${m.detail})`,
      facts: { provider: p, version: caps[p].version, mode, why: m.why, missing: m.detail }
    });
  }
  const codexModel = codexRoles.some((r) => !!models[r as "lead"]);
  const claudeModel = !!models.executor;
  for (const [p, wanted] of [["codex", codexModel], ["claude", claudeModel]] as const) {
    if (!wanted || caps[p].model) continue;
    out.push({ id: `model_${p}_pass`, level: "blocker", detail: `${name(p)} ${caps[p].version}: a model cannot be passed`, facts: { provider: p, version: caps[p].version, why: "no_model", missing: caps[p].missing.model?.detail ?? "" } });
  }
  return out;
}

// The readiness item of the CLIs: ok when everything a run relies on is there; a warning that names what changed.
export function clisItem(caps: Capabilities): OrchestrationReadinessItem {
  const changed = (["codex", "claude"] as const).flatMap((p) => caps[p].differences.map((d) => `${p === "codex" ? "Codex" : "Claude"} ${caps[p].version}: ${d}`));
  const facts = { codex: caps.codex.version, claude: caps.claude.version };
  return changed.length
    ? { id: "clis", level: "warning", detail: `the protocol differs: ${changed.join("; ")}`.slice(0, 600), facts: { ...facts, changes: changed.join("\n").slice(0, 600) } }
    : { id: "clis", level: "ok", detail: "installed CLIs: everything a run relies on is there", facts };
}
