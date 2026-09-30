// S4 criteria of the real series (scripts/s4-criteria.mjs): an MCP form shown by the app, answered, received by the
// server and its result line in release/receipts.txt, for the Claude executor (S4C) and the Codex lead (S4X).
import assert from "node:assert/strict";
import { test } from "node:test";
import { s4Verdict, VARIANTS } from "../scripts/s4-criteria.mjs";

const CLIENT = { claude: { name: "claude-code", version: "2" }, codex: { name: "codex-mcp-client", version: "0" } };
const TOOL = { claude: "mcp__release-form__release_ticket", codex: "release_ticket" };
const ANSWER = { ticket: "REL-42", env: "qa", reviewers: 2 };

function facts(variant) {
  const { provider, role, components } = VARIANTS[variant];
  const [acc, dec] = Object.keys(components);
  const call = (component, nonce, action, n) => ({
    type: "call", pid: 7, client: CLIENT[provider], component, nonce, elicitId: `srv-${n}`, action, valid: true, errors: {},
    content: action === "accept" ? ANSWER : null,
    text: action === "accept" ? `RELEASE-FORM nonce=${nonce} component=${component} action=accept ticket=REL-42 env=qa` : `RELEASE-FORM nonce=${nonce} component=${component} action=decline`
  });
  const form = (component, nonce, answer, n) => ({
    requestId: `r${n}`, provider, role, server: "release-form", message: `Release ticket for ${component} (call ${nonce})`, answer,
    content: answer === "accept" ? ANSWER : null,
    invalidAttempts: answer === "accept" ? [{ what: "ticket R", outcome: "blocked in the panel" }, { what: "env prod", outcome: "refused by main (invalid_form)" }] : []
  });
  const server = [{ type: "initialize", pid: 7, client: CLIENT[provider] }, call(acc, "aaaa11", "accept", 1), call(dec, "bbbb22", "decline", 2)];
  return {
    variant, provider, role, server,
    forms: [form(acc, "aaaa11", "accept", 1), form(dec, "bbbb22", "decline", 2)],
    toolPrompts: [{ requestId: "t1", provider, tool: TOOL[provider], server: "release-form" }],
    toolResults: [{ provider, tool: TOOL[provider], ok: true }, { provider, tool: TOOL[provider], ok: true }],
    receipts: [`  ${server[1].text}`, server[2].text, ""], acceptUnchanged: true, checksPassed: true
  };
}
const failed = (f) => s4Verdict(f).filter((r) => !r.ok).map((r) => r.what);

test("full success of each variant", () => {
  for (const variant of ["S4C", "S4X"]) {
    const rows = s4Verdict(facts(variant));
    assert.equal(rows.length, 14, variant);
    assert.deepEqual(rows.filter((r) => !r.ok), [], variant);
  }
});

test("empty server log, forms or other lists fail", () => {
  const f = facts("S4C");
  assert.ok(failed({ ...f, server: [] }).length >= 8);
  assert.ok(failed({ ...f, forms: [] }).some((w) => /form the app showed/.test(w)));
  for (const k of ["toolResults", "receipts"]) assert.ok(failed({ ...f, [k]: [] }).length >= 1, k);
  // a CLI that asked no permission for the MCP tool is fine
  const none = s4Verdict({ ...f, toolPrompts: [] }).find((r) => /tool prompt/.test(r.what));
  assert.deepEqual([none.ok, none.got], [true, "no tool prompt"]);
  assert.ok(failed({ variant: "S4X" }).length >= 10);
  // loaded, never used
  assert.ok(failed({ ...f, server: [f.server[0]] }).some((w) => /started by claude and called/.test(w)));
});

test("a repeated nonce is one call; a second call of a component or a conflicting line fails", () => {
  const f = facts("S4C");
  assert.deepEqual(failed({ ...f, server: [...f.server, { ...f.server[1], pid: 8 }] }), []);
  assert.ok(failed({ ...f, server: [...f.server, { ...f.server[1], action: "decline" }] }).some((w) => /^foreign/.test(w)));
  assert.ok(failed({ ...f, server: [...f.server, { ...f.server[1], nonce: "cccc33" }] }).some((w) => /api: exactly one call/.test(w)));
});

test("a form or a call of another provider or role is foreign", () => {
  const f = facts("S4C");
  assert.ok(failed({ ...f, forms: [...f.forms, { ...f.forms[0], requestId: "x", provider: "codex" }] }).some((w) => /^foreign/.test(w)));
  assert.ok(failed({ ...f, forms: [{ ...f.forms[0], role: "lead" }, f.forms[1]] }).some((w) => /api: the call is the form/.test(w)));
  const x = facts("S4X");
  const alien = { ...facts("S4C").server[1] };
  assert.ok(failed({ ...x, server: [...x.server, alien] }).some((w) => /^foreign/.test(w)));
});

test("a call without the form the app showed fails", () => {
  const f = facts("S4C");
  assert.ok(failed({ ...f, forms: [{ ...f.forms[0], message: "Release ticket for api (call 999999)" }, f.forms[1]] }).some((w) => /api: the call is the form/.test(w)));
  assert.ok(failed({ ...f, forms: [{ ...f.forms[0], requestId: null }, f.forms[1]] }).some((w) => /api: the call is the form/.test(w)));
  assert.ok(failed({ ...f, forms: [{ ...f.forms[0], server: "other" }, f.forms[1]] }).some((w) => /api: the call is the form/.test(w)));
});

test("invalid answers: fewer than two, one SENT or an invalid line on the server fail", () => {
  const f = facts("S4C");
  const withAttempts = (a) => ({ ...f, forms: [{ ...f.forms[0], invalidAttempts: a }, f.forms[1]] });
  assert.ok(failed(withAttempts([f.forms[0].invalidAttempts[0]])).some((w) => /invalid answers/.test(w)));
  assert.ok(failed(withAttempts([...f.forms[0].invalidAttempts, { what: "x", outcome: "SENT" }])).some((w) => /invalid answers/.test(w)));
  const failedLine = { type: "call_failed", pid: 7, client: CLIENT.claude, component: "api", nonce: "aaaa11" };
  assert.ok(failed({ ...f, server: [...f.server, failedLine] }).some((w) => /invalid answers/.test(w)));
  assert.ok(failed({ ...f, server: [f.server[0], { ...f.server[1], valid: false }, f.server[2]] }).some((w) => /invalid answers/.test(w)));
  assert.ok(failed({ ...f, forms: [{ ...f.forms[0], content: { ...ANSWER, reviewers: 3 } }, f.forms[1]] }).some((w) => /got the answer given/.test(w)));
});

test("receipts: a changed line with the right nonce, a missing or an extra line fail", () => {
  const f = facts("S4X");
  const changed = f.server[1].text.replace("REL-42", "REL-43");
  assert.ok(failed({ ...f, receipts: [changed, f.receipts[1]] }).some((w) => /receipts/.test(w)));
  assert.ok(failed({ ...f, receipts: [f.receipts[1]] }).some((w) => /receipts/.test(w)));
  assert.ok(failed({ ...f, receipts: [...f.receipts, f.receipts[1]] }).some((w) => /receipts/.test(w)));
  assert.ok(failed({ ...f, receipts: [...f.receipts, "RELEASE-FORM nonce=ffff component=x action=accept"] }).some((w) => /receipts/.test(w)));
});

test("tool prompts of another tool, server or provider and incomplete calls fail", () => {
  const f = facts("S4C");
  for (const p of [{ tool: "Bash", server: null }, { server: "other" }, { provider: "codex" }]) {
    assert.ok(failed({ ...f, toolPrompts: [...f.toolPrompts, { ...f.toolPrompts[0], ...p }] }).some((w) => /tool prompt/.test(w)), JSON.stringify(p));
  }
  assert.ok(failed({ ...f, toolResults: [f.toolResults[0], { ...f.toolResults[1], ok: false }] }).some((w) => /completed/.test(w)));
  assert.deepEqual(failed({ ...f, acceptUnchanged: false, checksPassed: false }).length, 2);
});
