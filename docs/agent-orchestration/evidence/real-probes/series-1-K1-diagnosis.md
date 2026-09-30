# K1 diagnosis (real series 2026-09-22 14:08, no re-run)

- Failed condition: `init.tools unexpected` (expected `[]`, derived from `--tools ""`).
- All other K1 conditions passed: outcome=completed, delivery=ok, report=valid (schema), tokenMatch, answerOk, sessionOk (session_id = U1), stopCause=null, group cleared.
- Evidence (Claude's own transcript of this test session, ~/.claude/projects/<repo-path>/<U1>.jsonl, read by field names only):
  - attachment `prompt_snapshot.tools` (tools sent to the model): `["StructuredOutput"]`
  - assistant message: one `tool_use` named `StructuredOutput`
  - attachment `budget_usd`: total 0.25, used 0 (client estimate)
- Conclusion: with `--json-schema`, Claude Code 2.1.278 adds a synthetic `StructuredOutput` tool even with `--tools ""`. The plan's expectation (`expectedClaudeInit`) did not account for it. The exact `system/init.tools` value was not persisted by probe-series (only the failed condition name) — diagnostic gap.
- Not a sign of extra capabilities: no built-in tool (Bash/Read/Edit/...) and no MCP tool was sent to the model.
