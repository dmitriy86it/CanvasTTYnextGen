#!/bin/bash
# Two .app with one test profile: which one holds the lock, in both orders; direct exec and `open -n`.
S="$1"; AA="$S/diag-out-Alpha/mac-arm64/S0 Diag Alpha.app"; AB="$S/diag-out-Beta/mac-arm64/S0 Diag Beta.app"
exe() { echo "$1/Contents/MacOS/$(basename "$1" .app)"; }
run_pair() { # label mode firstApp secondApp
  local L=$1 M=$2 F=$3 SEC=$4 P="$S/p-si-$1"; rm -rf "$P" "$S/runs/si2-$L-"*.json
  if [ "$M" = exec ]; then S0_OUT="$S/runs/si2-$L-first.json" S0_HOLD_MS=9000 "$(exe "$F")" --user-data-dir="$P" >/dev/null 2>&1 &
  else open -n -a "$F" --env S0_OUT="$S/runs/si2-$L-first.json" --env S0_HOLD_MS=9000 --args --user-data-dir="$P"; fi
  for i in $(seq 1 100); do [ -f "$S/runs/si2-$L-first.json" ] && break; sleep 0.1; done
  local lockfile=$(ls -la "$P" | grep -c Singleton)
  local t0=$(date +%s.%N)
  if [ "$M" = exec ]; then S0_OUT="$S/runs/si2-$L-second.json" "$(exe "$SEC")" --user-data-dir="$P" >/dev/null 2>&1
  else open -n -W -a "$SEC" --env S0_OUT="$S/runs/si2-$L-second.json" --args --user-data-dir="$P"; fi
  local t1=$(date +%s.%N)
  local firstAlive=$(pgrep -f "$(basename "$F" .app).*p-si-$L" | head -1)
  node -e "const f=require('$S/runs/si2-$L-first.json'),s=require('$S/runs/si2-$L-second.json');console.log(JSON.stringify({case:'$L',singletonFiles:$lockfile,first:{lock:f.lock,ready:f.ready===true},second:{lock:s.lock,ready:s.ready===true},secondSeconds:+($t1-$t0).toFixed(2),firstStillRunning:${firstAlive:+true}${firstAlive:-false}}))"
  wait 2>/dev/null; sleep 9
}
run_pair exec-A-B exec "$AA" "$AB"
run_pair exec-B-A exec "$AB" "$AA"
run_pair open-A-B open "$AA" "$AB"
run_pair open-B-A open "$AB" "$AA"
