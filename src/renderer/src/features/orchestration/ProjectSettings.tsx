// Stage 13: the one-time setup of a project (docs/agent-orchestration/implementation/stage-13-autopilot.md §2). A few
// fields up front — where the agents work, the checks, automatic preparation, the agents' rights — and the rest under
// "Advanced". Filled from the repository by main; main validates and saves it. The "Environment" check asks the CLIs
// themselves what they loaded (no model turn) and shows only what they confirmed.
import { useEffect, useState } from "react";
import type { LocaleId } from "../../../../shared/contracts";
import type {
  OrchestrationEnvironmentReport,
  OrchestrationProfileInfo,
  OrchestrationProjectProfile
} from "../../../../shared/orchestration";
import { t, type TranslationKey } from "../../lib/i18n";
import { outcomeOf, probeText } from "./runModel";
import { NO_MODELS, RoleModelsField } from "./RoleModels";
import { outcomeText } from "./useOrchestration";

const tr = (locale: LocaleId, key: string): string => t(locale, key as TranslationKey) ?? key;
const api = () => window.canvasTTY.orchestration;

const stepsText = (p: OrchestrationProjectProfile) => p.prepare.steps.map((s) => (s.unless ? `${s.command} | ${s.unless}` : s.command)).join("\n");
function parseSteps(text: string): OrchestrationProjectProfile["prepare"]["steps"] {
  return text.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
    const at = l.lastIndexOf(" | ");
    return at > 0 ? { command: l.slice(0, at).trim(), unless: l.slice(at + 3).trim() || null } : { command: l, unless: null };
  });
}

export function EnvironmentCheck({ locale, linkId }: { locale: LocaleId; linkId: string }): React.JSX.Element {
  const [state, setState] = useState<{ kind: "idle" } | { kind: "busy" } | { kind: "error"; text: string } | { kind: "done"; report: OrchestrationEnvironmentReport }>({ kind: "idle" });
  const run = async (): Promise<void> => {
    setState({ kind: "busy" });
    const { outcome, value } = await outcomeOf(() => api().probe(linkId));
    if (outcome.kind === "accepted" && value) setState({ kind: "done", report: value });
    else setState({ kind: "error", text: outcomeText(locale, outcome) ?? t(locale, "orchError_generic") });
  };
  return (
    <fieldset className="orch-field orch-env-check" data-orch-env-check={state.kind}>
      <legend>{t(locale, "orchEnvTitle")}</legend>
      <p className="orch-hint">{t(locale, "orchEnvProbeHint")}</p>
      <button type="button" disabled={state.kind === "busy"} onClick={() => void run()}>{t(locale, state.kind === "busy" ? "orchEnvProbing" : "orchEnvProbe")}</button>
      {state.kind === "error" && <p className="dialog-error" role="alert">{state.text}</p>}
      {state.kind === "done" && (
        <div className="orch-env" data-orch-env-report>
          <p>{t(locale, "orchEnvShell")}: <code>{state.report.shell.shell ?? "?"}</code> · PATH {state.report.shell.pathEntries} · {tr(locale, `orchDirenv_${state.report.shell.direnv}`)}</p>
          {state.report.providers.map((p) => (
            <div key={p.provider} data-env-provider={p.provider} {...(p.limitMs ? { "data-env-limit": p.limitMs } : {})}>
              <strong>{p.provider === "codex" ? "Codex" : "Claude"}</strong>
              {!p.ok && <p className="dialog-error">{t(locale, "orchEnvFailed")}: {p.error}</p>}
              <ul>
                {p.items.map((i) => (
                  <li key={i.id} data-env-item={i.id} data-confirmed={i.confirmed ? "yes" : "no"}
                    {...(i.complete !== undefined ? { "data-env-complete": i.complete ? "yes" : "no" } : {})} {...(i.incomplete ? { "data-env-incomplete": i.incomplete } : {})}>
                    {tr(locale, `orchEnvItem_${i.id}`)}: {!i.confirmed ? <i>{t(locale, "orchEnvUnconfirmed")}</i> : i.servers?.length ? i.servers.map((m, k) => (
                      <span key={m.name} data-mcp-server={m.name} data-mcp-connection={m.connection ?? ""} data-mcp-auth={m.auth ?? ""} data-mcp-tools={m.tools.join(",")}>
                        {k ? ", " : ""}<b>{m.name}</b> ({m.connection ?? t(locale, "orchEnvMcpNotChecked")}{m.auth ? `; ${t(locale, "orchEnvMcpAuth")}: ${m.auth}` : ""}{m.tools.length ? `; ${t(locale, "orchEnvMcpTools")}: ${m.tools.length}` : ""})
                      </span>)) : <b>{probeText(locale, i.value)}</b>}
                    {i.note ? <small className="orch-hint"> — {probeText(locale, i.note)}</small> : null}
                  </li>
                ))}
              </ul>
              {p.timing?.length ? (
                <details className="orch-hint" data-env-timing>
                  <summary>{t(locale, "orchEnvTiming")}{p.limitMs ? ` (${Math.round(p.limitMs / 1000)} s)` : ""}</summary>
                  <ol>
                    {p.timing.map((x, k) => (
                      <li key={k} data-timing-method={x.method} data-timing-page={x.page ?? ""} data-timing-start={x.startMs} data-timing-duration={x.durationMs}
                        data-timing-allotted={x.allottedMs} data-timing-left={x.leftMs} data-timing-outcome={x.outcome}>
                        <code>{x.method}{x.page ? ` #${x.page}` : ""}</code>: {x.durationMs} ms / {x.allottedMs} ms — {tr(locale, `orchEnvOutcome_${x.outcome}`)}
                      </li>
                    ))}
                  </ol>
                </details>
              ) : null}
            </div>
          ))}
          <p className="orch-hint">{t(locale, "orchEnvParityNote")}</p>
        </div>
      )}
    </fieldset>
  );
}

export function ProjectSettings({ locale, linkId, info, onSaved, onCancel }: {
  locale: LocaleId; linkId: string; info: OrchestrationProfileInfo; onSaved(profile: OrchestrationProjectProfile): void; onCancel(): void;
}): React.JSX.Element {
  const [p, setP] = useState<OrchestrationProjectProfile>(info.profile);
  const [checks, setChecks] = useState(info.profile.checks.join("\n"));
  const [steps, setSteps] = useState(stepsText(info.profile));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // "As in my terminal" newly chosen for a CLI: saved only with its warning confirmed (main checks it again)
  const [confirmTerminal, setConfirmTerminal] = useState(false);
  const toTerminal = (["claude", "codex"] as const).some((k) => p.access[k] === "terminal" && !(info.saved && info.profile.access[k] === "terminal"));
  // The rights modes the installed CLIs offer: asked when the settings open (the CLIs start with --help, no model).
  const [caps, setCaps] = useState<OrchestrationProfileInfo["capabilities"] | null>(null);
  useEffect(() => {
    let live = true;
    void api().profile(linkId, true).then((r) => { if (live && r.ok) setCaps(r.value.capabilities); }).catch(() => {});
    return () => { live = false; };
  }, [linkId]);
  const set = (patch: Partial<OrchestrationProjectProfile>) => setP((cur) => ({ ...cur, ...patch }));
  const finish = (patch: Partial<OrchestrationProjectProfile["finish"]>) => setP((cur) => ({ ...cur, finish: { ...cur.finish, ...patch } }));
  const qa = p.finish.qa ?? { environment: "", command: "", verify: "", reportsVersion: false };
  const qaOn = !!(qa.environment || qa.command || qa.verify);
  // QA delivers this run's commit (main refuses QA without the commit action): filling it in turns the commit on
  const setQa = (patch: Partial<typeof qa>) => finish({ qa: { ...qa, ...patch }, ...(Object.values(patch).some((v) => typeof v === "string" && v.trim()) ? { commit: true } : {}) });

  // Checked here first so the person is told which field is wrong; main validates everything again.
  const invalid = (): string | null => {
    const parts = [qa.environment, qa.command, qa.verify].filter((v) => v.trim()).length;
    if (parts > 0 && parts < 3) return t(locale, "orchSettingsErrQa");
    if (p.finish.push && !p.finish.push.branch.trim()) return t(locale, "orchSettingsErrBranch");
    if ((parts > 0 || p.finish.push) && !p.finish.commit) return t(locale, "orchSettingsErrNeedsCommit");
    if (toTerminal && !confirmTerminal) return t(locale, "orchError_terminal_not_confirmed");
    return null;
  };
  const save = async (): Promise<void> => {
    const wrong = invalid();
    if (wrong) return setError(wrong);
    const profile: OrchestrationProjectProfile = {
      ...p,
      checks: checks.split("\n").map((c) => c.trim()).filter(Boolean),
      prepare: { ...p.prepare, steps: parseSteps(steps) },
      finish: { ...p.finish, qa: qaOn ? { environment: qa.environment.trim(), command: qa.command.trim(), verify: qa.verify.trim(), reportsVersion: !!qa.reportsVersion } : null }
    };
    setBusy(true);
    setError(null);
    const { outcome, value } = await outcomeOf(() => api().saveProfile(linkId, { ...profile, ...(toTerminal ? { confirmTerminal } : {}) }));
    setBusy(false);
    if (outcome.kind === "accepted" && value) onSaved(value);
    else setError(outcomeText(locale, outcome) ?? t(locale, "orchError_generic"));
  };

  const accessSelect = (provider: "claude" | "codex") => {
    const options = (caps ?? info.capabilities)[provider];
    const current = p.access[provider];
    const all = options.some((o) => o.mode === current) ? options : [...options, { mode: current, mapping: "" }];
    const mapping = current === "terminal" ? null : all.find((o) => o.mode === current)?.mapping ?? "";
    return (
      <label className="orch-field" data-orch-access={provider}>
        <span>{provider === "claude" ? "Claude" : "Codex"}</span>
        <select value={current} onChange={(e) => set({ access: { ...p.access, [provider]: e.target.value } })}>
          {all.map((o) => <option key={o.mode} value={o.mode}>{tr(locale, `orchAccess_${o.mode}`)}</option>)}
        </select>
        {/* the CLI's own flags are a detail: folded under «Подробнее» */}
        <details className="orch-hint" data-orch-access-details>
          <summary>{t(locale, "orchMore")}</summary>
          {t(locale, "orchAccessMaps")} {mapping === null ? t(locale, "orchAccessMapsNone") : <code>{mapping}</code>}
        </details>
        {current === "workspace" && <small className="orch-hint">{t(locale, "orchAccessWorkspaceHint")}</small>}
        {current === "terminal" && <small className="orch-hint orch-hint--warn" data-orch-terminal-warning>{t(locale, "orchAccessTerminalWarn")}</small>}
        {current === "full" && <small className="dialog-error" data-orch-full-warning>{t(locale, "orchAccessFullWarn")}</small>}
      </label>
    );
  };

  return (
    <form className="orch-form orch-settings" data-orch-settings onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <p className="orch-hint">{t(locale, "orchSettingsIntro")}</p>
      <fieldset className="orch-field orch-workmode" data-orch-settings-workmode={p.workMode}>
        <legend>{t(locale, "orchWorkMode")}</legend>
        {(["project", "worktree"] as const).map((m) => (
          <label key={m} className="orch-check">
            <input type="radio" name="orch-settings-workmode" checked={p.workMode === m} onChange={() => set({ workMode: m })} />
            <span><b>{tr(locale, `orchWorkMode_${m}`)}</b> — {tr(locale, `orchWorkMode_${m}Hint`)}</span>
          </label>
        ))}
      </fieldset>
      <label className="orch-field">
        <span>{t(locale, "orchSettingsChecks")}</span>
        <textarea rows={2} spellCheck={false} value={checks} data-orch-settings-checks onChange={(e) => setChecks(e.target.value)} />
      </label>
      <label className="orch-check">
        <input type="checkbox" checked={p.prepare.auto} data-orch-settings-prepare onChange={(e) => set({ prepare: { ...p.prepare, auto: e.target.checked } })} />
        <span>{t(locale, "orchSettingsPrepareAuto")}</span>
      </label>
      {/* the commands themselves under «More» (UX audit PR 2: technical details folded) */}
      {info.facts.needed.length ? <details className="orch-hint" data-orch-needed><summary>{t(locale, "orchSettingsNeeded")} {info.facts.needed.length} · {t(locale, "orchMore")}</summary>{info.facts.needed.join(" · ")}</details>
        : <p className="orch-hint" data-orch-needed>{t(locale, "orchSettingsNothingNeeded")}</p>}
      <fieldset className="orch-field">
        <legend>{t(locale, "orchSettingsAccess")}</legend>
        <p className="orch-hint">{t(locale, "orchSettingsAccessHint")}</p>
        {accessSelect("claude")}
        {accessSelect("codex")}
        {toTerminal && (
          <label className="orch-check" data-orch-terminal-confirm>
            <input type="checkbox" checked={confirmTerminal} onChange={(e) => setConfirmTerminal(e.target.checked)} />
            <span>{t(locale, "orchAccessTerminalConfirm")}</span>
          </label>
        )}
      </fieldset>
      {/* journal v2: a role's model is recorded in the goal only there */}
      {info.optionalChecks && (
        <RoleModelsField locale={locale} linkId={linkId} value={p.models ?? NO_MODELS} hint={t(locale, "orchModelsSettingsHint")} onChange={(models) => set({ models })} />
      )}

      <details className="orch-advanced" data-orch-advanced>
        <summary>{t(locale, "orchAdvanced")}</summary>
        <label className="orch-field">
          <span>{t(locale, "orchSettingsPrepareSteps")}</span>
          <textarea rows={3} spellCheck={false} value={steps} data-orch-settings-steps onChange={(e) => setSteps(e.target.value)} />
        </label>
        <label className="orch-check">
          <input type="checkbox" checked={p.env.direnv} onChange={(e) => set({ env: { direnv: e.target.checked } })} />
          <span>{t(locale, "orchSettingsDirenv")}</span>
        </label>
        <fieldset className="orch-field" data-orch-settings-finish>
          <legend>{t(locale, "orchSettingsFinish")}</legend>
          <label className="orch-check">
            <input type="checkbox" checked={p.finish.commit} onChange={(e) => finish({ commit: e.target.checked, ...(e.target.checked ? {} : { push: null }) })} />
            <span>{t(locale, "orchSettingsCommitDefault")}</span>
          </label>
          <label className="orch-field">
            <span>{t(locale, "orchSettingsPush")}</span>
            <span className="orch-field__row">
              <select value={p.finish.push?.remote ?? ""} data-orch-settings-remote
                onChange={(e) => finish(e.target.value ? { commit: true, push: { remote: e.target.value, branch: p.finish.push?.branch ?? "", remoteUrl: null } } : { push: null })}>
                <option value="">{t(locale, "orchSettingsPushNone")}</option>
                {info.facts.remotes.map((r) => <option key={r.name} value={r.name}>{r.name} — {r.url}</option>)}
              </select>
              {p.finish.push && (
                <input value={p.finish.push.branch} placeholder={t(locale, "orchSettingsPushBranch")} data-orch-settings-branch
                  onChange={(e) => finish({ push: { ...p.finish.push!, branch: e.target.value } })} />
              )}
            </span>
          </label>
          <label className="orch-field"><span>{t(locale, "orchSettingsQa")}: {t(locale, "orchSettingsQaEnv")}</span>
            <input value={qa.environment} data-orch-settings-qa-env onChange={(e) => setQa({ environment: e.target.value })} /></label>
          <label className="orch-field"><span>{t(locale, "orchSettingsQaCommand")}</span>
            <input value={qa.command} spellCheck={false} data-orch-settings-qa-command onChange={(e) => setQa({ command: e.target.value })} /></label>
          <label className="orch-field"><span>{t(locale, "orchSettingsQaVerify")}</span>
            <input value={qa.verify} spellCheck={false} data-orch-settings-qa-verify onChange={(e) => setQa({ verify: e.target.value })} /></label>
          <label className="orch-check" data-orch-settings-qa-reports>
            <input type="checkbox" checked={!!qa.reportsVersion} onChange={(e) => setQa({ reportsVersion: e.target.checked })} />
            <span>{t(locale, "orchSettingsQaReportsVersion")}</span>
          </label>
          {qa.verify.trim() && !qa.reportsVersion && <small className="orch-hint" data-orch-qa-unverified>{t(locale, "orchSettingsQaUnverified")}</small>}
          <small className="orch-hint">{t(locale, "orchSettingsQaHint")} {t(locale, "orchSettingsQaNeedsCommit")}</small>
        </fieldset>
        <fieldset className="orch-field" data-orch-settings-grants>
          <legend>{t(locale, "orchSettingsGrants")}</legend>
          {p.grants.length === 0 ? <p className="orch-hint">{t(locale, "orchSettingsGrantsNone")}</p> : (
            <ul>{p.grants.map((g) => (
              <li key={g.id} data-grant={g.id}>
                {g.provider === "codex" ? "Codex" : "Claude"} · {g.tool}: <code>{g.summary}</code>{" "}
                <button type="button" onClick={() => set({ grants: p.grants.filter((x) => x.id !== g.id) })}>{t(locale, "orchSettingsGrantRemove")}</button>
              </li>
            ))}</ul>
          )}
        </fieldset>
        <EnvironmentCheck locale={locale} linkId={linkId} />
      </details>

      <div className="orch-form__actions">
        <button type="button" onClick={onCancel}>{t(locale, "orchCancel")}</button>
        <button type="submit" className="orch-primary" disabled={busy}>{busy ? t(locale, "orchSending") : t(locale, "orchSettingsSave")}</button>
      </div>
      {error && <div className="dialog-error" role="alert">{error}</div>}
    </form>
  );
}
