import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";

export function contentType(abs) {
  const ext = path.extname(abs).toLowerCase();
  switch (ext) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
    case ".mjs":
      return "text/javascript; charset=utf-8";
    case ".wasm":
      return "application/wasm";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".ico":
      return "image/x-icon";
    default:
      return "application/octet-stream";
  }
}

/** Minimal static server for `webRoot` (GET/HEAD only, no path traversal). */
export function startWebRootServer(webRoot) {
  const root = path.resolve(webRoot);
  const server = http.createServer(async (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405).end();
      return;
    }
    try {
      const u = new URL(req.url || "/", "http://127.0.0.1");
      let pathname = decodeURIComponent(u.pathname);
      if (pathname === "/" || pathname === "") pathname = "/index.html";
      const abs = path.resolve(root, `.${pathname}`);
      const rel = path.relative(root, abs);
      if (rel.startsWith("..") || path.isAbsolute(rel)) {
        res.writeHead(403).end();
        return;
      }
      const body = await readFile(abs);
      res.setHeader("Content-Type", contentType(abs));
      if (req.method === "HEAD") {
        res.writeHead(200).end();
        return;
      }
      res.writeHead(200).end(body);
    } catch {
      res.writeHead(404).end("Not found");
    }
  });

  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      const base = `http://127.0.0.1:${port}`;
      resolve({
        base,
        close: () =>
          new Promise((r, rej) => {
            server.close((e) => (e ? rej(e) : r()));
          }),
      });
    });
    server.on("error", reject);
  });
}
