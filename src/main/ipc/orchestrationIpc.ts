// Orchestration channels (stage-7-contract.md §IPC). Registered through registerIpc's handleMain, so every call is
// refused unless it comes from the main window's top frame. Every argument is checked here, before the manager sees
// it: a wrong shape, an extra field or a value out of range is refused without any effect.
import type { IpcMainInvokeEvent, WebContents } from "electron";
import { IPC } from "../../shared/contracts.ts";
import type {
  OrchestrationBounds,
  OrchestrationCreateRequest,
  OrchestrationGoalInput,
  OrchestrationTakeInput,
  OrchestrationProviderKind,
  OrchestrationResult,
  OrchestrationRoleModels,
  OrchestrationRunEvent
} from "../../shared/orchestration.ts";
import type { RunCommand } from "../services/orchestration/orchestrationService.ts";
import type { RunManager } from "../services/orchestration/manager.ts";
import { SAFE_MODEL } from "../services/orchestration/providers.ts";
import type { BoardTaskInput, BoardTaskPatch } from "../../shared/taskBoard.ts";

type Handle = (channel: string, listener: (event: IpcMainInvokeEvent, ...args: any[]) => unknown) => void;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const CHECK_ID = /^[a-z][a-z0-9-]{0,63}$/;
const RUN_LIMITS = ["turns", "roundsPerStage", "replans", "noProgressRounds", "runMs", "leadTurnMs", "executorTurnMs"];
const RAISABLE = ["turns", "roundsPerStage", "replans", "runMs"];

class Invalid extends Error {}
const bad = (what: string): never => { throw new Invalid(what); };
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)
  && Object.getPrototypeOf(v) === Object.prototype;
function obj(v: unknown, what: string, required: string[], optional: string[] = []): Record<string, unknown> {
  if (!isObj(v)) bad(`${what} must be a plain object`);
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!required.includes(k) && !optional.includes(k)) bad(`${what}.${k} is not allowed`);
  for (const k of required) if (!(k in o)) bad(`${what}.${k} is required`);
  return o;
}
const str = (v: unknown, what: string, max: number, min = 1): string =>
  typeof v === "string" && v.length >= min && v.length <= max && !v.includes("\0") ? v : bad(`${what} must be a string of ${min}..${max}`);
const workspaceId = (v: unknown): string =>
  (typeof v === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(v) ? v : bad("workspaceId must be a workspace id"));
const uuid = (v: unknown, what: string): string => (typeof v === "string" && UUID.test(v) ? v : bad(`${what} must be a UUID`));
const findingId = (v: unknown): string => (typeof v === "string" && /^F[1-9]\d{0,5}$/.test(v) ? v : bad("a finding id must be F<n>"));
const int = (v: unknown, what: string, min: number, max = Number.MAX_SAFE_INTEGER): number =>
  Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max ? v as number : bad(`${what} must be an integer ${min}..${max}`);
const strings = (v: unknown, what: string, maxItems: number, maxLen: number): string[] =>
  Array.isArray(v) && v.length >= 1 && v.length <= maxItems ? v.map((x, i) => str(x, `${what}[${i}]`, maxLen)) : bad(`${what} must be 1..${maxItems} strings`);

export function parseCreate(v: unknown): OrchestrationCreateRequest {
  const o = obj(v, "request", ["requestId", "source", "goal"]);
  const source = str(o.source, "source", 4096);
  if (!source.startsWith("/")) bad("source must be an absolute path");
  return { requestId: uuid(o.requestId, "requestId"), source, goal: parseGoal(o.goal) };
}

function parseGoal(v: unknown): OrchestrationGoalInput {
  const g = obj(v, "goal", ["text", "criteria", "checks"], ["reviewPlan", "limits", "commands", "workMode", "mode", "finish", "models", "language", "accessOverride", "task"]);
  // A goal names its checks either by catalog ids or (stage 12) by its own commands, then `checks` is [].
  // Stage 13: a goal with a mode may leave its commands to the project profile.
  const checks = (g.commands !== undefined || g.mode !== undefined) && Array.isArray(g.checks) && g.checks.length === 0 ? [] : strings(g.checks, "goal.checks", 16, 64);
  if (checks.some((c) => !CHECK_ID.test(c))) bad("goal.checks must be check ids");
  // [] — journal v2 under its development flag: the lead proposes the commands (main decides whether that is allowed)
  const commands = g.commands === undefined ? undefined : Array.isArray(g.commands) && g.commands.length === 0 ? [] : commandLines(g.commands, "goal.commands");
  if (g.workMode !== undefined && g.workMode !== "project" && g.workMode !== "copy" && g.workMode !== "worktree") bad("goal.workMode must be project, worktree or copy");
  if (g.mode !== undefined && g.mode !== "autopilot" && g.mode !== "steps") bad("goal.mode must be autopilot or steps");
  let finish: OrchestrationGoalInput["finish"];
  if (g.finish !== undefined) {
    const f = obj(g.finish, "goal.finish", ["commit", "push", "qa"]);
    for (const k of ["commit", "push", "qa"]) if (typeof f[k] !== "boolean") bad(`goal.finish.${k} must be a boolean`);
    finish = { commit: f.commit as boolean, push: f.push as boolean, qa: f.qa as boolean };
  }
  let limits: Record<string, number> | undefined;
  if (g.limits !== undefined) {
    const l = obj(g.limits, "goal.limits", [], RUN_LIMITS);
    limits = Object.fromEntries(Object.entries(l).map(([k, x]) => [k, int(x, `goal.limits.${k}`, 1)]));
  }
  if (g.reviewPlan !== undefined && typeof g.reviewPlan !== "boolean") bad("goal.reviewPlan must be a boolean");
  if (g.language !== undefined && g.language !== "ru" && g.language !== "en") bad("goal.language must be ru or en");
  return {
    text: str(g.text, "goal.text", 8000), criteria: strings(g.criteria, "goal.criteria", 32, 500), checks,
    ...(g.reviewPlan !== undefined ? { reviewPlan: g.reviewPlan as boolean } : {}), ...(limits ? { limits } : {}),
    ...(commands !== undefined ? { commands } : {}), ...(g.workMode !== undefined ? { workMode: g.workMode as "project" | "copy" } : {}),
    ...(g.mode !== undefined ? { mode: g.mode as "autopilot" | "steps" } : {}), ...(finish ? { finish } : {}),
    ...(g.models !== undefined ? { models: roleModels(g.models, "goal.models") } : {}),
    ...(g.language !== undefined ? { language: g.language as "ru" | "en" } : {}),
    ...(g.accessOverride !== undefined ? { accessOverride: accessOverride(g.accessOverride, "goal.accessOverride") } : {}),
    ...(g.task !== undefined ? { task: taskRef(g.task, "goal.task") } : {})
  };
}

// «Как в моём терминале» for one CLI of this run only (the person confirmed it in the dialog): nothing else is accepted.
function accessOverride(v: unknown, what: string): Partial<Record<"claude" | "codex", "terminal">> {
  const o = obj(v, what, [], ["claude", "codex"]);
  for (const [k, m] of Object.entries(o)) if (m !== "terminal") bad(`${what}.${k} must be "terminal"`);
  return o as Partial<Record<"claude" | "codex", "terminal">>;
}

// A role's model over the project setting: lead, executor, reviewer — each a model name or null (as in the CLI).
function uuids(v: unknown, what: string): string[] {
  if (!Array.isArray(v) || v.length > 200) bad(`${what} must be at most 200 ids`);
  return (v as unknown[]).map((x, i) => uuid(x, `${what}[${i}]`));
}

function taskRef(v: unknown, what: string): { id: string; key: string } {
  const o = obj(v, what, ["id", "key"]);
  const key = str(o.key, `${what}.key`, 8);
  if (!/^T-\d{1,6}$/.test(key)) bad(`${what}.key must be T-<n>`);
  return { id: uuid(o.id, `${what}.id`), key };
}

function roleModels(v: unknown, what: string): Partial<OrchestrationRoleModels> {
  const o = obj(v, what, [], ["lead", "executor", "reviewer"]);
  for (const [k, m] of Object.entries(o)) if (m !== null && !(typeof m === "string" && SAFE_MODEL.test(m))) bad(`${what}.${k} must be a model name or null`);
  return o as Partial<OrchestrationRoleModels>;
}

// The user's own check command lines (stage 12): 0..16 lines of 1..1000 characters, no NUL or line break.
function commandLines(v: unknown, what: string, min = 1): string[] {
  const lines = Array.isArray(v) && v.length >= min && v.length <= 16 ? v.map((c, i) => str(c, `${what}[${i}]`, 1000)) : bad(`${what} must be ${min}..16 command lines`);
  if (lines.some((l) => /[\0\r\n]/.test(l) || l.trim() === "")) bad(`${what} must be single non-empty lines`);
  return lines;
}

const finite = (v: unknown, what: string): number => (typeof v === "number" && Number.isFinite(v) ? v : bad(`${what} must be a finite number`));
export function parseBounds(v: unknown): OrchestrationBounds {
  const b = obj(v, "bounds", ["position", "size"]);
  const p = obj(b.position, "bounds.position", ["x", "y"]);
  const z = obj(b.size, "bounds.size", ["width", "height"]);
  return { position: { x: finite(p.x, "x"), y: finite(p.y, "y") }, size: { width: finite(z.width, "width"), height: finite(z.height, "height") } };
}

export function parseCommand(v: unknown): { runId: string; commandId: string; expectedRevision: number; command: RunCommand } {
  const o = obj(v, "request", ["runId", "commandId", "expectedRevision", "command"]);
  const c = isObj(o.command) ? o.command : bad("command must be a plain object");
  let command: RunCommand;
  switch (c.kind) {
    case "stop": case "resume": case "step": case "dismiss":
      obj(c, "command", ["kind"]); command = { kind: c.kind }; break;
    case "pause_after_turn":
      obj(c, "command", ["kind", "on"]);
      command = { kind: c.kind, on: typeof c.on === "boolean" ? c.on : bad("command.on must be a boolean") }; break;
    case "answer":
      obj(c, "command", ["kind", "questionId", "text"]);
      command = { kind: c.kind, questionId: uuid(c.questionId, "command.questionId"), text: str(c.text, "command.text", 8000) }; break;
    case "clarify":
      obj(c, "command", ["kind", "text"]); command = { kind: c.kind, text: str(c.text, "command.text", 8000) }; break;
    case "recover":
      obj(c, "command", ["kind", "action"], ["confirm"]);
      if (!["accept", "retry_turn", "reset_to_checkpoint"].includes(c.action as string)) bad("command.action is unknown");
      if (c.confirm !== undefined && typeof c.confirm !== "boolean") bad("command.confirm must be a boolean");
      command = { kind: c.kind, action: c.action as "accept", ...(c.confirm !== undefined ? { confirm: c.confirm as boolean } : {}) }; break;
    case "raise_limit":
      obj(c, "command", ["kind", "limit", "value"]);
      if (!RAISABLE.includes(c.limit as string)) bad("command.limit is unknown");
      command = { kind: c.kind, limit: c.limit as "turns", value: int(c.value, "command.value", 1) }; break;
    case "permission": {
      obj(c, "command", ["kind", "requestId", "decision"], ["answers", "content", "feedback"]);
      if (!["allow_once", "allow_session", "allow_run", "allow_project", "allow_readonly_run", "deny"].includes(c.decision as string)) bad("command.decision is unknown");
      let answers: Record<string, string[]> | undefined;
      if (c.answers !== undefined) {
        const a = isObj(c.answers) ? c.answers : bad("command.answers must be a plain object");
        if (Object.keys(a).length > 8) bad("command.answers: at most 8 questions");
        answers = Object.fromEntries(Object.entries(a).map(([k, x]) => [str(k, "command.answers key", 200), Array.isArray(x) && x.length === 0 ? [] : strings(x, `command.answers.${k}`, 12, 2000)]));
      }
      // An MCP form's values: primitives or lists of choices; their meaning is checked against the form in main.
      let content: Record<string, unknown> | undefined;
      if (c.content !== undefined) {
        const a = isObj(c.content) ? c.content : bad("command.content must be a plain object");
        if (Object.keys(a).length > 30) bad("command.content: at most 30 fields");
        content = Object.fromEntries(Object.entries(a).map(([k, x]) => {
          const ok = typeof x === "boolean" || (typeof x === "number" && Number.isFinite(x)) || (typeof x === "string" && x.length <= 10_000)
            || (Array.isArray(x) && x.length <= 100 && x.every((y) => typeof y === "string" && y.length <= 200));
          return [str(k, "command.content key", 100), ok ? x : bad(`command.content.${k} is not a form value`)];
        }));
      }
      const feedback = c.feedback === undefined ? undefined : str(c.feedback, "command.feedback", 8000, 0);
      command = {
        kind: c.kind, requestId: uuid(c.requestId, "command.requestId"), decision: c.decision as "deny",
        ...(answers ? { answers } : {}), ...(content ? { content } : {}), ...(feedback !== undefined ? { feedback } : {})
      };
      break;
    }
    case "checks.decide":
      obj(c, "command", ["kind", "decision"], ["checks"]);
      if (c.decision !== "accept" && c.decision !== "edit") bad("command.decision is unknown");
      if ((c.decision === "edit") !== (c.checks !== undefined)) bad("command.checks: exactly with edit");
      command = { kind: c.kind, decision: c.decision as "accept" | "edit", ...(c.checks !== undefined ? { checks: Array.isArray(c.checks) && c.checks.length === 0 ? [] : strings(c.checks, "command.checks", 16, 1000) } : {}) };
      break;
    case "finish.confirm": {
      obj(c, "command", ["kind", "tree", "commit", "push", "qa"]);
      const oid = (x: unknown, what: string) => (typeof x === "string" && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(x) ? x : bad(`${what} must be a Git object id`));
      const step = (x: unknown, what: string) => (x === null || x === "confirm" || x === "decline" ? x : bad(`${what} must be confirm, decline or null`));
      command = { kind: c.kind, tree: oid(c.tree, "command.tree"), commit: c.commit === null ? null : oid(c.commit, "command.commit"), push: step(c.push, "command.push"), qa: step(c.qa, "command.qa") };
      break;
    }
    case "check.amend":
      // A1.1 (journal-v2-format.md §2.6): the decided set's id and the person's line (main checks it); without a line
      // ("run the lead's command without the sandbox") there is no such command
      obj(c, "command", ["kind", "checkId", "line"]);
      if (typeof c.checkId !== "string" || !/^cmd-([1-9]|1[0-6])$/.test(c.checkId)) bad("command.checkId must be cmd-1…cmd-16");
      command = { kind: c.kind, checkId: c.checkId as string, line: str(c.line, "command.line", 1000, 1) };
      break;
    // A4 (journal-v2-format.md §2.9): the person's decisions — exactly these fields; anything else (who decided, a role)
    // is not the renderer's to say: a decision is the person's command, and main records it so
    case "person.decide": {
      obj(c, "command", ["kind", "subject", "target", "decision", "finding", "runKey"]);
      const runKey = typeof c.runKey === "string" && SHA256.test(c.runKey) ? c.runKey : bad("command.runKey must be a run key");
      if (c.subject === "disputed") {
        const t = obj(c.target, "command.target", ["reviewTurnId", "index"]);
        if (c.decision !== "new" && c.decision !== "repeat") bad("command.decision is unknown");
        const finding = c.decision === "new" ? (c.finding === null ? null : bad("command.finding: null for a new finding")) : findingId(c.finding);
        command = { kind: c.kind, subject: "disputed", target: { reviewTurnId: uuid(t.reviewTurnId, "command.target.reviewTurnId"), index: int(t.index, "command.target.index", 0, 49) },
          decision: c.decision, finding, runKey } as RunCommand;
      } else if (c.subject === "condition" || c.subject === "finding") {
        const id = c.subject === "condition" ? (typeof c.target === "string" && /^C[1-9]\d{0,5}$/.test(c.target) ? c.target : bad("command.target must be C<n>")) : findingId(c.target);
        const allowed = c.subject === "condition" ? ["met", "not_met"] : ["close", "to_wish"];
        if (!allowed.includes(c.decision as string)) bad("command.decision is unknown");
        if (c.finding !== null) bad("command.finding must be null");
        command = { kind: c.kind, subject: c.subject, target: id, decision: c.decision, finding: null, runKey } as RunCommand;
      } else return bad("command.subject is unknown");
      break;
    }
    case "plan.decide": {
      obj(c, "command", ["kind", "proposalTurnId", "decision", "choices", "note", "runKey"]);
      const runKey = typeof c.runKey === "string" && SHA256.test(c.runKey) ? c.runKey : bad("command.runKey must be a run key");
      if (!Array.isArray(c.choices) || c.choices.length > 50) bad("command.choices: up to 50");
      const choices = (c.choices as unknown[]).map((x, i) => {
        const ch = obj(x, `command.choices[${i}]`, ["id", "choice", "stage", "condition"]);
        if (!["move", "close", "to_wish"].includes(ch.choice as string)) bad(`command.choices[${i}].choice is unknown`);
        return { id: findingId(ch.id), choice: ch.choice as "move", stage: ch.stage === null ? null : int(ch.stage, `command.choices[${i}].stage`, 1, 10_000),
          condition: ch.condition === null ? null : typeof ch.condition === "string" && /^C[1-9]\d{0,5}$/.test(ch.condition) ? ch.condition : bad(`command.choices[${i}].condition must be C<n>`) };
      });
      if (c.decision === "accept") {
        if (c.note !== null) bad("command.note: only with return");
        command = { kind: c.kind, proposalTurnId: uuid(c.proposalTurnId, "command.proposalTurnId"), decision: "accept", choices, note: null, runKey };
      } else if (c.decision === "return") {
        if (choices.length) bad("command.choices: only with accept");
        command = { kind: c.kind, proposalTurnId: uuid(c.proposalTurnId, "command.proposalTurnId"), decision: "return", choices: [], note: c.note === null ? null : str(c.note, "command.note", 4000, 0), runKey };
      } else return bad("command.decision is unknown");
      break;
    }
    default:
      return bad("command.kind is unknown");
  }
  return { runId: uuid(o.runId, "runId"), commandId: uuid(o.commandId, "commandId"), expectedRevision: int(o.expectedRevision, "expectedRevision", 0), command };
}

const invalid = (error: unknown): OrchestrationResult<never> => {
  if (error instanceof Invalid) return { ok: false, code: "invalid_argument", message: error.message };
  throw error;
};
// Arguments first; the manager is reached only with checked values.
const checked = <A extends unknown[], T>(parse: () => A, call: (...a: A) => Promise<OrchestrationResult<T>>) => {
  let args: A;
  try { args = parse(); } catch (e) { return Promise.resolve(invalid(e)); }
  return call(...args);
};

export function registerOrchestrationIpc(handleMain: Handle, manager: RunManager): void {
  // The current page of each webContents: runId -> its one subscription. A watch that is still being set up has
  // unwatch null; when it settles it stays only if its page is still current and the entry is still its own, otherwise
  // it is released at once (an unwatch, a newer watch, a reload or a closed window came first).
  type Entry = { unwatch: (() => void) | null; unwatchActivity?: () => void };
  const pages = new Map<number, Map<string, Entry>>();
  const hooked = new Set<number>();
  const release = (id: number) => {
    const page = pages.get(id);
    pages.delete(id);
    for (const e of page?.values() ?? []) { e.unwatch?.(); e.unwatchActivity?.(); }
  };
  function pageOf(sender: WebContents): Map<string, Entry> {
    const id = sender.id;
    if (!hooked.has(id)) {
      hooked.add(id);
      sender.once("destroyed", () => { release(id); hooked.delete(id); });
      // A reload or navigation of the main frame starts a new page with a new preload: its watches are gone.
      sender.on("did-start-navigation", (details: { isMainFrame?: boolean; isSameDocument?: boolean }) => {
        if (details?.isMainFrame && !details.isSameDocument) release(id);
      });
    }
    let page = pages.get(id);
    if (!page) pages.set(id, (page = new Map()));
    return page;
  }
  const current = (sender: WebContents, page: Map<string, Entry>, runId: string, entry: Entry) =>
    !sender.isDestroyed() && pages.get(sender.id) === page && page.get(runId) === entry;

  handleMain(IPC.orchestrationCatalog, () => manager.catalog());
  handleMain(IPC.orchestrationList, () => manager.list());
  handleMain(IPC.orchestrationGet, (_e, runId: unknown) => checked(() => [uuid(runId, "runId")] as [string], manager.get));
  handleMain(IPC.orchestrationCreate, (_e, req: unknown) => checked(() => [parseCreate(req)] as [OrchestrationCreateRequest], manager.create));
  handleMain(IPC.orchestrationCommand, (_e, req: unknown) => checked(() => {
    const { runId, ...input } = parseCommand(req);
    return [runId, input] as [string, Omit<ReturnType<typeof parseCommand>, "runId">];
  }, manager.command));
  handleMain(IPC.orchestrationHistory, (_e, runId: unknown, fromSeq: unknown, limit: unknown) => checked(
    () => [uuid(runId, "runId"), int(fromSeq, "fromSeq", 0), int(limit, "limit", 1, 200)] as [string, number, number], manager.history
  ));
  handleMain(IPC.orchestrationText, (_e, runId: unknown, sha256: unknown) => checked(() => {
    if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) bad("sha256 must be 64 lowercase hex digits");
    return [uuid(runId, "runId"), sha256 as string] as [string, string];
  }, manager.text));
  handleMain(IPC.orchestrationCanvas, () => manager.canvas());
  handleMain(IPC.orchestrationAgentCreate, (_e, input: unknown) => checked(() => {
    const o = obj(input, "request", ["agentId", "provider", "project", "bounds", "workspaceId"]);
    if (o.provider !== "codex" && o.provider !== "claude") bad("provider must be codex or claude");
    const project = str(o.project, "project", 4096);
    if (!project.startsWith("/")) bad("project must be an absolute path");
    return [{ agentId: uuid(o.agentId, "agentId"), provider: o.provider as OrchestrationProviderKind, project, bounds: parseBounds(o.bounds), workspaceId: workspaceId(o.workspaceId) }] as [
      { agentId: string; provider: OrchestrationProviderKind; project: string; bounds: OrchestrationBounds; workspaceId: string }];
  }, manager.createAgent));
  handleMain(IPC.orchestrationAgentGroupMove, (_e, agentIds: unknown, target: unknown) => checked(() => {
    if (!Array.isArray(agentIds) || agentIds.length < 1 || agentIds.length > 200) bad("agentIds must be 1..200 ids");
    return [(agentIds as unknown[]).map((id, i) => uuid(id, `agentIds[${i}]`)), workspaceId(target)] as [string[], string];
  }, manager.moveAgentGroup));
  handleMain(IPC.orchestrationAgentMove, (_e, agentId: unknown, bounds: unknown, expanded: unknown) => checked(
    () => [uuid(agentId, "agentId"), parseBounds(bounds), expanded === undefined ? undefined : parseBounds({ position: { x: 0, y: 0 }, size: expanded }).size] as [string, OrchestrationBounds, OrchestrationBounds["size"] | undefined],
    manager.moveAgent));
  handleMain(IPC.orchestrationAgentDelete, (_e, agentId: unknown) => checked(() => [uuid(agentId, "agentId")] as [string], manager.deleteAgent));
  handleMain(IPC.orchestrationLinkCreate, (_e, input: unknown) => checked(() => {
    const o = obj(input, "request", ["linkId", "fromAgentId", "toAgentId"]);
    return [{ linkId: uuid(o.linkId, "linkId"), fromAgentId: uuid(o.fromAgentId, "fromAgentId"), toAgentId: uuid(o.toAgentId, "toAgentId") }] as [
      { linkId: string; fromAgentId: string; toAgentId: string }];
  }, manager.createLink));
  handleMain(IPC.orchestrationLinkDelete, (_e, linkId: unknown) => checked(() => [uuid(linkId, "linkId")] as [string], manager.deleteLink));
  handleMain(IPC.orchestrationLinkReleaseNewer, (_e, input: unknown) => checked(() => {
    const o = obj(input, "request", ["commandId", "linkId", "runId"]);
    return [{ commandId: uuid(o.commandId, "commandId"), linkId: uuid(o.linkId, "linkId"), runId: uuid(o.runId, "runId") }] as [
      { commandId: string; linkId: string; runId: string }];
  }, manager.releaseNewerLink));
  handleMain(IPC.orchestrationLinkStart, (_e, input: unknown) => checked(() => {
    const o = obj(input, "request", ["linkId", "requestId", "goal"]);
    return [{ linkId: uuid(o.linkId, "linkId"), requestId: uuid(o.requestId, "requestId"), goal: parseGoal(o.goal) }] as [
      { linkId: string; requestId: string; goal: OrchestrationGoalInput }];
  }, manager.startOnLink));
  handleMain(IPC.orchestrationActivity, (_e, runId: unknown, afterId: unknown, limit: unknown) => checked(
    () => [uuid(runId, "runId"), int(afterId, "afterId", 0), int(limit, "limit", 1, 500)] as [string, number, number], manager.activity));
  handleMain(IPC.orchestrationChanges, (_e, runId: unknown) => checked(() => [uuid(runId, "runId")] as [string], manager.changes));
  handleMain(IPC.orchestrationDiff, (_e, runId: unknown, path: unknown) => checked(() => {
    const p = str(path, "path", 4096);
    if (p.startsWith("/") || p.split("/").includes("..")) bad("path must be relative to the copy");
    return [uuid(runId, "runId"), p] as [string, string];
  }, manager.diff));
  handleMain(IPC.orchestrationTake, (_e, runId: unknown) => checked(() => [uuid(runId, "runId")] as [string], manager.take));
  handleMain(IPC.orchestrationTakeResult, (_e, runId: unknown, input: unknown) => checked(() => {
    const o = obj(input, "request", ["action"], ["name"]);
    if (o.action === "apply" && o.name === undefined) return [uuid(runId, "runId"), { action: "apply" }] as [string, OrchestrationTakeInput];
    if (o.action !== "branch") bad("action must be branch or apply");
    return [uuid(runId, "runId"), { action: "branch", name: str(o.name, "name", 200) }] as [string, OrchestrationTakeInput];
  }, manager.takeResult));
  // B1: the task board — every argument checked here, every rule of the board in main (boardStore)
  handleMain(IPC.orchestrationBoard, () => checked(() => [] as [], manager.board));
  handleMain(IPC.orchestrationBoardCreate, (_e, input: unknown) => checked(() => {
    const o = obj(input, "task", ["workspaceId", "project", "title", "text", "criteria"], ["dependsOn"]);
    return [{
      workspaceId: str(o.workspaceId, "task.workspaceId", 64), project: str(o.project, "task.project", 4096), title: str(o.title, "task.title", 200),
      text: str(o.text, "task.text", 8000), criteria: strings(o.criteria, "task.criteria", 32, 500),
      ...(o.dependsOn !== undefined ? { dependsOn: uuids(o.dependsOn, "task.dependsOn") } : {})
    }] as [BoardTaskInput];
  }, manager.boardCreate));
  handleMain(IPC.orchestrationBoardUpdate, (_e, id: unknown, patch: unknown) => checked(() => {
    const o = obj(patch, "patch", [], ["title", "text", "criteria", "dependsOn", "order"]);
    if (o.order !== undefined && (typeof o.order !== "number" || !Number.isFinite(o.order))) bad("patch.order must be a number");
    return [uuid(id, "id"), {
      ...(o.title !== undefined ? { title: str(o.title, "patch.title", 200) } : {}), ...(o.text !== undefined ? { text: str(o.text, "patch.text", 8000) } : {}),
      ...(o.criteria !== undefined ? { criteria: strings(o.criteria, "patch.criteria", 32, 500) } : {}),
      ...(o.dependsOn !== undefined ? { dependsOn: uuids(o.dependsOn, "patch.dependsOn") } : {}), ...(o.order !== undefined ? { order: o.order as number } : {})
    }] as [string, BoardTaskPatch];
  }, manager.boardUpdate));
  handleMain(IPC.orchestrationBoardArchive, (_e, id: unknown, archived: unknown) => checked(() => {
    if (typeof archived !== "boolean") bad("archived must be a boolean");
    return [uuid(id, "id"), archived as boolean] as [string, boolean];
  }, manager.boardArchive));
  handleMain(IPC.orchestrationBoardRemove, (_e, id: unknown) => checked(() => [uuid(id, "id")] as [string], manager.boardRemove));
  handleMain(IPC.orchestrationBoardAccept, (_e, id: unknown) => checked(() => [uuid(id, "id")] as [string], manager.boardAccept));
  handleMain(IPC.orchestrationReadiness, (_e, input: unknown) => checked(() => {
    const o = obj(input, "request", ["linkId", "commands", "workMode"], ["models", "accessOverride", "full", "timeoutMs"]);
    if (o.workMode !== "project" && o.workMode !== "copy" && o.workMode !== "worktree") bad("workMode must be project, worktree or copy");
    const commands = Array.isArray(o.commands) && o.commands.length === 0 ? [] : commandLines(o.commands, "commands");
    if (o.full !== undefined && typeof o.full !== "boolean") bad("full must be a boolean");
    // «Проверить сейчас»: at most an hour for the preparation and the commands together
    const timeoutMs = o.timeoutMs === undefined ? undefined : int(o.timeoutMs, "timeoutMs", 1_000, 60 * 60_000);
    return [{ linkId: uuid(o.linkId, "linkId"), commands, workMode: o.workMode as "project", ...(o.models !== undefined ? { models: roleModels(o.models, "models") } : {}),
      ...(o.accessOverride !== undefined ? { accessOverride: accessOverride(o.accessOverride, "accessOverride") } : {}),
      ...(o.full === true ? { full: true } : {}), ...(timeoutMs !== undefined ? { timeoutMs } : {}) }] as
      [{ linkId: string; commands: string[]; workMode: "project" | "copy" | "worktree"; models?: Partial<OrchestrationRoleModels>; accessOverride?: Partial<Record<"claude" | "codex", "terminal">>; full?: boolean; timeoutMs?: number }];
  }, manager.readiness));
  // Stage 13: the project profile (its fields are checked by validateProfile in main) and the environment probe.
  handleMain(IPC.orchestrationProfileGet, (_e, linkId: unknown, capabilities: unknown) => checked(() => {
    if (capabilities !== undefined && typeof capabilities !== "boolean") bad("capabilities must be a boolean");
    return [uuid(linkId, "linkId"), capabilities === true] as [string, boolean];
  }, manager.profile));
  handleMain(IPC.orchestrationProfileSave, (_e, linkId: unknown, profile: unknown) => checked(() => {
    if (!isObj(profile)) bad("profile must be a plain object");
    if (JSON.stringify(profile).length > 256 * 1024) bad("profile is too large");
    return [uuid(linkId, "linkId"), profile] as [string, unknown];
  }, manager.saveProfile));
  handleMain(IPC.orchestrationCodexModels, (_e, linkId: unknown, refresh: unknown) => checked(() => {
    if (refresh !== undefined && typeof refresh !== "boolean") bad("refresh must be a boolean");
    return [uuid(linkId, "linkId"), refresh === true] as [string, boolean];
  }, manager.codexModels));
  handleMain(IPC.orchestrationProbe, (_e, linkId: unknown, options: unknown) => checked(() => {
    // options: absent, or { mcpReady: the name of one MCP server }
    const o = options === undefined ? {} : options as Record<string, unknown>;
    if (typeof o !== "object" || o === null || Array.isArray(o) || Object.keys(o).some((k) => k !== "mcpReady")
      || (o.mcpReady !== undefined && !(typeof o.mcpReady === "string" && /^[\w.@-]{1,64}$/.test(o.mcpReady)))) bad("options: { mcpReady?: server name }");
    return [uuid(linkId, "linkId"), o.mcpReady === undefined ? {} : { mcpReady: o.mcpReady }] as [string, { mcpReady?: string }];
  }, manager.probe));
  handleMain(IPC.orchestrationWatch, (event, runId: unknown) => checked(() => [uuid(runId, "runId")] as [string], async (id) => {
    const sender = event.sender;
    const page = pageOf(sender);
    const older = page.get(id); // one subscription per page and run: a newer watch replaces the older one
    older?.unwatch?.();
    older?.unwatchActivity?.();
    const entry: Entry = { unwatch: null };
    page.set(id, entry);
    const send = (e: OrchestrationRunEvent) => { if (current(sender, page, id, entry)) sender.send(IPC.orchestrationEvent, e); };
    const { snapshot, unwatch } = await manager.watch(id, send);
    if (!current(sender, page, id, entry)) { unwatch(); return snapshot; } // cancelled while it was being set up
    if (snapshot.ok) {
      entry.unwatch = unwatch;
      // Activity batches of the run travel on the same channel and subscription ({ runId, entries }, no view).
      entry.unwatchActivity = manager.watchActivity(id, (a) => { if (current(sender, page, id, entry)) sender.send(IPC.orchestrationEvent, a); });
    } else page.delete(id);
    return snapshot;
  }));
  handleMain(IPC.orchestrationUnwatch, (event, runId: unknown) => checked(() => [uuid(runId, "runId")] as [string], async (id) => {
    const page = pages.get(event.sender.id);
    page?.get(id)?.unwatch?.();
    page?.get(id)?.unwatchActivity?.();
    page?.delete(id);
    return { ok: true, value: null };
  }));
}
