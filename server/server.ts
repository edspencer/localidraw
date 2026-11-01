// The HTTP server: the built page, the canvas API, and server-sent events when canvases change on disk.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, readFileSync, statSync, watch, type FSWatcher } from "node:fs";
import { extname, resolve, sep } from "node:path";
import { contentHash, EMPTY_SCENE, listProjects, relativePath, resolveInRoot, SKIPPED_DIRS, writeAtomic } from "./files.ts";
import { localOnly } from "./security.ts";

export type Options = { root: string; port: number; webDir: string };
export type Running = { server: Server; url: string; close: () => Promise<void> };

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2",
  ".ttf": "font/ttf", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json",
};
const MAX_BODY = 64 * 1024 * 1024; // a canvas with embedded images can be large; this only bounds a runaway request

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((ok, fail) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) { fail(new Error("request too large")); req.destroy(); } else chunks.push(c);
    });
    req.on("end", () => ok(Buffer.concat(chunks).toString("utf8")));
    req.on("error", fail);
  });
}

function sendStatic(res: ServerResponse, base: string, rel: string) {
  const abs = resolve(base, decodeURIComponent(rel));
  if (!abs.startsWith(base + sep) || !existsSync(abs) || !statSync(abs).isFile()) return res.writeHead(404).end();
  res.writeHead(200, { "content-type": TYPES[extname(abs)] ?? "application/octet-stream" }).end(readFileSync(abs));
}

/** Watches the root for canvas changes and tells every connected page, debounced per file. */
function watchCanvases(root: string, send: (event: object) => void): FSWatcher {
  const pending = new Map<string, NodeJS.Timeout>();
  return watch(root, { recursive: true }, (_type, name) => {
    if (!name) return;
    const rel = name.split(sep).join("/");
    if (rel.split("/").some((p) => p.startsWith(".") || SKIPPED_DIRS.has(p))) return;
    clearTimeout(pending.get(rel));
    pending.set(rel, setTimeout(() => {
      pending.delete(rel);
      if (!rel.endsWith(".excalidraw")) return send({ type: "projects" }); // a folder came or went
      const abs = resolve(root, rel);
      if (!existsSync(abs)) return send({ type: "projects" });
      const content = readFileSync(abs, "utf8");
      try {
        JSON.parse(content);
      } catch {
        return; // caught mid-write by a tool that doesn't write atomically; its next event follows
      }
      send({ type: "changed", path: rel, hash: contentHash(content) });
      send({ type: "projects" });
    }, 120));
  });
}

export function startServer({ root, port, webDir }: Options): Promise<Running> {
  const clients = new Set<ServerResponse>();
  const send = (event: object) => { for (const c of clients) c.write(`data: ${JSON.stringify(event)}\n\n`); };
  const watcher = watchCanvases(root, send);
  const index = readFileSync(resolve(webDir, "index.html"), "utf8");

  const server = createServer(async (req, res) => {
    if (!localOnly(req, res)) return;
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    try {
      if (req.method === "GET" && path === "/") return res.writeHead(200, { "content-type": TYPES[".html"] }).end(index);
      if (req.method === "GET" && path.startsWith("/static/")) return sendStatic(res, webDir, path.slice("/static/".length));
      if (req.method === "GET" && path === "/api/projects") return json(res, 200, { root, projects: listProjects(root) });
      if (req.method === "GET" && path === "/api/events") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        res.write(": connected\n\n");
        clients.add(res);
        const beat = setInterval(() => res.write(": beat\n\n"), 25_000);
        req.on("close", () => { clearInterval(beat); clients.delete(res); });
        return;
      }
      if (path === "/api/canvas") {
        const abs = resolveInRoot(root, url.searchParams.get("path"), "file");
        if (!abs) return json(res, 400, { error: "That isn't a .excalidraw path inside the folder." });
        if (req.method === "GET") {
          if (!existsSync(abs)) return json(res, 404, { error: "No such canvas." });
          const content = readFileSync(abs, "utf8");
          return json(res, 200, { hash: contentHash(content), scene: JSON.parse(content) });
        }
        if (req.method === "PUT") {
          // The page says which version it edited (x-base-hash). If the file has moved on since, it gets the new
          // version back (409) and merges before saving again, so nothing written on disk is ever lost.
          const current = existsSync(abs) ? readFileSync(abs, "utf8") : undefined;
          if (current !== undefined && req.headers["x-base-hash"] !== contentHash(current)) {
            return json(res, 409, { hash: contentHash(current), scene: JSON.parse(current) });
          }
          const content = await readBody(req);
          JSON.parse(content);
          writeAtomic(abs, content.endsWith("\n") ? content : `${content}\n`);
          return json(res, 200, { hash: contentHash(readFileSync(abs, "utf8")) });
        }
      }
      if (req.method === "POST" && path === "/api/canvases") {
        const { path: wanted } = JSON.parse(await readBody(req));
        const withExt = typeof wanted === "string" && !wanted.endsWith(".excalidraw") ? `${wanted.trim()}.excalidraw` : wanted;
        const abs = resolveInRoot(root, withExt, "file");
        if (!abs) return json(res, 400, { error: "That isn't a path inside the folder." });
        if (existsSync(abs)) return json(res, 409, { error: "There's already a canvas there." });
        writeAtomic(abs, `${JSON.stringify(EMPTY_SCENE, null, 2)}\n`);
        return json(res, 201, { path: relativePath(root, abs) });
      }
      return json(res, 404, { error: "Not found." });
    } catch (err) {
      return json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  return new Promise((ok, fail) => {
    server.once("error", fail);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const actual = typeof address === "object" && address ? address.port : port;
      ok({
        server,
        url: `http://localhost:${actual}/`,
        close: () => new Promise((done) => {
          watcher.close();
          for (const c of clients) c.end();
          server.close(() => done());
        }),
      });
    });
  });
}
