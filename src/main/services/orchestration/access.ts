import { readFileSync } from "node:fs";
import { join } from "node:path";

// Stage 13: the rights each CLI runs with, chosen per project, separate from how much the run does on its own
// (autopilot or step by step). "terminal" adds nothing: the user's own settings decide, as in their terminal. The other
// modes are the CLI's own documented switches for one session; nothing is written to a global configuration. The
// same word means different things for the two CLIs, so every mode says exactly what it turns into.
export type ClaudeAccess = "terminal" | "workspace" | "acceptEdits" | "auto" | "full";
export type CodexAccess = "terminal" | "workspace" | "full";
export interface AgentAccess { claude: ClaudeAccess; codex: CodexAccess }
// New projects start in the work folder; "terminal" is a project setting chosen on purpose. A saved profile keeps its
// mode, and a goal keeps the mode it was created with.
export const DEFAULT_ACCESS: Readonly<AgentAccess> = Object.freeze({ claude: "workspace", codex: "workspace" });

export const CLAUDE_ACCESS: readonly ClaudeAccess[] = ["terminal", "workspace", "acceptEdits", "auto", "full"];

// "workspace" for Claude: edits without asking, and Bash in Claude's own sandbox (Seatbelt on macOS) that writes only in
// the work folder and reaches no outside host (localhost is allowed). A command run outside the sandbox goes through
// the permission prompt, which the host turns into a pause for the person. Passed with --settings for this session only.
export const CLAUDE_WORKSPACE_SETTINGS = Object.freeze({
  sandbox: {
    enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: true,
    network: { allowedDomains: [], allowLocalBinding: true }
  }
});
export const CODEX_ACCESS: readonly CodexAccess[] = ["terminal", "workspace", "full"];

// Commands the user's own settings run outside the sandbox (sandbox.excludedCommands, in any settings file Claude reads
// for this folder). Then a Bash prompt in «Рабочая папка» is not answered by the session: such a command would not be
// held by the sandbox. A file that is there but cannot be read or parsed counts as one that lists some (fail closed).
// configDir: CLAUDE_CONFIG_DIR of the CLI's environment, where the user's settings are then.
export function claudeSandboxExclusions(home: string, cwd: string, configDir?: string): boolean {
  const user = configDir || join(home, ".claude");
  const files = [join(user, "settings.json"), join(user, "settings.local.json"), join(home, ".claude", "settings.json"), join(cwd, ".claude", "settings.json"),
    join(cwd, ".claude", "settings.local.json"), "/Library/Application Support/ClaudeCode/managed-settings.json", "/etc/claude-code/managed-settings.json"];
  return files.some((f) => {
    let text: string;
    try { text = readFileSync(f, "utf8"); } catch (e) { return (e as NodeJS.ErrnoException).code !== "ENOENT" && (e as NodeJS.ErrnoException).code !== "ENOTDIR"; }
    try {
      const v = JSON.parse(text) as { sandbox?: { excludedCommands?: unknown } } | null;
      const list = v?.sandbox?.excludedCommands;
      return list !== undefined && !(Array.isArray(list) && list.length === 0);
    } catch { return true; }
  });
}

// Extra arguments of `claude -p` for one session. "full" is the CLI's own bypass switch.
export function claudeAccessArgs(a: ClaudeAccess): string[] {
  switch (a) {
    case "terminal": return [];
    case "workspace": return ["--permission-mode", "acceptEdits", "--settings", JSON.stringify(CLAUDE_WORKSPACE_SETTINGS)];
    case "acceptEdits": return ["--permission-mode", "acceptEdits"];
    case "auto": return ["--permission-mode", "auto"];
    case "full": return ["--dangerously-skip-permissions"];
  }
}

// Thread parameters of `codex app-server` (thread/start, thread/resume) for one thread.
export function codexAccessParams(a: CodexAccess): Record<string, string> {
  switch (a) {
    case "terminal": return {};
    case "workspace": return { sandbox: "workspace-write", approvalPolicy: "on-request" };
    case "full": return { sandbox: "danger-full-access", approvalPolicy: "never" };
  }
}

// What a mode turns into, for the interface (the exact switch, not a promise of equal meaning).
export function accessMapping(provider: "claude" | "codex", a: string): string {
  if (provider === "claude") {
    const args = claudeAccessArgs(a as ClaudeAccess);
    return args.length ? `claude ${args.join(" ")}` : "claude: no permission flag (your settings)";
  }
  const p = codexAccessParams(a as CodexAccess);
  return Object.keys(p).length ? `codex thread: sandbox=${p.sandbox}, approvalPolicy=${p.approvalPolicy}` : "codex: no sandbox/approval override (your config.toml)";
}

// Modes the installed CLI actually offers. Claude: the choices of --permission-mode in its own --help (bypass is the
// separate --dangerously-skip-permissions flag). Codex: the thread parameters exist in the app-server protocol of the
// versions its shapes were compared with; another version offers only "terminal".
export function claudeModesFromHelp(help: string): ClaudeAccess[] {
  const out: ClaudeAccess[] = ["terminal"];
  const m = /--permission-mode <mode>[\s\S]{0,400}?\(choices:([^)]*)\)/.exec(help);
  const choices = m ? [...m[1].matchAll(/"([A-Za-z]+)"/g)].map((x) => x[1]) : [];
  if (choices.includes("acceptEdits") && /--settings\b/.test(help)) out.push("workspace");
  if (choices.includes("acceptEdits")) out.push("acceptEdits");
  if (choices.includes("auto")) out.push("auto");
  if (/--dangerously-skip-permissions\b/.test(help)) out.push("full");
  return out;
}

export function isClaudeAccess(v: unknown): v is ClaudeAccess { return typeof v === "string" && (CLAUDE_ACCESS as readonly string[]).includes(v); }
export function isCodexAccess(v: unknown): v is CodexAccess { return typeof v === "string" && (CODEX_ACCESS as readonly string[]).includes(v); }
