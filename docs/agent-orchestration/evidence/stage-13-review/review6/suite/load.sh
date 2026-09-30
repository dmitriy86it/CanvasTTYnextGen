#!/bin/sh
# Artificial CPU load for the review-6 suite repros: N busy-loop node processes for the duration of a command.
# usage: load.sh N command...   (N=40 on this 12-core Mac gives a load average around 45, as in the review-5 run)
N=$1; shift
pids=""
i=0
while [ $i -lt $N ]; do node -e 'for(;;){}' & pids="$pids $!"; i=$((i+1)); done
"$@"; rc=$?
kill $pids 2>/dev/null
exit $rc
