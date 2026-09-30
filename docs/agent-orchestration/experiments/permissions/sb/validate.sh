#!/bin/bash
# Validate sb.sh + runner*.sb on a throwaway fixture. Usage: validate.sh BASE_DIR  (KEEP=1 keeps the fixture)
# rc=0 only if every positive control passes outside the sandbox and every result inside matches expectations.
set -u
D=$(cd "$(dirname "$0")" && pwd -P)
BASE=$(cd "${1:?base dir}" && pwd -P)
FIX=$(mktemp -d "$BASE/CTTYEXP-fx.XXXX") && FIX=$(cd "$FIX" && pwd -P) || exit 2
RH=$FIX/realhome UD="$FIX/realhome/Library/Application Support/CanvasTTY" SR=$FIX/realhome/dev/proj OUT=$FIX/outside RUN=r1
R="$UD/runs/$RUN"
NODEDIR=$(cd "$(dirname "$(readlink -f "$(command -v node)")")/.." && pwd -P)
fail=0 PIDS=
bad(){ echo "FAIL: $*"; fail=1; }
cleanup(){ for p in $PIDS; do kill "$p" 2>/dev/null; done; rm -f "$(getconf DARWIN_USER_TEMP_DIR)"CTTYEXP-w-*; [ -n "${KEEP:-}" ] || rm -rf "$FIX"; }
trap cleanup EXIT

# --- fixture (all FAKE) ---
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
for f in .ssh/id_ed25519 .aws/credentials .codex/auth.json .claude/.credentials.json .claude.json .config/gh/hosts.yml \
  .npmrc .gitconfig .config/git/config Library/Keychains/login.keychain-db .netrc .docker/config.json .kube/config .gnupg/pubring.kbx notes.txt; do
  mkdir -p "$(dirname "$RH/$f")"; echo "FAKE-$f" > "$RH/$f"; done
mkdir -p "$UD/runs/other/repo" "$R/tmp" "$R/home" "$OUT" "$SR/src" "$SR/node_modules/dep-a" "$SR/node_modules/dep-b" "$RH/.toolchain/bin" "$RH/.toolchain/lib"
echo '{"FAKE":"state"}' > "$UD/state.json"; echo other > "$UD/runs/other/repo/f.txt"; echo 'FAKE-src' > "$SR/src/app.js"
echo 'module.exports=require("dep-b")+"-a"' > "$SR/node_modules/dep-a/index.js"; echo 'module.exports="b"' > "$SR/node_modules/dep-b/index.js"
printf 'node_modules\n' > "$SR/.gitignore"
git -C "$SR" init -q -b main && git -C "$SR" add -A && git -C "$SR" commit -qm base
git clone -q --shared --no-checkout "$SR" "$R/repo" && git -C "$R/repo" checkout -q --detach main
ln -s "$SR/node_modules" "$R/repo/node_modules"; echo in > "$R/repo/in.txt"
cp -c "$NODEDIR/bin/node" "$RH/.toolchain/bin/node"; echo 'console.log("toolchain-lib-ok")' > "$RH/.toolchain/lib/t.js"
unset GIT_CONFIG_GLOBAL GIT_CONFIG_NOSYSTEM

SB(){ USERDATA="$UD" RUN_ID=$RUN REALHOME="$RH" SRCREPO="$SR" TOOLCHAIN="${TC-$NODEDIR}" "$D/sb.sh" "$@"; }
CTL(){ (cd "$R/repo" && /usr/bin/env -i HOME="$R/home" PATH="$NODEDIR/bin:/usr/bin:/bin" TMPDIR="$R/tmp" LANG=C "$@"); }
clean_writes(){ rm -f "$UD/w-"* "$UD/runs/other/repo/w-"* "$SR/w-"* "$SR/node_modules/dep-a/w-"* "$RH/w-"* "$OUT/w-"* "$R/repo/w-"* "$R/tmp/w-"* "$R/home/w-"* "$(getconf DARWIN_USER_TEMP_DIR)"CTTYEXP-w-*; }
# judge LABEL FILE: probe output inside must match deny./allow. prefixes (all 39 of them); env must be clean.
# Allowed env: HOME PATH TMPDIR LANG (sb.sh), PWD SHLVL _ OLDPWD (sh), __CF_USER_TEXT_ENCODING (node/CoreFoundation)
judge(){ local n=0
  while IFS= read -r l; do case $l in
    deny.*": denied"|allow.*": ALLOWED") n=$((n+1));;
    deny.*|allow.*) bad "$1 $l";;
    env-names:*) for v in ${l#env-names:}; do case $v in HOME|PATH|TMPDIR|LANG|PWD|SHLVL|_|OLDPWD|__CF_USER_TEXT_ENCODING) ;; *) bad "$1 unexpected env $v";; esac; done;;
    "home: $R/home") ;;
    home:*) bad "$1 $l";;
  esac; done < "$2"
  grep -q '^env-names:' "$2" || bad "$1 no env line"; [ "$n" -ge 39 ] || bad "$1 only $n checks matched"; echo "$1: $n checks as expected"; }
# chk EXPECT(allow|deny|limit) NAME cmd...: control outside must succeed; inside via SB must match
chk(){ local e=$1 n=$2 r; shift 2
  CTL "$@" </dev/null >/dev/null 2>&1 || { bad "control $n did not pass outside"; return; }
  if SB "$@" </dev/null >/dev/null 2>&1; then r=ALLOWED; else r=denied; fi
  case $e:$r in allow:ALLOWED|deny:denied) echo "$n: $r (control ok)";; limit:ALLOWED) echo "$n: ALLOWED (control ok) -- NOT ENSURED";; *) bad "$n: $r, expected $e";; esac; }

echo "== guard: empty argument"; sh "$D/probe.sh" "" "" "" ; [ $? = 2 ] && echo "probe rc=2 on empty argument" || bad "probe did not fail on empty argument"
echo "== guard: unresolved path"; USERDATA=/tmp RUN_ID=x REALHOME="$RH" SRCREPO="$SR" "$D/sb.sh" true 2>&1; [ $? = 2 ] || bad "sb.sh accepted /tmp"

echo "== positive control (outside sandbox, same probe, same env)"
CTL FAKE_PARENT_TOKEN=x ELECTRON_RUN_AS_NODE=1 /bin/sh "$D/probe.sh" "$FIX" $RUN out </dev/null > "$FIX/ctl.txt" 2>&1
cat "$FIX/ctl.txt"; grep -q ': denied' "$FIX/ctl.txt" && bad "control has denied lines"
grep -q '^deny.*: ALLOWED' "$FIX/ctl.txt" || bad "control empty"
grep -q 'FAKE_PARENT_TOKEN.*' "$FIX/ctl.txt" && grep -q ELECTRON_RUN_AS_NODE "$FIX/ctl.txt" || bad "control does not see parent vars"
clean_writes

export FAKE_PARENT_TOKEN=x ELECTRON_RUN_AS_NODE=1
for ex in "" denyhome; do
  echo "== sandbox EXTRAS='$ex': direct, grandchild, detached"
  EXTRAS=$ex SB /bin/sh "$D/probe.sh" "$FIX" $RUN in </dev/null > "$FIX/in.txt" 2>&1; cat "$FIX/in.txt"; judge "direct[$ex]" "$FIX/in.txt"
  EXTRAS=$ex SB /bin/sh -c 'sh -c "sh \"$0\" \"$1\" \"$2\" in-gc"' "$D/probe.sh" "$FIX" $RUN </dev/null > "$FIX/gc.txt" 2>&1; judge "grandchild[$ex]" "$FIX/gc.txt"
  EXTRAS=$ex SB node "$D/detach.cjs" "$D/probe.sh" "$FIX" $RUN "$R/tmp/det.txt" </dev/null
  for i in $(seq 1 30); do grep -q '^done' "$R/tmp/det.txt" 2>/dev/null && break; perl -e 'select undef,undef,undef,0.5'; done
  judge "detached[$ex]" "$R/tmp/det.txt"; rm -f "$R/tmp/det.txt"
  clean_writes
done

echo "== denyhome: toolchain inside fake HOME"
EXTRAS=denyhome chk deny read-~/notes.txt cat "$RH/notes.txt"
EXTRAS= chk allow read-~/notes.txt-without-denyhome cat "$RH/notes.txt"
TC="$RH/.toolchain" EXTRAS=denyhome chk allow node+lib-in-home-with-TOOLCHAIN "$RH/.toolchain/bin/node" "$RH/.toolchain/lib/t.js"
TC= EXTRAS=denyhome chk deny node+lib-in-home-without-TOOLCHAIN "$RH/.toolchain/bin/node" "$RH/.toolchain/lib/t.js"
TC= EXTRAS=denyhome chk limit exec-binary-in-denied-home-without-TOOLCHAIN "$RH/.toolchain/bin/node" -e 0
TC= EXTRAS=denyhome chk allow sh-git-without-TOOLCHAIN /bin/sh -c 'git --version && git log -1'

echo "== localhost:PORT (opt-in)"
P1=$((40000 + RANDOM % 10000)); P2=$((P1 + 1))
EXTRAS= PORT=$P1 chk deny min:listen+connect-P1 node "$D/net.cjs" port $P1
EXTRAS=localhost PORT=$P1 chk allow localhost:listen+connect-P1 node "$D/net.cjs" port $P1
EXTRAS=localhost PORT=$P1 chk deny localhost:listen-random-port node "$D/net.cjs" local
EXTRAS=localhost PORT=$P1 chk limit localhost:bind-0.0.0.0-P1 node "$D/net.cjs" bindany $P1
LAN=$(ipconfig getifaddr en0 || ipconfig getifaddr en1); P3=$((P1 + 2))
if [ -n "$LAN" ]; then
  node "$D/net.cjs" serve $P3 0.0.0.0 CTTYEXP-srv >/dev/null 2>&1 & c=$!; perl -e 'select undef,undef,undef,0.7'
  node "$D/net.cjs" connect $P3 "$LAN" >/dev/null 2>&1 || bad "control LAN connect"; kill $c; wait $c 2>/dev/null
  # sb.sh execs down to node, so $! is the server itself
  USERDATA="$UD" RUN_ID=$RUN REALHOME="$RH" SRCREPO="$SR" TOOLCHAIN="$NODEDIR" EXTRAS=localhost PORT=$P3 "$D/sb.sh" node "$D/net.cjs" serve $P3 0.0.0.0 CTTYEXP-srv </dev/null >/dev/null 2>&1 & PIDS="$PIDS $!"; perl -e 'select undef,undef,undef,0.7'
  node "$D/net.cjs" connect $P3 "$LAN" >/dev/null 2>&1 && echo "localhost:LAN-IP-reaches-sandboxed-0.0.0.0-server: ALLOWED (control ok) -- NOT ENSURED" || bad "LAN connect to sandboxed server failed"
else echo "LAN check skipped: no en0/en1 address"; fi
node "$D/net.cjs" serve $P2 127.0.0.1 CTTYEXP-srv >/dev/null 2>&1 & PIDS="$PIDS $!"
node "$D/net.cjs" serve $P1 127.0.0.1 CTTYEXP-srv >/dev/null 2>&1 & PIDS="$PIDS $!"; perl -e 'select undef,undef,undef,0.7'
EXTRAS=localhost PORT=$P1 chk deny localhost:connect-outside-service-P2 node "$D/net.cjs" connect $P2
EXTRAS=localhost PORT=$P1 chk limit localhost:connect-outside-service-on-P1 node "$D/net.cjs" connect $P1

echo "== unix sockets in TMP (opt-in)"
(cd "$OUT" && exec node "$D/net.cjs" serve o.sock - CTTYEXP-srv >/dev/null 2>&1) & PIDS="$PIDS $!"; perl -e 'select undef,undef,undef,0.7'
EXTRAS= chk deny min:unix-in-TMP /bin/sh -c 'cd "$TMPDIR" && node "$0" unix s1.sock; r=$?; rm -f s1.sock; exit $r' "$D/net.cjs"
EXTRAS=unix chk allow unix:unix-in-TMP /bin/sh -c 'cd "$TMPDIR" && node "$0" unix s2.sock; r=$?; rm -f s2.sock; exit $r' "$D/net.cjs"
EXTRAS=unix chk deny unix:connect-outside-socket /bin/sh -c 'cd "$1" && node "$0" uconnect o.sock' "$D/net.cjs" "$OUT"
EXTRAS=unix chk deny unix:listen-outside-TMP /bin/sh -c 'cd "$1" && node "$0" unix s3.sock; r=$?; rm -f s3.sock; exit $r' "$D/net.cjs" "$R/repo"

echo "== PTY (opt-in)"
python3 -c 'import os,pty,sys,time;m,s=pty.openpty();open(sys.argv[1],"w").write(os.ttyname(s));time.sleep(30)' "$FIX/tty.txt" CTTYEXP-pty & PIDS="$PIDS $!"
for i in $(seq 1 20); do [ -s "$FIX/tty.txt" ] && break; perl -e 'select undef,undef,undef,0.2'; done
TTY=$(cat "$FIX/tty.txt"); echo "foreign pty (created outside the sandbox): ${TTY:-none}"; [ -n "$TTY" ] || bad "no foreign pty"
EXTRAS= chk deny min:openpty /usr/bin/script -q /dev/null /usr/bin/true
EXTRAS= chk deny min:open-foreign-tty /bin/sh -c 'echo x > "$0"' "$TTY"
EXTRAS=pty chk allow pty:openpty /usr/bin/script -q /dev/null /usr/bin/true
EXTRAS=pty chk limit pty:open-foreign-tty /bin/sh -c 'echo x > "$0"' "$TTY"

echo "== informational: denyhome with REALHOME = real \$HOME (nothing is read; only exec)"
RHOME=$(cd "$HOME" && pwd -P)
for tc in "" "$NODEDIR"; do
  for c in "/bin/sh -c true" "/usr/bin/git --version" "$NODEDIR/bin/node -e 0" "$NODEDIR/bin/node -p require(process.execPath.replace(/bin.node\$/,\"lib/node_modules/npm/package.json\")).name"; do
    if USERDATA="$UD" RUN_ID=$RUN REALHOME="$RHOME" SRCREPO="$SR" TOOLCHAIN="$tc" EXTRAS=denyhome "$D/sb.sh" $c </dev/null >/dev/null 2>&1; then r=ok; else r=FAILS; fi
    echo "real-home denyhome TOOLCHAIN=${tc:+node-dir}${tc:-none}: $c -> $r"; done; done

echo "== result: $([ $fail = 0 ] && echo PASS || echo FAIL)"
exit $fail
