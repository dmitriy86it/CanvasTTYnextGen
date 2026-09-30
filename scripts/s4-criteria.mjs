// S4 of the real series: an MCP server's form (elicitation) through the app. The tool release_ticket
// (tests/fixtures/orchestration/mcp-elicit-server.mjs) makes a nonce per call, names it in the form's message and in its
// result; a call counts only when the app showed that very form, the server got the answer given in it, and the result
// line reached release/receipts.txt word for word. Pure checks; each criterion is its own row, an empty list fails
// (except tool prompts: a CLI may not ask).

export const VARIANTS = {
  S4C: { provider: "claude", role: "executor", components: { api: "accept", web: "decline" } },
  S4X: { provider: "codex", role: "lead", components: { "plan-a": "accept", "plan-b": "decline" } }
};
const TOOL_NAMES = new Set(["release_ticket", "mcp__release-form__release_ticket"]);
// the server logs the MCP client's clientInfo; its name says which CLI started it
const clientProvider = (client) => { const n = String(client?.name ?? client ?? ""); return /claude/i.test(n) ? "claude" : /codex/i.test(n) ? "codex" : null; };
const formNonce = (message) => /\(call ([0-9a-f]+)\)\s*$/.exec(String(message ?? ""))?.[1] ?? null;
const canon = (v) => JSON.stringify(v, (_, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));

export function s4Verdict(f) {
  const rows = [];
  const row = (ok, what, got) => rows.push({ ok: Boolean(ok), what, got });
  const v = VARIANTS[f.variant];
  if (!v) return [{ ok: false, what: `unknown variant ${f.variant}`, got: f.variant }];
  const { provider, role } = v;
  const server = f.server ?? [], forms = f.forms ?? [];
  const mine = (e) => clientProvider(e.client) === provider;
  const inits = server.filter((e) => e.type === "initialize" && mine(e));
  const lines = server.filter((e) => e.type === "call" || e.type === "call_failed");
  // one call per nonce: a repeated line of the same nonce is the same call, not another one
  const byNonce = new Map();
  const conflicting = [];
  for (const c of lines.filter((e) => e.type === "call" && mine(e))) {
    const seen = byNonce.get(c.nonce);
    if (!seen) byNonce.set(c.nonce, c);
    else if (canon({ ...seen, ts: 0, pid: 0 }) !== canon({ ...c, ts: 0, pid: 0 })) conflicting.push(c.nonce);
  }
  const calls = [...byNonce.values()];
  row(inits.length > 0 && calls.length > 0, `the server was started by ${provider} and called`, { initialize: inits.length, calls: calls.length });
  const foreign = [...lines.filter((e) => !mine(e)).map((e) => `call ${e.nonce} by ${clientProvider(e.client) ?? JSON.stringify(e.client)}`),
    ...forms.filter((x) => x.provider !== provider || x.role !== role).map((x) => `form ${x.requestId} of ${x.provider}/${x.role}`)];
  row(foreign.length === 0 && conflicting.length === 0, "foreign: no call or form of another provider or role, no conflicting lines of one nonce", { foreign, conflicting });

  const texts = [];
  for (const [component, action] of Object.entries(v.components)) {
    const own = calls.filter((c) => c.component === component);
    const c = own.length === 1 ? own[0] : null;
    row(c && c.action === action, `${component}: exactly one call, answered ${action}`, own.map((x) => ({ nonce: x.nonce, action: x.action })));
    const form = c ? forms.find((x) => formNonce(x.message) === c.nonce) ?? null : null;
    row(form && form.requestId && form.provider === provider && form.role === role && form.server === "release-form" && form.answer === action,
      `${component}: the call is the form the app showed (nonce in its message, ${provider}/${role}, release-form)`,
      form ? { requestId: form.requestId, provider: form.provider, role: form.role, server: form.server, answer: form.answer } : c ? `no form for nonce ${c.nonce}` : null);
    if (action === "accept") {
      const attempts = form?.invalidAttempts ?? [];
      const forNonce = c ? lines.filter((e) => e.nonce === c.nonce) : [];
      row(c && attempts.length >= 2 && !attempts.some((a) => a.outcome === "SENT") && forNonce.every((e) => e.type === "call" && e.valid === true),
        `${component}: invalid answers were stopped before the server (≥2 tried, none sent)`,
        { attempts: attempts.map((a) => a.outcome), serverLines: forNonce.map((e) => ({ type: e.type, valid: e.valid })) });
      row(c && form && c.content && canon(c.content) === canon(form.content), `${component}: the server got the answer given in the form`, { server: c?.content ?? null, form: form?.content ?? null });
    } else {
      row(c && c.action === "decline", `${component}: the server got the decline as action decline`, c?.action ?? null);
    }
    if (c) texts.push(c.text);
  }

  const done = (f.toolResults ?? []).filter((r) => r.provider === provider && TOOL_NAMES.has(r.tool) && r.ok === true);
  row(calls.length > 0 && done.length >= calls.length, `release_ticket calls of ${provider} completed`, { completed: done.length, calls: calls.length });
  const receipts = (f.receipts ?? []).map((l) => String(l).trim()).filter(Boolean);
  const want = texts.filter((t) => typeof t === "string");
  const left = [...receipts];
  const missing = want.filter((t) => { const i = left.indexOf(t); if (i < 0) return true; left.splice(i, 1); return false; });
  row(receipts.length > 0 && want.length === Object.keys(v.components).length && !missing.length && !left.length,
    "release/receipts.txt holds exactly the servers' result lines", { missing, extra: left });
  const prompts = f.toolPrompts ?? [];
  const bad = prompts.filter((p) => p.provider !== provider || p.server !== "release-form" || !TOOL_NAMES.has(p.tool));
  // the CLI may not ask for the MCP tool at all; what it asked and was confirmed must be only this tool
  row(!bad.length, "every confirmed tool prompt was release-form release_ticket", prompts.length ? bad.map((p) => `${p.provider} ${p.server} ${p.tool}`) : "no tool prompt");
  row(f.acceptUnchanged === true, "the acceptance test is unchanged", f.acceptUnchanged);
  row(f.checksPassed === true, "the checks passed", f.checksPassed);
  return rows;
}
