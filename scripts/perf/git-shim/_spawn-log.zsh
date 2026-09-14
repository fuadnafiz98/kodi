#!/bin/zsh -f
# One TSV line per git/gh spawn, then the real binary runs untouched.
#
#   started_ns <TAB> elapsed_ms <TAB> exit_status <TAB> tool <TAB> argv
#
# `git` and `gh` are symlinks to this file, so the invoked name selects the
# tool and no wrapper process sits in front of the measurement. zsh's
# EPOCHREALTIME is read in-process: a `date`/`python3` subprocess per spawn
# would cost more than most of the commands being measured.
#
# Set KODI_GIT_SHIM_LOG to the file to append to; without it the shim is a
# transparent pass-through.
emulate -L zsh
zmodload zsh/datetime

typeset tool=${0:t}
if [[ $tool != git && $tool != gh ]]; then
  print -u2 "perf git-shim: refusing to shim '$tool'"
  exit 127
fi

# This directory is first on PATH, so it has to come off before asking where the
# real binary lives, or the shim would exec itself.
typeset -a other_directories
typeset directory
for directory in $path; do
  [[ ${directory:t} == git-shim ]] || other_directories+=($directory)
done

typeset real_binary
real_binary=$(PATH=${(j.:.)other_directories} command -v $tool 2>/dev/null)
if [[ -z $real_binary || ${real_binary:A} == ${0:A} ]]; then
  print -u2 "perf git-shim: no real '$tool' on PATH"
  exit 127
fi

if [[ -z ${KODI_GIT_SHIM_LOG:-} ]]; then
  exec $real_binary "$@"
fi

typeset started=$EPOCHREALTIME
$real_binary "$@"
typeset status_code=$?
typeset -F elapsed_ms=$(( ($EPOCHREALTIME - started) * 1000 ))

printf '%s\t%.1f\t%d\t%s\t%s\n' \
  $started $elapsed_ms $status_code $tool "$*" >> $KODI_GIT_SHIM_LOG

exit $status_code
