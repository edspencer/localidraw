// The HTTP server: the built page, the canvas API, and server-sent events when canvases change on disk.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, readdirSync, readFileSync, statSync, watch, type Dirent, type FSWatcher } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { contentHash, EMPTY_SCENE, LIBRARY_FILE, listProjects, moveToTrash, parseCanvas, parseLibrary, relativePath, renameNoReplace, resolveInRoot, resolveInTrash, SKIPPED_DIRS, writeAtomic } from "./files.ts";
import { configPath, isThere, readConfig, SCRATCH, scratchDir } from "./folders.ts";
import { pkg } from "./package.ts";
import { guard, isLoopbackAddress } from "./security.ts";
import { send, staticFiles } from "./static.ts";

export type Options = {
  /** The one folder it serves (`localidraw <folder>`, the image): canvas paths are relative to it. */
  root?: string;
  /**
   * Or, instead, Localidraw's home (`~/.localidraw`): it serves Scratch (`drawings/`) and the folders listed in its
   * `config.json`, which it watches, and canvas paths start with the folder's name (`notes/flow.excalidraw`).
   */
  home?: string;
  port: number;
  webDir: string;
  /** The address to listen on (default 127.0.0.1). Anything but loopback needs `allowedHosts`. */
  host?: string;
  /** Host names to answer to besides loopback, normalised (parseAllowedHost in security.ts). */
  allowedHosts?: string[];
  /** Look for changes by checking the files every `poll` ms, instead of by file events (for network mounts). */
  poll?: number;
};
export type Running = {
  server: Server;
  url: string;
  /** Stops at once: every connection is dropped, a request half-answered included. */
  close: () => Promise<void>;
  /**
   * Stops gracefully, for SIGTERM and Ctrl-C: it stops listening, answers 503 to any new request on a connection that's
   * still open, ends the event streams, and waits for the requests under way (a save, mid-`writeAtomic`) to finish.
   * Resolves with how many it had to cut off after `timeoutMs`; 0 means every one finished.
   */
  drain: (timeoutMs: number, waiting?: (count: number) => void) => Promise<number>;
  /** The writes under way, as `/api/busy` counts them. */
  busy: () => BusyCounts;
};

/**
 * What `/api/busy` counts (the CLI contract's SPEC §4): the writes a restart would cut short. `canvas` is a save, or a
 * new canvas, a rename, a move, a delete or an undo of one, from the request's start to its answer; `library` is a
 * save of the folder's Library file. An open page isn't counted: it saves again once the server is back
 * (e2e/restart.spec.ts).
 */
export type BusyCounts = { canvas: number; library: number };

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

/** The base hash of a save that puts back a canvas that's gone. */
const NO_FILE = "none";

const skipped = (rel: string) => rel.split("/").some((p) => p.startsWith(".") || SKIPPED_DIRS.has(p));

/**
 * Calls `changed` with the root-relative path of whatever changes under the root, until it's closed.
 *
 * On macOS and Windows that's one recursive watch. On Linux it's a watch on each folder, as folders come and go:
 * Node's recursive watch there follows each file, so it goes deaf to a file once another is renamed over it, which
 * is how Localidraw saves (writeAtomic) and how many editors and agents do. A folder's own watch reports its entries
 * by name, whatever is renamed over them. It also skips dot-folders and node_modules instead of walking them. Folders
 * without canvases are watched too, so a canvas made in one is seen.
 */
type Watch = { close: () => void; /** False once the folder's own watch has ended (the folder went). */ alive: () => boolean };

function watchTree(root: string, changed: (rel: string) => void, again = false): Watch {
  if (process.platform !== "linux") {
    let w: FSWatcher;
    try {
      w = watch(root, { recursive: true }, (_type, name) => { if (name) changed(name.split(sep).join("/")); });
    } catch {
      return { close: () => {}, alive: () => false }; // gone already: the folder's check watches it again once it's back
    }
    let ok = true;
    w.on("error", () => { ok = false; w.close(); }); // the folder went (an unmounted drive): as above
    if (again) announceAll(root, changed);
    return { close: () => w.close(), alive: () => ok };
  }
  const watchers = new Map<string, FSWatcher>(); // by root-relative folder, "" for the root
  let warned = false;
  const unwatch = (dir: string) => {
    for (const [d, w] of watchers) if (dir === "" || d === dir || d.startsWith(`${dir}/`)) { w.close(); watchers.delete(d); }
  };
  // A folder that arrives with files already in it (a `git mv` into a new folder, a checkout) had them before its watch
  // began, so those are announced as it's added; at the start, nothing is.
  const add = (dir: string, arrived = false) => {
    if (watchers.has(dir)) return;
    const abs = join(root, dir);
    let w: FSWatcher;
    try {
      w = watch(abs, (_type, name) => {
        if (!name) return;
        // The folder itself went (deleted, or its drive unmounted): inotify's watch on it has ended, and Node says so
        // only as a "rename" of the folder's own name. Stop, so the folder's check watches it again once it's back. (A
        // folder holding one of its own name gets watched again for nothing, which does no harm.)
        if (dir === "" && name === basename(root) && !isThere(join(root, name))) return unwatch("");
        const rel = dir ? `${dir}/${name}` : name;
        if (!skipped(rel)) {
          // A folder that came is watched from now on; one that went stops being watched.
          let isDir = false;
          try { isDir = statSync(join(root, rel)).isDirectory(); } catch {}
          if (isDir) add(rel, true); else if (watchers.has(rel)) unwatch(rel);
        }
        changed(rel);
      });
    } catch (err) {
      // Each folder costs an inotify watch, and they're limited per user (fs.inotify.max_user_watches). Past the limit
      // a folder can't be watched; say so once, rather than miss its changes in silence.
      const code = (err as NodeJS.ErrnoException).code;
      if ((code === "ENOSPC" || code === "EMFILE") && !warned) {
        warned = true;
        console.error(`localidraw: can't watch ${dir || "the folder"} for changes: the system's limit on file watches is reached (${code === "ENOSPC" ? "fs.inotify.max_user_watches" : "open files"}). Changes there won't show until you reload. Raise the limit, or use --poll.`);
      }
      return; // gone already, unreadable, or past the limit
    }
    w.on("error", () => unwatch(dir));
    watchers.set(dir, w);
    let entries: Dirent[] = [];
    try { entries = readdirSync(abs, { withFileTypes: true }); } catch {}
    for (const e of entries) {
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (skipped(rel)) continue;
      if (e.isDirectory()) add(rel, arrived);
      else if (arrived) changed(rel);
    }
  };
  add("", again);
  return { close: () => unwatch(""), alive: () => watchers.has("") };
}

/** Says every canvas under `root` may have changed: for a folder watched again, whose changes meanwhile went unseen. */
function announceAll(root: string, changed: (rel: string) => void) {
  for (const p of listProjects(root)) for (const c of p.canvases) changed(c.path);
  changed(LIBRARY_FILE);
}

/**
 * Calls `changed` like watchTree, but by looking: every `interval` ms it lists the folders and canvases under the root
 * and compares each canvas's (and the Library's) size, modification time and inode with the last look. For network mounts (NFS, SMB),
 * where the file events for another machine's writes never arrive.
 */
function pollTree(root: string, interval: number, changed: (rel: string) => void): Watch {
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
  return { close: () => clearTimeout(timer), alive: () => true };
}

/**
 * Tells the pages a Library file changed: its path as the API names it (`id`), and its new hash, or null once it's
 * gone. Half-written, it waits for the rest.
 */
function announceLibrary(abs: string, id: string, announce: (event: object) => void) {
  if (!existsSync(abs)) return announce({ type: "library", path: id, hash: null });
  let content: string;
  try { content = readFileSync(abs, "utf8"); } catch { return; }
  try { parseLibrary(content); } catch { return; }
  announce({ type: "library", path: id, hash: contentHash(content) });
}

/**
 * Watches a folder for canvas changes and tells every connected page, debounced per file. `prefix` is put before
 * each path: the folder's name and a slash when serving the list, nothing for one folder.
 */
function watchCanvases(root: string, prefix: string, poll: number | undefined, announce: (event: object) => void, again = false): Watch {
  const pending = new Map<string, NodeJS.Timeout>();
  const changed = (rel: string) => {
    if (skipped(rel)) return;
    clearTimeout(pending.get(rel));
    pending.set(rel, setTimeout(() => {
      pending.delete(rel);
      if (rel === LIBRARY_FILE) return announceLibrary(join(root, LIBRARY_FILE), `${prefix}${LIBRARY_FILE}`, announce);
      if (!rel.endsWith(".excalidraw")) return announce({ type: "projects" }); // a folder came or went
      const abs = resolve(root, rel);
      if (!existsSync(abs)) {
        announce({ type: "gone", path: `${prefix}${rel}` }); // deleted, or moved: a page with it open says so (and looks for it)
        return announce({ type: "projects" });
      }
      let content: string;
      try { content = readFileSync(abs, "utf8"); } catch { return announce({ type: "projects" }); } // gone since
      try {
        parseCanvas(content);
      } catch {
        // Caught mid-write by a tool that doesn't write atomically (its next event follows), or not a scene at all.
        return announce({ type: "projects" });
      }
      announce({ type: "changed", path: `${prefix}${rel}`, hash: contentHash(content) });
      announce({ type: "projects" });
    }, 120));
  };
  const tree = poll ? pollTree(root, poll, changed) : watchTree(root, changed, again);
  return { close: () => { tree.close(); for (const t of pending.values()) clearTimeout(t); pending.clear(); }, alive: tree.alive };
}

/** A folder being served: Scratch, a listed folder, or the one folder of `localidraw <folder>`. */
type Mount = {
  name: string;
  path: string;
  /** Put before its canvases' paths in the API: `<name>/` when serving the list, "" for one folder. */
  prefix: string;
  scratch: boolean;
  /** Not there now (an unmounted drive, a deleted clone): listed, greyed out, and back once it is. */
  missing: boolean;
  watcher?: Watch;
  /** Watched before: a new watch says what's there, since its changes in between went unseen. */
  seen?: boolean;
  /** The folder watched (its device and inode): one deleted and made again between two looks needs a new watch. */
  watched?: string;
};

/** What the page is told about each folder (`/api/projects`), when serving the list. */
export type FolderInfo = { name: string; path: string; scratch: boolean; missing: boolean };

/** How often the list's config, its folders' presence and the home Library are looked at, without --poll. */
const CHECK_MS = 1000;

const stampOf = (abs: string) => {
  try { const s = statSync(abs); return `${s.size}:${s.mtimeMs}:${s.ino}`; } catch { return ""; }
};

/**
 * The folders served, and keeping them current: in list mode, Scratch first, then config.json's, re-read when it
 * changes (a config that doesn't parse keeps the last good list, and says so); each folder watched while it's there.
 */
function mountFolders(opts: { root?: string; home?: string; poll?: number }, announce: (event: object) => void) {
  const { root, home, poll } = opts;
  let mounts: Mount[] = [];
  /** Why config.json was last refused, for stderr and the page; undefined while it parses. */
  let warning: string | undefined;
  const identity = (path: string) => { try { const s = statSync(path); return s.isDirectory() ? `${s.dev}:${s.ino}` : undefined; } catch { return undefined; } };
  const unwatchMount = (m: Mount) => { m.watcher?.close(); m.watcher = undefined; m.watched = undefined; };
  /** Watches the folder while it's there, and again if it's another folder by now (deleted and made again). */
  const watchMount = (m: Mount) => {
    const id = identity(m.path);
    m.missing = id === undefined;
    if (m.watcher && (m.watched !== id || !m.watcher.alive())) unwatchMount(m);
    if (id !== undefined && !m.watcher) {
      m.watcher = watchCanvases(m.path, m.prefix, poll, announce, m.seen);
      m.watched = id;
      m.seen = true;
    }
  };

  if (root !== undefined) {
    mounts = [{ name: basename(root) || root, path: root, prefix: "", scratch: false, missing: false }];
    watchMount(mounts[0]);
    return {
      list: false as const,
      mounts: () => mounts,
      warning: () => undefined,
      kick: () => {},
      close: () => mounts.forEach(unwatchMount),
    };
  }
  if (home === undefined) throw new Error("startServer needs a root or a home");

  const scratch: Mount = { name: SCRATCH, path: scratchDir(home), prefix: `${SCRATCH}/`, scratch: true, missing: false };
  mounts = [scratch]; // and Scratch alone, if config.json doesn't parse from the start
  /** The listed folders, kept as they are when the config changes but they don't. */
  const load = () => {
    let config;
    try {
      config = readConfig(home);
    } catch (err) {
      const why = (err as Error).message;
      if (why !== warning) console.error(`localidraw: ${why}. Keeping the folders it listed before; fix the file and they'll follow.`);
      warning = why;
      return false;
    }
    warning = undefined;
    const before = new Map(mounts.filter((m) => !m.scratch).map((m) => [m.name, m]));
    const next: Mount[] = [scratch];
    for (const f of config.folders) {
      const kept = before.get(f.name);
      if (kept && kept.path === f.path) { next.push(kept); before.delete(f.name); continue; }
      next.push({ name: f.name, path: f.path, prefix: `${f.name}/`, scratch: false, missing: false });
    }
    for (const gone of before.values()) unwatchMount(gone);
    mounts = next;
    return true;
  };
  load();
  for (const m of mounts) watchMount(m);
  // Scratch is made with its first canvas, so it isn't "missing" before then: it's simply empty.
  const shown = () => mounts.map((m) => `${m.name}:${m.path}:${m.scratch || !m.missing}`).join("|");

  const configFile = configPath(home), homeLibrary = join(home, LIBRARY_FILE);
  let configStamp = stampOf(configFile), libraryStamp = stampOf(homeLibrary);
  let homeWatch: FSWatcher | undefined;
  let soon: NodeJS.Timeout | undefined;
  const check = () => {
    const was = shown();
    const warned = warning;
    const c = stampOf(configFile);
    if (c !== configStamp) { configStamp = c; load(); }
    for (const m of mounts) watchMount(m);
    if (shown() !== was || warning !== warned) announce({ type: "projects" });
    const l = stampOf(homeLibrary);
    if (l !== libraryStamp) { libraryStamp = l; announceLibrary(homeLibrary, LIBRARY_FILE, announce); }
    // A watch on the home folder makes a hand edit of config.json show at once; the timer is for everything else
    // (and for a home that doesn't exist yet).
    if (!homeWatch && !poll && isThere(home)) {
      try {
        homeWatch = watch(home, () => { clearTimeout(soon); soon = setTimeout(check, 50); });
        homeWatch.on("error", () => { homeWatch?.close(); homeWatch = undefined; });
      } catch {}
    }
  };
  let timer: NodeJS.Timeout;
  const tick = () => { check(); timer = setTimeout(tick, poll ?? CHECK_MS); };
  timer = setTimeout(tick, poll ?? CHECK_MS);
  check();
  return {
    list: true as const,
    mounts: () => mounts,
    warning: () => warning,
    /** Looks now: after a canvas is made in Scratch, say, so it's watched from then on. */
    kick: check,
    close: () => { clearTimeout(timer); clearTimeout(soon); homeWatch?.close(); mounts.forEach(unwatchMount); },
  };
}

export function startServer({ root, home, port, webDir, host = DEFAULT_HOST, allowedHosts = [], poll }: Options): Promise<Running> {
  if (!isLoopbackAddress(host) && allowedHosts.length === 0) {
    // Without one, every request would be refused anyway; this says why, before anything listens.
    return Promise.reject(new Error(`listening on ${host} needs at least one allowed host name (--allowed-host)`));
  }
  const clients = new Set<ServerResponse>();
  const announce = (event: object) => { for (const c of clients) c.write(`data: ${JSON.stringify(event)}\n\n`); };
  const folders = mountFolders({ root, home, poll }, announce);
  const watcher = { close: () => folders.close() };
  const serveStatic = staticFiles(resolve(webDir));
  // The requests under way, for drain(): every one but the event streams, which never finish by themselves.
  let active = 0;
  let draining = false;
  let drained = () => {};
  // Counted around every write, so /api/busy reads two numbers and never the disk.
  const busy: BusyCounts = { canvas: 0, library: 0 };

  /**
   * The folder an API path is in, and the path inside it. Serving one folder, that's the folder and the path as it
   * is; serving the list, the path's first part is the folder's name.
   */
  const locate = (p: unknown): { mount: Mount; rel: string } | undefined => {
    if (typeof p !== "string") return undefined;
    if (!folders.list) return { mount: folders.mounts()[0], rel: p };
    const at = p.indexOf("/");
    const mount = folders.mounts().find((m) => m.name === (at < 0 ? p : p.slice(0, at)));
    return mount && at > 0 ? { mount, rel: p.slice(at + 1) } : undefined;
  };
  /** A canvas's (or a folder's, for `kind: "dir"`) absolute path, from an API path, or undefined if it isn't one. */
  const canvasAt = (p: unknown) => {
    const found = locate(p);
    const abs = found && resolveInRoot(found.mount.path, found.rel, "file");
    return found && abs ? { mount: found.mount, abs } : undefined;
  };
  const apiPath = (mount: Mount, abs: string) => `${mount.prefix}${relativePath(mount.path, abs)}`;
  const projects = () => folders.mounts().flatMap((m) => m.missing ? [] : listProjects(m.path).map((p) => ({
    ...(folders.list ? { folder: m.name } : {}),
    dir: m.prefix ? `${m.name}${p.dir ? `/${p.dir}` : ""}` : p.dir,
    canvases: p.canvases.map((c) => ({ ...c, path: `${m.prefix}${c.path}` })),
  })));
  const NOT_IN = folders.list ? "That isn't a .excalidraw path inside one of the folders." : "That isn't a .excalidraw path inside the folder.";
  const MISSING = "That folder isn't there right now (an unmounted drive, or a moved folder?).";

  /**
   * The Library a page should use, and where it's kept. Serving one folder, it's that folder's library.excalidrawlib,
   * when there is one. Serving the list, it's the open canvas's folder's, if that folder has one, and otherwise
   * Localidraw's own (`~/.localidraw/library.excalidrawlib`), which is made on the first change.
   */
  const libraryFor = (canvas: string | null): { id: string; abs: string; home: boolean } => {
    if (!folders.list) return { id: LIBRARY_FILE, abs: join(folders.mounts()[0].path, LIBRARY_FILE), home: false };
    const found = canvas === null ? undefined : locate(canvas);
    if (found && !found.mount.missing && existsSync(join(found.mount.path, LIBRARY_FILE))) {
      return { id: `${found.mount.prefix}${LIBRARY_FILE}`, abs: join(found.mount.path, LIBRARY_FILE), home: false };
    }
    return { id: LIBRARY_FILE, abs: join(home!, LIBRARY_FILE), home: true };
  };
  /** A Library by the path the API names it, for a save. */
  const libraryAt = (id: string | null): { id: string; abs: string; home: boolean } | undefined => {
    if (!folders.list) return id === null || id === LIBRARY_FILE ? libraryFor(null) : undefined;
    if (id === null || id === LIBRARY_FILE) return { id: LIBRARY_FILE, abs: join(home!, LIBRARY_FILE), home: true };
    const found = locate(id);
    return found && found.rel === LIBRARY_FILE && !found.mount.missing ? { id, abs: join(found.mount.path, LIBRARY_FILE), home: false } : undefined;
  };

  const server = createServer(async (req, res) => {
    if (draining) {
      res.writeHead(503, { "content-type": "application/json", "cache-control": "no-store", connection: "close" });
      return res.end(JSON.stringify({ error: "Localidraw is stopping." }));
    }
    active++;
    let counted = true;
    const finished = () => {
      if (!counted) return;
      counted = false;
      active--;
      if (draining) { server.closeIdleConnections(); if (active === 0) drained(); }
    };
    res.on("close", finished);
    if (!guard(req, res, allowedHosts)) return;
    // Not `new URL(req.url, base)`: a path starting `//` would be read as a host, and throw.
    let url: URL;
    try { url = new URL(`http://localhost${req.url ?? "/"}`); } catch { return res.writeHead(400).end(); }
    const path = url.pathname;
    const read = req.method === "GET" || req.method === "HEAD"; // Node leaves out the body for a HEAD
    // A write, counted until it's answered (or the connection drops). Anything else that isn't a read is answered 404
    // below, quickly, so counting it too does no harm.
    const kind: keyof BusyCounts | undefined = read ? undefined : path === "/api/library" ? "library" : path.startsWith("/api/canvas") ? "canvas" : undefined;
    if (kind) {
      busy[kind]++;
      res.once("close", () => { busy[kind]--; });
    }
    try {
      if (read && path === "/") return await serveStatic(req, res, "index.html");
      if (read && path.startsWith("/static/")) return await serveStatic(req, res, path.slice("/static/".length));
      if (read && path === "/api/health") return await json(req, res, 200, { ok: true, version: pkg.version });
      // Counts only, no labels, so it needs no more than the guard every request goes through (SPEC §4).
      if (read && path === "/api/busy") return await json(req, res, 200, { busy: busy.canvas + busy.library > 0, version: pkg.version, counts: { ...busy } });
      if (req.method === "GET" && path === "/api/projects") {
        if (!folders.list) return await json(req, res, 200, { root, projects: projects() });
        const list: FolderInfo[] = folders.mounts().map((m) => ({ name: m.name, path: m.path, scratch: m.scratch, missing: !m.scratch && m.missing }));
        return await json(req, res, 200, { root: null, folders: list, projects: projects(), ...(folders.warning() ? { warning: folders.warning() } : {}) });
      }
      if (req.method === "GET" && path === "/api/events") {
        // Never compressed, and `x-accel-buffering: no`, so a proxy passes each event on as it comes.
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" });
        res.write(": connected\n\n");
        clients.add(res);
        finished(); // an event stream is open until the page goes; it isn't a request under way
        const beat = setInterval(() => res.write(": beat\n\n"), 25_000);
        req.on("close", () => { clearInterval(beat); clients.delete(res); });
        return;
      }
      if (path === "/api/canvas") {
        const at = canvasAt(url.searchParams.get("path"));
        if (!at) return json(req, res, 400, { error: NOT_IN });
        const { abs, mount } = at;
        // 422: the file is there, but it isn't a scene to open or merge.
        const loaded = (content: string, status: number) => {
          try {
            return json(req, res, status, { hash: contentHash(content), scene: parseCanvas(content) });
          } catch (err) {
            return json(req, res, 422, { error: (err as Error).message });
          }
        };
        if (req.method === "GET") {
          if (!existsSync(abs)) return json(req, res, 404, { error: mount.missing ? MISSING : "There's no canvas at that path." });
          return loaded(readFileSync(abs, "utf8"), 200);
        }
        if (req.method === "PUT") {
          // The page says which version it edited (x-base-hash). If the file has moved on since, it gets the new
          // version back (409) and merges before saving again, so nothing written on disk is ever lost.
          // A file that's gone was deleted or moved on disk (or from another page): a save never puts it back, unless the
          // page says it means to (`x-base-hash: none`, "there's no file"), and then only if there's still none.
          // A folder that's gone (an unmounted drive) is never written to: that would make a new folder where it was.
          // (Scratch is the exception: it's made by whatever is first written there.)
          if (!mount.scratch && (mount.missing || !isThere(mount.path))) return json(req, res, 410, { error: MISSING });
          const current = existsSync(abs) ? readFileSync(abs, "utf8") : undefined;
          const base = req.headers["x-base-hash"];
          if (current === undefined && base !== NO_FILE) return json(req, res, 410, { error: "It isn't there any more: it was deleted or moved." });
          if (current !== undefined && base !== contentHash(current)) return loaded(current, 409);
          const content = await readBody(req);
          JSON.parse(content);
          writeAtomic(abs, content.endsWith("\n") ? content : `${content}\n`);
          const hash = contentHash(readFileSync(abs, "utf8"));
          folders.kick();
          return json(req, res, 200, { hash });
        }
      }
      if (path === "/api/library") {
        // Serving one folder: its own Library, when it has one, and never created here (the user makes the file to
        // share one). Serving the list: the open canvas's folder's, or else Localidraw's own, made on the first change.
        if (req.method === "GET") {
          const lib = libraryFor(url.searchParams.get("canvas"));
          const current = existsSync(lib.abs) ? readFileSync(lib.abs, "utf8") : undefined;
          if (current === undefined) return json(req, res, 200, { shared: false, path: lib.id, ...(lib.home ? { creatable: true } : {}) });
          try {
            return json(req, res, 200, { shared: true, path: lib.id, hash: contentHash(current), library: parseLibrary(current) });
          } catch (err) {
            return json(req, res, 422, { error: (err as Error).message });
          }
        }
        if (req.method === "PUT") {
          const lib = libraryAt(url.searchParams.get("path"));
          if (!lib) return json(req, res, 400, { error: "That isn't a Library this Localidraw keeps." });
          const current = existsSync(lib.abs) ? readFileSync(lib.abs, "utf8") : undefined;
          const base = req.headers["x-base-hash"];
          // Localidraw's own Library is made by the first save that says there's none yet (`x-base-hash: none`).
          if (current === undefined && !(lib.home && base === NO_FILE)) return json(req, res, 404, { error: `There's no ${LIBRARY_FILE} there.` });
          // As for a canvas: a save based on an older version gets the newer one back to merge.
          if (current !== undefined && base !== contentHash(current)) {
            try {
              return json(req, res, 409, { shared: true, path: lib.id, hash: contentHash(current), library: parseLibrary(current) });
            } catch (err) {
              return json(req, res, 422, { error: (err as Error).message });
            }
          }
          const content = await readBody(req);
          try { parseLibrary(content); } catch (err) { return json(req, res, 400, { error: (err as Error).message }); }
          writeAtomic(lib.abs, content.endsWith("\n") ? content : `${content}\n`);
          return json(req, res, 200, { path: lib.id, hash: contentHash(readFileSync(lib.abs, "utf8")) });
        }
      }
      if (req.method === "POST" && path === "/api/canvases") {
        const { path: wanted } = JSON.parse(await readBody(req));
        const at = canvasAt(withExtension(wanted));
        if (!at) return json(req, res, 400, { error: folders.list ? "That isn't a path inside one of the folders: start it with the folder's name (scratch/untitled)." : "That isn't a path inside the folder." });
        if (at.mount.missing && !at.mount.scratch) return json(req, res, 404, { error: MISSING });
        if (existsSync(at.abs)) return json(req, res, 409, { error: "There's already a canvas there." });
        writeAtomic(at.abs, `${JSON.stringify(EMPTY_SCENE, null, 2)}\n`);
        folders.kick(); // Scratch's first canvas makes its folder: watch it from now on
        return json(req, res, 201, { path: apiPath(at.mount, at.abs) });
      }
      // Renaming, moving and deleting from the sidebar. A rename never replaces a file, and a delete is a move into the
      // trash (.localidraw/trash, in the canvas's own folder), never an unlink, so it can be undone.
      if (req.method === "POST" && path === "/api/canvases/move") {
        const { from, to } = JSON.parse(await readBody(req));
        const src = canvasAt(from), dest = canvasAt(withExtension(to));
        if (!src || !dest) return json(req, res, 400, { error: folders.list ? "That isn't a path inside one of the folders." : "That isn't a path inside the folder." });
        // A move is a hard link, then an unlink, which can't cross file systems; and two folders are often on two.
        if (src.mount !== dest.mount) return json(req, res, 400, { error: `A canvas can't move from one folder to another yet: keep it in ${src.mount.name}.` });
        if (!existsSync(src.abs)) return json(req, res, 404, { error: "There's no canvas at that path." });
        if (src.abs === dest.abs) return json(req, res, 200, { path: apiPath(dest.mount, dest.abs) });
        try {
          renameNoReplace(src.abs, dest.abs);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "EEXIST") return json(req, res, 409, { error: "There's already a canvas there." });
          throw err;
        }
        return json(req, res, 200, { path: apiPath(dest.mount, dest.abs) });
      }
      if (req.method === "POST" && path === "/api/canvases/trash") {
        const { path: rel } = JSON.parse(await readBody(req));
        const at = canvasAt(rel);
        if (!at) return json(req, res, 400, { error: folders.list ? "That isn't a path inside one of the folders." : "That isn't a path inside the folder." });
        if (!existsSync(at.abs)) return json(req, res, 404, { error: "There's no canvas at that path." });
        return json(req, res, 200, { trashed: `${at.mount.prefix}${moveToTrash(at.mount.path, at.abs)}` });
      }
      if (req.method === "POST" && path === "/api/canvases/restore") {
        const { trashed, path: rel } = JSON.parse(await readBody(req));
        const from = locate(trashed), dest = canvasAt(rel);
        const src = from && resolveInTrash(from.mount.path, from.rel);
        if (!src || !dest || from.mount !== dest.mount) return json(req, res, 400, { error: "That isn't a canvas in the trash, or a path inside its folder." });
        if (!existsSync(src)) return json(req, res, 404, { error: "It isn't in the trash any more." });
        try {
          renameNoReplace(src, dest.abs);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "EEXIST") return json(req, res, 409, { error: "There's a canvas at its old path now." });
          throw err;
        }
        return json(req, res, 200, { path: apiPath(dest.mount, dest.abs) });
      }
      return json(req, res, 404, { error: "Not found." });
    } catch (err) {
      return json(req, res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  return new Promise((ok, fail) => {
    // Not listening (the port is in use, say): stop watching too, or the watches alone would keep the process alive.
    server.once("error", (err) => { watcher.close(); fail(err); });
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
        busy: () => ({ ...busy }),
        drain: (timeoutMs, waiting) => new Promise((done) => {
          draining = true;
          watcher.close();
          server.close();
          for (const c of clients) c.end();
          server.closeIdleConnections();
          if (active === 0) return done(0);
          waiting?.(active);
          const timer = setTimeout(() => { const cut = active; server.closeAllConnections(); done(cut); }, timeoutMs);
          drained = () => { clearTimeout(timer); server.closeAllConnections(); done(0); };
        }),
      });
    });
  });
}
