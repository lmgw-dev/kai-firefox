// The fixture site (tests/site/) on loopback addresses only, one port: 127.0.0.1 (and `localhost`,
// the second origin for cross-origin frames), 127.0.0.2 (a host the tests put on Firefox's
// restricted-domains list) and 127.0.0.3 (an origin only the network gate's and history.seen's
// tests visit). Besides the static files:
//   /search?q=…   the test profile's search engine: a results page naming the query
//   /long?chars=N one paragraph of N characters on one line (&ascii: ASCII letters only)
//   /slow         a page that loads until release() (or the run ends)
//   /spa          the same, and while it loads its script changes the URL (replaceState) and the
//                 fragment, as single-page apps do
//   /hang         a request that gets no answer at all until release()
//   /download     a file Firefox downloads instead of showing
//   /large, /large-frame, /big.pdf, /table   generated (tests/lib/large-page.mjs)
//   /once.pdf     prices.pdf, cacheable, to the first request; every later one hangs like /hang
//   /moved.pdf    prices.pdf to the first request; every later one is redirected to /prices.pdf
//   /r307?to=P    a 307 redirect to path P, for any method (a POST stays a POST)
//   /frames-source  a page whose HTML names frames of the other origin (localhost) by its port
//   /accept/search?q=…, /accept/product?id=…   the acceptance runs' store (tests/accept/): its
//                 search's results, each a product page, from CATALOG; a POST to /accept/order
//                 (logged as every write) answers a confirmation that links to the other
//                 origin's store (the partner shop)
//   any POST, PUT, PATCH or DELETE: logged with its body (`log`), answered 200: JSON under /api/,
//                 else a page "Received <method> <path>"
// Files named cached-* are served cacheable, so Back and Forward restore them from Firefox's
// back-forward cache; everything else is no-store.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, normalize, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { largePage, largeFrame, bigPdf, largeTable } from "./large-page.mjs";

const SITE = join(dirname(fileURLToPath(import.meta.url)), "..", "site");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".pdf": "application/pdf", ".json": "application/json" };
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// The acceptance runs' store (tests/site/accept/store.html shows the same lamps).
export const CATALOG = [
  { id: "trail-lamp", name: "Trail Lamp", tags: ["lamp", "trail"], text: "A clip-on lamp for the trail, 120 lumens.", price: "29 €" },
  { id: "lantern-classic", name: "Lantern Classic", tags: ["lamp", "lantern"], text: "A warm lantern for the camp table.", price: "45 €" },
  { id: "headlamp-pro", name: "Headlamp Pro", tags: ["lamp", "headlamp"], text: "A headlamp with a red night mode and a tilting beam, 450 lumens.", price: "59 €" },
  { id: "desk-lamp-mini", name: "Desk Lamp Mini", tags: ["lamp", "desk"], text: "A folding desk lamp that charges over USB.", price: "19 €" },
  { id: "ridge-tent", name: "Ridge Tent", tags: ["tent"], text: "Two people, three seasons.", price: "189 €" },
];
const storeHead = (title) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title></head><body>` +
  `<header><p>Northwind Outdoor, store.example</p><nav aria-label="Main"><a href="/accept/store.html">Store</a> <a href="/help.html">Help</a></nav></header>`;

export async function serveSite() {
  let port = 0;
  const slow = new Set();
  const hung = new Set();
  const log = [];
  let onceServed = false;
  let movedServed = false;
  const handler = async (req, res) => {
    const url = new URL(req.url, "http://x");
    const entry = { method: req.method, host: req.headers.host, path: url.pathname + url.search };
    log.push(entry);
    if (url.pathname === "/r307") {
      await new Promise((r) => req.resume().on("end", r));
      res.writeHead(307, { location: url.searchParams.get("to") || "/", "cache-control": "no-store" });
      res.end();
      return;
    }
    if (!["GET", "HEAD"].includes(req.method)) {
      const parts = [];
      for await (const c of req) parts.push(c);
      entry.body = Buffer.concat(parts).toString("utf8");
      entry.type = req.headers["content-type"] ?? null;
      if (url.pathname === "/accept/order") {
        const other = `http://${(req.headers.host || "").startsWith("127.0.0.1") ? "localhost" : "127.0.0.1"}:${port}`;
        res.writeHead(200, { "content-type": TYPES[".html"], "cache-control": "no-store" });
        res.end(storeHead("Order received: Northwind Outdoor") + `<main><h1>Thank you</h1><p>Your order is on its way.</p><p><a href="${other}/accept/store.html">Visit our partner shop</a></p></main></body></html>`);
        return;
      }
      if (url.pathname.startsWith("/api/")) {
        res.writeHead(200, { "content-type": TYPES[".json"], "cache-control": "no-store" });
        res.end(JSON.stringify({ ok: true }));
      } else {
        res.writeHead(200, { "content-type": TYPES[".html"], "cache-control": "no-store" });
        res.end(`<!doctype html><title>Received</title><p>Received ${esc(req.method)} ${esc(url.pathname)}</p>`);
      }
      return;
    }
    if (url.pathname === "/frames-source") {
      const other = `http://localhost:${port}`;
      res.writeHead(200, { "content-type": TYPES[".html"], "cache-control": "no-store" });
      res.end(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Partners: Northwind Gear</title></head>
<body>
<h1>Partners</h1>
<!-- <iframe src="${other}/commented-out.html"></iframe> -->
<iframe title="Consent" src="${other}/consent.html?site=shop&amp;v=2"></iframe>
<object data="help.html" type="text/html" title="Help"></object>
<iframe title="Spelled out" src='&#104;ttp://localhost:${port}/help.html'></iframe>
<script>const later = '<iframe src="${other}/in-script.html">';</script>
</body></html>`);
      return;
    }
    if (url.pathname === "/search") {
      const q = url.searchParams.get("q") || "";
      res.writeHead(200, { "content-type": TYPES[".html"] });
      res.end(`<!doctype html><title>Results for ${esc(q)}</title><h1>Results for ${esc(q)}</h1><ol><li><a href="/shop.html">Trail Lamp</a></li></ol>`);
      return;
    }
    if (url.pathname === "/accept/search") {
      const q = (url.searchParams.get("q") || "").trim().toLowerCase();
      const hits = q ? CATALOG.filter((p) => p.tags.some((t) => t.includes(q) || q.includes(t)) || p.name.toLowerCase().includes(q)) : [];
      res.writeHead(200, { "content-type": TYPES[".html"], "cache-control": "no-store" });
      res.end(
        storeHead(`Results for ${url.searchParams.get("q") || ""}`) +
          `<main><h1>Results for ${esc(url.searchParams.get("q") || "")}</h1><p>${hits.length} products</p><ol id="results">` +
          hits.map((p) => `<li><a href="/accept/product?id=${p.id}">${esc(p.name)}</a> ${esc(p.text)}</li>`).join("") +
          `</ol></main></body></html>`,
      );
      return;
    }
    if (url.pathname === "/accept/product") {
      const p = CATALOG.find((x) => x.id === url.searchParams.get("id"));
      res.writeHead(p ? 200 : 404, { "content-type": TYPES[".html"], "cache-control": "no-store" });
      res.end(
        p
          ? storeHead(`${p.name}: Northwind Outdoor`) +
              `<main><h1>${esc(p.name)}</h1><p id="text">${esc(p.text)}</p><p id="price">Price: ${esc(p.price)}</p>` +
              `<p><button type="button">Add to cart</button> <a href="/accept/order.html?item=${p.id}">Order now</a></p></main></body></html>`
          : storeHead("Not found") + "<p>No such product.</p></body></html>",
      );
      return;
    }
    if (url.pathname === "/long") {
      const n = Number(url.searchParams.get("chars") || 1000);
      const unit = url.searchParams.has("ascii") ? "abcdefghij" : "Long line ä€😀 \"quoted\" \\ ";
      const text = unit.repeat(Math.ceil(n / unit.length)).slice(0, n);
      res.writeHead(200, { "content-type": TYPES[".html"] });
      res.end(`<!doctype html><title>Long line</title><p id="long">${esc(text)}</p><p>Second line.</p>`);
      return;
    }
    if (url.pathname === "/large" || url.pathname === "/large-frame") {
      const groups = Number(url.searchParams.get("groups") || 500);
      res.writeHead(200, { "content-type": TYPES[".html"], "cache-control": "no-store" });
      res.end(url.pathname === "/large" ? largePage(groups, port) : largeFrame(groups, url.searchParams.get("p") || ""));
      return;
    }
    if (url.pathname === "/table") {
      res.writeHead(200, { "content-type": TYPES[".html"], "cache-control": "no-store" });
      res.end(largeTable(Number(url.searchParams.get("rows") || 1000), Number(url.searchParams.get("cols") || 8)));
      return;
    }
    if (url.pathname === "/once.pdf") {
      if (onceServed) {
        hung.add(res);
        res.on("close", () => hung.delete(res));
        return;
      }
      onceServed = true;
      res.writeHead(200, { "content-type": TYPES[".pdf"], "cache-control": "max-age=3600" });
      res.end(await readFile(join(SITE, "prices.pdf")));
      return;
    }
    if (url.pathname === "/moved.pdf") {
      if (movedServed) {
        res.writeHead(302, { location: "/prices.pdf", "cache-control": "no-store" });
        res.end();
        return;
      }
      movedServed = true;
      res.writeHead(200, { "content-type": TYPES[".pdf"], "cache-control": "no-store" });
      res.end(await readFile(join(SITE, "prices.pdf")));
      return;
    }
    if (url.pathname === "/big.pdf") {
      res.writeHead(200, { "content-type": TYPES[".pdf"], "cache-control": "no-store" });
      res.end(bigPdf());
      return;
    }
    if (url.pathname === "/download") {
      res.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": 'attachment; filename="price-list.txt"' });
      res.end("Trail Lamp 29\n");
      return;
    }
    if (url.pathname === "/slow" || url.pathname === "/spa") {
      res.writeHead(200, { "content-type": TYPES[".html"], "cache-control": "no-store" });
      if (url.pathname === "/spa") res.write(`<!doctype html><title>Single page</title><script>history.replaceState(null, "", "/spa?view=list"); location.hash = "top";</script><p>Loading`);
      else res.write("<!doctype html><title>Slow</title><p>Loading");
      slow.add(res);
      res.on("close", () => slow.delete(res));
      return;
    }
    if (url.pathname === "/hang") {
      hung.add(res);
      res.on("close", () => hung.delete(res));
      return;
    }
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.(\/|$))+/, "");
    try {
      const body = await readFile(join(SITE, rel === "/" ? "shop.html" : rel));
      const cache = /^\/?cached-/.test(rel) ? "max-age=3600" : "no-store";
      res.writeHead(200, { "content-type": TYPES[extname(rel)] || "application/octet-stream", "cache-control": cache });
      res.end(body);
    } catch {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    }
  };
  const a = createServer(handler);
  await new Promise((r) => a.listen(0, "127.0.0.1", r));
  port = a.address().port;
  const b = createServer(handler);
  await new Promise((r) => b.listen(port, "127.0.0.2", r));
  const c = createServer(handler);
  await new Promise((r) => c.listen(port, "127.0.0.3", r));
  return {
    port,
    url: (path, host = "127.0.0.1") => `http://${host}:${port}/${path.replace(/^\//, "")}`,
    log,
    slowOpen: () => slow.size,
    hungOpen: () => hung.size,
    release() {
      for (const r of slow) r.end("ed.</p>");
      slow.clear();
      for (const r of hung) {
        r.writeHead(200, { "content-type": TYPES[".html"], "cache-control": "no-store" });
        r.end("<!doctype html><title>Arrived</title><p>Arrived.</p>");
      }
      hung.clear();
    },
    async close() {
      this.release();
      for (const srv of [a, b, c]) srv.closeAllConnections();
      await Promise.all([a, b, c].map((srv) => new Promise((r) => srv.close(r))));
    },
  };
}
