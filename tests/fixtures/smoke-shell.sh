#!/bin/sh
# The shell of a hermetic smoke run (CANVASTTY_SMOKE_SHELL): the command line without a login. A login sh on macOS
# runs path_helper, which puts /etc/paths.d (Homebrew among them) back in front of the smoke PATH.
case "$1" in -*c*) shift ;; esac
exec /bin/sh -c "$1"
