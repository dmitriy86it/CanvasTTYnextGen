#!/bin/bash
# Run a command under runner.sb (+ opt-in fragments) with a clean environment.
# Usage: USERDATA=.. RUN_ID=.. REALHOME=.. SRCREPO=.. [TOOLCHAIN=dir] [PORT=n] [EXTRAS="denyhome localhost unix pty"] sb.sh cmd...
# Work copy: $USERDATA/runs/$RUN_ID/{repo,tmp,home}. TOOLCHAIN/bin goes first in PATH.
set -eu
D=$(cd "$(dirname "$0")" && pwd -P)
real(){ [ -d "$1" ] && [ "$(cd "$1" && pwd -P)" = "$1" ] || { echo "sb.sh: $2 must be an existing resolved dir: $1" >&2; exit 2; }; }
case $RUN_ID in ''|*/*|.|..) echo "sb.sh: bad RUN_ID" >&2; exit 2;; esac
R=$USERDATA/runs/$RUN_ID
real "$USERDATA" USERDATA; real "$REALHOME" REALHOME; real "$SRCREPO" SRCREPO
real "$R/repo" repo; real "$R/tmp" tmp; real "$R/home" home
[ -z "${TOOLCHAIN:-}" ] || real "$TOOLCHAIN" TOOLCHAIN
P=$(cat "$D/runner.sb"; for x in ${EXTRAS:-}; do cat "$D/runner-$x.sb"; done)
cd "$R/repo"
exec /usr/bin/sandbox-exec -p "$P" -D REALHOME="$REALHOME" -D USERDATA="$USERDATA" -D SRCREPO="$SRCREPO" \
  -D WORK="$R/repo" -D TMP="$R/tmp" -D FAKEHOME="$R/home" -D TOOLCHAIN="${TOOLCHAIN:-/var/empty/none}" -D PORT="${PORT:-0}" \
  /usr/bin/env -i HOME="$R/home" PATH="${TOOLCHAIN:+$TOOLCHAIN/bin:}/usr/bin:/bin" TMPDIR="$R/tmp" LANG=C "$@"
