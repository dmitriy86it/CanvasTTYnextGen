// Provider turns for the modes proven by real probes (revision 6, series 1 and 2), plus candidate modes that run only
// when the caller asks for them explicitly (candidate: true; stage-6-contract.md §3). startProviderTurn is the one
// public way to run a provider turn: it refuses unsupported input before creating files or processes, runs the
// transport turn, and then checks the provider contract; a transport "completed" that breaks the contract is
// "contract_violation" and never allows a next turn.
// The contract check reads CLI metadata (system/init, thread.started). It is not proof of process isolation.
// Only these modes exist here; the diagnostic probe plan lives in docs/ and is not imported.
import { claudeAccessArgs, claudeSandboxExclusions, codexAccessParams } from "./access.ts";
import type { AgentAccess } from "./access.ts";
import { ACCESS_MISMATCH, type AccessMismatch } from "./activity.ts";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { AvailableProviderCli } from "../providerCliRegistry.ts";
import { providerChildProcessLaunch } from "../providerCliRegistry.ts";
import { compileSchema } from "./schema.ts";
import { claudeHostDriver, codexAppServerDriver, type AskPerson } from "./sessions.ts";
import { DEFAULT_TURN_LIMITS, checkTurnSpec, startTurn } from "./turn.ts";
import type {
  AnswerSchema,
  OrchestrationProvider,
  SupervisorLaunch,
  SupervisorTimings,
  TurnLimits,
  TurnOutcome,
  TurnReport,
  TurnResult,
  TurnObserver,
  TurnSpec,
  Frame
} from "./types.ts";

export type ProviderMode = "structured-readonly" | "structured-no-tools" | "structured-edit";

export interface ProviderModeSupport {
  mode: ProviderMode;
  status: "proven" | "candidate"; // candidate: not proven by a real series, runs only with input.candidate === true
  versions: readonly string[];
  capabilities: readonly string[];
  modelParams: Readonly<Record<string, readonly string[]>>; // allowed keys and values, checked at run time
}

// What each mode does. Nothing beyond this is claimed: no shell, no full isolation (Codex read-only can still read
// outside cwd; Claude structured-edit is CLI permission policy, not an OS boundary).
export const PROVIDER_MODES: Readonly<Record<OrchestrationProvider, readonly ProviderModeSupport[]>> = Object.freeze({
  codex: Object.freeze([Object.freeze({
    mode: "structured-readonly",
    status: "proven",
    versions: Object.freeze(["0.155.1"]),
    capabilities: Object.freeze(["structured-answer", "resume-exact-session", "sandbox-read-only"]),
    // Only "high" was used in a real run; low/medium are the documented values of model_reasoning_effort.
    modelParams: Object.freeze({ reasoningEffort: Object.freeze(["low", "medium", "high"]) })
  })]),
  claude: Object.freeze([
    Object.freeze({
      mode: "structured-no-tools",
      status: "proven",
      versions: Object.freeze(["2.1.278"]),
      capabilities: Object.freeze(["structured-answer", "resume-exact-session", "tools-structured-output-only", "no-mcp"]),
      modelParams: Object.freeze({})
    }),
    Object.freeze({
      mode: "structured-edit",
      status: "candidate",
      // Candidates only, each version named explicitly after its --help was compared with stage-6-contract.md §2
      // (2.1.281: 2026-09-24). Unknown versions are refused; listing one here proves nothing about its behaviour.
      // 2.1.282 is not listed: its probe (evidence/claude-2.1.282/) ran the native path only, not this mode.
      versions: Object.freeze(["2.1.280", "2.1.281"]),
      capabilities: Object.freeze(["structured-answer", "resume-exact-session", "edit-in-cwd-by-policy", "no-shell", "no-mcp"]),
      modelParams: Object.freeze({})
    })
  ])
});

// Claude Code 2.1.278 with `--tools "" --json-schema ... --strict-mcp-config` (no --mcp-config): proven by real K1/K2.
export const CLAUDE_EXPECTED_INIT = Object.freeze({
  tools: Object.freeze(["StructuredOutput"]) as readonly string[],
  mcpServers: Object.freeze([]) as readonly string[]
});

// Claude Code 2.1.280/2.1.281 structured-edit (candidate, hypotheses H1/H3 of stage-6-contract.md §7).
export const CLAUDE_EDIT_EXPECTED_INIT = Object.freeze({
  tools: Object.freeze(["Read", "Edit", "Write", "Glob", "Grep", "StructuredOutput"]) as readonly string[],
  mcpServers: Object.freeze([]) as readonly string[],
  permissionMode: "dontAsk"
});
const CLAUDE_EDIT_SETTINGS = JSON.stringify({ permissions: { blockReadsOutsideWorkingDirectories: true } });

export type ProviderSession = { kind: "new"; id?: string } | { kind: "resume"; id: string };

export interface ProviderTurnInput {
  cli: AvailableProviderCli;
  cliVersion: string; // first line of `<cli> --version`, measured by the caller
  mode: ProviderMode;
  candidate?: boolean; // required (true) for a mode with status "candidate"; changes nothing for a proven mode
  model?: string;
  modelParams?: Readonly<Record<string, string>>; // keys and values per the mode's PROVIDER_MODES entry
  maxBudgetUsd?: number; // claude only
  cwd: string;
  schema: unknown;
  accept?: unknown; // TurnSpec.accept
  env: Readonly<Record<string, string>>; // CLI environment; the registry PATH is the base
  task: string | Uint8Array;
  attemptDir?: string; // required for codex (schema file + report file)
  session: ProviderSession;
  limits?: TurnLimits;
  supervisor?: SupervisorTimings;
}

export type ProviderRefusal =
  | "unsupported_provider"
  | "unsupported_mode"
  | "unproven_mode"
  | "unsupported_version"
  | "unsupported_launcher"
  | "invalid_input";

export type ProviderTurnBuild =
  | { ok: true; spec: TurnSpec; sessionId: string | null; schemaFile: string | null }
  | { ok: false; reason: ProviderRefusal; detail: string };

export interface ProviderContractCheck {
  status: "verified" | "violated";
  errors: string[];
  // Bounded names only: no MCP configuration, no env, no event bodies.
  expected: { sessionId: string | null; tools?: readonly string[]; mcpServers?: readonly string[]; permissionMode?: string };
  actual: { sessionId: string | null; tools?: string[] | null; mcpServers?: string[] | null; permissionMode?: string | null };
}

export interface ProviderTurnResult {
  outcome: TurnOutcome | "contract_violation";
  nextTurnAllowed: boolean; // outcome === "completed": transport completed AND the provider contract verified
  sessionId: string | null;
  report: TurnReport;
  contract: ProviderContractCheck;
  transport: TurnResult; // low-level turn; its outcome alone is not a verified provider outcome
}

export type ProviderTurnStart =
  | { ok: true; sessionId: string | null; stop(): void; result: Promise<ProviderTurnResult> }
  | { ok: false; reason: ProviderRefusal; detail: string };

const INPUT_KEYS = new Set(["cli", "cliVersion", "mode", "candidate", "model", "modelParams", "maxBudgetUsd", "cwd", "schema", "accept", "env",
  "task", "attemptDir", "session", "limits", "supervisor"]);
export const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/[\]-]{0,127}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODEX_THREAD = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/; // never starts with "-": it is a positional argv item
const MAX_NAMES = 32;
const MAX_NAME_CHARS = 128;

// "codex-cli 0.155.1" -> "0.155.1"; "2.1.278 (Claude Code)" -> "2.1.278"
export function parseCliVersion(provider: OrchestrationProvider, versionLine: string): string | null {
  const match = provider === "codex"
    ? /^codex-cli (\d+\.\d+\.\d+)\s*$/.exec(versionLine.trim())
    : /^(\d+\.\d+\.\d+) \(Claude Code\)\s*$/.exec(versionLine.trim());
  return match ? match[1] : null;
}

export function startProviderTurn(input: ProviderTurnInput, launch: SupervisorLaunch, observer?: TurnObserver): ProviderTurnStart {
  const built = buildProviderTurn(input);
  if (!built.ok) return built;
  try {
    checkTurnSpec(built.spec, launch);
  } catch (error) {
    return refuse("invalid_input", (error as Error).message);
  }
  if (built.schemaFile) {
    try {
      writeFileSync(built.schemaFile, JSON.stringify(built.spec.schema), { flag: "wx", mode: 0o600 });
    } catch (error) {
      return refuse("invalid_input", `cannot write schema file: ${(error as NodeJS.ErrnoException).code ?? "error"}`);
    }
  }
  const turn = startTurn(built.spec, launch, observer);
  const expectSessionId = built.spec.expectSessionId ?? null;
  const result = turn.result.then((transport): ProviderTurnResult => {
    const contract = checkProviderContract(built.spec.provider, input.mode, expectSessionId, transport);
    const outcome = transport.outcome !== "completed" ? transport.outcome
      : contract.status === "verified" ? "completed" : "contract_violation";
    return { outcome, nextTurnAllowed: outcome === "completed", sessionId: transport.sessionId, report: transport.report, contract, transport };
  });
  return { ok: true, sessionId: built.sessionId, stop: turn.stop, result };
}

// Pure: validates the input at run time and builds the spec; creates no files (the codex schema file is only named).
export function buildProviderTurn(input: ProviderTurnInput): ProviderTurnBuild {
  if (!isRecord(input)) return refuse("invalid_input", "input must be an object");
  const unknownKey = Object.keys(input).find((k) => !INPUT_KEYS.has(k));
  if (unknownKey !== undefined) return refuse("invalid_input", `unknown input field: ${unknownKey}`);
  const cli = input.cli as unknown;
  if (!isRecord(cli) || cli.state !== "available" || typeof cli.executable !== "string" || !isRecord(cli.environment)) {
    return refuse("invalid_input", "cli must be an available provider CLI");
  }
  const provider = input.cli.provider;
  if (provider !== "codex" && provider !== "claude") return refuse("unsupported_provider", `no orchestration mode for ${String(provider)}`);
  const support = PROVIDER_MODES[provider].find((m) => m.mode === input.mode);
  if (!support) return refuse("unsupported_mode", `${provider} supports only ${PROVIDER_MODES[provider].map((m) => m.mode).join(", ")}`);
  if (input.candidate !== undefined && typeof input.candidate !== "boolean") return refuse("invalid_input", "candidate must be a boolean");
  if (support.status === "candidate" && input.candidate !== true) {
    return refuse("unproven_mode", `${provider} ${support.mode} is a candidate mode, not proven by a real series; it runs only with candidate: true`);
  }
  const version = typeof input.cliVersion === "string" ? parseCliVersion(provider, input.cliVersion) : null;
  if (!version || !support.versions.includes(version)) {
    return refuse("unsupported_version", `${provider} ${String(input.cliVersion).trim()}: ${support.mode} is proven only for ${support.versions.join(", ")}`);
  }
  // A batch launcher wraps the CLI in cmd.exe; the supervisor protocol is not proven through it.
  if (input.cli.launcher !== "native") return refuse("unsupported_launcher", `${String(input.cli.launcher)} launcher is not supported`);
  if (typeof input.cwd !== "string" || !isAbsolute(input.cwd)) return refuse("invalid_input", "cwd must be absolute");
  if (input.model !== undefined && (typeof input.model !== "string" || !SAFE_MODEL.test(input.model))) {
    return refuse("invalid_input", "model name is not allowed");
  }
  if (input.modelParams !== undefined) {
    if (!isRecord(input.modelParams)) return refuse("invalid_input", "modelParams must be an object");
    for (const [key, value] of Object.entries(input.modelParams)) {
      const allowed = Object.hasOwn(support.modelParams, key) ? support.modelParams[key] : undefined;
      if (!allowed) return refuse("invalid_input", `${provider} ${support.mode} does not support modelParams.${key}`);
      if (typeof value !== "string" || !allowed.includes(value)) {
        return refuse("invalid_input", `modelParams.${key} must be one of ${allowed.join(", ")}`);
      }
    }
  }
  if (!isRecord(input.env) || !Object.values(input.env).every((v) => typeof v === "string")) {
    return refuse("invalid_input", "env must be an object of strings");
  }
  const session = input.session as unknown;
  if (!isRecord(session) || (session.kind !== "new" && session.kind !== "resume")
    || Object.keys(session).some((k) => k !== "kind" && k !== "id")
    || (session.id !== undefined && typeof session.id !== "string")
    || (session.kind === "resume" && typeof session.id !== "string")) {
    return refuse("invalid_input", "session must be { kind: \"new\", id? } or { kind: \"resume\", id }");
  }

  let schema: AnswerSchema;
  try {
    schema = compileSchema(input.schema);
  } catch (error) {
    return refuse("invalid_input", `schema: ${(error as Error).message}`);
  }
  const env = { ...input.cli.environment, ...input.env };
  const limits = input.limits ?? DEFAULT_TURN_LIMITS;
  return provider === "codex"
    ? buildCodex(input, schema, env, limits)
    : buildClaude(input, schema, env, limits, input.mode === "structured-edit");
}

function buildCodex(input: ProviderTurnInput, schema: AnswerSchema, env: Record<string, string>, limits: TurnLimits): ProviderTurnBuild {
  if (input.maxBudgetUsd !== undefined) return refuse("invalid_input", "codex has no budget limit flag");
  if (typeof input.attemptDir !== "string" || !isAbsolute(input.attemptDir)) return refuse("invalid_input", "codex requires an absolute attemptDir");
  if (input.session.kind === "new" && input.session.id !== undefined) return refuse("invalid_input", "codex assigns the thread id itself");
  if (input.session.kind === "resume" && !CODEX_THREAD.test(input.session.id)) return refuse("invalid_input", "codex thread id is not allowed");

  const effort = input.modelParams?.reasoningEffort;
  const schemaFile = join(input.attemptDir, `output-schema-${randomUUID()}.json`);
  const common = [
    "--json", "--ignore-user-config", "--ignore-rules",
    ...(input.model ? ["-m", input.model] : []),
    ...(effort ? ["-c", `model_reasoning_effort="${effort}"`] : []),
    "-c", 'approval_policy="never"',
    "--output-schema", schemaFile, "-o", "{REPORT_FILE}"
  ];
  const args = input.session.kind === "new"
    ? ["exec", ...common, "-s", "read-only", "-C", input.cwd, "-"]
    : ["exec", "resume", ...common, "-c", 'sandbox_mode="read-only"', input.session.id, "-"];
  const sessionId = input.session.kind === "resume" ? input.session.id : null;
  return { ok: true, sessionId, schemaFile, spec: spec("codex", input, args, schema, env, limits, sessionId) };
}

function buildClaude(input: ProviderTurnInput, schema: AnswerSchema, env: Record<string, string>, limits: TurnLimits, edit: boolean): ProviderTurnBuild {
  if (input.maxBudgetUsd !== undefined && !(typeof input.maxBudgetUsd === "number" && Number.isFinite(input.maxBudgetUsd) && input.maxBudgetUsd > 0)) {
    return refuse("invalid_input", "maxBudgetUsd must be a positive number");
  }
  if (input.attemptDir !== undefined) return refuse("invalid_input", "claude mode takes no attemptDir");
  const sessionId = input.session.id ?? randomUUID();
  if (!UUID.test(sessionId)) return refuse("invalid_input", "claude session id must be a UUID");
  const args = [
    "-p", "--output-format", "stream-json", "--verbose",
    "--json-schema", JSON.stringify(schema),
    ...(edit
      ? ["--safe-mode", "--restricted", "--settings", CLAUDE_EDIT_SETTINGS, "--tools", "Read,Edit,Write,Glob,Grep", "--strict-mcp-config",
        "--allowedTools", "Read,Glob,Grep,Edit(/**)", "--disallowedTools", "mcp__*,Edit(/.git/**),Edit(/.claude/**)", "--disable-slash-commands"]
      : ["--safe-mode", "--tools", "", "--strict-mcp-config", "--disallowedTools", "mcp__*", "--disable-slash-commands"]),
    "--permission-mode", "dontAsk", "--permission-prompts", "none",
    ...(input.maxBudgetUsd !== undefined ? ["--max-budget-usd", String(input.maxBudgetUsd)] : []),
    ...(input.model ? ["--model", input.model] : []),
    input.session.kind === "new" ? "--session-id" : "--resume", sessionId
  ];
  return { ok: true, sessionId, schemaFile: null, spec: spec("claude", input, args, schema, env, limits, sessionId) };
}

function spec(
  provider: OrchestrationProvider,
  input: ProviderTurnInput,
  args: string[],
  schema: AnswerSchema,
  env: Record<string, string>,
  limits: TurnLimits,
  expectSessionId: string | null
): TurnSpec {
  const launch = providerChildProcessLaunch(input.cli, args);
  return {
    provider,
    argv: [launch.command, ...launch.args],
    cwd: input.cwd,
    env,
    task: input.task,
    schema,
    ...(input.accept ? { accept: compileSchema(input.accept) } : {}),
    ...(input.attemptDir ? { attemptDir: input.attemptDir } : {}),
    expectSessionId,
    limits,
    ...(input.supervisor ? { supervisor: input.supervisor } : {})
  };
}

// Codex: thread.started with a string thread_id (= the resumed one). Claude: system/init with session_id,
// tools exactly the mode's set (an array of strings, nothing coerced) and mcp_servers exactly [].
// An absent field is an error of its own, never read as an empty array. structured-edit also records
// permissionMode: absent is recorded as null (not an error), anything but "dontAsk" is an error.
function checkProviderContract(provider: OrchestrationProvider, mode: ProviderMode, expectSessionId: string | null, turn: TurnResult): ProviderContractCheck {
  const errors: string[] = [];
  if (turn.sessionMismatch) errors.push("session id does not match the expected or earlier one");
  if (provider === "codex") {
    const started = findEvent(turn, "thread.started");
    const id = started?.thread_id;
    if (!started) errors.push("thread.started not observed");
    else if (id === undefined) errors.push("thread.started.thread_id absent");
    else if (typeof id !== "string" || id === "") errors.push("thread.started.thread_id is not a non-empty string");
    else if (expectSessionId !== null && id !== expectSessionId) errors.push("thread.started.thread_id differs from the resumed thread");
    return {
      status: errors.length ? "violated" : "verified",
      errors,
      expected: { sessionId: expectSessionId },
      actual: { sessionId: typeof id === "string" ? bound(id) : null }
    };
  }

  const edit = mode === "structured-edit";
  const expected = edit ? CLAUDE_EDIT_EXPECTED_INIT : CLAUDE_EXPECTED_INIT;
  const init = findEvent(turn, "system", "init");
  let permissionMode: string | null = null;
  let tools: string[] | null = null;
  let mcpServers: string[] | null = null;
  let sessionId: string | null = null;
  if (!init) errors.push("system/init not observed");
  else {
    if (init.session_id === undefined) errors.push("system/init.session_id absent");
    else if (typeof init.session_id !== "string") errors.push("system/init.session_id is not a string");
    else {
      sessionId = bound(init.session_id);
      if (init.session_id !== expectSessionId) errors.push("system/init.session_id differs from the requested session");
    }
    if (init.tools === undefined) errors.push("system/init.tools absent");
    else if (!Array.isArray(init.tools)) errors.push("system/init.tools is not an array");
    else if (!init.tools.every((t) => typeof t === "string")) errors.push("system/init.tools has a non-string element");
    else {
      tools = names(init.tools as string[]);
      if (!sameSet(init.tools as string[], expected.tools)) errors.push(`system/init.tools differs from ${JSON.stringify(expected.tools)}`);
    }
    if (init.mcp_servers === undefined) errors.push("system/init.mcp_servers absent");
    else if (!Array.isArray(init.mcp_servers)) errors.push("system/init.mcp_servers is not an array");
    else {
      mcpServers = names(init.mcp_servers.map((s) => (isRecord(s) && typeof s.name === "string" ? s.name : "<unnamed>")));
      if (init.mcp_servers.length !== 0) errors.push(`system/init.mcp_servers has ${init.mcp_servers.length} entries, expected none`);
    }
    if (edit && init.permissionMode !== undefined) {
      if (typeof init.permissionMode === "string") permissionMode = bound(init.permissionMode);
      if (init.permissionMode !== CLAUDE_EDIT_EXPECTED_INIT.permissionMode) errors.push("system/init.permissionMode is not \"dontAsk\"");
    }
  }
  return {
    status: errors.length ? "violated" : "verified",
    errors,
    expected: edit
      ? { sessionId: expectSessionId, tools: expected.tools, mcpServers: expected.mcpServers, permissionMode: CLAUDE_EDIT_EXPECTED_INIT.permissionMode }
      : { sessionId: expectSessionId, tools: expected.tools, mcpServers: expected.mcpServers },
    actual: edit ? { sessionId, tools, mcpServers, permissionMode } : { sessionId, tools, mcpServers }
  };
}

// The first matching event: history is a prefix of the stream; sessionEvent survives history limits.
function findEvent(turn: TurnResult, type: string, subtype?: string): Record<string, unknown> | null {
  const matches = (v: Record<string, unknown> | null | undefined) => !!v && v.type === type && (subtype === undefined || v.subtype === subtype);
  for (const f of turn.history) if (f.kind === "event" && matches(f.value)) return f.value;
  return matches(turn.sessionEvent) ? turn.sessionEvent : null;
}

function sameSet(actual: readonly string[], expected: readonly string[]): boolean {
  const a = [...actual].sort();
  const b = [...expected].sort();
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function names(list: readonly string[]): string[] {
  return list.slice(0, MAX_NAMES).map(bound);
}

function bound(s: string): string {
  return s.length > MAX_NAME_CHARS ? `${s.slice(0, MAX_NAME_CHARS)}…` : s;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function refuse(reason: ProviderRefusal, detail: string): { ok: false; reason: ProviderRefusal; detail: string } {
  return { ok: false, reason, detail };
}

// ---------------- stage 12: native sessions ----------------
// The CLI as the user runs it in a terminal of the project: no flag that removes configuration, tools, MCP, hooks or
// permission prompts; the user's own login-shell environment; prompts go to the person through the driver
// (sessions.ts). What the installed version offers is probed, not looked up in a list of versions (capabilities.ts).

export interface NativeTurnInput {
  cli: AvailableProviderCli;
  cliVersion: string;
  cwd: string;
  env: Readonly<Record<string, string>>; // the user's login-shell environment (loginEnv.ts)
  task: string;
  schema: unknown;
  accept?: unknown; // TurnSpec.accept
  session: ProviderSession;
  ask: AskPerson;
  clientVersion: string;
  limits?: TurnLimits;
  supervisor?: SupervisorTimings;
  access?: AgentAccess; // stage 13: the chosen rights mode per CLI (default: the user's own settings)
  ownFolder?: boolean; // cwd is the run's own copy or worktree (sessions.ts: Codex trusts it for the thread only)
  // The model for this thread (Codex thread/start|resume `model`) or this run (claude --model); absent: the CLI's own
  // configuration decides. Nothing is written to config.toml or Claude's settings.
  model?: string;
}

export function buildNativeTurn(input: NativeTurnInput): ProviderTurnBuild {
  const provider = input.cli?.provider;
  if (provider !== "codex" && provider !== "claude") return refuse("unsupported_provider", `no orchestration session for ${String(provider)}`);
  if (input.cli.state !== "available" || typeof input.cli.executable !== "string") return refuse("invalid_input", "cli must be an available provider CLI");
  if (input.cli.launcher !== "native") return refuse("unsupported_launcher", `${String(input.cli.launcher)} launcher is not supported`);
  if (!parseCliVersion(provider, input.cliVersion)) return refuse("unsupported_version", `cannot read the ${provider} version from "${String(input.cliVersion).trim()}"`);
  if (typeof input.cwd !== "string" || !isAbsolute(input.cwd)) return refuse("invalid_input", "cwd must be absolute");
  if (typeof input.task !== "string") return refuse("invalid_input", "task must be a string");
  if (input.model !== undefined && (typeof input.model !== "string" || !SAFE_MODEL.test(input.model))) return refuse("invalid_input", "model name is not allowed");
  let schema: AnswerSchema;
  let accept: AnswerSchema | null;
  try {
    schema = compileSchema(input.schema);
    accept = input.accept === undefined ? null : compileSchema(input.accept);
  } catch (error) {
    return refuse("invalid_input", `schema: ${(error as Error).message}`);
  }
  let args: string[];
  let sessionId: string | null;
  let driver;
  if (provider === "codex") {
    if (input.session.kind === "new" && input.session.id !== undefined) return refuse("invalid_input", "codex assigns the thread id itself");
    if (input.session.kind === "resume" && !CODEX_THREAD.test(input.session.id)) return refuse("invalid_input", "codex thread id is not allowed");
    sessionId = input.session.kind === "resume" ? input.session.id : null;
    args = ["app-server"];
    driver = codexAppServerDriver({
      cwd: input.cwd, task: input.task, schema, threadId: sessionId, clientVersion: input.clientVersion, ask: input.ask,
      access: codexAccessParams(input.access?.codex ?? "terminal"), ...(input.ownFolder ? { trustCwd: true } : {}),
      ...(input.model ? { model: input.model } : {})
    });
  } else {
    sessionId = input.session.id ?? randomUUID();
    if (!UUID.test(sessionId)) return refuse("invalid_input", "claude session id must be a UUID");
    args = [
      "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
      "--permission-prompt-tool", "stdio", ...claudeAccessArgs(input.access?.claude ?? "terminal"), ...(input.model ? ["--model", input.model] : []),
      "--json-schema", JSON.stringify(schema),
      input.session.kind === "new" ? "--session-id" : "--resume", sessionId
    ];
  }
  const launch = providerChildProcessLaunch(input.cli, args);
  // PATH of the registry only where the login shell gave none; everything else is the user's.
  const env = { ...launch.environment, ...input.env };
  // the sandbox exclusions are read where this very process will read its settings (its HOME, its CLAUDE_CONFIG_DIR)
  if (provider === "claude") {
    driver = claudeHostDriver({ task: input.task, ask: input.ask,
      sandboxed: input.access?.claude === "workspace" && !claudeSandboxExclusions(env.HOME || homedir(), input.cwd, env.CLAUDE_CONFIG_DIR) });
  }
  return {
    ok: true, sessionId, schemaFile: null,
    spec: {
      provider, argv: [launch.command, ...launch.args], cwd: input.cwd, env,
      task: "", schema, ...(accept ? { accept } : {}), expectSessionId: sessionId, limits: input.limits ?? DEFAULT_TURN_LIMITS, session: driver,
      ...(input.supervisor ? { supervisor: input.supervisor } : {})
    }
  };
}

// Stage 13: what a chosen rights mode must show in the CLI's own report of the session (system/init.permissionMode,
// the thread/start or thread/resume reply). A CLI may run another mode than asked (Claude leaves "auto" when the plan,
// model or settings do not allow it; a managed configuration may refuse a sandbox): the feed then says so.
export function accessMismatch(provider: OrchestrationProvider, access: AgentAccess | undefined, frame: Frame): AccessMismatch[] | null {
  if (frame.kind !== "event") return null;
  const v = frame.value;
  const differ = (field: string, asked: string, reported: unknown): AccessMismatch[] =>
    reported === asked ? [] : [{ field, asked, reported: typeof reported === "string" ? reported : reported === undefined || reported === null ? "nothing" : JSON.stringify(reported).slice(0, 200) }];
  if (provider === "claude") {
    const asked = ({ workspace: "acceptEdits", acceptEdits: "acceptEdits", auto: "auto", full: "bypassPermissions" } as Record<string, string>)[access?.claude ?? "terminal"];
    if (!asked || frame.type !== "system" || v.subtype !== "init") return null;
    const out = differ("permissionMode", asked, v.permissionMode);
    return out.length ? out : null;
  }
  const asked = ({ workspace: ["on-request", "workspaceWrite"], full: ["never", "dangerFullAccess"] } as Record<string, [string, string]>)[access?.codex ?? "terminal"];
  const r = v.result as Record<string, unknown> | undefined;
  if (!asked || frame.type !== "rpc.response" || !r || typeof r !== "object" || !r.thread || typeof r.model !== "string") return null;
  const sandbox = r.sandbox && typeof r.sandbox === "object" ? (r.sandbox as Record<string, unknown>).type : r.sandbox;
  const out = [...differ("approvalPolicy", asked[0], r.approvalPolicy), ...differ("sandbox", asked[1], sandbox)];
  return out.length ? out : null;
}

export function startNativeTurn(input: NativeTurnInput, launch: SupervisorLaunch, observer?: TurnObserver): ProviderTurnStart {
  const built = buildNativeTurn(input);
  if (!built.ok) return built;
  try {
    checkTurnSpec(built.spec, launch);
  } catch (error) {
    return refuse("invalid_input", (error as Error).message);
  }
  const provider = built.spec.provider;
  const watched: TurnObserver | undefined = observer?.frame ? {
    ...observer,
    frame(frame) {
      observer.frame!(frame);
      const mismatch = accessMismatch(provider, input.access, frame);
      if (mismatch) observer.frame!({ kind: "event", type: "canvastty.access", value: { [ACCESS_MISMATCH]: mismatch }, bytes: 0 } as unknown as Frame);
    }
  } : observer;
  const turn = startTurn(built.spec, launch, watched);
  const expected = built.spec.expectSessionId ?? null;
  const result = turn.result.then((transport): ProviderTurnResult => {
    // The one contract left: the session is the one asked for. What the CLI loaded is the user's, not checked here.
    const errors: string[] = [];
    if (transport.sessionMismatch) errors.push("session id does not match the expected or earlier one");
    if (transport.outcome === "completed" && !transport.sessionId) errors.push("no session id observed");
    const contract: ProviderContractCheck = {
      status: errors.length ? "violated" : "verified", errors,
      expected: { sessionId: expected }, actual: { sessionId: transport.sessionId ? bound(transport.sessionId) : null }
    };
    const outcome = transport.outcome !== "completed" ? transport.outcome : errors.length ? "contract_violation" : "completed";
    return { outcome, nextTurnAllowed: outcome === "completed", sessionId: transport.sessionId, report: transport.report, contract, transport };
  });
  return { ok: true, sessionId: built.sessionId, stop: turn.stop, result };
}
