// The new-agent dialog and the goal dialog (stage-8-contract.md §1). Both only collect input; main checks it.
import { useCallback, useEffect, useRef, useState } from "react";
import type { LocaleId } from "../../../../shared/contracts";
import type {
  OrchestrationGoalInput, OrchestrationLimitKind, OrchestrationProfileInfo, OrchestrationReadiness, OrchestrationReadinessItem, OrchestrationRoleModels, OrchestrationRunMode,
  OrchestrationWorkMode
} from "../../../../shared/orchestration";
import { ProviderIcon } from "../../components/ProviderIcon";
import { UiIcon } from "../../components/UiIcon";
import { t, type TranslationKey } from "../../lib/i18n";
import { ProjectSettings } from "./ProjectSettings";
import { NO_MODELS, RoleModelsField } from "./RoleModels";
import { profileGoal } from "../../../../shared/taskBoard";
import { Differences, RunPanel, Termed } from "./RunPanel";
import { accessProblemText, commandLike, dirtyInPlace, failingOnSource } from "./runModel";
import type { AgentCanvasUi } from "./useAgentCanvasUi";
import { outcomeText, type Orchestration } from "./useOrchestration";

function useEscape(onClose: () => void): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
}

export function Dialog({ label, onClose, children, locale }: { label: string; onClose(): void; children: React.ReactNode; locale: LocaleId }): React.JSX.Element {
  useEscape(onClose);
  return (
    <div className="dialog-backdrop" role="presentation" data-interactive="true" data-wheel-owner="local" data-canvas-wheel-priority="local" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="launch-dialog orch-dialog" role="dialog" aria-modal="true" aria-label={label}>
        <div className="launch-dialog__toolbar">
          <strong className="orch-dialog__title">{label}</strong>
          <button className="launch-dialog__close" type="button" onClick={onClose} aria-label={t(locale, "orchClose")}><UiIcon name="close" size={18} /></button>
        </div>
        {children}
      </section>
    </div>
  );
}

function AgentCreateDialog({ ui, locale, defaultProject }: { ui: AgentCanvasUi; locale: LocaleId; defaultProject: string }): React.JSX.Element | null {
  const at = ui.createAt!;
  const [project, setProject] = useState(defaultProject);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (): Promise<void> => {
    setBusy(true);
    const text = await ui.createAgent(at.provider, project.trim(), at.point);
    setBusy(false);
    setError(text);
    if (!text) ui.closeCreate();
  };
  return (
    <Dialog label={t(locale, at.provider === "codex" ? "orchAgentCodex" : "orchAgentClaude")} onClose={ui.closeCreate} locale={locale}>
      <form className="orch-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <div className="launch-dialog__top">
          <div className="launch-dialog__provider"><ProviderIcon provider={at.provider} size="large" /></div>
          <label className="orch-field">
            <span>{t(locale, "orchProject")}</span>
            <span className="orch-field__row">
              <input autoFocus value={project} placeholder={t(locale, "orchProjectPlaceholder")} onChange={(e) => setProject(e.target.value)} />
              <button type="button" onClick={async () => {
                const picked = await window.canvasTTY.dialog.pickDirectory(project || undefined);
                if (picked) setProject(picked);
              }}><UiIcon name="folder" size={16} /> {t(locale, "orchChooseFolder")}</button>
            </span>
          </label>
        </div>
        <div className="orch-form__actions">
          <button type="button" onClick={ui.closeCreate}>{t(locale, "orchCancel")}</button>
          <button type="submit" className="orch-primary" disabled={busy || !project.trim().startsWith("/")}>{t(locale, "orchCreate")}</button>
        </div>
        {error && <div className="dialog-error" role="alert">{error}</div>}
      </form>
    </Dialog>
  );
}

const LIMITS: OrchestrationLimitKind[] = ["turns", "roundsPerStage", "replans", "runMs"];
const tr = (locale: LocaleId, key: string): string => t(locale, key as TranslationKey) ?? key;

// Readiness before the start (stages 11–12): asked from main whenever the check commands or the work place change, shown
// item by item. Start is possible only when main answered, no item is a blocker and every "confirm" item is
// acknowledged. A failure to ask is said as such and never counts as ready.
// the i18n key of an item: numbered ones (command_<n>, source_<n>) share one
const readyKey = (id: string) => (id.startsWith("command_") ? "command" : /^source_\d+$/.test(id) ? "source_cmd" : id);
// «Исправить»: where a problem item is fixed — the project settings, or the goal's check commands
export type ReadyFix = "settings" | "commands";
function fixTarget(item: OrchestrationReadinessItem): ReadyFix | null {
  if (item.level === "ok" || item.level === "info") return null;
  if (/^access_(claude|codex)$/.test(item.id) || /^model(_\w+_pass)?$/.test(item.id) || item.id === "source_prepare") return "settings";
  if (/^source_\d+$/.test(item.id) || item.id === "source_failing" || item.id.startsWith("command_")) return "commands";
  return null;
}

export function readinessLine(locale: LocaleId, item: OrchestrationReadinessItem): string {
  const f = item.facts ?? {};
  const id = readyKey(item.id);
  const base = tr(locale, `orchReady_${id}_${item.level}`);
  const cmd = String(f.command ?? "");
  switch (id) {
    // «Проверить сейчас» (UX audit №8): the sign-in, the check sandbox, the preparation and the commands on the source
    case "auth_codex": case "auth_claude": return item.level === "ok" && f.method ? `${base} (${String(f.method)})` : base;
    case "sandbox": return item.level === "ok" ? `${base} (${tr(locale, "orchReadySandboxChecks").replace("{n}", String(f.checks ?? "?"))})` : `${base} ${String(f.failed ?? "")}`;
    case "source_prepare": return item.level === "ok" ? base : `${tr(locale, `orchReady_source_prepare_${String(f.result ?? "failed")}`)} ${cmd}`;
    case "source_cmd": return `${tr(locale, `orchReady_source_cmd_${String(f.result ?? "failed")}`)} ${cmd}${f.result === "passed" && typeof f.durationMs === "number" ? ` (${Math.max(1, Math.round(f.durationMs / 1000))} ${t(locale, "orchUnitSec")})` : ""}`;
    case "source": return f.code === "workspace_failed" ? `${base} ${item.detail}` : base;
    case "clis": return item.level === "blocker" ? `${base} ${item.detail}`
      : `${base} Codex: ${String(f.codex ?? "")} · Claude: ${String(f.claude ?? "")}${item.level === "warning" && f.changes ? ` — ${String(f.changes).split("\n").join("; ")}` : ""}`;
    case "access_claude": case "access_codex": case "model_codex_pass": case "model_claude_pass": return accessProblemText(locale, f);
    case "access_claude_unconfirmed": case "access_codex_unconfirmed":
      return tr(locale, "orchAccessUnconfirmed").replaceAll("{cli}", f.provider === "codex" ? "Codex" : "Claude").replace("{mode}", tr(locale, `orchAccess_${String(f.mode ?? "")}`));
    case "access_claude_once": case "access_codex_once": return tr(locale, "orchAccessOnceInfo").replace("{cli}", f.provider === "codex" ? "Codex" : "Claude");
    case "env": return item.level === "blocker" ? `${base} ${item.detail}` : `${base} ${String(f.shell ?? "")} · PATH: ${String(f.pathEntries ?? "?")}`;
    case "git": return item.level === "info" ? `${base} ${String(f.changed ?? "")}` : base;
    case "workdir": return f.mode === "worktree" ? `${tr(locale, "orchReady_worktree_info")} ${String(f.path ?? "")}`
      : f.mode === "copy" ? `${tr(locale, "orchReady_workdir_copy")} ${String(f.path ?? "")}` : `${base} ${String(f.path ?? "")}`;
    case "laravel": return f.prepared === true ? tr(locale, "orchReady_laravel_prepared") : base;
    case "prepare": return `${base} ${String(f.steps ?? "").split("\n").join(" · ")}`;
    case "testdb": {
      // review 2: a connection URL (DB_URL, DATABASE_URL…) replaces DB_*; why the level is what it is, never the URL itself
      const why = t(locale, `orchReadyWhy_testdb_${String(f.reason ?? "")}` as TranslationKey) as string | undefined;
      // review 3: the active connection by its name (it may differ from the driver) and, when unknown, which field
      const variable = String(f.variable ?? "") || "DB_URL";
      const named = f.connectionName && f.connectionName !== f.connection ? `«${String(f.connectionName)}» ` : "";
      return `${base} ${named}${String(f.connection ?? "")}${f.database ? ` ${String(f.database)}` : ""}${f.host ? ` ${String(f.host)}` : ""} (${String(f.source ?? "")}${f.variable ? `, ${String(f.variable)}` : ""})${why ? ` — ${why.replaceAll("{variable}", variable).replaceAll("{unknown}", String(f.unknown || "?")).replaceAll("{connection}", String(f.connectionName || "?"))}` : ""}`;
    }
    case "stack": return `${base} ${tr(locale, `orchStack_${String(f.stack ?? "unknown")}`)}`;
    case "command": return f.later === true ? `${tr(locale, "orchReady_command_later")} ${String(f.command ?? "")}`
      : `${base} ${String(f.command ?? "")}${item.level === "warning" ? ` — ${String(f.program ?? "")}` : ""}`;
    case "tests": return item.level === "ok" ? `${base} ${String(f.testFiles ?? "?")}` : base;
    case "model": {
      if (item.level === "blocker") return base.replace("{model}", String(f.model ?? ""));
      const m = (v: unknown) => (v === "cli" || v === undefined ? t(locale, "orchModelCli") : String(v));
      return `${base} ${t(locale, "orchRoleLead")} — ${m(f.lead)} · ${t(locale, "orchRoleExecutor")} — ${m(f.executor)} · ${t(locale, "orchRoleReviewer")} — ${m(f.reviewer)}`;
    }
    default: return base;
  }
}

// The agents' rights as the project settings set them, in words ("Claude — Full access · Codex — As in my terminal").
const rightsText = (locale: LocaleId, access: { claude: string; codex: string }) =>
  `Claude — ${tr(locale, `orchAccess_${access.claude}`)} · Codex — ${tr(locale, `orchAccess_${access.codex}`)}`;

const NO_OVERRIDE: Partial<Record<"claude" | "codex", "terminal">> = {};
function Readiness({ linkId, commands, workMode, models, access, locale, onChange, onSuggest, onBusy, accessOverride = NO_OVERRIDE, onAccessOverride, onBlocker, onFix, onWorkMode, onFailing, auto = true }: {
  linkId: string; commands: string[]; workMode: OrchestrationWorkMode; models?: OrchestrationRoleModels; access: { claude: string; codex: string } | null; locale: LocaleId;
  onChange(ok: boolean): void; onSuggest(commands: string[]): void;
  onBusy(facts: unknown): void; // the "busy" item's facts: the run main says holds the folder (none: undefined)
  // «Как в моём терминале» for one CLI of this run only: offered on its access blocker, confirmed first
  accessOverride?: Partial<Record<"claude" | "codex", "terminal">>; onAccessOverride?(next: Partial<Record<"claude" | "codex", "terminal">>): void;
  onBlocker?(text: string | null): void; // the first blocker in words: said beside the inactive Start
  onFix?(target: ReadyFix): void; // «Исправить» on a problem item: open where it is fixed
  onWorkMode?(mode: OrchestrationWorkMode): void; // «Переключить на отдельную копию» (this goal only)
  onFailing?(commands: string[]): void; // the commands «Проверить сейчас» found failing before any change (of this goal as written)
  // false (the project settings): nothing is asked until «Проверить сейчас»; true (the goal dialog): the light check
  // (no preparation, no commands) is asked by itself on every change
  auto?: boolean;
}): React.JSX.Element {
  // «Проверить сейчас»: the same readiness with the preparation and the commands on the source; its time, for the key
  // it was asked for (a change of the goal brings back the light check)
  const [checked, setChecked] = useState<{ key: string; ms: number } | null>(null);
  const [checking, setChecking] = useState(false);
  const [confirming, setConfirming] = useState<"claude" | "codex" | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [state, setState] = useState<{ kind: "idle" } | { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; value: OrchestrationReadiness }>({ kind: auto ? "loading" : "idle" });
  const [acks, setAcks] = useState<Record<string, boolean>>({});
  const [attempt, setAttempt] = useState(0);
  const key = JSON.stringify([linkId, commands, workMode, models, accessOverride]);
  useEffect(() => {
    if (!auto) { setState({ kind: "idle" }); return; }
    let live = true;
    setState({ kind: "loading" });
    const id = window.setTimeout(async () => {
      const r = await window.canvasTTY.orchestration.readiness({ linkId, commands, workMode, ...(models ? { models } : {}), ...(Object.keys(accessOverride).length ? { accessOverride } : {}) }).catch((e: unknown) => ({ ok: false as const, code: "transport", message: String(e) }));
      if (!live) return;
      if (r.ok) {
        setState({ kind: "ready", value: r.value });
        onBusy(r.value.items.find((i) => i.id === "busy")?.facts);
        const suggest = String(r.value.items.find((i) => i.id === "stack")?.facts?.suggest ?? "");
        if (suggest) onSuggest(suggest.split("\n").filter(Boolean));
      } else setState({ kind: "error", message: r.code === "transport" ? t(locale, "orchTransportError") : tr(locale, `orchError_${r.code}`) });
    }, 350);
    return () => { live = false; window.clearTimeout(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, attempt, models, accessOverride, auto]);
  const checkNow = async (): Promise<void> => {
    setChecking(true);
    const started = performance.now();
    const r = await window.canvasTTY.orchestration.readiness({ linkId, commands, workMode, full: true, ...(models ? { models } : {}), ...(Object.keys(accessOverride).length ? { accessOverride } : {}) })
      .catch((e: unknown) => ({ ok: false as const, code: "transport", message: String(e) }));
    setChecking(false);
    if (r.ok) { setState({ kind: "ready", value: r.value }); setChecked({ key, ms: performance.now() - started }); onBusy(r.value.items.find((i) => i.id === "busy")?.facts); }
    else setState({ kind: "error", message: r.code === "transport" ? t(locale, "orchTransportError") : tr(locale, `orchError_${r.code}`) });
  };
  const items = state.kind === "ready" ? state.value.items : [];
  const confirms = items.filter((i) => i.level === "confirm");
  const ok = state.kind === "ready" && state.value.ready && confirms.every((i) => acks[i.id]);
  useEffect(() => { onChange(ok); }, [ok, onChange]);
  const blocker = items.find((i) => i.level === "blocker");
  const blockerText = blocker ? readinessLine(locale, blocker) : null;
  useEffect(() => { onBlocker?.(blockerText); }, [blockerText, onBlocker]);
  const failing = checked && checked.key === key ? failingOnSource(items).join("\n") : "";
  useEffect(() => { onFailing?.(failing ? failing.split("\n") : []); }, [failing, onFailing]);
  const dirty = onWorkMode ? dirtyInPlace(workMode, items) : null;
  return (
    <fieldset className="orch-field orch-ready" data-orch-readiness={state.kind === "ready" ? (state.value.ready ? (ok ? "ready" : "confirm") : "blocked") : state.kind} data-orch-checked={checked && checked.key === key ? "full" : undefined}>
      <legend>{t(locale, "orchReadyTitle")}</legend>
      <div className="orch-ready__now">
        <button type="button" data-orch-check-now disabled={checking} onClick={() => void checkNow()}>{t(locale, "orchCheckNow")}</button>
        {checking ? <small className="orch-hint" data-orch-check-running>{t(locale, workMode === "project" ? "orchCheckNowRunningProject" : "orchCheckNowRunning")}</small>
          : checked && checked.key === key ? <small className="orch-hint" data-orch-check-done>{t(locale, "orchCheckNowDone").replace("{time}", `${Math.max(1, Math.round(checked.ms / 1000))} ${t(locale, "orchUnitSec")}`)}</small>
            : <small className="orch-hint">{t(locale, "orchCheckNowHint")}</small>}
      </div>
      {state.kind === "ready" && (() => {
        const blockers = items.filter((i) => i.level === "blocker").length;
        const warnings = items.filter((i) => i.level === "warning").length + (dirty !== null ? 1 : 0);
        return (
          <p className={`orch-ready__summary${blockers ? " orch-ready__summary--blocked" : ""}`} data-orch-ready-summary={blockers ? "blocked" : warnings ? "warnings" : "ok"}>
            {t(locale, "orchReadySummary").replace("{blockers}", String(blockers)).replace("{warnings}", String(warnings))}{" "}
            {t(locale, blockers ? "orchReadySummaryBlocked" : "orchReadySummaryCan")}
          </p>
        );
      })()}
      {dirty !== null && (
        <p className="orch-hint orch-hint--warn" role="status" data-orch-dirty={dirty}>
          {t(locale, "orchDirtyInPlace").replace("{n}", String(dirty))}{" "}
          <button type="button" data-orch-dirty-switch onClick={() => onWorkMode?.("copy")}>{t(locale, "orchDirtySwitch")}</button>
        </p>
      )}
      {state.kind === "loading" && <p className="orch-hint">{t(locale, "orchReadyChecking")}</p>}
      {state.kind === "error" && <p className="dialog-error" role="alert">{t(locale, "orchReadyFailed")}: {state.message} <button type="button" onClick={() => setAttempt((n) => n + 1)}>{t(locale, "orchRepeat")}</button></p>}
      {items.length > 0 && (
        <ul>
          {items.map((item) => {
            const id = readyKey(item.id);
            const fix = item.level === "blocker" || item.level === "confirm" || item.level === "warning" ? t(locale, `orchReadyFix_${id}_${item.level}` as TranslationKey) : undefined;
            const target = onFix ? fixTarget(item) : null;
            const output = typeof item.facts?.output === "string" && item.facts.output ? item.facts.output : null;
            return (
              <li key={item.id} className={`orch-ready__item orch-ready__item--${item.level}`} data-ready-id={item.id} data-ready-level={item.level}>
                <span className="orch-ready__mark" aria-hidden="true">{item.level === "ok" ? "✓" : item.level === "info" ? "i" : item.level === "blocker" ? "✕" : "!"}</span>
                <span>
                  {item.id === "permissions" && access ? `${t(locale, "orchReady_permissions_access")} ${rightsText(locale, access)}.` : readinessLine(locale, item)}
                  {output && <pre className="orch-ready__output" data-ready-output>{output}</pre>}
                  {fix && <small className="orch-ready__fix">{fix}</small>}
                  {target && <button type="button" className="orch-ready__fix-button" data-orch-fix={target} onClick={() => onFix?.(target)}>{t(locale, "orchReadyFixButton")}</button>}
                  {item.level === "blocker" && /^access_(claude|codex)$/.test(item.id) && onAccessOverride && (() => {
                    const p = item.id === "access_codex" ? "codex" : "claude";
                    const cli = p === "codex" ? "Codex" : "Claude";
                    return confirming !== p
                      ? <button type="button" data-orch-access-once={p} onClick={() => { setConfirming(p); setConfirmed(false); }}>{tr(locale, "orchAccessOnce").replace("{cli}", cli)}</button>
                      : (
                        <span className="orch-access-once" data-orch-access-once-confirm={p}>
                          <small className="orch-hint orch-hint--warn">{tr(locale, "orchAccessOnceWarn").replace("{cli}", cli)}</small>
                          <label className="orch-check"><input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} /><span>{tr(locale, "orchAccessOnceAck")}</span></label>
                          <button type="button" disabled={!confirmed} data-orch-access-once-apply={p} onClick={() => { onAccessOverride({ ...accessOverride, [p]: "terminal" }); setConfirming(null); }}>{tr(locale, "orchAccessOnceApply")}</button>
                          <button type="button" onClick={() => setConfirming(null)}>{t(locale, "orchCancel")}</button>
                        </span>
                      );
                  })()}
                  {/^access_(claude|codex)_once$/.test(item.id) && onAccessOverride && (
                    <button type="button" data-orch-access-once-undo onClick={() => { const { [item.id.startsWith("access_codex") ? "codex" : "claude"]: _, ...rest } = accessOverride; onAccessOverride(rest); }}>{tr(locale, "orchAccessOnceUndo")}</button>
                  )}
                  {item.level === "confirm" && (
                    <label className="orch-check">
                      <input type="checkbox" checked={acks[item.id] ?? false} onChange={(e) => setAcks((a) => ({ ...a, [item.id]: e.target.checked }))} />
                      <span>{tr(locale, `orchReadyAck_${id}`)}</span>
                    </label>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <Differences locale={locale} />
    </fieldset>
  );
}

// The project profile of a link's lead project (stage 13): loaded when the dialog opens, saved from the settings.
function useProfile(linkId: string | undefined) {
  const [state, setState] = useState<{ kind: "loading" } | { kind: "error"; code: string } | { kind: "ready"; info: OrchestrationProfileInfo }>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!linkId) return;
    let live = true;
    setState({ kind: "loading" });
    void window.canvasTTY.orchestration.profile(linkId).then(
      (r) => { if (live) setState(r.ok ? { kind: "ready", info: r.value } : { kind: "error", code: r.code }); },
      () => { if (live) setState({ kind: "error", code: "transport" }); });
    return () => { live = false; };
  }, [linkId, attempt]);
  return { state, reload: () => setAttempt((n) => n + 1), set: (info: OrchestrationProfileInfo) => setState({ kind: "ready", info }) };
}

// folderBusy: another run already works in this folder, as main names it (readiness "busy" facts or the folder_busy
// refusal of the start); where it is. null: nothing (or nothing readable) holds it.
export type FolderBusy = (held: unknown) => { name: string; runReadable: boolean; open(): void } | null;

function GoalDialog({ orch, ui, locale, folderBusy }: { orch: Orchestration; ui: AgentCanvasUi; locale: LocaleId; folderBusy?: FolderBusy }): React.JSX.Element | null {
  const link = orch.canvas.links.find((l) => l.linkId === ui.goalLinkId);
  const lead = link && orch.canvas.agents.find((a) => a.agentId === link.fromAgentId);
  const profile = useProfile(link?.linkId);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // B2: started from a board task, the goal begins with its text and requirements and names it (goal.task)
  const task = ui.goalTask;
  const [text, setText] = useState(task?.text ?? "");
  const [criteria, setCriteria] = useState(task?.criteria.join("\n") ?? "");
  const [mode, setMode] = useState<OrchestrationRunMode>("autopilot");
  // The project's own check commands, one per line; from the project settings until the user edits them.
  const [commandsText, setCommandsText] = useState("");
  const edited = useRef(false);
  const [workMode, setWorkMode] = useState<OrchestrationWorkMode>("copy");
  const [fromBranch, setFromBranch] = useState(true); // B4: a task's copy from its dependency's branch, or the working folder
  const [finish, setFinish] = useState<{ commit: boolean; push: boolean; qa: boolean }>({ commit: false, push: false, qa: false });
  const suggest = useCallback((lines: string[]) => { if (!edited.current) setCommandsText((cur) => cur || lines.join("\n")); }, []);
  const [limits, setLimits] = useState<Record<string, string>>({});
  const [reviewPlan, setReviewPlan] = useState(false);
  const [models, setModels] = useState<OrchestrationRoleModels>(NO_MODELS);
  // a CLI without the project's rights mode, run «as in my terminal» for this run only (confirmed in the readiness)
  const [accessOverride, setAccessOverride] = useState<Partial<Record<"claude" | "codex", "terminal">>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [blockedBy, setBlockedBy] = useState<string | null>(null);
  const [held, setHeld] = useState<unknown>(undefined);
  // «Проверить сейчас» found commands failing before any change: at «Старт» the person chooses (this run only)
  const [failing, setFailing] = useState<string[]>([]);
  const [choosing, setChoosing] = useState(false);
  // One request id per goal as written: a retry after a transport failure repeats it, an edited goal is a new request.
  const request = useRef<{ fingerprint: string; id: string } | null>(null);
  const info = profile.state.kind === "ready" ? profile.state.info : null;
  // The dialog starts from the saved (or suggested) project settings; the person changes this goal only.
  const applied = useRef<string | null>(null);
  useEffect(() => {
    if (!info) return;
    const key = JSON.stringify(info.profile);
    if (applied.current === key) return;
    applied.current = key;
    // the same defaults as the board's autopilot takes (profileGoal): the person may change them here
    const d = profileGoal(info.profile);
    if (!edited.current) setCommandsText(d.commands.join("\n"));
    setWorkMode(d.workMode);
    setFinish(d.finish);
    setModels(d.models);
  }, [info]);
  if (!link || !lead) return null;

  const commands = commandsText.split("\n").map((c) => c.trim()).filter(Boolean);
  const canFinish = workMode !== "copy";
  // push and QA deliver this run's commit: ticking either takes the commit with it
  const chosen = canFinish ? { commit: finish.commit || finish.push || finish.qa, push: finish.push && !!info?.profile.finish.push, qa: finish.qa && !!info?.profile.finish.qa } : null;
  // journal v2 (development flag until A4): the commands may be left empty — the lead proposes them; a role's model
  const optionalChecks = info?.optionalChecks === true;
  const asked: OrchestrationGoalInput = {
    ...(optionalChecks ? { models } : {}),
    text: text.trim(),
    criteria: criteria.split("\n").map((c) => c.trim()).filter(Boolean),
    checks: [], commands, workMode, mode,
    reviewPlan: mode === "steps" || reviewPlan,
    language: locale === "ru" ? "ru" : "en", // the agents write what the person reads in the interface's language
    ...(Object.keys(accessOverride).length ? { accessOverride } : {}),
    ...(task ? { task: { id: task.id, key: task.key } } : {}),
    ...(task?.base && fromBranch && workMode === "copy" && optionalChecks ? { base: task.base } : {}),
    ...(chosen && (chosen.commit || chosen.push || chosen.qa) ? { finish: chosen } : {}),
    limits: Object.fromEntries(LIMITS.flatMap((kind) => {
      const n = Number(limits[kind]);
      if (!limits[kind]?.trim() || !Number.isInteger(n) || n <= 0) return [];
      return [[kind, kind === "runMs" ? n * 60_000 : n]];
    }))
  };
  // the dependency's result is in a branch only and this start does not take it: the person's choice, said and sent as such
  const withoutBase = !!task?.base && !asked.base;
  const complete = asked.text !== "" && asked.criteria.length > 0 && (commands.length > 0 || optionalChecks);
  const kept = commands.filter((c) => !failing.includes(c.slice(0, 200)));
  const submit = async (only?: string[]): Promise<void> => {
    setChoosing(false);
    const goal: OrchestrationGoalInput = only ? { ...asked, commands: only } : asked;
    const fingerprint = JSON.stringify([link.linkId, goal]);
    if (request.current?.fingerprint !== fingerprint) request.current = { fingerprint, id: crypto.randomUUID() };
    setBusy(true);
    setError(null);
    const { outcome, refused } = await orch.startOnLink({ linkId: link.linkId, requestId: request.current.id, goal, ...(task?.anyway || withoutBase ? { anyway: true } : {}) });
    setBusy(false);
    // taken after the readiness check: the hint below names the run and its workspace instead of the bare refusal
    if (outcome.kind === "refused" && outcome.code === "folder_busy" && folderBusy?.(refused)) {
      setHeld(refused);
      return;
    }
    const message = outcomeText(locale, outcome);
    if (message) {
      setError(message);
      return;
    }
    ui.openPanel(link.linkId);
  };

  if (settingsOpen && info) {
    return (
      <Dialog label={t(locale, "orchSettingsTitle")} onClose={() => setSettingsOpen(false)} locale={locale}>
        <div className="orch-field orch-field--static"><span>{t(locale, "orchProject")}</span><strong title={lead.project}>{lead.project}</strong></div>
        <ProjectSettings locale={locale} linkId={link.linkId} info={info} onCancel={() => setSettingsOpen(false)}
          check={(draft) => <Readiness linkId={link.linkId} commands={draft.checks} workMode={draft.workMode} access={draft.access} locale={locale} auto={false}
            onChange={() => {}} onSuggest={() => {}} onBusy={() => {}} />}
          onSaved={(saved) => { profile.set({ ...info, profile: saved, saved: true }); edited.current = false; setSettingsOpen(false); }} />
      </Dialog>
    );
  }

  return (
    <Dialog label={t(locale, "orchNewGoal")} onClose={ui.closeGoal} locale={locale}>
      <form className="orch-form" onSubmit={(event) => { event.preventDefault(); if (complete && ready) { if (failing.length) setChoosing(true); else void submit(); } }}>
        {task && (
          <div className="orch-field orch-field--static" data-goal-task={task.key}>
            <span>{t(locale, "boardTaskFrom")}</span>
            <strong title={task.title}>{task.key} · {task.title}</strong>
            {task.anyway && <small className="orch-hint orch-hint--warn" data-goal-task-anyway>{t(locale, "boardStartAnywayNote")}</small>}
          </div>
        )}
        {/* owner's decision 11: outside the autopilot the person chooses what the copy starts from */}
        {withoutBase && <small className="orch-hint orch-hint--warn" data-goal-base-without>{t(locale, "goalBaseWithout").replace("{key}", task!.base!.key)}</small>}
        {task?.base && workMode === "copy" && optionalChecks && (
          <fieldset className="orch-field" data-goal-base>
            <legend>{t(locale, "goalBase")}</legend>
            <label><input type="radio" name="goal-base" checked={fromBranch} onChange={() => setFromBranch(true)} data-goal-base-branch />
              {t(locale, "goalBaseBranch").replace("{key}", task.base.key).replace("{branch}", task.base.branch)}</label>
            <label><input type="radio" name="goal-base" checked={!fromBranch} onChange={() => setFromBranch(false)} data-goal-base-folder /> {t(locale, "goalBaseFolder")}</label>
          </fieldset>
        )}
        <div className="orch-field orch-field--static">
          <span>{t(locale, "orchProject")}</span>
          <strong title={lead.project}>{lead.project}</strong>
          <span className="orch-profile" data-orch-profile={profile.state.kind === "ready" ? (profile.state.info.saved ? "saved" : "suggested") : profile.state.kind}>
            {profile.state.kind === "ready" ? t(locale, profile.state.info.saved ? "orchProfileSaved" : "orchProfileSuggested")
              : profile.state.kind === "error" ? `${t(locale, "orchProfileFailed")} (${tr(locale, `orchError_${profile.state.code}`)})` : t(locale, "orchLoading")}
            {" "}{info
              ? <button type="button" data-orch-open-settings onClick={() => setSettingsOpen(true)}>{t(locale, "orchProfileOpen")}</button>
              : profile.state.kind === "error" && <button type="button" onClick={profile.reload}>{t(locale, "orchRepeat")}</button>}
          </span>
        </div>
        {info && (
          <p className="orch-rights" data-orch-rights>
            <b>{t(locale, "orchRights")}:</b> {rightsText(locale, info.profile.access)}
            {(info.profile.access.claude === "full" || info.profile.access.codex === "full") && <small className="dialog-error" data-orch-rights-full>{t(locale, "orchAccessFullWarn")}</small>}
            {(info.profile.access.claude === "terminal" || info.profile.access.codex === "terminal") && <small className="orch-hint orch-hint--warn" data-orch-rights-terminal>{t(locale, "orchAccessTerminalWarn")}</small>}
          </p>
        )}
        <label className="orch-field">
          <span>{t(locale, "orchGoalTask")}</span>
          <textarea autoFocus rows={3} value={text} placeholder={t(locale, "orchGoalTaskPlaceholder")} onChange={(e) => setText(e.target.value)} />
        </label>
        <label className="orch-field">
          <span>{t(locale, "orchGoalCriteria")}</span>
          <textarea rows={3} value={criteria} onChange={(e) => setCriteria(e.target.value)} />
          {criteria.split("\n").some(commandLike) && (
            <small className="orch-hint orch-hint--warn" data-orch-req-command>
              {t(locale, "orchGoalReqLooksLikeCommand")}{" "}
              <button type="button" data-orch-req-move onClick={() => {
                const lines = criteria.split("\n");
                edited.current = true;
                setCommandsText((c) => [...c.split("\n").filter((l) => l.trim()), ...lines.filter(commandLike).map((l) => l.trim())].join("\n"));
                setCriteria(lines.filter((l) => !commandLike(l)).join("\n"));
              }}>{t(locale, "orchGoalReqMove")}</button>
            </small>
          )}
        </label>
        <fieldset className="orch-field orch-runmode" data-orch-runmode={mode}>
          <legend>{t(locale, "orchRunMode")}</legend>
          {(["autopilot", "steps"] as const).map((m) => (
            <label key={m} className="orch-check">
              <input type="radio" name="orch-runmode" value={m} checked={mode === m} onChange={() => setMode(m)} />
              <span><b>{t(locale, `orchRunMode_${m}`)}</b> — {t(locale, `orchRunMode_${m}Hint`)}</span>
            </label>
          ))}
        </fieldset>
        <fieldset className="orch-field orch-finish" data-orch-finish-choice>
          <legend>{t(locale, "orchFinishTitle")}</legend>
          {!canFinish ? <p className="orch-hint">{t(locale, "orchFinishCopyOff")}</p> : (["commit", "push", "qa"] as const).map((step) => {
            const configured = step === "commit" || (step === "push" ? !!info?.profile.finish.push : !!info?.profile.finish.qa);
            const implied = step === "commit" && (finish.push || finish.qa);
            const target = step === "push" && info?.profile.finish.push ? ` → ${info.profile.finish.push.remote}/${info.profile.finish.push.branch}`
              : step === "qa" && info?.profile.finish.qa ? ` → ${info.profile.finish.qa.environment}` : "";
            return (
              <label key={step} className="orch-check" data-finish-option={step}>
                <input type="checkbox" disabled={!configured || implied} checked={configured && (finish[step] || implied)}
                  onChange={(e) => setFinish((f) => ({ ...f, [step]: e.target.checked }))} />
                <span>{t(locale, `orchFinish_${step}`)}{target}{!configured ? ` — ${t(locale, "orchFinishNotConfigured")}` : ""}{implied ? ` — ${t(locale, "orchFinishCommitImplied")}` : ""}</span>
              </label>
            );
          })}
          <small className="orch-hint">{t(locale, "orchFinish_keep")} {t(locale, "orchFinishHint")}</small>
        </fieldset>
        <label className="orch-field">
          <span>{t(locale, "orchGoalCommands")}</span>
          <textarea rows={2} value={commandsText} spellCheck={false} data-orch-commands placeholder={t(locale, "orchGoalCommandsPlaceholder")}
            onChange={(e) => { edited.current = true; setCommandsText(e.target.value); }} />
          <small className="orch-hint">{t(locale, "orchGoalCommandsHint")}{commandsText.trim() && !edited.current ? ` ${t(locale, "orchGoalCommandsFilled")}` : ""}</small>
          {optionalChecks && <small className="orch-hint" data-orch-commands-optional>{t(locale, "orchCommandsOptional")}</small>}
        </label>
        <details className="orch-advanced">
          <summary>{t(locale, "orchAdvanced")}</summary>
          <fieldset className="orch-field orch-workmode" data-orch-workmode={workMode}>
            <legend>{t(locale, "orchWorkMode")}</legend>
            {(["copy", "worktree", "project"] as const).map((m) => (
              <label key={m} className="orch-check">
                <input type="radio" name="orch-workmode" value={m} checked={workMode === m} onChange={() => setWorkMode(m)} />
                <span><b><Termed locale={locale} text={tr(locale, `orchWorkMode_${m}`)} /></b> — <Termed locale={locale} text={tr(locale, `orchWorkMode_${m}Hint`)} /></span>
              </label>
            ))}
          </fieldset>
          <fieldset className="orch-field orch-limits">
            <legend>{t(locale, "orchGoalLimits")}</legend>
            {LIMITS.map((kind) => (
              <label key={kind}>
                <span>{t(locale, `orchLimit_${kind}` as TranslationKey)}</span>
                <input type="number" min={1} step={1} inputMode="numeric" value={limits[kind] ?? ""}
                  onChange={(e) => setLimits((cur) => ({ ...cur, [kind]: e.target.value }))} />
              </label>
            ))}
          </fieldset>
          {mode === "autopilot" && (
            <label className="orch-check">
              <input type="checkbox" checked={reviewPlan} onChange={(e) => setReviewPlan(e.target.checked)} />
              <span>{t(locale, "orchReviewPlan")}</span>
            </label>
          )}
          {optionalChecks && <RoleModelsField locale={locale} linkId={link.linkId} value={models} hint={t(locale, "orchModelsGoalHint")} onChange={setModels} />}
        </details>
        <Readiness linkId={link.linkId} commands={commands} workMode={workMode} {...(optionalChecks ? { models } : {})} access={info?.profile.access ?? null} locale={locale} onChange={setReady} onSuggest={suggest} onBusy={setHeld}
          accessOverride={accessOverride} onAccessOverride={setAccessOverride} onBlocker={setBlockedBy} onWorkMode={setWorkMode} onFailing={setFailing}
          onFix={(target) => {
            if (target === "settings") { setSettingsOpen(true); return; }
            const field = document.querySelector<HTMLTextAreaElement>(".orch-dialog [data-orch-commands]");
            const fold = field?.closest("details");
            if (fold) fold.open = true;
            field?.scrollIntoView({ block: "center" });
            field?.focus();
          }} />
        {(() => {
          const other = folderBusy?.(held);
          return other && (
            <div className="orch-hint orch-hint--warn" role="status" data-orch-folder-busy>
              {t(locale, other.runReadable ? "orchFolderBusyIn" : "orchFolderBusyUnreadable").replace("{name}", other.name)}
              <button type="button" data-orch-folder-busy-open onClick={other.open}>{t(locale, "wsOpenNamed").replace("{name}", other.name)}</button>
            </div>
          );
        })()}
        {choosing && (
          <div className="orch-failing" role="alertdialog" aria-label={t(locale, "orchFailingTitle")} data-orch-failing-choice>
            <p><b>{t(locale, "orchFailingTitle")}</b></p>
            <ul>{failing.map((c) => <li key={c}><code>{c}</code></li>)}</ul>
            <p className="orch-hint">{t(locale, "orchFailingHint")}</p>
            {!kept.length && !optionalChecks && <p className="orch-hint orch-hint--warn" data-orch-failing-none>{t(locale, "orchFailingDropNone")}</p>}
            <div className="orch-failing__actions">
              <button type="button" className="orch-primary" data-orch-primary="drop_failing" data-orch-failing-drop disabled={busy || (!kept.length && !optionalChecks)}
                onClick={() => void submit(kept)}>{t(locale, "orchFailingDrop")}</button>
              <button type="button" data-orch-failing-keep disabled={busy} onClick={() => void submit()}>{t(locale, "orchFailingKeep")}</button>
              <button type="button" data-orch-failing-cancel onClick={() => setChoosing(false)}>{t(locale, "orchFailingBack")}</button>
            </div>
          </div>
        )}
        <div className="orch-form__actions">
          {/* why Start is off, beside it in the pinned bottom (UX audit PR 2) */}
          {!complete && <span className="orch-hint orch-form__why" data-orch-incomplete>{t(locale, optionalChecks ? "orchGoalIncompleteNoChecks" : "orchGoalIncomplete")}</span>}
          {complete && !ready && <span className="orch-hint orch-form__why" data-orch-not-ready>{blockedBy ? `${t(locale, "orchStartBlockedBy")} ${blockedBy}` : t(locale, "orchReadyNotYet")}</span>}
          <button type="button" onClick={ui.closeGoal}>{t(locale, "orchCancel")}</button>
          <button type="submit" className="orch-primary" disabled={busy || choosing || !complete || !ready}>{busy ? t(locale, "orchSending") : t(locale, "orchStart")}</button>
        </div>
        {error && <div className="dialog-error" role="alert">{error}</div>}
      </form>
    </Dialog>
  );
}

export function OrchestrationOverlays({ orch, ui, locale, defaultProject, folderBusy, taskOfRun }: {
  orch: Orchestration; ui: AgentCanvasUi; locale: LocaleId; defaultProject: string; folderBusy?: FolderBusy;
  taskOfRun?(runId: string): { key: string; title: string } | null; // B2: the board task a run works on
}): React.JSX.Element {
  const panelLink = orch.canvas.links.find((l) => l.linkId === ui.panelLinkId) ?? null;
  // A run opened by id stays open without its link; a link's panel shows the link's latest run.
  const panelRunId = ui.panel?.runId ?? panelLink?.runIds.at(-1) ?? null;
  const latestOfLink = panelLink !== null && panelLink.runIds.at(-1) === panelRunId;
  return (
    <>
      {ui.linkingFrom && <div className="orch-linking-hint" role="status">{t(locale, "orchLinkingHint")}</div>}
      {ui.createAt && <AgentCreateDialog key={`${ui.createAt.provider}:${ui.createAt.point.x}:${ui.createAt.point.y}`} ui={ui} locale={locale} defaultProject={defaultProject} />}
      {ui.goalLinkId && <GoalDialog key={ui.goalLinkId} orch={orch} ui={ui} locale={locale} folderBusy={folderBusy} />}
      {ui.panel && (panelLink || ui.panel.runId) && <RunPanel key={ui.panel.runId ?? panelLink?.linkId} orch={orch} runId={panelRunId} locale={locale} panel={ui.panel}
        onClose={ui.closePanel} onNewGoal={panelLink && latestOfLink ? () => ui.openGoal(panelLink.linkId) : null} onView={ui.setPanelView}
        task={panelRunId ? taskOfRun?.(panelRunId) ?? null : null} />}
    </>
  );
}
