// S7, the automatic part: what «Проверить окружение» must show before the lists can be compared with the terminal.
// Input: the series' safe environment (safe-environment.mjs fields only). Each of Claude and Codex answered exactly once
// and without an error, and its MCP list is the CLI's whole list — a confirmed empty list counts, a missing, partial or
// failed one does not. The manual comparison with the terminal is never counted here.
const PROVIDERS = ["claude", "codex"];

// "whole" (servers listed), "empty" (confirmed: none), "partial" (some pages), "missing" (no list), "failed" (not received)
export function mcpListState(item) {
  if (!item) return "missing";
  if (item.complete === true && item.confirmed === true && Array.isArray(item.servers)) return item.servers.length ? "whole" : "empty";
  if (item.complete === false && item.confirmed === true) return "partial";
  if (item.complete === false || item.confirmed === false) return "failed";
  return "missing"; // no completeness said: never taken for a whole list
}

export function s7Verdict(env) {
  const checks = [];
  const add = (ok, what, got) => checks.push({ ok, what, ...(ok ? {} : { got }) });
  const providers = Array.isArray(env?.providers) ? env.providers : [];
  add(env?.state === "done", "the environment check finished", env?.state ?? null);
  const names = providers.map((p) => p?.provider);
  add(names.length === 2 && PROVIDERS.every((n) => names.filter((x) => x === n).length === 1), "exactly one answer from Claude and one from Codex", names);
  const mcp = {};
  for (const n of PROVIDERS) {
    const own = providers.filter((p) => p?.provider === n);
    const p = own.length === 1 ? own[0] : null;
    add(!!p && p.ok === true && p.failed !== true, `${n} answered without an error`, p ? { ok: p.ok } : { answers: own.length });
    const items = (Array.isArray(p?.items) ? p.items : []).filter((i) => i?.id === "mcp");
    const item = items.length === 1 ? items[0] : undefined; // two lists in one answer: neither is taken for the whole one
    mcp[n] = p ? mcpListState(item) : "missing";
    add(mcp[n] === "whole" || mcp[n] === "empty", `${n}: the MCP list is whole (a confirmed empty list counts)`,
      { state: mcp[n], ...(item?.incomplete ? { incomplete: item.incomplete } : {}) });
  }
  return { ok: checks.every((c) => c.ok), checks, mcp, manual: "not counted: the person's comparison with the terminal (S7-MANUAL.md)" };
}
