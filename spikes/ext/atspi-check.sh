#!/usr/bin/env bash
# WP0 (d), a check to run on a real (windowed) Plasma session: does a separate Firefox expose its pages,
# its own UI and its tab-modal alert over AT-SPI, does doAction open a tab, a popup and a file
# picker, and what accessibility costs in memory. Opens Firefox windows on the desktop (one per
# variant, about 40 s each), switches org.a11y.Status IsEnabled on while they run and restores it.
# It runs on the session's own bus and starts no bus of its own. The only thing it spawns is its
# Firefox (stdio on /dev/null, own process group); at exit, Ctrl+C, TERM and HUP the check script
# ends it and whatever of its process tree outlived it, each by pid.
# This wrapper does not exec Python. libatspi aborts the whole Python process (SIGABRT, no finally)
# when the accessibility bus cannot be reached, so the check script keeps a state file (IsEnabled
# before the run, each Firefox's pid, start time and process group, the profile folder) and, when it
# ends by a signal or with a nonzero status, this wrapper runs `atspi_check.py --cleanup <state>`:
# IsEnabled back, the Firefox group ended (only if the pid's start time is still the recorded one),
# the profile folder removed. INT, TERM and HUP go to Python first and the cleanup runs after it.
# A SIGKILL on this wrapper cannot be caught: run that --cleanup line by hand then.
# The check script refuses to start (exit 2, nothing started or changed) when the accessibility bus
# refuses connections.
#   usage: spikes/ext/atspi-check.sh [--dry-run] [--yes] [--variants baseline,default,force[,env]] [--keep]
# For tests (atspi-selftest.sh --abort-test): --headless-selftest needs no display and no prompt, and
# ATSPI_CHECK_STATE=<file> picks the state file (default target/ext-spike/atspi-state-<wrapper pid>.json).
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
target="$(cd "$here/../.." && pwd)/target/ext-spike"
yes=0
dry=0
headless=0
args=()
for a in "$@"; do
  case "$a" in
    --yes) yes=1 ;;
    --dry-run) dry=1; args+=("$a") ;;
    --headless-selftest) headless=1; args+=("$a") ;;
    *) args+=("$a") ;;
  esac
done
if [[ -z "${WAYLAND_DISPLAY:-}${DISPLAY:-}" && $dry -eq 0 && $headless -eq 0 ]]; then
  echo "no graphical session (WAYLAND_DISPLAY/DISPLAY unset): run this from the Plasma session" >&2
  exit 2
fi
if [[ $dry -eq 0 && $yes -eq 0 && $headless -eq 0 ]]; then
  echo "This opens a separate Firefox window (throwaway profile) once per variant, switches"
  echo "org.a11y.Status IsEnabled on while it runs and restores it afterwards. Don't type into"
  echo "those windows while it runs. Press Enter to go on, Ctrl+C to stop."
  read -r _
fi

mkdir -p "$target"
state="${ATSPI_CHECK_STATE:-$target/atspi-state-$$.json}"
py=""
forward() { [[ -n "$py" ]] && kill -"$1" "$py" 2>/dev/null; return 0; }
trap 'forward INT' INT
trap 'forward TERM' TERM
trap 'forward HUP' HUP

python3 -I "$here/atspi_check.py" --state "$state" "${args[@]}" </dev/null &
py=$!
rc=0
while :; do
  rc=0
  wait "$py" || rc=$?
  kill -0 "$py" 2>/dev/null || break  # a trapped signal ended the wait, not Python
done

if [[ $rc -ne 0 && -e "$state" ]]; then
  echo "atspi-check: the check ended with status $rc (above 128: a signal's); cleaning up what it recorded in $state" >&2
  trap '' INT TERM HUP  # nothing interrupts the cleanup
  python3 -I "$here/atspi_check.py" --cleanup "$state" </dev/null ||
    echo "atspi-check: the cleanup left something (see above); state file kept: $state" >&2
fi
exit "$rc"
