// Trusted registry of project checks (stage-4-contract.md §1). A check command is configuration written by the
// application, never by an agent: the agent may only name an id that is already in the registry. There is no shell,
// so argv reaches the program as given and nothing is glob-expanded on the way.
import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, sep } from "node:path";
import { canonical } from "./journal.ts";

export type CheckConfigErrorCode = "invalid_command" | "duplicate_id" | "unknown_check";

export class CheckConfigError extends Error {
  readonly code: CheckConfigErrorCode;
  readonly detail: unknown;

  constructor(code: CheckConfigErrorCode, message: string, detail?: unknown) {
    super(`${code}: ${message}`);
    this.name = "CheckConfigError";
    this.code = code;
    this.detail = detail ?? null;
  }
}

const fail = (code: CheckConfigErrorCode, message: string, detail?: unknown): never => {
  throw new CheckConfigError(code, message, detail);
};

export interface CheckCommand {
  id: string;
  title: string;
  executable: string;
  argv: readonly string[];
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface CheckRegistry {
  commands: readonly CheckCommand[];
}

// Dependencies prepared by the user: read-only for the check, never installed by us.
export interface PreparedDeps {
  lockfileRelPath: string; // inside the copy, e.g. "package-lock.json"
  lockfileSha256: string;  // what the prepared node_modules was installed from
  nodeModulesPath: string; // absolute, in the source project
}

const CHECK_ID = /^[a-z][a-z0-9-]{0,63}$/;
export const MAX_CHECK_OUTPUT_BYTES = 65_536; // the store's text limit
const MAX_TIMEOUT_MS = 3_600_000;

function checkCommand(c: unknown): CheckCommand {
  if (typeof c !== "object" || c === null) return fail("invalid_command", "a command must be an object");
  const { id, title, executable, argv, timeoutMs, maxOutputBytes } = c as Record<string, unknown>;
  if (typeof id !== "string" || !CHECK_ID.test(id)) fail("invalid_command", "id must match ^[a-z][a-z0-9-]{0,63}$", { id });
  if (typeof title !== "string" || title.length === 0 || title.length > 200) fail("invalid_command", "title must be 1..200 characters", { id });
  if (typeof executable !== "string" || !isAbsolute(executable)) fail("invalid_command", "executable must be an absolute path", { id });
  // The real path is what actually runs and what the sandbox profile matches, so a symlinked executable is refused
  // rather than silently resolved: the configuration must name what it means.
  let real: string;
  try {
    real = realpathSync(executable as string);
  } catch (error) {
    return fail("invalid_command", "executable does not exist", { id, executable, cause: String(error) });
  }
  if (real !== executable) fail("invalid_command", "executable must be its own real path", { id, executable, real });
  if (!statSync(real).isFile()) fail("invalid_command", "executable must be a file", { id, executable });
  if (!Array.isArray(argv) || argv.some((a) => typeof a !== "string" || a.includes("\0"))) {
    fail("invalid_command", "argv must be an array of strings without NUL", { id });
  }
  if (!Number.isSafeInteger(timeoutMs) || (timeoutMs as number) < 1 || (timeoutMs as number) > MAX_TIMEOUT_MS) {
    fail("invalid_command", `timeoutMs must be 1..${MAX_TIMEOUT_MS}`, { id, timeoutMs });
  }
  if (!Number.isSafeInteger(maxOutputBytes) || (maxOutputBytes as number) < 1 || (maxOutputBytes as number) > MAX_CHECK_OUTPUT_BYTES) {
    fail("invalid_command", `maxOutputBytes must be 1..${MAX_CHECK_OUTPUT_BYTES}`, { id, maxOutputBytes });
  }
  return Object.freeze({
    id: id as string, title: title as string, executable: executable as string, argv: Object.freeze([...(argv as string[])]),
    timeoutMs: timeoutMs as number, maxOutputBytes: maxOutputBytes as number
  });
}

// Frozen on creation: the runner never adds a command and never allows one that is not here.
export function createRegistry(commands: readonly unknown[]): CheckRegistry {
  if (!Array.isArray(commands) || commands.length === 0) fail("invalid_command", "a registry needs at least one command");
  const checked = commands.map(checkCommand);
  const ids = new Set<string>();
  for (const c of checked) {
    if (ids.has(c.id)) fail("duplicate_id", `command id ${c.id} is used twice`, { id: c.id });
    ids.add(c.id);
  }
  return Object.freeze({ commands: Object.freeze(checked) });
}

// The only thing taken from an agent's answer: an id that is already in the registry.
export function resolveCheck(registry: CheckRegistry, id: unknown): CheckCommand {
  if (typeof id !== "string" || !CHECK_ID.test(id)) fail("unknown_check", "not a check id", { id });
  const found = registry.commands.find((c) => c.id === id);
  return found ?? fail("unknown_check", `no check with id ${id}`, { id });
}

export function checkPreparedDeps(deps: unknown): PreparedDeps {
  if (typeof deps !== "object" || deps === null) return fail("invalid_command", "preparedDeps must be an object");
  const { lockfileRelPath, lockfileSha256, nodeModulesPath } = deps as Record<string, unknown>;
  const relOk = typeof lockfileRelPath === "string" && lockfileRelPath.length > 0 && !isAbsolute(lockfileRelPath)
    && !lockfileRelPath.split(/[/\\]/).includes("..") && !lockfileRelPath.includes("\0");
  if (!relOk) fail("invalid_command", "lockfileRelPath must be a relative path inside the copy", { lockfileRelPath });
  if (typeof lockfileSha256 !== "string" || !/^[0-9a-f]{64}$/.test(lockfileSha256)) fail("invalid_command", "lockfileSha256 must be a sha256 hex");
  if (typeof nodeModulesPath !== "string" || !isAbsolute(nodeModulesPath)) fail("invalid_command", "nodeModulesPath must be absolute");
  return Object.freeze({
    lockfileRelPath: lockfileRelPath as string, lockfileSha256: lockfileSha256 as string, nodeModulesPath: nodeModulesPath as string
  });
}

// Identifies exactly what ran: id, real executable path, argv and the limits that shape the outcome.
export function commandSha256(c: CheckCommand): string {
  return createHash("sha256").update(canonical({
    id: c.id, executable: c.executable, argv: [...c.argv], timeoutMs: c.timeoutMs, maxOutputBytes: c.maxOutputBytes
  })).digest("hex");
}

// Directory the check may see as its own: <root>/runs/<runId>/checks/<checkRunId>
export const checkDirName = "checks";
export const checkRunDir = (runDir: string, checkRunId: string): string => `${runDir}${sep}${checkDirName}${sep}${checkRunId}`;
