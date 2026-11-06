#!/usr/bin/env bash
# Runs atspi_check.py --headless-selftest on a private D-Bus session with its own AT-SPI bus
# (at-spi-bus-launcher with an in-memory GSettings backend, the registry started by hand), so it
# needs no window and never touches the session's org.a11y.Status. It checks the script's tree
# code and whether a HEADLESS Firefox exposes anything over AT-SPI; the real answer comes from
# atspi-check.sh on a real desktop session.
#
# EVERYTHING it starts (the bus, the AT-SPI launcher and registry, the services D-Bus activates, the
# headless Firefox) runs with a private XDG_RUNTIME_DIR (mktemp -d /tmp/kai-atspi-XXXXXX, mode 0700,
# short because a unix socket path holds 108 bytes; removed on every exit path) and with DISPLAY and
# WAYLAND_DISPLAY unset. at-spi-bus-launcher binds $XDG_RUNTIME_DIR/at-spi/bus_<display> after
# unlinking whatever is there, and may write the AT_SPI_BUS property on the X root window: an earlier
# version ran it with the session's own XDG_RUNTIME_DIR and DISPLAY and replaced the session's
# accessibility socket with a dead one. Before it runs anything else, the script asks the private
# launcher for its address and stops unless the socket is inside the private runtime dir.
#
# The private bus is a plain dbus-daemon this script starts itself, with a config of its own that
# lists no service directory: nothing is D-Bus activated on it. (With the session's session.conf,
# xdg-desktop-portal-kde and ksecretd were activated on it, outlived their bus and held the caller's
# pipe; without a display they abort at once and every request for them dumped core, 16 cores in 7 s.)
# On every exit path (trap: exit, Ctrl+C, TERM, HUP) the script ends what it started, then every
# process of the user whose environment carries this bus's DBUS_SESSION_BUS_ADDRESS or the private
# XDG_RUNTIME_DIR (exact string, read from /proc/<pid>/environ), e.g. a leftover Firefox, then the
# bus. Processes on the real session bus are never matched. Everything it spawns has
# stdin/stdout/stderr on /dev/null (python3 keeps the caller's output), so a survivor cannot hold the
# caller's pipe. A SIGKILL on the script itself cannot run the trap.
#   usage: spikes/ext/atspi-selftest.sh [--variants default,force,env]
#          spikes/ext/atspi-selftest.sh --abort-test
#          spikes/ext/atspi-selftest.sh --docurl
# --abort-test checks atspi-check.sh on the private bus, in two runs. First a hard abort: the wrapper
# runs the check headless (atspi-check.sh --headless-selftest --variants default) and, once the state
# file names its Firefox, this script sends SIGABRT to the check script (libatspi connects inside
# Atspi.init(), before any Firefox exists, so an unreachable bus no longer aborts a run that has
# one); it then reports whether the wrapper's cleanup ended that Firefox (pid and start time from the
# state file), restored IsEnabled, and removed the profile folder and the state file. Second the
# preflight: it removes the private AT-SPI socket and runs the check again, which must exit 2 with
# nothing started or changed.
# --docurl (WP0 (d2)) runs one headless Firefox (force_disabled = -1) on the private AT-SPI bus against
# pages with same-origin, same-site cross-origin and cross-site frames, a sandboxed, a nested, an
# about:blank, a data: and a srcdoc frame, a frame that navigates, and extra tabs (about:robots,
# about:blank, data:, file:, view-source:), and asks every Document in Firefox's tree what Kai's desktop
# tools ask: GetAttributeValue("DocURL"), GetAttributes(), its parents, and whether the top document's
# subtree holds it (atspi_docurl.py). It prints the answers and writes target/atspi-docurl-<time>.json.
# Same private bus, runtime dir, cleanup and sweep as every other mode; atspi_check.py refuses --docurl
# anywhere else.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

unset NO_AT_BRIDGE AT_SPI_BUS_ADDRESS DBUS_STARTER_ADDRESS DBUS_STARTER_BUS_TYPE
real_bus="${DBUS_SESSION_BUS_ADDRESS:-}"
real_runtime="${XDG_RUNTIME_DIR:-}"
abort_test=0
docurl=()
if [[ "${1:-}" == "--abort-test" ]]; then abort_test=1; shift; fi
if [[ "${1:-}" == "--docurl" ]]; then docurl=(--docurl); shift; fi
rt=""
addr=""
addr_file=""
bus_pid=""
py_pid=""
launcher=""
registry=""

# pids of the user's processes (not this script, not the helper) whose environment has the private
# bus address as DBUS_SESSION_BUS_ADDRESS or DBUS_STARTER_ADDRESS (the latter is how D-Bus hands it
# to an activated service) or the private XDG_RUNTIME_DIR; one pid per line
IFS= read -r -d '' sweep_py <<'PY' || true
import os, sys
addr = sys.argv[1].encode()
want = {b"DBUS_SESSION_BUS_ADDRESS=" + addr, b"DBUS_STARTER_ADDRESS=" + addr, b"XDG_RUNTIME_DIR=" + sys.argv[3].encode()}
skip = {int(sys.argv[2]), os.getpid(), os.getppid()}
me = os.getuid()
for d in os.listdir("/proc"):
    if not d.isdigit() or int(d) in skip:
        continue
    try:
        if os.stat("/proc/" + d).st_uid != me:
            continue
        with open("/proc/%s/environ" % d, "rb") as f:
            env = f.read().split(b"\0")
    except OSError:
        continue
    if want.intersection(env):
        print(d)
PY

sweep() { python3 -I -c "$sweep_py" "$addr" "$$" "$rt" </dev/null; }

alive() { kill -0 "$1" 2>/dev/null; }

# wait up to $2 tenths of a second for pid $1 to be gone
gone_within() {
  local _
  for _ in $(seq "$2"); do alive "$1" || return 0; sleep 0.1; done
  ! alive "$1"
}

cleanup() {
  local rc=$? pids sig round p _
  trap - EXIT INT TERM HUP
  set +e
  # our own children first, by pid: the check script gets TERM so it stops its Firefox itself
  if [[ -n "$py_pid" ]] && alive "$py_pid"; then
    kill -TERM "$py_pid" 2>/dev/null
    gone_within "$py_pid" 150 || kill -KILL "$py_pid" 2>/dev/null
  fi
  for p in $registry $launcher; do kill -TERM "$p" 2>/dev/null; done
  # then everything that carries the private bus address (activated services, a leftover Firefox)
  if [[ -n "$addr" && -n "$rt" ]]; then
    for round in 1 2 3; do
      for sig in TERM KILL; do
        pids="$(sweep)"
        [[ -z "$pids" ]] && continue
        # shellcheck disable=SC2086
        kill -"$sig" $pids 2>/dev/null
        for _ in $(seq 30); do [[ -z "$(sweep)" ]] && break; sleep 0.1; done
      done
      [[ -z "$(sweep)" ]] && break
    done
    pids="$(sweep)"
    # shellcheck disable=SC2086
    [[ -n "$pids" ]] && echo "atspi-selftest: still on the private bus after cleanup: $(echo $pids)" >&2
  fi
  # the bus itself
  if [[ -n "$bus_pid" ]]; then
    kill -TERM "$bus_pid" 2>/dev/null
    gone_within "$bus_pid" 30 || kill -KILL "$bus_pid" 2>/dev/null
  fi
  wait 2>/dev/null
  [[ -n "$addr_file" ]] && rm -f "$addr_file"
  # the private runtime dir last: everything that could hold a socket in it is gone
  if [[ -n "$rt" && "$rt" == /tmp/kai-atspi-* && -d "$rt" && ! -L "$rt" ]]; then rm -rf -- "$rt"; fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

# the private runtime dir and an environment without a display, for everything started from here on
rt="$(mktemp -d /tmp/kai-atspi-XXXXXX)"
chmod 700 "$rt"
if [[ "$rt" != /tmp/kai-atspi-* || ( -n "$real_runtime" && "$rt" == "$real_runtime"* ) ]]; then
  echo "atspi-selftest: refusing the runtime dir '$rt'" >&2
  exit 1
fi
export XDG_RUNTIME_DIR="$rt"
unset DISPLAY WAYLAND_DISPLAY XAUTHORITY DBUS_SESSION_BUS_ADDRESS
# in memory for the launcher and for any launcher D-Bus activates: never the user's dconf
export GSETTINGS_BACKEND=memory

# the private bus: its address comes back through a file, its pid is $!
addr_file="$rt/addr"
cat >"$rt/bus.conf" <<CONF
<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN"
 "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <type>session</type>
  <keep_umask/>
  <listen>unix:path=$rt/bus</listen>
  <auth>EXTERNAL</auth>
  <policy context="default">
    <allow send_destination="*" eavesdrop="true"/>
    <allow eavesdrop="true"/>
    <allow own="*"/>
  </policy>
</busconfig>
CONF
dbus-daemon --config-file="$rt/bus.conf" --nofork --print-address=3 3>"$addr_file" </dev/null >/dev/null 2>&1 &
bus_pid=$!
for _ in $(seq 50); do
  [[ -s "$addr_file" ]] && break
  alive "$bus_pid" || { echo "atspi-selftest: dbus-daemon did not start" >&2; exit 1; }
  sleep 0.1
done
addr="$(head -n 1 "$addr_file")"
# never sweep on anything that could be the real session bus
if [[ -z "$addr" || "$addr" == "$real_bus" || "$addr" != "unix:path=$rt/"* ]]; then
  echo "atspi-selftest: refusing the bus address '$addr' (empty, the session's, or not a socket inside $rt)" >&2
  addr=""
  exit 1
fi
export DBUS_SESSION_BUS_ADDRESS="$addr"
echo "private bus: $addr (dbus-daemon $bus_pid), runtime dir $rt"

/usr/libexec/at-spi-bus-launcher </dev/null >/dev/null 2>&1 &
launcher=$!
for _ in $(seq 50); do busctl --user status org.a11y.Bus </dev/null >/dev/null 2>&1 && break; sleep 0.1; done

# where the private launcher put its socket: it must be inside the private runtime dir
a11y_address() {
  busctl --user call org.a11y.Bus /org/a11y/bus org.a11y.Bus GetAddress </dev/null 2>/dev/null | sed -n 's/^s "\(.*\)"$/\1/p'
}
a11y_address_full="$(a11y_address)"
a11y_socket="${a11y_address_full#unix:path=}"
a11y_socket="${a11y_socket%%,*}"
if [[ "$a11y_socket" != "$rt"/* ]]; then
  echo "atspi-selftest: refusing: the private launcher's AT-SPI address is '$a11y_address_full', not a socket inside $rt" >&2
  exit 1
fi
echo "private AT-SPI bus: $a11y_socket (inside the private runtime dir)"

/usr/libexec/at-spi2-registryd </dev/null >/dev/null 2>&1 &
registry=$!
sleep 1

a11y_enabled() {
  busctl --user get-property org.a11y.Bus /org/a11y/bus org.a11y.Status IsEnabled </dev/null 2>/dev/null | awk '{print $2}'
}

# start time (field 22 of /proc/<pid>/stat) of a pid, empty when it is gone
start_of() { sed -n 's/.*) //p' "/proc/$1/stat" 2>/dev/null | awk '{print $20}'; }

# One run of the check, headless through the wrapper, ended by signal $1 sent to the check script
# (who=script) or to the wrapper (who=wrapper) once the state file names its Firefox; the wrapper must
# exit with status $3 and leave nothing: no Firefox (pid and start time from the state file), IsEnabled
# as before ($4), no profile folder, no state file. Returns the number of failures.
state=""
log=""
abort_stage() {
  local sig="$1" who="$2" want="$3" before="$4" fails=0 _ pid="" start pgid base spid during after wrc="" now left
  local ok='abort-test: PASS:' bad='abort-test: FAIL:'
  rm -f "$state" "$state.tmp"
  # (a background job starts with SIGINT ignored and bash cannot trap what it inherited ignored: reset it, as a terminal's foreground job has it)
  (ulimit -c 0; exec python3 -I -c 'import os, signal, sys; signal.signal(signal.SIGINT, signal.SIG_DFL); os.execvp(sys.argv[1], sys.argv[1:])' \
    env ATSPI_PRIVATE_BUS=1 ATSPI_CHECK_STATE="$state" "$here/atspi-check.sh" --headless-selftest --variants default --settle 12) </dev/null >"$log" 2>&1 &
  py_pid=$!
  for _ in $(seq 600); do  # the state file names the Firefox once it is started
    if [[ -s "$state" ]]; then
      read -r pid start pgid base spid < <(python3 -I -c 'import json,sys
d = json.load(open(sys.argv[1]))
if d["firefox"]:
    f = d["firefox"][0]
    print(f["pid"], f["start"], f["pgid"], d["base"], d["script_pid"])' "$state" 2>/dev/null) || true
      [[ -n "${pid:-}" ]] && break
    fi
    alive "$py_pid" || break
    sleep 0.1
  done
  if [[ -z "${pid:-}" ]]; then
    echo "$bad the check never recorded a Firefox (see $log)"
    return 1
  fi
  during="$(a11y_enabled)"
  echo "abort-test: state file: Firefox pid $pid, start time $start, process group $pgid, check script pid $spid; IsEnabled now $during"
  if ! tr '\0' ' ' <"/proc/$spid/cmdline" 2>/dev/null | grep -q 'atspi_check.py'; then
    echo "$bad pid $spid is not the check script"
    return 1
  fi
  if [[ "$who" == "script" ]]; then
    echo "abort-test: SIG$sig to the check script (pid $spid)"
    kill -"$sig" "$spid"
  else
    echo "abort-test: SIG$sig to the wrapper (pid $py_pid)"
    kill -"$sig" "$py_pid"
  fi
  for _ in $(seq 1200); do alive "$py_pid" || break; sleep 0.1; done
  if alive "$py_pid"; then
    echo "$bad the wrapper is still running 120 s after the signal (see $log)"
    return 1
  fi
  wait "$py_pid" || wrc=$?
  wrc="${wrc:-0}"
  echo "abort-test: wrapper exit status $wrc"
  sed -n '/atspi-check:\|atspi_check cleanup\|Traceback/p' "$log" | sed 's/^/abort-test: log: /'
  if [[ "$wrc" -eq "$want" ]]; then echo "$ok the wrapper exited with $want"; else echo "$bad wrapper exit status $wrc, not $want"; fails=$((fails + 1)); fi
  now="$(start_of "$pid")"
  left="$(pgrep -g "$pgid" 2>/dev/null | wc -l)"
  if [[ ( -z "$now" || "$now" != "$start" ) && "$left" -eq 0 ]]; then
    echo "$ok Firefox pid $pid (start $start) is gone, nothing left in process group $pgid"
  else
    echo "$bad Firefox pid $pid still has start time '${now:-}', $left process(es) in group $pgid"; fails=$((fails + 1))
  fi
  after="$(a11y_enabled)"
  if [[ "$after" == "$before" ]]; then echo "$ok IsEnabled is $after again (was $during during the run)"; else echo "$bad IsEnabled is '$after', was $before"; fails=$((fails + 1)); fi
  if [[ ! -e "$base" ]]; then echo "$ok profile base removed"; else echo "$bad profile base $base is still there"; fails=$((fails + 1)); fi
  if [[ ! -e "$state" ]]; then echo "$ok state file removed"; else echo "$bad state file $state is still there"; fails=$((fails + 1)); fi
  return "$fails"
}

# what a finished run must not leave: prints the leftovers, one per line (a Firefox of the check, a profile folder, a state file)
leftovers() {
  python3 -I -c 'import os
for d in os.listdir("/proc"):
    try:
        argv = open("/proc/%s/cmdline" % d, "rb").read().split(b"\0")
    except OSError:
        continue
    if d.isdigit() and argv[0].endswith(b"/firefox") and b"kai-atspi-check" in argv:  # an element of argv, not a substring of a shell line
        print("firefox", d)' </dev/null
  ls -d "$(cd "$here/../.." && pwd)"/target/ext-spike/atspi-1* 2>/dev/null || true
  [[ -e "$state" ]] && echo "$state" || true
}

abort_test() {
  local before fails=0 f log2 wrc2 enabled2 target wrc0 log0 left
  local ok='abort-test: PASS:' bad='abort-test: FAIL:'
  target="$(cd "$here/../.." && pwd)/target/ext-spike"
  mkdir -p "$target"
  state="$target/atspi-state-abort-test.json"
  log="$target/atspi-abort-test.log"
  log2="$target/atspi-abort-test-preflight.log"
  log0="$target/atspi-abort-test-control.log"
  before="$(a11y_enabled)"
  echo "abort-test: org.a11y.Status IsEnabled before the run: $before"

  # 0. control: a normal run through the wrapper ends with status 0 and leaves no state file
  echo "abort-test: -- 0. a normal run through the wrapper"
  rm -f "$state" "$state.tmp"
  wrc0=0
  env ATSPI_PRIVATE_BUS=1 ATSPI_CHECK_STATE="$state" "$here/atspi-check.sh" --headless-selftest --variants force --settle 3 </dev/null >"$log0" 2>&1 || wrc0=$?
  enabled2="$(a11y_enabled)"
  left="$(leftovers)"
  if [[ "$wrc0" -eq 0 && -z "$left" && "$enabled2" == "$before" ]]; then
    echo "$ok exit 0, no state file, no profile folder, no Firefox, IsEnabled $enabled2"
  else
    echo "$bad exit status $wrc0, IsEnabled '$enabled2', left: ${left:-nothing} (see $log0)"; fails=$((fails + 1))
  fi

  # 1. a hard abort after the Firefox is up. libatspi (2.60) connects inside Atspi.init(), before any
  # Firefox exists, so an unreachable bus can no longer abort a run that has one; the test raises
  # SIGABRT, the signal libatspi's abort raises (core dumps off for this run).
  echo "abort-test: -- 1. SIGABRT to the check script"
  f=0; abort_stage ABRT script 134 "$before" || f=$?; fails=$((fails + f))
  # 2. Ctrl+C or a kill on the wrapper: forwarded to Python first, the cleanup after it
  echo "abort-test: -- 2. SIGTERM to the wrapper"
  f=0; abort_stage TERM wrapper 130 "$before" || f=$?; fails=$((fails + f))
  echo "abort-test: -- 2b. SIGINT to the wrapper"
  f=0; abort_stage INT wrapper 130 "$before" || f=$?; fails=$((fails + f))

  # 3. the preflight: the private AT-SPI socket is gone, the run must stop before it starts or changes anything
  echo "abort-test: -- 3. the accessibility bus refuses connections"
  echo "abort-test: removing the private AT-SPI socket $a11y_socket"
  rm -f -- "$a11y_socket"
  rm -f "$state"
  wrc2=0
  env ATSPI_PRIVATE_BUS=1 ATSPI_CHECK_STATE="$state" "$here/atspi-check.sh" --headless-selftest --variants default </dev/null >"$log2" 2>&1 || wrc2=$?
  sed 's/^/abort-test: log: /' "$log2"
  if [[ "$wrc2" -eq 2 ]] && grep -q "refuses connections" "$log2" && grep -qF "$a11y_socket" "$log2"; then
    echo "$ok exit 2, the message says the bus refuses connections and names $a11y_socket"
  else
    echo "$bad exit status $wrc2 or the message is wrong (see $log2)"; fails=$((fails + 1))
  fi
  enabled2="$(a11y_enabled)"
  left="$(leftovers)"
  if [[ -z "$left" && "$enabled2" == "$before" ]]; then
    echo "$ok nothing started and nothing changed: no state file, no profile folder, no Firefox, IsEnabled $enabled2"
  else
    echo "$bad something was started or changed: IsEnabled '$enabled2', left: ${left:-nothing}"; fails=$((fails + 1))
  fi
  [[ $fails -eq 0 ]] && echo "abort-test: all checks passed" || echo "abort-test: $fails check(s) failed"
  return "$((fails > 0))"
}

rc=0
if [[ $abort_test -eq 1 ]]; then
  abort_test || rc=$?
else
  ATSPI_PRIVATE_BUS=1 python3 -I "$here/atspi_check.py" --headless-selftest "${docurl[@]}" "$@" </dev/null &
  py_pid=$!
  wait "$py_pid" || rc=$?
fi
exit "$rc"
