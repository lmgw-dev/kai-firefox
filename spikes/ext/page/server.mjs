// A static file server on 127.0.0.1 only (a free port), for the spike's test pages.
//   const srv = await serve(dir); srv.port; await srv.close();
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, normalize, extname } from "node:path";

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };

export async function serve(dir, { log = null } = {}) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    if (log) log({ t: Date.now(), method: req.method, path: url.pathname + url.search, host: req.headers.host });
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.(\/|$))+/, "");
    try {
      const body = await readFile(join(dir, rel === "/" ? "index.html" : rel));
      res.writeHead(200, { "content-type": TYPES[extname(rel)] || "application/octet-stream", "cache-control": "no-store" });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end("not found");
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { port: server.address().port, close: () => new Promise((r) => server.close(r)) };
}
