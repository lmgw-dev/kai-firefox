#!/usr/bin/python3 -I
"""WP0 (d), the check: what a separate Firefox exposes over AT-SPI on the real Plasma session.

usage: atspi_check.py [--dry-run] [--variants baseline,default,force[,env]] [--settle S] [--keep] [--state FILE]
       atspi_check.py --headless-selftest --docurl      (only under atspi-selftest.sh --docurl, see below)
       atspi_check.py --cleanup FILE

Starts its OWN Firefox (not headless: AT-SPI needs a real window) with a throwaway profile under the
worktree's target/, and HOME/XDG_CONFIG_HOME/XDG_CACHE_HOME/XDG_DATA_HOME/XDG_STATE_HOME pointed there
too, once per variant:
  baseline  accessibility.force_disabled = 1, org.a11y.Status IsEnabled as it was: memory without a11y
  default   IsEnabled switched on before Firefox starts, no accessibility pref
  force     IsEnabled on, accessibility.force_disabled = -1
  env       IsEnabled on, GNOME_ACCESSIBILITY=1 in Firefox's environment (not in the default list)
It loads a local test page (served on 127.0.0.1 by this script) with a link, a button, a
target=_blank link, a window.open button, a file input and an alert() button, and reports:
  - whether Firefox is on the AT-SPI bus, whether the page's elements are in its tree, and
    whether Firefox's own UI is (tool bars, tabs, the address bar, the tab-modal alert);
  - doAction on each element: did the page see the click (isTrusted, user activation), did the
    target=_blank link and window.open open a tab (the server sees the new tab's request), did the
    file input open a picker (a new dialog in Firefox's tree; the GTK picker is forced with
    widget.use-xdg-desktop-portal.file-picker = 0 so it is Firefox's own window), did the alert show;
  - RSS and PSS of the Firefox process tree per variant, and whether libatk-bridge is mapped.
It restores IsEnabled to its value before the run (also on Ctrl+C and errors), kills only the
Firefox it started (its own process group), and deletes its folder unless --keep.
--dry-run does only what needs no window and changes nothing: generates the page, serves and
fetches it, writes a profile, reads (does not set) org.a11y.Status, and prints the plan.
--headless-selftest checks this script's tree code without a window: one headless Firefox with
GNOME_ACCESSIBILITY=1 (IsEnabled untouched), the tree walk, doAction on the plain button and the
two tab-opening elements and the alert button (no file picker). Under atspi-selftest.sh (a private
D-Bus session with its own AT-SPI bus, ATSPI_PRIVATE_BUS=1) every variant runs headless and
IsEnabled is switched on that private bus only.
--docurl (WP0 (d2); only with --headless-selftest on the private bus, else exit 2 before anything starts) runs
one headless Firefox with accessibility.force_disabled = -1 on atspi_docurl.py's pages (frames of several
origins, about:, data:, srcdoc, extra tabs) and has that module ask the Document interface's DocURL and
GetAttributes of every document in Firefox's tree, as Kai's desktop tools do.
Before it changes or starts anything (--dry-run included) it opens a real connection to the accessibility
bus (AT_SPI_BUS_ADDRESS, else the address org.a11y.Bus.GetAddress gives on the session bus). libatspi
aborts the whole process (SIGABRT, no finally) when it cannot connect, so a bus that refuses connections
ends the run here with exit 2 and a message, with nothing started and nothing changed.
A hard abort (that one, SIGKILL of this script) skips every finally, so the script keeps a state file
(--state, default target/ext-spike/atspi-state-<pid>.json) from before it first touches org.a11y.Status:
IsEnabled's value before the run, the profile base folder, and per Firefox started its pid, /proc start
time and process group. atspi-check.sh runs `atspi_check.py --cleanup FILE` when this script ends by a
signal or with a nonzero status: it restores IsEnabled, ends the recorded process group (only when the
pid's start time is still the recorded one) and removes the profile base (not with --keep). A normal run
removes the state file. A SIGKILL on atspi-check.sh itself cannot be caught; run --cleanup by hand then.
Prints only roles, counts, timings and the names of the test page's elements and of Firefox's UI.
"""
import argparse
import collections
import http.server
import json
import os
import shutil
import signal
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
WORKTREE = os.path.normpath(os.path.join(HERE, "..", ".."))
TARGET = os.path.join(WORKTREE, "target", "ext-spike")
FIREFOX = os.environ.get("FIREFOX", "/usr/lib64/firefox/firefox")
TITLE = "Kai AT-SPI check"
ALERT_TEXT = "Kai check alert"

PAGE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>%(title)s</title>
<style>body{font:16px sans-serif;margin:24px} p{margin:14px 0} button,input{font-size:16px}</style>
<script>
function beacon(ev, e) {
  const q = new URLSearchParams({ ev, trusted: e ? e.isTrusted : "", activation: navigator.userActivation ? navigator.userActivation.isActive : "" });
  fetch("/beacon?" + q, { keepalive: true });
}
</script></head><body>
<h1>%(title)s</h1>
<p><a href="#plain" id="plain" onclick="beacon('plain-link', event)">Plain link</a></p>
<p><button id="btn" onclick="beacon('plain-button', event)">Plain button</button></p>
<p><a href="/opened?via=blank" target="_blank" id="blank" onclick="beacon('blank-link', event)">New tab link</a></p>
<p><button id="pop" onclick="beacon('popup-button', event); const w = window.open('/opened?via=window.open'); beacon(w ? 'popup-opened' : 'popup-blocked');">Popup button</button></p>
<p><input type="file" id="file" aria-label="Upload file" onclick="beacon('file-click', event)"></p>
<p><button id="alert" onclick="beacon('alert-button', event); alert('%(alert)s'); beacon('alert-closed');">Alert button</button></p>
</body></html>
""" % {"title": TITLE, "alert": ALERT_TEXT}

BUTTON = ("push button", "button")  # at-spi2 2.60 names ROLE_PUSH_BUTTON "button"
TARGETS = [  # (key, roles, name) of the page's elements
    ("plain_link", ("link",), "Plain link"),
    ("button", BUTTON, "Plain button"),
    ("blank_link", ("link",), "New tab link"),
    ("popup_button", BUTTON, "Popup button"),
    ("file_input", None, "Upload file"),
    ("alert_button", BUTTON, "Alert button"),
]

PREFS = {
    "browser.shell.checkDefaultBrowser": False,
    "browser.aboutwelcome.enabled": False,
    "trailhead.firstrun.didSeeAboutWelcome": True,
    "browser.startup.homepage_override.mstone": "ignore",
    "startup.homepage_welcome_url": "",
    "startup.homepage_welcome_url.additional": "",
    "datareporting.policy.dataSubmissionEnabled": False,
    "datareporting.policy.firstRunURL": "",
    "toolkit.telemetry.reportingpolicy.firstRun": False,
    "browser.tabs.warnOnClose": False,
    "browser.sessionstore.resume_from_crash": False,
    "widget.use-xdg-desktop-portal.file-picker": 0,
    "app.update.disabledForTesting": True,
}


# ------------------------------------------------------------------ the local server
class Server:
    def __init__(self, root):
        self.hits = []
        hits = self.hits

        class H(http.server.BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_GET(self):
                u = urllib.parse.urlparse(self.path)
                q = dict(urllib.parse.parse_qsl(u.query))
                hits.append({"t": time.time(), "path": u.path, **q})
                if u.path in ("/", "/index.html"):
                    body = PAGE.encode()
                elif u.path == "/opened":
                    body = b"<!doctype html><title>opened</title><p>opened"
                else:
                    body = b""
                self.send_response(200 if body or u.path == "/beacon" else 404)
                self.send_header("content-type", "text/html; charset=utf-8")
                self.send_header("cache-control", "no-store")
                self.end_headers()
                self.wfile.write(body)

        self.httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.port = self.httpd.server_address[1]
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def since(self, t, **match):
        return [h for h in self.hits if h["t"] >= t and all(h.get(k) == v for k, v in match.items())]

    def close(self):
        self.httpd.shutdown()


# ------------------------------------------------------------------ org.a11y.Status
def a11y_status():
    import dbus
    bus = dbus.SessionBus()
    obj = bus.get_object("org.a11y.Bus", "/org/a11y/bus")
    props = dbus.Interface(obj, "org.freedesktop.DBus.Properties")
    vals = {k: bool(props.Get("org.a11y.Status", k)) for k in ("IsEnabled", "ScreenReaderEnabled")}
    return props, vals


def set_enabled(props, value):
    import dbus
    props.Set("org.a11y.Status", "IsEnabled", dbus.Boolean(value))


# ------------------------------------------------------------------ processes
def tree_pids(pid):
    out, stack = [], [pid]
    while stack:
        p = stack.pop()
        out.append(p)
        try:
            tids = os.listdir("/proc/%d/task" % p)
        except OSError:
            continue
        for tid in tids:  # Firefox forks from other threads than its main one
            try:
                with open("/proc/%d/task/%s/children" % (p, tid)) as f:
                    stack += [int(c) for c in f.read().split()]
            except OSError:
                pass
    return out


def mem_of(pid):
    rss = pss = 0
    for p in tree_pids(pid):
        try:
            with open("/proc/%d/status" % p) as f:
                for line in f:
                    if line.startswith("VmRSS:"):
                        rss += int(line.split()[1])
            with open("/proc/%d/smaps_rollup" % p) as f:
                for line in f:
                    if line.startswith("Pss:"):
                        pss += int(line.split()[1])
        except OSError:
            pass
    return {"processes": len(tree_pids(pid)), "rss_mb": round(rss / 1024), "pss_mb": round(pss / 1024)}


def atk_bridge_mapped(pid):
    try:
        with open("/proc/%d/maps" % pid) as f:
            return "libatk-bridge" in f.read()
    except OSError:
        return None


def make_dirs(base):
    d = {k: os.path.join(base, k) for k in ("profile", "home", "xdg-config", "xdg-cache", "xdg-data", "xdg-state")}
    for p in d.values():
        os.makedirs(p, exist_ok=True)
    return d


def write_prefs(profile, extra):
    prefs = dict(PREFS, **extra)
    with open(os.path.join(profile, "user.js"), "w") as f:
        for k, v in prefs.items():
            f.write("user_pref(%s, %s);\n" % (json.dumps(k), json.dumps(v)))


def firefox_cmd(dirs, url):
    return [FIREFOX, "--no-remote", "--profile", dirs["profile"], "--name", "kai-atspi-check", url]


def firefox_env(dirs, extra):
    env = dict(os.environ)
    env.update(HOME=dirs["home"], XDG_CONFIG_HOME=dirs["xdg-config"], XDG_CACHE_HOME=dirs["xdg-cache"],
               XDG_DATA_HOME=dirs["xdg-data"], XDG_STATE_HOME=dirs["xdg-state"], MOZ_CRASHREPORTER_DISABLE="1")
    env.pop("GNOME_ACCESSIBILITY", None)
    env.update(extra)
    return env


def start_time(pid):
    """Field 22 of /proc/<pid>/stat (clock ticks since boot): with the pid, it tells a process from a later one reusing the pid."""
    try:
        with open("/proc/%d/stat" % pid) as f:
            stat = f.read()
        return stat[stat.rindex(")") + 2:].split()[19]
    except (OSError, ValueError, IndexError):
        return None


def family(proc):
    """pid -> start time of Firefox's process tree plus every member of its process group (start_new_session)."""
    pids = set(tree_pids(proc.pid))
    for d in os.listdir("/proc"):
        if d.isdigit():
            try:
                if os.getpgid(int(d)) == proc.pid:
                    pids.add(int(d))
            except OSError:
                pass
    return {p: st for p in pids if (st := start_time(p)) is not None}


def stop(proc):
    """Ends our Firefox: SIGTERM to its own process group (start_new_session), SIGKILL after 10 s; then
    SIGKILL, by pid, to whatever of its process tree or group is still alive 3 s after the main process
    went (a pid is only killed if its start time is still the one seen before SIGTERM)."""
    mine = family(proc)
    how = "already gone"
    if proc.poll() is None:
        try:
            os.killpg(proc.pid, signal.SIGTERM)
            how = "SIGTERM"
        except ProcessLookupError:
            how = "gone"
    if how == "SIGTERM":
        try:
            proc.wait(10)
        except subprocess.TimeoutExpired:
            os.killpg(proc.pid, signal.SIGKILL)
            proc.wait(5)
            how = "SIGKILL"
    deadline = time.time() + 3
    left = {}
    while time.time() < deadline:
        left = {p: st for p, st in mine.items() if p != proc.pid and start_time(p) == st}
        if not left:
            return how
        time.sleep(0.2)
    for p in left:
        try:
            os.kill(p, signal.SIGKILL)
        except ProcessLookupError:
            pass
    return "%s, %d left over killed by pid" % (how, len(left))


# ------------------------------------------------------------------ the accessibility bus, before anything starts
def a11y_preflight():
    """(address, None) when a real connection to the accessibility bus opens, else (address or None, reason).
    The address is found the way libatspi finds it: AT_SPI_BUS_ADDRESS, else org.a11y.Bus.GetAddress on the
    session bus. Changes and starts nothing."""
    import dbus
    addr = os.environ.get("AT_SPI_BUS_ADDRESS")
    if not addr:
        try:
            obj = dbus.SessionBus().get_object("org.a11y.Bus", "/org/a11y/bus")
            addr = str(dbus.Interface(obj, "org.a11y.Bus").GetAddress())
        except Exception as e:
            return None, "org.a11y.Bus.GetAddress on the session bus failed: %s" % e
    try:
        dbus.bus.BusConnection(addr).close()
    except Exception as e:
        return addr, str(e)
    return addr, None


def preflight_message(addr, reason):
    return ("atspi_check: the accessibility bus refuses connections (%s).\n"
            "  address: %s\n"
            "libatspi would abort this script without cleaning up, so nothing was started and nothing was changed.\n"
            "Restart the bus and run the check again:\n"
            "  systemctl --user restart at-spi-dbus-bus.service\n"
            "or log out and back in." % (reason, addr or "(none: the session bus did not give one)"))


# ------------------------------------------------------------------ the state file for a hard abort
class State:
    """What a cleanup needs after this script died without its finally: see the docstring."""

    def __init__(self, path, base, keep):
        self.path = path
        self.data = {"version": 1, "script_pid": os.getpid(), "is_enabled_before": None, "base": base, "keep": keep, "firefox": []}

    def write(self):
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        tmp = self.path + ".tmp"
        with open(tmp, "w") as f:
            json.dump(self.data, f, indent=1)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, self.path)

    def started(self, pid):
        """Right after a Firefox start: pid, /proc start time, process group."""
        try:
            pgid = os.getpgid(pid)
        except OSError:
            pgid = None
        self.data["firefox"].append({"pid": pid, "start": start_time(pid), "pgid": pgid})
        self.write()

    def stopped(self, pid):
        self.data["firefox"] = [x for x in self.data["firefox"] if x["pid"] != pid]
        self.write()

    def remove(self):
        for p in (self.path, self.path + ".tmp"):
            try:
                os.unlink(p)
            except FileNotFoundError:
                pass


def end_recorded(pid, pgid, start):
    """Ends the process group a state file names. Only when the pid still has the recorded start time (a reused pid
    is left alone); with the leader gone, the members still in that group (no process has the group's number as its
    pid then, so the group is the recorded one) go by pid. SIGTERM, SIGKILL after 10 s; every kill by pid after
    its start time was read again."""
    if pgid is None or start is None:
        return "pid %d: no process group or start time was recorded: left alone" % pid
    now = start_time(pid)
    if now is not None and now != start:
        return "pid %d is another process now (start %s, recorded %s): left alone" % (pid, now, start)
    mine = {}
    for d in os.listdir("/proc"):
        if d.isdigit():
            try:
                if os.getpgid(int(d)) == pgid:
                    st = start_time(int(d))
                    if st is not None and (int(d) == pid or int(st) >= int(start)):
                        mine[int(d)] = st
            except OSError:
                pass
    if not mine:
        return "pid %d already gone" % pid
    if now is not None:
        try:
            os.killpg(pgid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        how = "SIGTERM to process group %d" % pgid
    else:
        for p, st in mine.items():
            if start_time(p) == st:
                try:
                    os.kill(p, signal.SIGTERM)
                except ProcessLookupError:
                    pass
        how = "leader gone, SIGTERM to its %d remaining member(s) by pid" % len(mine)
    deadline = time.time() + 10
    left = mine
    while time.time() < deadline:
        left = {p: st for p, st in mine.items() if start_time(p) == st}
        if not left:
            return "pid %d (start %s): %s, gone" % (pid, start, how)
        time.sleep(0.2)
    for p, st in left.items():
        if start_time(p) == st:
            try:
                os.kill(p, signal.SIGKILL)
            except ProcessLookupError:
                pass
    time.sleep(0.5)
    return "pid %d (start %s): %s, %d needed SIGKILL by pid" % (pid, start, how, len(left))


def cleanup(path):
    """--cleanup FILE: restores IsEnabled, ends the recorded Firefox, removes the profile base, removes the file.
    Exit 0 when all of it is done (or there was no file), 1 when something is left (the file stays)."""
    try:
        with open(path) as f:
            st = json.load(f)
    except FileNotFoundError:
        print("atspi_check cleanup: no state file %s: nothing recorded, nothing to clean up" % path)
        return 0
    except ValueError as e:
        print("atspi_check cleanup: %s is not readable (%s); left in place" % (path, e))
        return 1
    ok = True
    for x in st.get("firefox", []):
        try:
            print("atspi_check cleanup: Firefox " + end_recorded(x["pid"], x["pgid"], x["start"]))
        except Exception as e:
            ok = False
            print("atspi_check cleanup: ending Firefox pid %s failed: %s" % (x.get("pid"), e))
    want = st.get("is_enabled_before")
    if want is not None:
        try:
            props, now = a11y_status()
            if now["IsEnabled"] == want:
                print("atspi_check cleanup: org.a11y.Status IsEnabled is %s, as before the run" % want)
            else:
                set_enabled(props, want)
                print("atspi_check cleanup: org.a11y.Status IsEnabled restored to %s (was %s)" % (a11y_status()[1]["IsEnabled"], now["IsEnabled"]))
        except Exception as e:
            ok = False
            print("RESTORE FAILED: set org.a11y.Status IsEnabled back to %s by hand (%s)" % (want, e))
    base = st.get("base")
    if base and st.get("keep"):
        print("atspi_check cleanup: kept %s (--keep)" % base)
    elif base and os.path.dirname(os.path.realpath(base)) == os.path.realpath(TARGET) and os.path.basename(base).startswith("atspi-"):
        existed = os.path.exists(base)
        shutil.rmtree(base, ignore_errors=True)
        print("atspi_check cleanup: %s %s" % (("removed" if existed else "already gone") if not os.path.exists(base) else "COULD NOT REMOVE", base))
        ok = ok and not os.path.exists(base)
    elif base:
        print("atspi_check cleanup: %s is not a folder this script makes under %s: left in place" % (base, TARGET))
        ok = False
    if ok:
        try:
            os.unlink(path)
        except FileNotFoundError:
            pass
    else:
        print("atspi_check cleanup: not everything is done; run `python3 -I %s --cleanup %s` again after fixing it" % (os.path.abspath(__file__), path))
    return 0 if ok else 1


# ------------------------------------------------------------------ AT-SPI
def load_docurl():
    """atspi_docurl.py next to this file (python -I leaves the script's folder off sys.path)."""
    import importlib.util
    sys.dont_write_bytecode = True  # no __pycache__ in the checkout
    spec = importlib.util.spec_from_file_location("atspi_docurl", os.path.join(HERE, "atspi_docurl.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def atspi():
    import gi
    gi.require_version("Atspi", "2.0")
    from gi.repository import Atspi
    return Atspi


def find_app(Atspi, pid, wait_s):
    t0 = time.time()
    while time.time() - t0 < wait_s:
        desk = Atspi.get_desktop(0)
        for i in range(desk.get_child_count()):
            app = desk.get_child_at_index(i)
            try:
                if app is not None and app.get_process_id() == pid:
                    return app, time.time() - t0
            except Exception:
                pass
        time.sleep(0.5)
    return None, time.time() - t0


def walk(node, budget_s=20.0):
    """All nodes under node as (node, role, name, depth); stops at the budget."""
    out, stack, t0 = [], [(node, 0)], time.time()
    while stack and time.time() - t0 < budget_s:
        n, d = stack.pop()
        try:
            role, name = n.get_role_name(), n.get_name() or ""
            out.append((n, role, name, d))
            for i in range(n.get_child_count() - 1, -1, -1):
                c = n.get_child_at_index(i)
                if c is not None:
                    stack.append((c, d + 1))
        except Exception:
            pass
    return out, time.time() - t0


def find_doc(Atspi, app, wait_s):
    t0 = time.time()
    while time.time() - t0 < wait_s:
        nodes, _ = walk(app, 10)
        for n, role, name, _d in nodes:
            if role == "document web" and name == TITLE:
                return n, time.time() - t0
        time.sleep(0.5)
    return None, time.time() - t0


def actions_of(n):
    try:
        a = n.get_action_iface()
        if a is None:
            return []
        return [a.get_action_name(i) for i in range(a.get_n_actions())]
    except Exception as e:
        return ["error: %s" % e]


def do_action(Atspi, n, i=0):
    t0 = time.time()
    try:
        try:
            ok = n.do_action(i)
        except AttributeError:
            ok = Atspi.Action.do_action(n, i)
        return {"ok": bool(ok), "ms": round((time.time() - t0) * 1000)}
    except Exception as e:
        return {"ok": False, "error": str(e)[:200], "ms": round((time.time() - t0) * 1000)}


def ui_summary(nodes, doc_nodes):
    doc_set = set(id(x[0]) for x in doc_nodes)
    roles = collections.Counter(r for n, r, nm, d in nodes if id(n) not in doc_set)
    names = sorted(set(nm for n, r, nm, d in nodes if id(n) not in doc_set and nm and r in BUTTON + ("page tab", "entry", "combo box", "tool bar", "menu bar")))[:30]
    return {"ui_nodes": sum(roles.values()), "tool_bars": roles.get("tool bar", 0), "page_tabs": roles.get("page tab", 0),
            "entries": roles.get("entry", 0) + roles.get("combo box", 0), "buttons": roles.get("push button", 0) + roles.get("button", 0),
            "top_roles": roles.most_common(10), "ui_names_sample": names}


def check_variant(Atspi, server, name, proc, args, gui=True):
    res = {}
    app, waited = find_app(Atspi, proc.pid, args.bus_wait)
    res["on_bus"] = app is not None
    res["bus_wait_s"] = round(waited, 1)
    if app is None:
        return res
    doc, waited = find_doc(Atspi, app, args.doc_wait)
    res["document_found"] = doc is not None
    res["document_wait_s"] = round(waited, 1)
    nodes, secs = walk(app, 30)
    doc_nodes = walk(doc, 10)[0] if doc else []
    res["app_nodes"] = len(nodes)
    res["walk_s"] = round(secs, 2)
    res["document_nodes"] = len(doc_nodes)
    res["document_roles"] = collections.Counter(r for _n, r, _nm, _d in doc_nodes).most_common(10)
    res["firefox_ui"] = ui_summary(nodes, doc_nodes)
    if not doc:
        return res
    els = {}
    for key, role, nm in TARGETS:
        hit = [x for x in doc_nodes if x[2] == nm and (role is None or x[1] in role)]
        if not hit and key == "file_input":  # Firefox may name the file input's button itself
            known = set(t[2] for t in TARGETS)
            hit = [x for x in doc_nodes if x[1] in BUTTON and x[2] not in known]
        hit.sort(key=lambda x: 0 if actions_of(x[0]) else 1)  # the node that has an action first
        els[key] = hit[0][0] if hit else None
        res.setdefault("elements", {})[key] = {"found": bool(hit), "role": hit[0][1] if hit else None, "name": hit[0][2] if hit else None,
                                              "actions": actions_of(hit[0][0]) if hit else None}
    acts = res["actions"] = {}

    def tabs_now():
        return sum(1 for _n, r, _nm, _d in walk(app, 10)[0] if r == "page tab")

    def act(key, settle=1.5):
        t = time.time()
        if els.get(key) is None:
            return {"skipped": "not in the tree"}, t
        r = do_action(Atspi, els[key])
        time.sleep(settle)
        r["page_saw"] = [{k: v for k, v in h.items() if k not in ("t", "path")} for h in server.since(t, path="/beacon")]
        return r, t

    r, _ = act("button")
    acts["button"] = r
    before = tabs_now()
    r, t = act("blank_link", 2.5)
    r["opened_request"] = bool(server.since(t, path="/opened", via="blank")) if "skipped" not in r else None
    r["page_tabs"] = [before, tabs_now()]
    acts["blank_link"] = r
    before = tabs_now()
    r, t = act("popup_button", 2.5)
    r["opened_request"] = bool(server.since(t, path="/opened", via="window.open")) if "skipped" not in r else None
    r["page_tabs"] = [before, tabs_now()]
    acts["popup_button"] = r
    # File input: a picker shows as a new dialog/file chooser in Firefox's own tree.
    top_before = app.get_child_count()
    r, _ = act("file_input", 3.0) if gui else ({"skipped": "headless self-test"}, 0)
    nodes2 = walk(app, 15)[0] if gui else []
    chooser = [x for x in nodes2 if x[1] == "file chooser"]
    r["top_level_windows"] = [top_before, app.get_child_count()]
    r["file_chooser_in_tree"] = bool(chooser)
    if chooser:
        cancel = [x for x in walk(chooser[0][0], 5)[0] if x[1] in BUTTON and x[2] in ("Cancel", "_Cancel", "Abbrechen")]
        r["cancel"] = do_action(Atspi, cancel[0][0]) if cancel else "no Cancel button found"
        time.sleep(1.0)
    acts["file_input"] = r
    # alert(): the tab-modal dialog, in Firefox's tree or not.
    r, _ = act("alert_button", 2.0)
    nodes3 = walk(app, 15)[0]
    dialogs = [x for x in nodes3 if x[1] in ("alert", "dialog")]
    text_hit = [x for x in nodes3 if ALERT_TEXT in x[2]]
    r["dialogs_in_tree"] = [(x[1], x[2][:60]) for x in dialogs][:5]
    r["alert_text_in_tree"] = bool(text_hit)
    ok_btn = []
    for d in dialogs:
        ok_btn += [x for x in walk(d[0], 5)[0] if x[1] in BUTTON and x[2] in ("OK", "Ok")]
    if not ok_btn:  # the prompt's button may sit beside the alert node, not inside it
        ok_btn = [x for x in nodes3 if x[1] in BUTTON and x[2] in ("OK", "Ok")]
    r["ok_button_in_tree"] = bool(ok_btn)
    if ok_btn:
        r["ok"] = do_action(Atspi, ok_btn[0][0])
        time.sleep(1.0)
        r["after_ok"] = [h["ev"] for h in server.since(time.time() - 1.5, path="/beacon")]
    acts["alert_button"] = r
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--variants", default="baseline,default,force")
    ap.add_argument("--settle", type=float, default=8.0, help="seconds after start before memory is read (default 8)")
    ap.add_argument("--bus-wait", type=float, default=30.0)
    ap.add_argument("--doc-wait", type=float, default=30.0)
    ap.add_argument("--keep", action="store_true")
    ap.add_argument("--headless-selftest", action="store_true")
    ap.add_argument("--docurl", action="store_true", help="WP0 (d2): DocURL and frames; only with --headless-selftest on the private bus")
    ap.add_argument("--state", help="state file for atspi-check.sh's cleanup (default target/ext-spike/atspi-state-<pid>.json)")
    ap.add_argument("--cleanup", metavar="FILE", help="clean up after a run that ended without its finally, from this state file, and exit")
    args = ap.parse_args()
    if args.cleanup:
        return cleanup(args.cleanup)
    variants = [v for v in args.variants.split(",") if v]
    private_bus = os.environ.get("ATSPI_PRIVATE_BUS") == "1"
    if args.docurl and not (args.headless_selftest and private_bus):
        print("atspi_check: --docurl runs only with --headless-selftest on the private bus (atspi-selftest.sh --docurl); nothing was started", file=sys.stderr)
        return 2
    if args.headless_selftest and not private_bus:
        variants = ["env"]
    if args.docurl:
        variants = ["force"]
    bad = [v for v in variants if v not in ("baseline", "default", "force", "env")]
    if bad:
        print("unknown variant(s): %s" % bad)
        return 2

    # A shell starts a background job with SIGINT ignored: until restore() takes over, a signal ends the script.
    for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(sig, lambda *_: sys.exit(130))
    # Before anything is created, started or changed: can the accessibility bus be reached at all?
    addr, reason = a11y_preflight()
    if reason:
        print(preflight_message(addr, reason), file=sys.stderr)
        return 2

    base = os.path.join(TARGET, "atspi-%d" % int(time.time()))
    os.makedirs(base, exist_ok=True)
    state = State(args.state or os.path.join(TARGET, "atspi-state-%d.json" % os.getpid()), base, args.keep)
    server = Server(base)
    url = "http://127.0.0.1:%d/index.html" % server.port
    docurl = sites = None
    if args.docurl:
        docurl = load_docurl()
        sites = docurl.Sites(base)
        url = sites.top_url
    report = {"firefox": subprocess.run([FIREFOX, "--version"], capture_output=True, text=True).stdout.strip(),
              "page": url, "variants": {}}
    props = None
    before = None
    procs = []
    changed = []

    def restore(*_sig):
        for p in procs:
            stop(p)
        if changed and props is not None and before is not None:
            try:
                set_enabled(props, before["IsEnabled"])
                print("org.a11y.Status IsEnabled restored to %s" % a11y_status()[1]["IsEnabled"])
            except Exception as e:
                print("RESTORE FAILED: set org.a11y.Status IsEnabled back to %s by hand (%s)" % (before["IsEnabled"], e))
        if _sig:
            sys.exit(130)

    try:
        props, before = a11y_status()
        report["a11y_status_before"] = before
        report["a11y_bus"] = addr
        page = urllib.request.urlopen(url, timeout=5).read().decode()
        report["page_served"] = (docurl.TOP_TITLE if docurl else TITLE) in page
        if args.dry_run:
            atspi()  # the bindings import
            d = make_dirs(os.path.join(base, "dry"))
            write_prefs(d["profile"], {"accessibility.force_disabled": -1})
            print(json.dumps(report, indent=1))
            print("plan:")
            for v in variants:
                print("  %-8s IsEnabled=%s  prefs=%s  env=%s" % (
                    v, before["IsEnabled"] if v == "baseline" else True,
                    {"baseline": "force_disabled=1", "force": "force_disabled=-1"}.get(v, "-"),
                    "GNOME_ACCESSIBILITY=1" if v == "env" else "-"))
            print("  command: %s" % " ".join(firefox_cmd(d, url)))
            print("  user.js:\n    " + open(os.path.join(d["profile"], "user.js")).read().strip().replace("\n", "\n    "))
            print("dry run: no Firefox started, org.a11y.Status not changed")
            return 0
        # the state file exists before org.a11y.Status is touched or a Firefox started
        state.data["is_enabled_before"] = before["IsEnabled"]
        state.write()
        signal.signal(signal.SIGINT, restore)
        signal.signal(signal.SIGTERM, restore)
        signal.signal(signal.SIGHUP, restore)
        Atspi = atspi()
        Atspi.init()
        for v in variants:
            if not args.headless_selftest or private_bus:
                changed.append(v)
                set_enabled(props, before["IsEnabled"] if v == "baseline" else True)
                time.sleep(1.0)
            d = make_dirs(os.path.join(base, v))
            extra = {"baseline": {"accessibility.force_disabled": 1}, "force": {"accessibility.force_disabled": -1}}.get(v, {})
            if sites:
                extra = dict(extra, **sites.prefs)
            write_prefs(d["profile"], extra)
            env = firefox_env(d, {"GNOME_ACCESSIBILITY": "1"} if v == "env" else {})
            cmd = firefox_cmd(d, url)
            if sites:
                cmd += sites.extra_urls()
            if args.headless_selftest:
                env["MOZ_HEADLESS"] = "1"
                cmd.insert(1, "--headless")
            print("\n## %s: starting Firefox (IsEnabled=%s, prefs %s)" % (v, a11y_status()[1]["IsEnabled"], extra or "-"))
            t0 = time.time()
            proc = subprocess.Popen(cmd, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                    stderr=subprocess.DEVNULL, start_new_session=True)
            procs.append(proc)
            state.started(proc.pid)
            res = {"pid": proc.pid}
            time.sleep(args.settle)
            res["page_loaded"] = bool(sites.beacons()) if sites else bool(server.since(t0, path="/index.html"))
            res["memory_after_load"] = mem_of(proc.pid)
            res["atk_bridge_mapped"] = atk_bridge_mapped(proc.pid)
            if sites:
                res["docurl"] = docurl.probe(addr, proc.pid, sites)
                res["memory_after_checks"] = mem_of(proc.pid)
            elif v != "baseline":
                res.update(check_variant(Atspi, server, v, proc, args, gui=not args.headless_selftest))
                res["memory_after_checks"] = mem_of(proc.pid)
            else:
                app, _ = find_app(Atspi, proc.pid, 5)
                res["on_bus"] = app is not None
            res["stopped_by"] = stop(proc)
            procs.remove(proc)
            state.stopped(proc.pid)
            report["variants"][v] = res
            print("\n".join(docurl.table(res["docurl"])) if sites else json.dumps(res, indent=1, default=str))
    finally:
        restore()
        server.close()
        if sites:
            sites.close()
        if not args.keep:
            shutil.rmtree(base, ignore_errors=True)
    state.remove()  # only a run that got here: an exception or a signal leaves it for --cleanup
    out = os.path.join(TARGET, "..", "atspi-%s-%d.json" % ("docurl" if sites else "check", int(time.time())))
    with open(out, "w") as f:
        json.dump(report, f, indent=1, default=str)
    print("\nreport written to %s" % os.path.normpath(out))
    if sites:
        return 0
    print("summary:")
    for v, r in report["variants"].items():
        print("  %-8s on_bus=%s doc=%s ui_nodes=%s tool_bars=%s pss=%s MB atk_bridge=%s" % (
            v, r.get("on_bus"), r.get("document_found"), (r.get("firefox_ui") or {}).get("ui_nodes"),
            (r.get("firefox_ui") or {}).get("tool_bars"), (r.get("memory_after_checks") or r["memory_after_load"])["pss_mb"],
            r.get("atk_bridge_mapped")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
