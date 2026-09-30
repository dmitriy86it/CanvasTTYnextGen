#!/bin/bash
# fingerprint of shared git state: refs, config, hooks, info/*
C=$1
{ git --git-dir="$C" -c core.fsmonitor=false -c core.hooksPath=/dev/null for-each-ref --format='%(refname) %(objectname)'
  cat "$C/packed-refs" 2>/dev/null
  shasum "$C"/config "$C"/config.worktree "$C"/worktrees/*/config.worktree 2>/dev/null
  find "$C/hooks" -exec stat -f '%Sp %N' {} + ; find "$C/hooks" -type f -exec shasum {} +
  cat "$C"/info/attributes "$C"/info/exclude "$C"/info/sparse-checkout 2>/dev/null
  cat "$C"/objects/info/alternates 2>/dev/null
} | shasum | cut -c1-16
