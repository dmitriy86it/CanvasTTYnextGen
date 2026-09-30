// The exact plan of the four real 0B probes (B1, B2, K1, K2): single source for this CLI and probe-series.mjs.
// Never runs a CLI with a prompt.
// Usage: node probe-plan.mjs            -> JSON plan (placeholders in <...>)
//        node probe-plan.mjs --check    -> also checks every flag against the installed `--help` (local, no model call)
import { execFileSync } from "node:child_process";

export const CODEX_MODEL = "gpt-6-astra"; // from ~/.codex/config.toml `model` (read by key only); --ignore-user-config drops it, so pass explicitly
const CODEX_EFFORT = "high"; // same file, `model_reasoning_effort`
export const SCHEMA = {
  type: "object",
  properties: { token: { type: "string" }, answer: { type: "string" } },
  required: ["token", "answer"],
  additionalProperties: false,
};
export const FROM_B1 = "<THREAD_ID from B1>"; // replaced by probe-series.mjs with B1's sessionId (argv and expectSessionId)
export const TOKEN_RE = /TOKEN=([A-Za-z0-9_-]+)/; // how the mocks read the token from a task

const PLACEHOLDERS = {
  probeDir: "<PROBE>", repo: "<REPO>", home: "<PROBE>/home", tmp: "<PROBE>/tmp", schemaFile: "<PROBE>/schema.json",
  realHome: "<real $HOME>", codexHome: "<real ~/.codex>", user: "<USER>", path: "<~/.local/bin>:<node dir>:/usr/bin:/bin",
  token: "<TOKEN>", token2: "<TOKEN2>", u1: "<U1 uuid>",
};

// Claude Code version the init expectation below was established for. probe-series refuses a real run on another version.
export const CLAUDE_VERSION = "2.1.278";
// Series that may be run; the real-run gate env must equal the chosen key exactly.
export const SERIES = { "B1,B2,K1,K2": ["B1", "B2", "K1", "K2"], "K1,K2": ["K1", "K2"] };

// What system/init must report for a claude argv, for Claude Code 2.1.278 and ONLY these two flag combinations:
//   --tools "" with --json-schema    -> tools ["StructuredOutput"]  (basis: the transcript of the real K1 run on 2026-09-22 —
//                                        the model was sent exactly StructuredOutput and called it; system/init itself was
//                                        not recorded then, so this still has to be confirmed by a new system/init)
//   --tools "" without --json-schema -> tools []
//   --strict-mcp-config without --mcp-config -> mcp_servers []
// Any other combination throws: no expectation is claimed without evidence. Lists are compared exactly (sorted).
export function expectedClaudeInit(argv) {
  const i = argv.indexOf("--tools");
  if (i < 0 || argv[i + 1] !== "") throw new Error("expectedClaudeInit: only --tools \"\" is supported");
  if (!argv.includes("--strict-mcp-config") || argv.includes("--mcp-config")) throw new Error("expectedClaudeInit: only --strict-mcp-config without --mcp-config is supported");
  return { tools: argv.includes("--json-schema") ? ["StructuredOutput"] : [], mcp_servers: [] };
}

// ctx: absolute paths, env values, tokens and U1; missing keys print as placeholders.
export function buildPlan(ctx = {}) {
  const c = { ...PLACEHOLDERS, ...ctx };
  const codexCommon = [
    "--json", "--ignore-user-config", "--ignore-rules",
    "-m", CODEX_MODEL, "-c", `model_reasoning_effort="${CODEX_EFFORT}"`, "-c", 'approval_policy="never"',
    "--output-schema", c.schemaFile, "-o", "{REPORT_FILE}",
  ];
  const claudeCommon = [
    "-p", "--output-format", "stream-json", "--verbose",
    "--json-schema", JSON.stringify(SCHEMA),
    "--safe-mode", "--tools", "", "--strict-mcp-config", "--disallowedTools", "mcp__*", "--disable-slash-commands",
    "--permission-mode", "dontAsk", "--permission-prompts", "none", "--max-budget-usd", "0.25",
  ];
  const codexEnv = { HOME: c.home, CODEX_HOME: c.codexHome, PATH: c.path, LANG: "C", TMPDIR: c.tmp };
  const claudeEnv = { HOME: c.realHome, USER: c.user, PATH: c.path, LANG: "C", TMPDIR: c.tmp, ENABLE_CLAUDEAI_MCP_SERVERS: "false", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" };
  const k1 = ["claude", ...claudeCommon, "--session-id", c.u1];
  const k2 = ["claude", ...claudeCommon, "--resume", c.u1];
  return [
    {
      id: "B1", provider: "codex", what: "Codex: structured answer",
      argv: ["codex", "exec", ...codexCommon, "-s", "read-only", "-C", c.repo, "-"],
      cwd: c.repo, env: codexEnv, timeoutMs: 180_000, expectSessionId: null, expectToken: c.token, expectAnswer: "ok",
      task: `TOKEN=${c.token}\nReturn JSON with token = the TOKEN value above and answer = "ok". Do not run commands.\n`,
      success: "outcome=completed; report valid by schema; report.token=<TOKEN>; sessionId (thread.started.thread_id) present",
    },
    {
      id: "B2", provider: "codex", what: "Codex: continue the same session", continues: "B1",
      argv: ["codex", "exec", "resume", ...codexCommon, "-c", 'sandbox_mode="read-only"', FROM_B1, "-"],
      cwd: c.repo, env: codexEnv, timeoutMs: 120_000, expectSessionId: FROM_B1, expectToken: c.token, expectAnswer: "resumed",
      task: 'Return JSON: token = the token from my previous message, answer = "resumed".\n',
      success: "outcome=completed; sessionId = B1 thread_id; report.token=<TOKEN> (not in this task text)",
    },
    {
      id: "K1", provider: "claude", what: "Claude: structured answer",
      argv: k1, cwd: c.repo, env: claudeEnv, timeoutMs: 180_000, expectSessionId: c.u1, expectToken: c.token2, expectAnswer: "ok",
      expectInit: { ...expectedClaudeInit(k1), session_id: c.u1 },
      task: `TOKEN=${c.token2}\nReturn JSON with token = the TOKEN value above and answer = "ok".\n`,
      success: "outcome=completed; system/init.session_id = U1; system/init.tools = [\"StructuredOutput\"] exactly and mcp_servers = []; result.structured_output valid; result.session_id = U1",
    },
    {
      id: "K2", provider: "claude", what: "Claude: continue the same session", continues: "K1",
      argv: k2, cwd: c.repo, env: claudeEnv, timeoutMs: 120_000, expectSessionId: c.u1, expectToken: c.token2, expectAnswer: "resumed",
      expectInit: { ...expectedClaudeInit(k2), session_id: c.u1 },
      task: 'Return JSON: token = the token from my previous message, answer = "resumed".\n',
      success: "outcome=completed; session_id = U1; structured_output.token=<TOKEN2> (not in this task text); tools = [\"StructuredOutput\"] exactly; mcp_servers = []",
    },
  ];
}

if (import.meta.main) {
  const probes = buildPlan();
  const out = { schema: SCHEMA, probes };
  if (process.argv.includes("--check")) {
    const help = {
      codex: execFileSync("codex", ["exec", "--help"], { encoding: "utf8" }),
      "codex resume": execFileSync("codex", ["exec", "resume", "--help"], { encoding: "utf8" }),
      claude: execFileSync("claude", ["--help"], { encoding: "utf8" }),
    };
    out.check = probes.map((p) => {
      const h = p.argv[0] === "claude" ? help.claude : p.argv[2] === "resume" ? help["codex resume"] : help.codex;
      const flags = p.argv.filter((a) => /^-{1,2}[a-zA-Z]/.test(a));
      // `-c` values and short flags are matched as "-x," / "-x " in help; long flags as "--name"
      const missing = flags.filter((f) => !(f.startsWith("--") ? h.includes(f + " ") || h.includes(f + ",") || h.includes(f + "\n") : new RegExp(`(^|\\s)${f}[, ]`, "m").test(h)));
      return { id: p.id, flags: flags.length, missing };
    });
  }
  console.log(JSON.stringify(out, null, 2));
}
