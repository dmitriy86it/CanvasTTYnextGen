#!/bin/sh
# Probe matrix for sb.sh fixtures. Usage: probe.sh FIX RUN_ID MODE
# Prints "deny.X: ALLOWED|denied" / "allow.X: ...", env names and HOME. validate.sh judges the result.
FIX=$1 RUN=$2 M=$3
[ -n "$FIX" ] && [ -n "$RUN" ] && [ -n "$M" ] || { echo "FAIL: empty argument"; exit 2; }
D=$(cd "$(dirname "$0")" && pwd -P)
RH=$FIX/realhome UD="$FIX/realhome/Library/Application Support/CanvasTTY" SR=$FIX/realhome/dev/proj OUT=$FIX/outside
R="$UD/runs/$RUN" O="$UD/runs/other"
cd "$R/repo" || { echo "FAIL: no repo"; exit 2; }
t(){ n=$1; shift; if "$@" >/dev/null 2>&1; then echo "$n: ALLOWED"; else echo "$n: denied"; fi; }
w(){ echo x > "$1"; }
ap(){ : >> "$1"; }
for f in .ssh/id_ed25519 .aws/credentials .codex/auth.json .claude/.credentials.json .claude.json .config/gh/hosts.yml \
  .npmrc .gitconfig .config/git/config Library/Keychains/login.keychain-db .netrc .docker/config.json .kube/config .gnupg/pubring.kbx; do
  t "deny.read-~/$f" cat "$RH/$f"; done
t deny.ls-~/.ssh ls "$RH/.ssh"
t deny.read-userdata-state cat "$UD/state.json"
t deny.ls-userdata ls "$UD"
t deny.read-other-run cat "$O/repo/f.txt"
t deny.read-srcrepo-src cat "$SR/src/app.js"
t deny.read-srcrepo-gitconfig cat "$SR/.git/config"
t deny.write-userdata-state ap "$UD/state.json"
t deny.write-userdata-root w "$UD/w-$M"
t deny.write-other-run w "$O/repo/w-$M"
t deny.write-srcrepo w "$SR/w-$M"
t deny.write-node_modules w "$R/repo/node_modules/dep-a/w-$M"
t deny.write-realhome w "$RH/w-$M"
t deny.write-outside w "$OUT/w-$M"
t deny.write-user-tmpdir w "$(getconf DARWIN_USER_TEMP_DIR)CTTYEXP-w-$M"
t deny.net-localhost node "$D/net.cjs" local
t deny.net-external-ip node "$D/net.cjs" ext
t deny.dns-lookup node "$D/net.cjs" dns
t deny.openpty /usr/bin/script -q /dev/null /usr/bin/true
t allow.read-work cat "$R/repo/in.txt"
t allow.write-work w "$R/repo/w-$M"
t allow.write-tmp w "$R/tmp/w-$M"
t allow.write-fakehome w "$R/home/w-$M"
t allow.read-node_modules-symlink cat "$R/repo/node_modules/dep-a/index.js"
t allow.node-require-dep node -e 'if(require("dep-a")!=="b-a")process.exit(1)'
t allow.git-log-shared-clone git log -1 --format=%H
echo "env-names: $(env | cut -d= -f1 | sort | tr '\n' ' ')"
echo "home: $HOME"
