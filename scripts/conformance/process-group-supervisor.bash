#!/usr/bin/env bash
set -uo pipefail

if (( $# == 0 )); then
  echo "process-group-supervisor requires a command" >&2
  exit 64
fi

child_pid=""

terminate_child_group() {
  if [[ -n "$child_pid" ]]; then
    kill -KILL -- "-$child_pid" 2>/dev/null || true
  fi
}

terminate_on_parent_signal() {
  trap - TERM INT HUP
  terminate_child_group
  kill -KILL "$$"
}

trap terminate_on_parent_signal TERM INT HUP

# Monitor mode assigns the background command its own process group. The
# supervisor can then terminate the command and every descendant as one unit.
set -m
"$@" &
child_pid=$!
set +m

wait "$child_pid"
status=$?
trap - TERM INT HUP
exit "$status"
