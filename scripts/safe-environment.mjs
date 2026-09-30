// What the series keeps of the application's environment probe: explicitly chosen protocol fields only — item ids and
// whether the CLI confirmed them, MCP servers' names, connection, sign-in state and tool names, readiness flags. Never
// an item's text, a note, an error message, environment values, headers, addresses or a raw answer: any of them may
// carry a credential, and masking is not relied on.
const str = (v) => (typeof v === "string" ? v : null);
const server = (x) => ({ name: str(x?.name), connection: str(x?.connection), auth: str(x?.auth), tools: Array.isArray(x?.tools) ? x.tools.filter((t) => typeof t === "string") : [] });

// The fixed codes of an incomplete list (shared/orchestration.ts OrchestrationListIncomplete); anything else is dropped.
const INCOMPLETE = new Set(["timeout", "request_failed", "cli_exited", "page_failed", "no_list", "cursor_unreadable", "cursor_repeats", "page_limit"]);
// The probe's timing (OrchestrationProbeTiming): the protocol's own method names, whole milliseconds, a fixed outcome.
const METHODS = new Set(["initialize", "mcp_status", "config/read", "skills/list", "plugin/installed", "hooks/list", "account/read", "mcpServerStatus/list", "thread/start"]);
const OUTCOMES = new Set(["answered", "protocol_error", "wait_expired", "late", "cli_exited", "not_sent"]);
const ms = (v) => (Number.isFinite(v) && v >= 0 ? Math.round(v) : null);
export const safeTiming = (list) => (Array.isArray(list) ? list : []).filter((t) => METHODS.has(t?.method) && OUTCOMES.has(t?.outcome)).map((t) => ({
  method: t.method, page: Number.isInteger(t.page) && t.page > 0 ? t.page : null, startMs: ms(t.startMs), durationMs: ms(t.durationMs), allottedMs: ms(t.allottedMs), leftMs: ms(t.leftMs), outcome: t.outcome }));

export function safeReport(report) {
  if (!report || !Array.isArray(report.providers)) return null;
  return {
    providers: report.providers.map((p) => ({
      provider: str(p.provider), ok: p.ok === true, failed: p.ok !== true,
      items: (Array.isArray(p.items) ? p.items : []).map((i) => ({ id: str(i.id), confirmed: i.confirmed === true,
        ...(typeof i.complete === "boolean" ? { complete: i.complete } : {}), ...(INCOMPLETE.has(i.incomplete) ? { incomplete: i.incomplete } : {}),
        ...(Array.isArray(i.servers) ? { servers: i.servers.map(server) } : {}) })),
      ...(Array.isArray(p.timing) ? { timing: safeTiming(p.timing) } : {}), ...(ms(p.limitMs) !== null ? { limitMs: ms(p.limitMs) } : {}),
      ...(p.readiness ? { readiness: {
        server: str(p.readiness.server), projectLayer: str(p.readiness.projectLayer), disabled: !!p.readiness.disabledReason,
        inProjectLayer: p.readiness.inProjectLayer === true, inConfig: p.readiness.inConfig === true, threadStarted: p.readiness.threadStarted === true,
        status: p.readiness.status ? server(p.readiness.status) : null, error: p.readiness.error ? errorKind(p.readiness.error) : null } } : {})
    }))
  };
}

// "thread/start: <the CLI's words>" → "thread/start": only the step that failed.
export const errorKind = (e) => String(e).split(":")[0].slice(0, 40);

// The MCP server names one provider reported, from the structured fields (not from any text).
export const mcpNames = (safe, provider) => (safe?.providers?.find((p) => p.provider === provider)?.items.find((i) => i.id === "mcp")?.servers ?? []).map((x) => x.name).filter(Boolean);
