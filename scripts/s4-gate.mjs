// S4 of the real series: may the variant start? Decided before any model turn from the application's own probe (the
// CLI's executable, environment and project as the application runs them) and the test server's log — never from the
// text the interface shows.
//
// Codex (S4X): probe(linkId, { mcpReady }) readiness — the project layer loaded (no disabledReason), the server defined
// in it and in the effective configuration, the tool discovered and the connection "connected" inside the probe's ephemeral thread,
// and a fresh initialize from Codex in the server's log. Claude (S4C): mcp_status "connected" and a fresh initialize.
// authStatus ("unsupported" for servers without sign-in) is never a connection state.
import { errorKind } from "./safe-environment.mjs";

export const S4_SERVER = "release-form";
export const S4_TOOL = "release_ticket";

// initialize lines of the server's log (JSON lines) from `client` at or after `since` (ms).
export function freshInitialize(logText, since, client) {
  return String(logText ?? "").split("\n").flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } })
    .filter((e) => e.type === "initialize" && e.client?.name === client && Date.parse(e.ts) >= since);
}

// { ok, reasons[] }: every reason blocks the start.
export function s4Gate({ provider, report, logText, since, client }) {
  const reasons = [];
  const p = report?.providers?.find((x) => x.provider === provider);
  if (!p) reasons.push(`${provider}: no probe result`);
  else if (!p.ok) reasons.push(`${provider}: the probe failed`);
  if (provider === "codex") {
    const r = p?.readiness;
    if (!r || r.server !== S4_SERVER) reasons.push(`codex: no readiness of ${S4_SERVER}`);
    else {
      if (r.error) reasons.push(`codex: ${errorKind(r.error)} failed`); // the step only, never the CLI's words
      if (r.projectLayer !== "enabled" || r.disabledReason) reasons.push(`codex: the project layer is ${r.projectLayer}${r.disabledReason ? " (disabled by Codex)" : ""}`);
      if (!r.inProjectLayer) reasons.push(`codex: ${S4_SERVER} is not defined in the project layer`);
      if (!r.inConfig) reasons.push(`codex: ${S4_SERVER} is not in the effective configuration`);
      if (!r.threadStarted) reasons.push("codex: no thread was started, the connection is not checked");
      if (!r.status?.tools?.includes(S4_TOOL)) reasons.push(`codex: ${S4_TOOL} is not discovered`);
      if (r.status?.connection !== "connected") reasons.push(`codex: the connection is ${r.status?.connection ?? "not checked"}`);
    }
  } else {
    const own = p?.items?.find((i) => i.id === "mcp")?.servers?.find((x) => x.name === S4_SERVER);
    if (!own) reasons.push(`claude: ${S4_SERVER} is not among the servers the CLI reports`);
    else if (own.connection !== "connected") reasons.push(`claude: the connection is ${own.connection ?? "not checked"}`);
  }
  if (!freshInitialize(logText, since, client).length) reasons.push(`no initialize from ${client} in the server's log during this probe`);
  return { ok: reasons.length === 0, reasons };
}
