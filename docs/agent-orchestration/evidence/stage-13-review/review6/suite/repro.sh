#!/bin/sh
# Deterministic slowdown for the review-6 repros: a copy of a test file whose checks get a sandbox that is the real
# sandbox.ts with runSelftest delayed by DELAY ms (the existing deps.checks.sandbox injection point). This models a
# check setup that is slow on a loaded machine (the selftest runs after the deadline timer is armed, before
# check.started), without busy loops that macOS schedules away.
# usage: repro.sh <test file> <DELAY ms> <name pattern> <out.tap>
set -e
SRC=$1; DELAY=$2; PAT=$3; OUT=$4
ROOT=$(cd "$(dirname "$0")/../../../../../.." && pwd)
COPY="$ROOT/tests/.review6-repro-$$.mjs"
python3 - "$SRC" "$COPY" <<'PY'
import sys
s = open(sys.argv[1]).read()
anchor = 'import { createTestAgents'
inj = ('import * as realSandbox from "../src/main/services/orchestration/sandbox.ts";\n'
       'const SLOW_SANDBOX = { ...realSandbox, runSelftest: async (a) => {\n'
       '  await new Promise((r) => setTimeout(r, Number(process.env.REPRO_SELFTEST_DELAY_MS)));\n'
       '  return realSandbox.runSelftest(a);\n} };\n')
assert s.count(anchor) == 1 and s.count('deps: p.deps, launch: LAUNCH }') == 1
s = s.replace(anchor, inj + anchor).replace('deps: p.deps, launch: LAUNCH }', 'deps: p.deps, launch: LAUNCH, sandbox: SLOW_SANDBOX }')
open(sys.argv[2], 'w').write(s)
PY
trap 'rm -f "$COPY"' EXIT
cd "$ROOT"
{ echo "# repro: $(basename "$SRC") selftest delay ${DELAY} ms; $(uptime)"; REPRO_SELFTEST_DELAY_MS=$DELAY node --test --test-reporter=tap --test-name-pattern="$PAT" "$COPY" 2>&1 || true; echo "# end: $(uptime)"; } > "$OUT"
