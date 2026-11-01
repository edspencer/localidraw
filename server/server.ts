// The HTTP server: the built page, the canvas API, and server-sent events when canvases change on disk.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, readdirSync, readFileSync, statSync, watch, type Dirent, type FSWatcher } from "node:fs";
import { join, resolve, sep } from "node:path";
import { contentHash, EMPTY_SCENE, LIBRARY_FILE, listProjects, moveToTrash, parseCanvas, parseLibrary, relativePath, renameNoReplace, resolveInRoot, resolveInTrash, SKIPPED_DIRS, writeAtomic } from "./files.ts";
import { pkg } from "./package.ts";
import { guard, isLoopbackAddress } from "./security.ts";
import { send, staticFiles } from "./static.ts";

export type Options = {
  root: string;
  port: number;
  webDir: string;
  /** The address to listen on (default 127.0.0.1). Anything but loopback needs `allowedHosts`. */
  host?: string;
  /** Host names to answer to besides loopback, normalised (parseAllowedHost in security.ts). */
  allowedHosts?: string[];
  /** Look for changes by checking the files every `poll` ms, instead of by file events (for network mounts). */
  poll?: number;
};
export type Running = { server: Server; url: string; close: () => Promise<void> };

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_POLL = 2000;

const MAX_BODY = 64 * 1024 * 1024; // a canvas with embedded images can be large; this only bounds a runaway request

function json(req: IncomingMessage, res: ServerResponse, status: number, body: unknown) {
  return send(req, res, status, { "content-type": "application/json", "cache-control": "no-store" }, Buffer.from(JSON.stringify(body)));
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

/** A canvas path as the page may give it, with or without the .excalidraw. */
const withExtension = (wanted: unknown) =>
  typeof wanted === "string" && !wanted.trim().endsWith(".excalidraw") ? `${wanted.trim()}.excalidraw` : typeof wanted === "string" ? wanted.trim() : wanted;

const skipped = (rel: string) => rel.split("/").some((p) => p.startsWith(".") || SKIPPED_DIRS.has(p));

/**
 * Calls `changed` with the root-relative path of whatever changes under the root, until it's closed.
 *
 * On macOS and Windows that's one recursive watch. On Linux it's a watch on each folder, as folders come and go:
 * Node's recursive watch there follows each file, so it goes deaf to a file once another is renamed over it, which
 * is how Localidraw saves (writeAtomic) and how many editors and agents do. A folder's own watch reports its entries
 * by name, whatever is renamed over them. It also skips dot-folders and node_modules instead of walking them.
 */
function watchTree(root: string, changed: (rel: string) => void): { close: () => void } {
  if (process.platform !== "linux") {
    const w = watch(root, { recursive: true }, (_type, name) => { if (name) changed(name.split(sep).join("/")); });
    return { close: () => w.close() };
  }
  const watchers = new Map<string, FSWatcher>(); // by root-relative folder, "" for the root
  const unwatch = (dir: string) => {
    for (const [d, w] of watchers) if (dir === "" || d === dir || d.startsWith(`${dir}/`)) { w.close(); watchers.delete(d); }
  };
  const add = (dir: string) => {
    if (watchers.has(dir)) return;
    const abs = join(root, dir);
    let w: FSWatcher;
    try {
      w = watch(abs, (_type, name) => {
        if (!name) return;
        const rel = dir ? `${dir}/${name}` : name;
        if (!skipped(rel)) {
          // A folder that came is watched from now on; one that went stops being watched.
          let isDir = false;
          try { isDir = statSync(join(root, rel)).isDirectory(); } catch {}
          if (isDir) add(rel); else if (watchers.has(rel)) unwatch(rel);
        }
        changed(rel);
      });
    } catch {
      return; // gone already, or unreadable
    }
    w.on("error", () => unwatch(dir));
    watchers.set(dir, w);
    let entries: Dirent[] = [];
    try { entries = readdirSync(abs, { withFileTypes: true }); } catch {}
    for (const e of entries) {
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (e.isDirectory() && !skipped(rel)) add(rel);
    }
  };
  add("");
  return { close: () => unwatch("") };
}

/**
 * Calls `changed` like watchTree, but by looking: every `interval` ms it lists the folders and canvases under the root
 * and compares each canvas's (and the Library's) size, modification time and inode with the last look. For network mounts (NFS, SMB),
 * where the file events for another machine's writes never arrive.
 */
function pollTree(root: string, interval: number, changed: (rel: string) => void): { close: () => void } {
  const look = () => {
    const seen = new Map<string, string>(); // root-relative path → a stamp; folders end in "/"
    const walk = (dir: string) => {
      let entries: Dirent[];
      try { entries = readdirSync(join(root, dir), { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const rel = dir ? `${dir}/${e.name}` : e.name;
        if (skipped(rel)) continue;
        if (e.isDirectory()) { seen.set(`${rel}/`, ""); walk(rel); }
        else if (e.name.endsWith(".excalidraw") || rel === LIBRARY_FILE) {
          try {
            const s = statSync(join(root, rel));
            seen.set(rel, `${s.size}:${s.mtimeMs}:${s.ino}`);
          } catch {} // gone since the listing
        }
      }
    };
    walk("");
    return seen;
  };
  let last = look();
  let timer: NodeJS.Timeout;
  const tick = () => {
    const now = look();
    for (const [rel, stamp] of now) if (last.get(rel) !== stamp) changed(rel.replace(/\/$/, ""));
    for (const rel of last.keys()) if (!now.has(rel)) changed(rel.replace(/\/$/, ""));
    last = now;
    timer = setTimeout(tick, interval); // after the look, so a slow mount never has two at once
  };
  timer = setTimeout(tick, interval);
  return { close: () => clearTimeout(timer) };
}

/** Tells the pages the Library file changed: its new hash, or null once it's gone. Half-written, it waits for the rest. */
function announceLibrary(root: string, announce: (event: object) => void) {
  const abs = join(root, LIBRARY_FILE);
  if (!existsSync(abs)) return announce({ type: "library", path: LIBRARY_FILE, hash: null });
  const content = readFileSync(abs, "utf8");
  try { parseLibrary(content); } catch { return; }
  announce({ type: "library", path: LIBRARY_FILE, hash: contentHash(content) });
}

/** Watches the root for canvas changes and tells every connected page, debounced per file. */
function watchCanvases(root: string, poll: number | undefined, announce: (event: object) => void): { close: () => void } {
  const pending = new Map<string, NodeJS.Timeout>();
  const changed = (rel: string) => {
    if (skipped(rel)) return;
    clearTimeout(pending.get(rel));
    pending.set(rel, setTimeout(() => {
      pending.delete(rel);
      if (rel === LIBRARY_FILE) return announceLibrary(root, announce);
      if (!rel.endsWith(".excalidraw")) return announce({ type: "projects" }); // a folder came or went
      const abs = resolve(root, rel);
      if (!existsSync(abs)) return announce({ type: "projects" });
      const content = readFileSync(abs, "utf8");
      try {
        parseCanvas(content);
      } catch {
        // Caught mid-write by a tool that doesn't write atomically (its next event follows), or not a scene at all.
        return announce({ type: "projects" });
      }
      announce({ type: "changed", path: rel, hash: contentHash(content) });
      announce({ type: "projects" });
    }, 120));
  };
  return poll ? pollTree(root, poll, changed) : watchTree(root, changed);
}

export function startServer({ root, port, webDir, host = DEFAULT_HOST, allowedHosts = [], poll }: Options): Promise<Running> {
  if (!isLoopbackAddress(host) && allowedHosts.length === 0) {
    // Without one, every request would be refused anyway; this says why, before anything listens.
    return Promise.reject(new Error(`listening on ${host} needs at least one allowed host name (--allowed-host)`));
  }
  const clients = new Set<ServerResponse>();
  const announce = (event: object) => { for (const c of clients) c.write(`data: ${JSON.stringify(event)}\n\n`); };
  const watcher = watchCanvases(root, poll, announce);
  const serveStatic = staticFiles(resolve(webDir));

  const server = createServer(async (req, res) => {
    if (!guard(req, res, allowedHosts)) return;
    // Not `new URL(req.url, base)`: a path starting `//` would be read as a host, and throw.
    let url: URL;
    try { url = new URL(`http://localhost${req.url ?? "/"}`); } catch { return res.writeHead(400).end(); }
    const path = url.pathname;
    const read = req.method === "GET" || req.method === "HEAD"; // Node leaves out the body for a HEAD
    try {
      if (read && path === "/") return await serveStatic(req, res, "index.html");
      if (read && path.startsWith("/static/")) return await serveStatic(req, res, path.slice("/static/".length));
      if (read && path === "/api/health") return await json(req, res, 200, { ok: true, version: pkg.version });
      if (req.method === "GET" && path === "/api/projects") return await json(req, res, 200, { root, projects: listProjects(root) });
      if (req.method === "GET" && path === "/api/events") {
        // Never compressed, and `x-accel-buffering: no`, so a proxy passes each event on as it comes.
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" });
        res.write(": connected\n\n");
        clients.add(res);
        const beat = setInterval(() => res.write(": beat\n\n"), 25_000);
        req.on("close", () => { clearInterval(beat); clients.delete(res); });
        return;
      }
      if (path === "/api/canvas") {
        const abs = resolveInRoot(root, url.searchParams.get("path"), "file");
        if (!abs) return json(req, res, 400, { error: "That isn't a .excalidraw path inside the folder." });
        // 422: the file is there, but it isn't a scene to open or merge.
        const loaded = (content: string, status: number) => {
          try {
            return json(req, res, status, { hash: contentHash(content), scene: parseCanvas(content) });
          } catch (err) {
            return json(req, res, 422, { error: (err as Error).message });
          }
        };
        if (req.method === "GET") {
          if (!existsSync(abs)) return json(req, res, 404, { error: "There's no canvas at that path." });
          return loaded(readFileSync(abs, "utf8"), 200);
        }
        if (req.method === "PUT") {
          // The page says which version it edited (x-base-hash). If the file has moved on since, it gets the new
          // version back (409) and merges before saving again, so nothing written on disk is ever lost.
          const current = existsSync(abs) ? readFileSync(abs, "utf8") : undefined;
          if (current !== undefined && req.headers["x-base-hash"] !== contentHash(current)) return loaded(current, 409);
          const content = await readBody(req);
          JSON.parse(content);
          writeAtomic(abs, content.endsWith("\n") ? content : `${content}\n`);
          return json(req, res, 200, { hash: contentHash(readFileSync(abs, "utf8")) });
        }
      }
      if (path === "/api/library") {
        // The folder's own Library, when it has one. Never created here: the user makes the file to share one.
        const abs = join(root, LIBRARY_FILE);
        const current = existsSync(abs) ? readFileSync(abs, "utf8") : undefined;
        const loaded = (content: string, status: number) => {
          try {
            return json(req, res, status, { shared: true, hash: contentHash(content), library: parseLibrary(content) });
          } catch (err) {
            return json(req, res, 422, { error: (err as Error).message });
          }
        };
        if (req.method === "GET") return current === undefined ? json(req, res, 200, { shared: false }) : loaded(current, 200);
        if (req.method === "PUT") {
          if (current === undefined) return json(req, res, 404, { error: `There's no ${LIBRARY_FILE} in the folder.` });
          // As for a canvas: a save based on an older version gets the newer one back to merge.
          if (req.headers["x-base-hash"] !== contentHash(current)) return loaded(current, 409);
          const content = await readBody(req);
          try { parseLibrary(content); } catch (err) { return json(req, res, 400, { error: (err as Error).message }); }
          writeAtomic(abs, content.endsWith("\n") ? content : `${content}\n`);
          return json(req, res, 200, { hash: contentHash(readFileSync(abs, "utf8")) });
        }
      }
      if (req.method === "POST" && path === "/api/canvases") {
        const { path: wanted } = JSON.parse(await readBody(req));
        const abs = resolveInRoot(root, withExtension(wanted), "file");
        if (!abs) return json(req, res, 400, { error: "That isn't a path inside the folder." });
        if (existsSync(abs)) return json(req, res, 409, { error: "There's already a canvas there." });
        writeAtomic(abs, `${JSON.stringify(EMPTY_SCENE, null, 2)}\n`);
        return json(req, res, 201, { path: relativePath(root, abs) });
      }
      // Renaming, moving and deleting from the sidebar. A rename never replaces a file, and a delete is a move into the
      // trash (.localidraw/trash), never an unlink, so it can be undone.
      if (req.method === "POST" && path === "/api/canvases/move") {
        const { from, to } = JSON.parse(await readBody(req));
        const src = resolveInRoot(root, from, "file"), dest = resolveInRoot(root, withExtension(to), "file");
        if (!src || !dest) return json(req, res, 400, { error: "That isn't a path inside the folder." });
        if (!existsSync(src)) return json(req, res, 404, { error: "There's no canvas at that path." });
        if (src === dest) return json(req, res, 200, { path: relativePath(root, dest) });
        try {
          renameNoReplace(src, dest);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "EEXIST") return json(req, res, 409, { error: "There's already a canvas there." });
          throw err;
        }
        return json(req, res, 200, { path: relativePath(root, dest) });
      }
      if (req.method === "POST" && path === "/api/canvases/trash") {
        const { path: rel } = JSON.parse(await readBody(req));
        const abs = resolveInRoot(root, rel, "file");
        if (!abs) return json(req, res, 400, { error: "That isn't a path inside the folder." });
        if (!existsSync(abs)) return json(req, res, 404, { error: "There's no canvas at that path." });
        return json(req, res, 200, { trashed: moveToTrash(root, abs) });
      }
      if (req.method === "POST" && path === "/api/canvases/restore") {
        const { trashed, path: rel } = JSON.parse(await readBody(req));
        const src = resolveInTrash(root, trashed), dest = resolveInRoot(root, rel, "file");
        if (!src || !dest) return json(req, res, 400, { error: "That isn't a canvas in the trash, or a path inside the folder." });
        if (!existsSync(src)) return json(req, res, 404, { error: "It isn't in the trash any more." });
        try {
          renameNoReplace(src, dest);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "EEXIST") return json(req, res, 409, { error: "There's a canvas at its old path now." });
          throw err;
        }
        return json(req, res, 200, { path: relativePath(root, dest) });
      }
      return json(req, res, 404, { error: "Not found." });
    } catch (err) {
      return json(req, res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  return new Promise((ok, fail) => {
    server.once("error", fail);
    server.listen(port, host.replace(/^\[(.*)\]$/, "$1"), () => {
      const address = server.address();
      const actual = typeof address === "object" && address ? address.port : port;
      // Loopback, or every address (0.0.0.0, ::), is reachable as localhost; one particular address only as itself.
      const local = isLoopbackAddress(host) || host === "0.0.0.0" || host === "::" || host === "[::]";
      const at = local ? "localhost" : host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
      ok({
        server,
        url: `http://${at}:${actual}/`,
        close: () => new Promise((done) => {
          watcher.close();
          for (const c of clients) c.end();
          server.close(() => done());
          // A page's EventSource reconnects at once, and can do it over a kept-alive connection the server still has
          // open, which would hold close() up for good; so drop every connection rather than wait for them.
          server.closeAllConnections();
        }),
      });
    });
  });
}
