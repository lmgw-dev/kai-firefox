"""WP0 (d2): what a real Firefox answers for Kai's DocURL call, on the private accessibility bus.

Not a program of its own: atspi_check.py --headless-selftest --docurl loads it (through atspi-selftest.sh
--docurl, on its private D-Bus session and private AT-SPI bus; the check script refuses the flag anywhere
else). The check script starts the headless Firefox, this module serves the pages and does the probing.

Kai's desktop tools (Kai's src/desktop/fdo/atspi.rs `doc_url`, `documents_of`) judge each Firefox page and
frame by the Document interface's GetAttributeValue("DocURL") on every element that has the interface,
reached either by descending from the window (read_window, ui_press's find: only VISIBLE elements) or by
following the Parent property up from a pressed element. This module asks the same questions over raw
D-Bus (python-dbus on the accessibility bus, the same destination, path, interface, method and argument
as Kai's zbus call; an error counts as the empty string, as Kai's unwrap_or_default) and reports, for
every Document in Firefox's tree:
  - GetAttributeValue("DocURL") and GetAttributes() (all of them), against what the page itself says
    (document.URL, sent to the local server as a beacon);
  - its role, name, states, parent chain, whether it lies in the top document's subtree, and whether
    Kai's visible-only descent from the window reaches it;
  - Kai's documents_of() chain from an element inside it.
Served pages: a top page with a same-origin frame, a same-site cross-origin frame (another port on
127.0.0.1), a cross-site frame (localhost, which site isolation gives a process of its own; the split is not
checked here), a sandboxed frame (opaque origin, scripts allowed), a nested frame two sites deep, about:blank,
data:, srcdoc, blob: and a refused connection (Firefox's error page), a frame the top page navigates after
the load, and a "lag" frame it navigates when the probe says go, while the probe polls what that iframe shows
every 10 ms; the top page itself changes its URL with history.pushState and holds a link and two buttons whose
NActions (the Action interface, which Kai's ui_press needs above 0) is read for 3 s. The extra tabs are
top-level about:robots, about:blank, data: (with Firefox's block on top-level data: navigations lifted, since
it refuses one passed on the command line), file:, view-source: and Reader view. The probe then selects each tab in turn
(doAction on the tab, "switch") and the first one again.
"""
import http.server
import os
import threading
import time
import urllib.parse

ACCESSIBLE = "org.a11y.atspi.Accessible"
DOCUMENT = "org.a11y.atspi.Document"
ACTION = "org.a11y.atspi.Action"
ROOT = "/org/a11y/atspi/accessible/root"
REGISTRY = "org.a11y.atspi.Registry"
NULL = "/org/a11y/atspi/null"
TOP_TITLE = "Kai docurl top"
CALL_TIMEOUT = 5

STATE_NAMES = [
    "invalid", "active", "armed", "busy", "checked", "collapsed", "defunct", "editable", "enabled", "expandable",
    "expanded", "focusable", "focused", "has-tooltip", "horizontal", "iconified", "modal", "multi-line",
    "multiselectable", "opaque", "pressed", "resizable", "selectable", "selected", "sensitive", "showing",
    "single-line", "stale", "transient", "vertical", "visible", "manages-descendants", "indeterminate",
    "required", "truncated", "animated", "invalid-entry", "supports-autocompletion", "selectable-text",
    "is-default", "visited", "checkable", "has-popup", "read-only",
]
VISIBLE = 30
MANAGES_DESCENDANTS = 31


# ------------------------------------------------------------------ the pages
class Sites:
    """Two local servers on 127.0.0.1 (A and B, different ports); the same pages on both. A page asks
    another origin with localhost:<port> for the cross-site case, so one server serves every origin."""

    def __init__(self, base):
        self.hits = []
        self.go = False  # the probe sets it; the top page polls /go and then navigates its "lag" frame
        # Firefox blocks a top-level data: navigation by default (also from the command line); lifted so the
        # data: tab below can show what DocURL says of one. The data: FRAME is not touched by it.
        self.prefs = {"security.data_uri.block_toplevel_data_uri_navigations": False}
        hits = self.hits
        sites = self
        os.makedirs(base, exist_ok=True)
        self.file_page = os.path.join(base, "file-page.html")
        with open(self.file_page, "w") as f:
            f.write("<!doctype html><title>file page</title><p>a file: page")

        class H(http.server.BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_GET(self):
                u = urllib.parse.urlparse(self.path)
                q = dict(urllib.parse.parse_qsl(u.query))
                if u.path != "/go":
                    hits.append({"t": time.time(), "path": u.path, "port": self.server.server_address[1], **q})
                body = sites.page(u.path, q)
                self.send_response(200 if body is not None else 404)
                self.send_header("content-type", "text/html; charset=utf-8")
                self.send_header("cache-control", "no-store")
                self.end_headers()
                self.wfile.write(body or b"")

        self.a = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.b = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.pa, self.pb = self.a.server_address[1], self.b.server_address[1]
        for s in (self.a, self.b):
            threading.Thread(target=s.serve_forever, daemon=True).start()
        self.top_url = "http://127.0.0.1:%d/top.html" % self.pa
        self.article_url = "http://127.0.0.1:%d/article.html" % self.pa
        # top-level pages of the other kinds, opened as tabs beside the first
        self.tabs = [
            ("about:robots", "about:robots"),
            ("about:blank", "about:blank"),
            ("data:", "data:text/html,%3Ctitle%3Edata%20top%3C/title%3E%3Cp%3Ea%20top-level%20data%20page"),
            ("file:", "file://" + self.file_page),
            ("view-source:", "view-source:" + self.top_url),
            ("about:reader", "about:reader?url=" + urllib.parse.quote(self.article_url, safe="")),
        ]

    def extra_urls(self):
        return [u for _name, u in self.tabs]

    def close(self):
        for s in (self.a, self.b):
            s.shutdown()

    def beacons(self):
        return [h for h in self.hits if h["path"] == "/beacon"]

    def page(self, path, q):
        pa, pb = self.pa, self.pb
        if path == "/top.html":
            return TOP.format(pa=pa, pb=pb, title=TOP_TITLE).encode()
        if path == "/article.html":
            return ARTICLE.encode()
        if path == "/frame.html":
            return FRAME.format(pa=pa, who=q.get("who", "?")).encode()
        if path == "/nested.html":
            return NESTED.format(pa=pa, pb=pb).encode()
        if path == "/beacon":
            return b""
        if path == "/go":
            return b"1" if self.go else b"0"
        return None


ARTICLE = "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>Kai reader article</title></head><body><article><h1>Kai reader article</h1>" + "".join(
    "<p>Paragraph %d of an article that Firefox's reader view can lift out of its page: it has a title, a heading, "
    "and enough running text in several paragraphs for the readability check to call it an article, which is all "
    "this page is for, so it keeps going for a few more words, then a few more, and ends here.</p>" % i for i in range(1, 9)) + "</article></body></html>"

BEACON = """function beacon(who) {{
  const q = new URLSearchParams({{ who, url: document.URL, origin: location.origin, top: String(window === window.top) }});
  fetch("http://127.0.0.1:{pa}/beacon?" + q, {{ keepalive: true, mode: "no-cors" }});
}}"""

FRAME = """<!doctype html><html lang="en"><head><meta charset="utf-8"><title>frame {who}</title>
<script>""" + BEACON + """</script></head><body>
<p>text in frame {who}</p>
<script>beacon("{who}");</script></body></html>"""

NESTED = """<!doctype html><html lang="en"><head><meta charset="utf-8"><title>frame nested-outer</title>
<script>""" + BEACON + """</script></head><body>
<p>text in frame nested-outer</p>
<iframe name="inner" title="frame: nested-inner" src="http://localhost:{pb}/frame.html?who=nested-inner"></iframe>
<script>beacon("nested-outer");</script></body></html>"""

TOP = """<!doctype html><html lang="en"><head><meta charset="utf-8"><title>{title}</title>
<style>body{{font:16px sans-serif;margin:12px}} iframe{{width:200px;height:56px;margin:2px}}</style>
<script>""" + BEACON + """</script></head><body>
<h1>{title}</h1>
<p>text in the top document</p>
<p><a href="#plain">Plain link</a> <button>Plain button</button> <button onclick="void 0">Handler button</button></p>
<iframe name="same" title="frame: same-origin" src="/frame.html?who=same"></iframe>
<iframe name="sibling" title="frame: same-site cross-origin" src="http://127.0.0.1:{pb}/frame.html?who=sibling"></iframe>
<iframe name="crosssite" title="frame: cross-site" src="http://localhost:{pa}/frame.html?who=crosssite"></iframe>
<iframe name="sandboxed" title="frame: sandboxed" sandbox="allow-scripts" src="/frame.html?who=sandboxed"></iframe>
<iframe name="nested" title="frame: nested" src="/nested.html"></iframe>
<iframe name="blank" title="frame: about:blank" src="about:blank"></iframe>
<iframe name="data" title="frame: data" src="data:text/html,%3Ctitle%3Edata%20frame%3C/title%3E%3Cp%3Etext%20in%20frame%20data"></iframe>
<iframe name="srcdoc" title="frame: srcdoc" srcdoc="&lt;title&gt;srcdoc frame&lt;/title&gt;&lt;p&gt;text in frame srcdoc"></iframe>
<iframe name="moves" title="frame: navigated" src="/frame.html?who=moves-start"></iframe>
<iframe name="lag" title="frame: lag" src="/frame.html?who=lag-start"></iframe>
<iframe name="refused" title="frame: refused" src="http://127.0.0.1:1/refused"></iframe>
<iframe name="blob" title="frame: blob"></iframe>
<script>
beacon("top");
frames["blob"].location.href = URL.createObjectURL(new Blob(["<title>blob frame</title><p>text in frame blob"], {{ type: "text/html" }}));
const poll = setInterval(async () => {{
  const r = await fetch("/go", {{ cache: "no-store" }});
  if ((await r.text()) === "1") {{ clearInterval(poll); frames["lag"].location.href = "http://localhost:{pb}/frame.html?who=lag-end"; }}
}}, 50);
setTimeout(() => {{ frames["moves"].location.href = "http://localhost:{pb}/frame.html?who=moves-end"; }}, 1500);
setTimeout(() => {{ history.pushState({{}}, "", "/top-pushed.html"); beacon("top-pushed"); }}, 3000);
</script></body></html>"""

# ------------------------------------------------------------------ raw D-Bus, as Kai's call does it
class Ax:
    def __init__(self, addr):
        import dbus
        self.dbus = dbus
        self.bus = dbus.bus.BusConnection(addr)
        self.calls = 0

    def call(self, dest, path, iface, method, *args):
        self.calls += 1
        obj = self.bus.get_object(dest, path, introspect=False)
        return obj.get_dbus_method(method, iface)(*args, timeout=CALL_TIMEOUT)

    def prop(self, dest, path, iface, name):
        self.calls += 1
        obj = self.bus.get_object(dest, path, introspect=False)
        return obj.Get(iface, name, dbus_interface="org.freedesktop.DBus.Properties", timeout=CALL_TIMEOUT)

    def children(self, dest, path):
        return [(str(d), str(p)) for d, p in self.call(dest, path, ACCESSIBLE, "GetChildren")]

    def states(self, dest, path):
        words = [int(w) for w in self.call(dest, path, ACCESSIBLE, "GetState")][:2]
        return sum(w << (32 * i) for i, w in enumerate(words))

    def doc_url(self, dest, path):
        """Kai's doc_url: the string, or "" for any failure."""
        try:
            return str(self.call(dest, path, DOCUMENT, "GetAttributeValue", "DocURL"))
        except Exception:
            return ""

    def pid_of(self, dest):
        return int(self.bus.get_object("org.freedesktop.DBus", "/org/freedesktop/DBus", introspect=False)
                   .GetConnectionUnixProcessID(dest, dbus_interface="org.freedesktop.DBus", timeout=CALL_TIMEOUT))


def state_names(bits):
    return [n for i, n in enumerate(STATE_NAMES) if bits & (1 << i)]


def find_app(ax, pid, wait_s):
    t0 = time.time()
    while time.time() - t0 < wait_s:
        try:
            for dest, _path in ax.children(REGISTRY, ROOT):
                try:
                    if ax.pid_of(dest) == pid:
                        return dest
                except Exception:
                    pass
        except Exception:
            pass
        time.sleep(0.5)
    return None


# ------------------------------------------------------------------ the probe
# the page the document is, by the iframe element around it (its title attribute names it): which
# beacon's document.URL it should show, or the literal address
EXPECT = {
    "frame: same-origin": "same",
    "frame: same-site cross-origin": "sibling",
    "frame: cross-site": "crosssite",
    "frame: sandboxed": "sandboxed",
    "frame: nested": "nested-outer",
    "frame: nested-inner": "nested-inner",
    "frame: navigated": "moves-end",
    "frame: lag": "lag",
    "frame: about:blank": "=about:blank",
    "frame: srcdoc": "=about:srcdoc",
    "frame: data": "=data:",  # the address Firefox shows is the data: URL itself, the page cannot say it
    "frame: blob": "=blob:http://127.0.0.1:",
    "frame: refused": "=about:neterror",  # a refused connection: Firefox's error page takes the frame
}
KEEP_STATES = ("visible", "showing", "active", "focused", "defunct", "stale", "busy", "opaque")


def chain_of(nodes, i):
    """Indices from the walk's root down to node i."""
    out = []
    while i is not None:
        out.append(i)
        i = nodes[i]["up"]
    return out[::-1]


def doc_nodes(nodes):
    return [i for i, n in enumerate(nodes) if DOCUMENT in n["ifaces"]]


def walk(ax, app, start=None, budget_s=30.0):
    """Every node below `start` (default: the app's root) depth first, as dicts in tree order; `up` is the
    index of the node it was reached from. Nothing is skipped for being invisible, and nothing below a node
    that MANAGES_DESCENDANTS is entered (as Kai does not); those are counted."""
    nodes, stack, seen, t0 = [], [(start or (app, ROOT), None, 0)], set(), time.time()
    skipped = 0
    while stack and time.time() - t0 < budget_s:
        (dest, path), up, depth = stack.pop()
        if (dest, path) in seen or dest != app or path == NULL:
            continue
        seen.add((dest, path))
        try:
            role = str(ax.call(dest, path, ACCESSIBLE, "GetRoleName"))
            name = str(ax.prop(dest, path, ACCESSIBLE, "Name"))
            bits = ax.states(dest, path)
            ifaces = [str(i) for i in ax.call(dest, path, ACCESSIBLE, "GetInterfaces")]
        except Exception as e:
            nodes.append({"dest": dest, "path": path, "up": up, "depth": depth, "role": "?", "name": "", "bits": 0, "ifaces": [], "error": str(e)[:120]})
            continue
        idx = len(nodes)
        nodes.append({"dest": dest, "path": path, "up": up, "depth": depth, "role": role, "name": name, "bits": bits, "ifaces": ifaces})
        if bits & (1 << MANAGES_DESCENDANTS):
            skipped += 1
            continue
        try:
            kids = ax.children(dest, path)
        except Exception as e:
            nodes[idx]["error"] = str(e)[:120]
            continue
        for k in reversed(kids):
            stack.append((k, idx, depth + 1))
    return nodes, skipped


def kai_documents_of(ax, node):
    """Kai's documents_of(): every element up to the window (the element whose parent is the app's root)
    with the Document interface, the node included, outermost first, each as its DocURL."""
    chain, seen, at = [], set(), node
    while True:
        if at in seen:
            return {"error": "loop"}
        seen.add(at)
        try:
            parent = ax.prop(at[0], at[1], ACCESSIBLE, "Parent")
            parent = (str(parent[0]), str(parent[1]))
        except Exception as e:
            return {"error": "Parent: %s" % str(e)[:100], "partial": chain[::-1]}
        if parent[1] == ROOT and parent[0] == at[0]:
            break
        if parent[0] != at[0] or parent[1] == NULL:
            return {"error": "no longer below its window (parent %s %s)" % parent, "partial": chain[::-1]}
        try:
            ifaces = [str(i) for i in ax.call(at[0], at[1], ACCESSIBLE, "GetInterfaces")]
        except Exception as e:
            return {"error": "GetInterfaces: %s" % str(e)[:100], "partial": chain[::-1]}
        if DOCUMENT in ifaces:
            chain.append(ax.doc_url(*at))
        at = parent
    return {"urls": chain[::-1]}


def first_element_in(nodes, i):
    """Some element inside document i that is not itself a document: Kai's press path starts at an element."""
    for j in range(i + 1, len(nodes)):
        if nodes[j]["depth"] <= nodes[i]["depth"]:
            break
        if DOCUMENT not in nodes[j]["ifaces"] and nodes[j]["role"] in ("paragraph", "heading", "text", "section", "link", "button"):
            return j
    return None


def describe(ax, nodes, i, window_i, top_i, beacons):
    n = nodes[i]
    node = (n["dest"], n["path"])
    ch = chain_of(nodes, i)
    attrs, attr_err = {}, None
    try:
        attrs = {str(k): str(v) for k, v in ax.call(*node, DOCUMENT, "GetAttributes").items()}
    except Exception as e:
        attr_err = str(e)[:120]
    try:
        locale = str(ax.call(*node, DOCUMENT, "GetLocale"))
    except Exception as e:
        locale = "error: %s" % str(e)[:80]
    url, err = "", None
    try:  # Kai's call, with the error kept apart so it is visible here
        url = str(ax.call(*node, DOCUMENT, "GetAttributeValue", "DocURL"))
    except Exception as e:
        err = str(e)[:120]
    parent = nodes[ch[-2]] if len(ch) > 1 else None
    around = parent["name"] if parent and parent["role"] == "internal frame" else None
    top_level = parent is not None and parent["role"] == "internal frame" and not any(DOCUMENT in nodes[j]["ifaces"] and j != window_i for j in ch[:-1])
    label = "top level" if top_level else (around or "?")
    want = EXPECT.get(around or "")
    if top_level and top_i == i:
        want = "top-pushed"
    expected = None
    if want and want.startswith("="):
        expected = want[1:]
    elif want and want in beacons:
        expected = beacons[want]["document.URL"]
    match = None if expected is None else (url.startswith(expected) if want.startswith("=") else url == expected)
    below = ch[ch.index(window_i) + 1:] if window_i in ch else []
    j = first_element_in(nodes, i)
    return {
        "label": label,
        "name": n["name"],
        "role": n["role"],
        "docurl": url,
        "docurl_error": err,
        "expected": expected,
        "match": match,
        "attributes": attrs,
        "attributes_error": attr_err,
        "locale": locale,
        "states": [s for s in state_names(n["bits"]) if s in KEEP_STATES],
        "in_top_subtree": None if top_i is None else top_i in ch,
        "kai_visible_descent": bool(below) and all(nodes[k]["bits"] & (1 << VISIBLE) for k in below),
        "parent_chain": [(nodes[k]["role"], nodes[k]["name"][:40]) for k in ch[1:-1]],
        "documents_of": kai_documents_of(ax, (nodes[j]["dest"], nodes[j]["path"])) if j is not None else "no element inside",
        "node": "%s %s" % (n["dest"], n["path"]),
    }


def probe_tree(ax, app, beacons):
    nodes, skipped = walk(ax, app)
    docs = doc_nodes(nodes)
    window_i = None
    for i in docs:  # the window: the app's top-level child above the first document
        ch = chain_of(nodes, i)
        if len(ch) > 1:
            window_i = ch[1]
            break
    # the top document: the page-level document whose address is the served top page, however it is named now
    top_i = None
    for i in docs:
        u = ax.doc_url(nodes[i]["dest"], nodes[i]["path"])
        if urllib.parse.urlparse(u).path in ("/top.html", "/top-pushed.html") and not u.startswith("view-source:"):
            top_i = i
            break
    out = [describe(ax, nodes, i, window_i, top_i, beacons) for i in docs if i != window_i]
    window = describe(ax, nodes, window_i, window_i, top_i, beacons) if window_i is not None else None
    return {"nodes": len(nodes), "not_entered": skipped, "window_document": window, "documents": out}, nodes, top_i


def subtree_documents(ax, app, nodes, top_i):
    """The documents found by walking only below the top document (not by the whole-app walk)."""
    sub, _ = walk(ax, app, start=(nodes[top_i]["dest"], nodes[top_i]["path"]))
    return [(sub[i]["name"], ax.doc_url(sub[i]["dest"], sub[i]["path"])) for i in doc_nodes(sub) if i != 0]


def select_tab(ax, node):
    """doAction on a page tab (its action is named "switch")."""
    try:
        n = int(ax.prop(node[0], node[1], "org.a11y.atspi.Action", "NActions"))
        names = [str(ax.call(node[0], node[1], "org.a11y.atspi.Action", "GetName", i)) for i in range(n)]
        ok = bool(ax.call(node[0], node[1], "org.a11y.atspi.Action", "DoAction", 0))
        return {"actions": names, "ok": ok}
    except Exception as e:
        return {"error": str(e)[:120]}


def lag_test(ax, nodes, sites, secs=4.0, every=0.01):
    """The frame "lag" navigates to another origin when the probe says go. Poll what its iframe shows
    (DocURL, the document's name, the first paragraph's text) every 10 ms and report each change against
    the moment the server saw the request for the new page and the moment that page's script ran."""
    fr = next((n for n in nodes if n["role"] == "internal frame" and n["name"] == "frame: lag"), None)
    if fr is None:
        return {"error": "the lag frame's iframe is not in the tree"}
    where = (fr["dest"], fr["path"])
    samples, last = [], None
    sites.go = True
    t_go = time.time()
    while time.time() - t_go < secs:
        t = time.time()
        try:
            kids = ax.children(*where)
            if not kids:
                cur = ("(no document below the iframe)", "", "")
            else:
                d = kids[0]
                url = ax.doc_url(*d)
                name = str(ax.prop(*d, ACCESSIBLE, "Name"))
                text = ""
                for k in ax.children(*d):
                    try:
                        text = str(ax.call(k[0], k[1], "org.a11y.atspi.Text", "GetText", 0, -1))
                        break
                    except Exception:
                        pass
                cur = (url, name, text)
        except Exception as e:
            cur = ("(error: %s)" % str(e)[:60], "", "")
        if cur != last:
            samples.append((t, cur))
            last = cur
        time.sleep(every)
    req = next((h["t"] for h in sites.hits if h["path"] == "/frame.html" and h.get("who") == "lag-end"), None)
    beacon = next((h["t"] for h in sites.hits if h["path"] == "/beacon" and h.get("who") == "lag-end"), None)
    return {
        "request_seen": None if req is None else round((req - t_go) * 1000),
        "script_ran": None if beacon is None else round((beacon - t_go) * 1000),
        "changes_ms_after_go": [(round((t - t_go) * 1000), list(c)) for t, c in samples],
    }


def probe(addr, pid, sites, wait_s=40.0):
    """Everything about DocURL for the Firefox with this pid; the report as a dict."""
    runtime = os.environ.get("XDG_RUNTIME_DIR", "")
    if not (runtime.startswith("/tmp/kai-atspi-") and addr.startswith("unix:path=" + runtime + "/")):
        raise SystemExit("atspi_docurl: refusing: the accessibility bus %r is not a socket inside the private runtime dir %r" % (addr, runtime))
    ax = Ax(addr)
    rep = {"bus": addr, "servers": {"A": sites.pa, "B": sites.pb}}
    app = find_app(ax, pid, wait_s)
    rep["on_bus"] = app is not None
    if app is None:
        return rep
    # wait for the top page, every frame's beacon and the navigations the top page schedules
    t0 = time.time()
    want = {"top", "same", "sibling", "crosssite", "sandboxed", "nested-outer", "nested-inner", "moves-start", "lag-start", "moves-end", "top-pushed"}
    while time.time() - t0 < wait_s:
        if want <= {h.get("who") for h in sites.beacons()}:
            break
        time.sleep(0.5)
    rep["beacons_missing"] = sorted(want - {h.get("who") for h in sites.beacons()})
    time.sleep(2.0)  # the tree catches up
    beacons = {h["who"]: {"document.URL": h.get("url"), "origin": h.get("origin")} for h in sites.beacons()}
    rep["page_says"] = beacons
    first, nodes, top_i = probe_tree(ax, app, {**beacons, "lag": beacons["lag-start"]})
    rep["first_look"] = first
    rep["top_found"] = top_i is not None
    if top_i is not None:
        rep["walk_below_top_only"] = subtree_documents(ax, app, nodes, top_i)
    # Kai's ui_press lists an element only when its Action interface says NActions > 0: what does Firefox say
    # of three controls of the top page, now and for the next 3 s (every 100 ms; only the changes are kept)?
    rep["controls"] = {}
    watched = []
    for i, n in enumerate(nodes):
        if n["name"] in ("Plain link", "Plain button", "Handler button") and top_i in chain_of(nodes, i):
            watched.append((n["name"], n["role"], ACTION in n["ifaces"], (n["dest"], n["path"])))
    series = {name: [] for name, *_ in watched}
    t0 = time.time()
    while time.time() - t0 < 3.0:
        for name, _role, _has, node in watched:
            try:
                v = int(ax.prop(*node, ACTION, "NActions"))
            except Exception as e:
                v = "error: %s" % str(e)[:60]
            if not series[name] or series[name][-1][1] != v:
                series[name].append((round((time.time() - t0) * 1000), v))
        time.sleep(0.1)
    for name, role, has, node in watched:
        rep["controls"][name] = {"role": role, "action_interface": has, "NActions_changes_ms": series[name],
                                 "name_of_action_0": str(ax.call(*node, ACTION, "GetName", 0)) if series[name][-1][1] == 1 else None}
    tabs = [i for i, n in enumerate(nodes) if n["role"] == "page tab"]
    rep["tabs"] = [(nodes[i]["name"][:40], "selected" in state_names(nodes[i]["bits"])) for i in tabs]
    rep["lag"] = lag_test(ax, nodes, sites)
    beacons = {h["who"]: {"document.URL": h.get("url"), "origin": h.get("origin")} for h in sites.beacons()}
    # every other tab in turn: which documents are SHOWING, which are VISIBLE, what DocURL says of the shown one
    rep["tab_switches"] = {}
    for i in tabs:
        name = nodes[i]["name"]
        if "selected" in state_names(nodes[i]["bits"]):
            continue
        sel = select_tab(ax, (nodes[i]["dest"], nodes[i]["path"]))
        time.sleep(2.0)
        r, _n, _t = probe_tree(ax, app, beacons)
        docs = r["documents"]
        rep["tab_switches"][name] = {
            "switch": sel,
            "documents": len(docs),
            "visible": sum("visible" in d["states"] for d in docs),
            "showing": sum("showing" in d["states"] for d in docs),
            "shown_top_level": [d for d in docs if d["label"] == "top level" and "showing" in d["states"]],
        }
    # back to the first tab: the same answers a while later?
    sel = select_tab(ax, (nodes[tabs[0]]["dest"], nodes[tabs[0]]["path"])) if tabs else None
    time.sleep(2.0)
    again, _n, _t = probe_tree(ax, app, {**beacons, "lag": beacons.get("lag-end", {"document.URL": None})})
    was = {(d["label"], d["node"]): d["docurl"] for d in first["documents"]}
    rep["second_look"] = {
        "switch_back": sel,
        "documents": again["documents"],
        "docurl_changed_since_first_look": [(d["label"], was.get((d["label"], d["node"])), d["docurl"]) for d in again["documents"]
                                            if was.get((d["label"], d["node"]), d["docurl"]) != d["docurl"]],
        "top_name_first_look_vs_now": (next((d["name"] for d in first["documents"] if d["docurl"].endswith("/top-pushed.html")), None),
                                       next((d["name"] for d in again["documents"] if d["docurl"].endswith("/top-pushed.html")), None)),
    }
    rep["dbus_calls"] = ax.calls
    return rep


def table(rep):
    """The report as lines for the terminal."""
    if not rep.get("on_bus"):
        return ["Firefox is not on the private accessibility bus"]
    out = ["beacons missing: %s" % (rep["beacons_missing"] or "none"), "the pages say (document.URL):"]
    for who, b in sorted(rep["page_says"].items()):
        out.append("  %-13s %s" % (who, b["document.URL"]))

    def docs(title, r):
        out.append("%s (%d nodes walked, %d not entered)" % (title, r["nodes"], r["not_entered"]))
        w = r["window_document"]
        if w:
            out.append("  the window itself has the Document interface: DocURL=%r attributes=%s" % (w["docurl"], w["attributes"]))
        for d in r["documents"]:
            verdict = {True: "= page", False: "!= page (%r)" % d["expected"], None: "(no page value)"}[d["match"]]
            out.append("  [%s] role=%s name=%r" % (d["label"], d["role"], d["name"]))
            out.append("      DocURL=%r %s%s" % (d["docurl"], verdict, "  ERROR " + d["docurl_error"] if d["docurl_error"] else ""))
            out.append("      GetAttributes=%s locale=%r states=%s" % (d["attributes"], d["locale"], ",".join(d["states"])))
            out.append("      in the top document's subtree=%s, Kai's visible-only descent reaches it=%s" % (d["in_top_subtree"], d["kai_visible_descent"]))
            out.append("      parents: %s" % " > ".join("%s %r" % (r_, n) for r_, n in d["parent_chain"]))
            out.append("      Kai's documents_of(an element inside) = %s" % (d["documents_of"],))

    docs("documents with the first tab selected", rep["first_look"])
    out.append("top document found: %s; walking only below it finds: %s" % (rep["top_found"], rep.get("walk_below_top_only")))
    out.append("plain controls in the top document, by the raw Action interface (Kai's NActions > 0): %s" % (rep["controls"],))
    out.append("tabs: %s" % (rep["tabs"],))
    lag = rep["lag"]
    out.append("lag frame navigated at go=0 ms: request seen at %s ms, new page's script ran at %s ms; polled (DocURL, document name, text), 10 ms apart:" % (lag.get("request_seen"), lag.get("script_ran")))
    for ms, c in lag.get("changes_ms_after_go", []):
        out.append("    +%5d ms  %s" % (ms, c))
    for name, t in rep["tab_switches"].items():
        out.append("tab %r: switch %s; %d documents in the tree, %d VISIBLE, %d SHOWING" % (name, t["switch"], t["documents"], t["visible"], t["showing"]))
        for d in t["shown_top_level"]:
            out.append("    shown: role=%s name=%r DocURL=%r attributes=%s" % (d["role"], d["name"], d["docurl"], d["attributes"]))
    sl = rep["second_look"]
    out.append("first tab selected again (switch %s): %d documents; DocURL changed since the first look: %s; the top document's name then and now: %s" % (
        sl["switch_back"], len(sl["documents"]), sl["docurl_changed_since_first_look"] or "none", sl["top_name_first_look_vs_now"]))
    out.append("  of them with DocURL empty: %s; not matching what the page says: %s" % (
        [d["label"] for d in sl["documents"] if not d["docurl"]], [(d["label"], d["docurl"], d["expected"]) for d in sl["documents"] if d["match"] is False and d["expected"]]))
    return out
