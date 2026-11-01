import { after, before, mock, test } from "node:test";
import assert from "node:assert/strict";
import fs, { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { request, type IncomingHttpHeaders } from "node:http";
import { connect } from "node:net";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { join } from "node:path";
import { contentHash, listProjects, resolveInRoot, writeAtomic } from "../server/files.ts";
import { startServer, type Running } from "../server/server.ts";

let root: string, web: string, app: Running;
const scene = (n: number) => JSON.stringify({ type: "excalidraw", version: 2, elements: Array.from({ length: n }, (_, i) => ({ id: `e${i}`, version: 1 })), appState: {}, files: {} });

before(async () => {
  const tmp = mkdtempSync(join(tmpdir(), "localidraw-test-"));
  root = join(tmp, "diagrams");
  web = join(tmp, "web");
  mkdirSync(join(root, "team/alpha"), { recursive: true });
  mkdirSync(join(root, "node_modules/pkg"), { recursive: true });
  mkdirSync(join(root, ".git"), { recursive: true });
  mkdirSync(web);
  writeFileSync(join(web, "index.html"), "<!doctype html><title>test</title>");
  writeFileSync(join(root, "top.excalidraw"), scene(1));
  writeFileSync(join(root, "team/alpha/b.excalidraw"), scene(2));
  writeFileSync(join(root, "team/alpha/a.excalidraw"), scene(1));
  writeFileSync(join(root, "node_modules/pkg/hidden.excalidraw"), scene(1));
  writeFileSync(join(root, ".git/hidden.excalidraw"), scene(1));
  writeFileSync(join(root, "team/notes.md"), "not a canvas");
  app = await startServer({ root, port: 0, webDir: web });
});
after(async () => { await app.close(); rmSync(join(root, ".."), { recursive: true, force: true }); });

/**
 * A request with full control of the headers (fetch won't let a test set Host or Origin). A body is sent as JSON
 * unless the headers say otherwise.
 */
function call(method: string, path: string, opts: { body?: string; headers?: Record<string, string>; to?: Running } = {}) {
  const { port } = new URL((opts.to ?? app).url);
  const type = opts.body === undefined ? {} : { "content-type": "application/json" };
  return new Promise<{ status: number; json: any; headers: IncomingHttpHeaders; raw: Buffer }>((ok, fail) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers: { host: `localhost:${port}`, ...type, ...opts.headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c)).on("end", () => {
        const raw = Buffer.concat(chunks);
        let json: any = raw.toString("utf8");
        try { json = JSON.parse(json); } catch {}
        ok({ status: res.statusCode!, json, headers: res.headers, raw });
      });
    });
    req.on("error", fail);
    req.end(opts.body);
  });
}

test("projects are folders with canvases; node_modules, dot-folders and other files are skipped", () => {
  assert.deepEqual(listProjects(root).map((p) => [p.dir, p.canvases.map((c) => c.name)]), [["", ["top"]], ["team/alpha", ["a", "b"]]]);
});

test("paths outside the folder, in skipped folders, or not canvases are refused", () => {
  assert.ok(resolveInRoot(root, "team/alpha/a.excalidraw", "file"));
  for (const bad of ["../x.excalidraw", "/etc/x.excalidraw", "team/notes.md", ".git/hidden.excalidraw", "node_modules/pkg/hidden.excalidraw", "a\0.excalidraw", ""]) {
    assert.equal(resolveInRoot(root, bad, "file"), undefined, bad);
  }
});

test("GET a canvas returns it with its hash", async () => {
  const r = await call("GET", "/api/canvas?path=team/alpha/b.excalidraw");
  assert.equal(r.status, 200);
  assert.equal(r.json.scene.elements.length, 2);
  assert.equal(r.json.hash, contentHash(readFileSync(join(root, "team/alpha/b.excalidraw"), "utf8")));
});

test("PUT saves over the version it was based on, and returns the newer one (409) when the file moved on", async () => {
  const path = "/api/canvas?path=top.excalidraw";
  const { json: loaded } = await call("GET", path);
  const saved = await call("PUT", path, { body: scene(3), headers: { "x-base-hash": loaded.hash } });
  assert.equal(saved.status, 200);
  assert.equal(JSON.parse(readFileSync(join(root, "top.excalidraw"), "utf8")).elements.length, 3);
  const stale = await call("PUT", path, { body: scene(9), headers: { "x-base-hash": loaded.hash } });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.scene.elements.length, 3, "the conflict carries the file as it is");
  assert.equal(JSON.parse(readFileSync(join(root, "top.excalidraw"), "utf8")).elements.length, 3, "and nothing was overwritten");
});

test("POST makes a canvas, with its folders, and won't overwrite one", async () => {
  const made = await call("POST", "/api/canvases", { body: JSON.stringify({ path: "new/project/first" }) });
  assert.equal(made.status, 201);
  assert.equal(made.json.path, "new/project/first.excalidraw");
  assert.equal(JSON.parse(readFileSync(join(root, "new/project/first.excalidraw"), "utf8")).elements.length, 0);
  assert.equal((await call("POST", "/api/canvases", { body: JSON.stringify({ path: "new/project/first" }) })).status, 409);
  assert.equal((await call("POST", "/api/canvases", { body: JSON.stringify({ path: "../escape" }) })).status, 400);
});

test("a file that isn't a scene won't open (422), and isn't saved over; an empty file is an empty canvas", async () => {
  const path = (name: string) => `/api/canvas?path=odd/${name}.excalidraw`;
  mkdirSync(join(root, "odd"), { recursive: true });
  const files = { half: '{"type":"excalidraw","elements":[', other: '{"hello":"world"}', list: "[1,2]", elementless: '{"elements":3}' };
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(root, `odd/${name}.excalidraw`), content);
    const r = await call("GET", path(name));
    assert.equal(r.status, 422, name);
    assert.match(r.json.error, name === "half" ? /^It isn't valid JSON: / : /^It's JSON, but not an Excalidraw scene\.$/, name);
    // A page that had opened the file before it went bad still can't write over it.
    const put = await call("PUT", path(name), { body: scene(1), headers: { "x-base-hash": "an-older-version" } });
    assert.equal(put.status, 422, name);
    assert.equal(readFileSync(join(root, `odd/${name}.excalidraw`), "utf8"), content, name);
  }
  assert.equal((await call("GET", path("missing"))).status, 404);

  writeFileSync(join(root, "odd/touched.excalidraw"), "");
  const empty = await call("GET", path("touched"));
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.json.scene.elements, []);
  assert.equal(empty.json.hash, contentHash(""));
  assert.equal((await call("PUT", path("touched"), { body: scene(2), headers: { "x-base-hash": empty.json.hash } })).status, 200);
  assert.equal(JSON.parse(readFileSync(join(root, "odd/touched.excalidraw"), "utf8")).elements.length, 2);
});

test("only localhost pages may call it", async () => {
  assert.equal((await call("GET", "/api/projects", { headers: { host: "evil.example" } })).status, 403);
  assert.equal((await call("PUT", "/api/canvas?path=top.excalidraw", { body: scene(0), headers: { origin: "http://evil.example" } })).status, 403);
  assert.equal((await call("GET", "/api/projects")).status, 200);
});

test("a path starting with // is a 404, and the server carries on", async () => {
  assert.equal((await call("GET", "//?canvas=top.excalidraw")).status, 404);
  assert.equal((await call("GET", "//evil.example/api/projects")).status, 404);
  assert.equal((await call("GET", "/api/projects")).status, 200);
});

/**
 * Resolves once the server announces `rel` with the content `write` puts there. The watcher can take a moment to
 * start (FSEvents on macOS), so it writes every 300 ms until the change is seen, up to 5 s.
 */
/** Waits for the event of this write: a change to `content`, or with null, the file gone. */
function announced(rel: string, content: string | null, write: () => void, to = app) {
  const { port } = new URL(to.url);
  const events: any[] = [];
  const isThisWrite = (e: any) => content === null
    ? e.type === "gone" && e.path === rel
    : (e.type === "changed" || e.type === "library") && e.path === rel && e.hash === contentHash(content);
  return new Promise<void>((ok, fail) => {
    let poke: NodeJS.Timeout | undefined;
    const req = request({ host: "127.0.0.1", port, path: "/api/events", headers: { host: `localhost:${port}` } }, (res) => {
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        for (const line of chunk.split("\n")) if (line.startsWith("data: ")) events.push(JSON.parse(line.slice(6)));
        // Earlier tests' saves can still be announced (FSEvents on macOS delivers late), even for this file and with
        // its earlier content; wait for this write's.
        if (events.some(isThisWrite)) { clearInterval(poke); req.destroy(); ok(); }
      });
    });
    req.end();
    let tries = 0;
    poke = setInterval(() => {
      write();
      if (++tries > 15) { clearInterval(poke); req.destroy(); fail(new Error(`no change event for ${rel} within 5 s`)); }
    }, 300);
  });
}

test("a change on disk is announced to the page", async () => {
  await announced("team/alpha/a.excalidraw", scene(5), () => writeFileSync(join(root, "team/alpha/a.excalidraw"), scene(5)));
});

// Node's recursive watch on Linux follows each file, and stopped hearing a file once another was renamed over it:
// after the page's first save (writeAtomic), changes made by an agent never arrived.
test("a change on disk is still announced after a save renamed a new file over it", async () => {
  await announced("team/alpha/b.excalidraw", scene(6), () => writeAtomic(join(root, "team/alpha/b.excalidraw"), scene(6)));
  await announced("team/alpha/b.excalidraw", scene(7), () => writeFileSync(join(root, "team/alpha/b.excalidraw"), scene(7)));
});

test("a canvas deleted or moved on disk is announced as gone, and a save never puts it back", async () => {
  const file = join(root, "team/alpha/doomed.excalidraw");
  writeFileSync(file, scene(2));
  const { hash } = (await call("GET", "/api/canvas?path=team/alpha/doomed.excalidraw")).json;
  await announced("team/alpha/doomed.excalidraw", null, () => rmSync(file, { force: true }));
  const put = (base: string, n: number) => call("PUT", "/api/canvas?path=team/alpha/doomed.excalidraw", { body: scene(n), headers: { "x-base-hash": base } });
  assert.equal((await put(hash, 3)).status, 410);
  assert.equal((await put("", 3)).status, 410);
  assert.equal(existsSync(file), false);
  // Unless the page means to put it back ("none": there's no file), and only while there's still none.
  assert.equal((await put("none", 4)).status, 200);
  assert.equal(readFileSync(file, "utf8"), `${scene(4)}\n`);
  const again = await put("none", 5);
  assert.equal(again.status, 409);
  assert.equal(again.json.hash, contentHash(`${scene(4)}\n`));
  rmSync(file);
});

// On Linux a new folder's watch starts after the folder is made, so a canvas that came with it (a `git mv` into a new
// folder, a checkout) was never announced.
test("a canvas that arrives with a new folder is announced", async () => {
  writeFileSync(join(root, "mover.excalidraw"), scene(9));
  await announced("arrived/with/mover.excalidraw", scene(9), () => {
    if (!existsSync(join(root, "mover.excalidraw"))) return;
    mkdirSync(join(root, "arrived/with"), { recursive: true });
    renameSync(join(root, "mover.excalidraw"), join(root, "arrived/with/mover.excalidraw"));
  });
});

test("canvases in a folder made after the server started are watched", async () => {
  mkdirSync(join(root, "later/deeper"), { recursive: true });
  await announced("later/deeper/c.excalidraw", scene(8), () => writeFileSync(join(root, "later/deeper/c.excalidraw"), scene(8)));
});

test("changes in node_modules and dot-folders are never announced", async () => {
  const events: any[] = [];
  const { port } = new URL(app.url);
  const req = request({ host: "127.0.0.1", port, path: "/api/events", headers: { host: `localhost:${port}` } }, (res) => {
    res.setEncoding("utf8");
    res.on("data", (chunk: string) => { for (const l of chunk.split("\n")) if (l.startsWith("data: ")) events.push(JSON.parse(l.slice(6))); });
  });
  req.end();
  try {
    await announced("top.excalidraw", scene(4), () => {
      writeFileSync(join(root, "node_modules/pkg/hidden.excalidraw"), scene(3));
      writeFileSync(join(root, ".git/hidden.excalidraw"), scene(3));
      writeFileSync(join(root, "top.excalidraw"), scene(4));
    });
  } finally {
    req.destroy();
  }
  assert.deepEqual(events.filter((e) => e.path?.includes("hidden")), []);
});

// On Linux each folder is its own inotify watch. Skipped folders get none, and past the system's limit the server
// says so, once, instead of going deaf to a folder in silence.
test("on Linux, skipped folders aren't watched, and running out of watches is reported once", { skip: process.platform !== "linux" }, async () => {
  const watched: string[] = [];
  const real = fs.watch;
  mock.method(fs, "watch", (path: string, ...rest: any[]) => {
    watched.push(path);
    if (path.includes(`${join("team", "alpha")}`) || path.endsWith("later")) throw Object.assign(new Error("no space"), { code: "ENOSPC" });
    return (real as any)(path, ...rest);
  });
  const errors = mock.method(console, "error", () => {});
  syncBuiltinESMExports();
  let limited: Running | undefined;
  try {
    limited = await startServer({ root, port: 0, webDir: web });
    assert.ok(watched.includes(root));
    assert.ok(watched.some((p) => p.endsWith(join("diagrams", "team"))));
    assert.deepEqual(watched.filter((p) => /node_modules|[\\/]\.git|\.localidraw/.test(p)), []);
    assert.equal(errors.mock.callCount(), 1);
    assert.match(String(errors.mock.calls[0].arguments[0]), /limit on file watches.*max_user_watches.*--poll/);
  } finally {
    await limited?.close();
    mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test("writes must be JSON (415), so no page can send one cross-site without a preflight", async () => {
  const before = readFileSync(join(root, "top.excalidraw"), "utf8");
  const { json: loaded } = await call("GET", "/api/canvas?path=top.excalidraw");
  for (const type of [undefined, "text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x"]) {
    const headers: Record<string, string> = { "x-base-hash": loaded.hash };
    if (type) headers["content-type"] = type;
    const put = await call("PUT", "/api/canvas?path=top.excalidraw", { body: scene(4), headers: type ? headers : { ...headers, "content-type": "" } });
    assert.equal(put.status, 415, String(type));
    assert.equal((await call("POST", "/api/canvases", { body: JSON.stringify({ path: "typed" }), headers: { "content-type": type ?? "" } })).status, 415);
  }
  assert.equal(readFileSync(join(root, "top.excalidraw"), "utf8"), before);
  assert.equal((await call("POST", "/api/canvases", { body: JSON.stringify({ path: "typed" }), headers: { "content-type": "application/json; charset=utf-8" } })).status, 201);
});

test("a cross-site or same-site API call is refused, whatever its Origin", async () => {
  for (const site of ["cross-site", "same-site"]) {
    assert.equal((await call("GET", "/api/projects", { headers: { "sec-fetch-site": site } })).status, 403, site);
  }
  for (const site of ["same-origin", "none"]) {
    assert.equal((await call("GET", "/api/projects", { headers: { "sec-fetch-site": site } })).status, 200, site);
  }
});

test("/api/health says it's up, and which version", async () => {
  const r = await call("GET", "/api/health");
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true, version: JSON.parse(readFileSync(join(import.meta.dirname, "../package.json"), "utf8")).version });
});

test("hashed files are cached for good; the page and the rest are revalidated with an ETag", async () => {
  mkdirSync(join(web, "chunks"), { recursive: true });
  writeFileSync(join(web, "chunks/chunk-O7ESXKUI.js"), "export {};");
  writeFileSync(join(web, "Font-0123456789abcdef0123456789abcdef.woff2"), "font");
  writeFileSync(join(web, "favicon.svg"), "<svg/>");
  for (const path of ["/static/chunks/chunk-O7ESXKUI.js", "/static/Font-0123456789abcdef0123456789abcdef.woff2"]) {
    assert.equal((await call("GET", path)).headers["cache-control"], "public, max-age=31536000, immutable", path);
  }
  for (const path of ["/", "/static/favicon.svg"]) {
    const first = await call("GET", path);
    assert.equal(first.status, 200, path);
    assert.equal(first.headers["cache-control"], "no-cache", path);
    assert.ok(first.headers.etag, path);
    const again = await call("GET", path, { headers: { "if-none-match": first.headers.etag! } });
    assert.equal(again.status, 304, path);
    assert.equal(again.raw.length, 0, path);
  }
  writeFileSync(join(web, "favicon.svg"), "<svg>changed</svg>");
  const old = (await call("GET", "/static/favicon.svg")).headers.etag;
  assert.notEqual(old, undefined);
  assert.equal((await call("GET", "/static/favicon.svg")).raw.toString(), "<svg>changed</svg>");
  assert.equal((await call("GET", "/static/%E0%A4%A")).status, 400, "a bad escape is a 400, not a crash");
});

test("text is compressed with brotli or gzip when the browser takes it, and the events never are", async () => {
  writeFileSync(join(web, "big.js"), `export const x = ${JSON.stringify("draw ".repeat(5000))};`);
  const br = await call("GET", "/static/big.js", { headers: { "accept-encoding": "gzip, deflate, br" } });
  assert.equal(br.headers["content-encoding"], "br");
  assert.equal(brotliDecompressSync(br.raw).toString(), readFileSync(join(web, "big.js"), "utf8"));
  assert.match(String(br.headers.vary), /accept-encoding/);
  const gz = await call("GET", "/static/big.js", { headers: { "accept-encoding": "gzip, br;q=0" } });
  assert.equal(gz.headers["content-encoding"], "gzip");
  assert.equal(gunzipSync(gz.raw).toString(), readFileSync(join(web, "big.js"), "utf8"));
  const plain = await call("GET", "/static/big.js");
  assert.equal(plain.headers["content-encoding"], undefined);
  // The API too: a canvas is JSON, and compresses well.
  writeFileSync(join(root, "team/big.excalidraw"), scene(400));
  const canvas = await call("GET", "/api/canvas?path=team/big.excalidraw", { headers: { "accept-encoding": "gzip" } });
  assert.equal(canvas.headers["content-encoding"], "gzip");
  assert.equal(JSON.parse(gunzipSync(canvas.raw).toString()).scene.elements.length, 400);
  // Fonts are compressed already.
  writeFileSync(join(web, "Big-0123456789abcdef0123456789abcdef.woff2"), Buffer.alloc(4096));
  assert.equal((await call("GET", "/static/Big-0123456789abcdef0123456789abcdef.woff2", { headers: { "accept-encoding": "br" } })).headers["content-encoding"], undefined);

  const { port } = new URL(app.url);
  const headers = await new Promise<IncomingHttpHeaders>((ok, fail) => {
    const req = request({ host: "127.0.0.1", port, path: "/api/events", headers: { host: `localhost:${port}`, "accept-encoding": "br, gzip" } }, (res) => { ok(res.headers); req.destroy(); });
    req.on("error", fail).end();
  });
  assert.equal(headers["content-encoding"], undefined);
  assert.equal(headers["x-accel-buffering"], "no");
});

test("with allowed hosts, it answers to those names too, over http or https, and to no others", async () => {
  const hosted = await startServer({ root, port: 0, webDir: web, allowedHosts: ["draw.example", "[fd00::1]"] });
  try {
    const at = (host: string, extra: Record<string, string> = {}) => call("GET", "/api/projects", { to: hosted, headers: { host, ...extra } });
    for (const host of ["draw.example", "DRAW.example:443", "draw.example:3729", "[fd00::1]:3729", `localhost:${new URL(hosted.url).port}`]) {
      assert.equal((await at(host)).status, 200, host);
    }
    for (const host of ["evil.example", "draw.example.evil.example", "sub.draw.example", "[fd00::1]evil"]) {
      const r = await at(host);
      assert.equal(r.status, 403, host);
      assert.match(r.raw.toString(), /--allowed-host/, host);
    }
    // The Origin must be the same host the request came to, by http or https.
    const put = (host: string, origin: string) => call("PUT", "/api/canvas?path=team/alpha/a.excalidraw", { to: hosted, body: scene(1), headers: { host, origin, "x-base-hash": "stale" } });
    for (const [host, origin] of [["draw.example", "https://draw.example"], ["draw.example:443", "https://draw.example"], ["draw.example:3729", "http://draw.example:3729"]]) {
      assert.equal((await put(host, origin)).status, 409, `${host} from ${origin}`); // let through, then refused as stale
    }
    for (const [host, origin] of [["draw.example", "https://evil.example"], ["draw.example", "https://draw.example:8443"], ["draw.example", "null"], ["draw.example", "ftp://draw.example"], ["draw.example:3729", "http://localhost:3729"]]) {
      assert.equal((await put(host, origin)).status, 403, `${host} from ${origin}`);
    }
  } finally {
    await hosted.close();
  }
});

test("it won't listen beyond loopback without an allowed host", async () => {
  for (const host of ["0.0.0.0", "::", "192.168.1.5"]) {
    await assert.rejects(startServer({ root, port: 0, webDir: web, host }), /needs at least one allowed host/, host);
  }
  const loop = await startServer({ root, port: 0, webDir: web, host: "127.0.0.1" });
  await loop.close();
});

test("with --poll, changes are found by checking the files, renamed-over and in new folders alike", async () => {
  const polled = await startServer({ root, port: 0, webDir: web, poll: 100 });
  try {
    await announced("team/alpha/a.excalidraw", scene(11), () => writeFileSync(join(root, "team/alpha/a.excalidraw"), scene(11)), polled);
    await announced("team/alpha/a.excalidraw", scene(12), () => writeAtomic(join(root, "team/alpha/a.excalidraw"), scene(12)), polled);
    mkdirSync(join(root, "polled/new"), { recursive: true });
    await announced("polled/new/d.excalidraw", scene(13), () => writeFileSync(join(root, "polled/new/d.excalidraw"), scene(13)), polled);
  } finally {
    await polled.close();
  }
});

test("a request with no Host at all is refused", async () => {
  const { port } = new URL(app.url);
  const reply = await new Promise<string>((ok, fail) => {
    let data = "";
    const socket = connect(Number(port), "127.0.0.1", () => socket.write("GET /api/projects HTTP/1.0\r\n\r\n"));
    socket.on("data", (c) => (data += c)).on("end", () => ok(data)).on("error", fail);
  });
  assert.match(reply, /^HTTP\/1\.1 403 /);
});

test("HEAD answers like GET, without the body", async () => {
  for (const path of ["/", "/static/favicon.svg", "/api/health"]) {
    const r = await call("HEAD", path);
    assert.equal(r.status, 200, path);
    assert.equal(r.raw.length, 0, path);
  }
});

const lib = (...ids: string[]) => JSON.stringify({ type: "excalidrawlib", version: 2, libraryItems: ids.map((id) => ({ id, status: "unpublished", elements: [] })) });

test("the Library: none until the folder has library.excalidrawlib, and never made by a save", async () => {
  const file = join(root, "library.excalidrawlib");
  assert.deepEqual((await call("GET", "/api/library")).json, { shared: false });
  const put = await call("PUT", "/api/library", { body: lib("a"), headers: { "x-base-hash": "" } });
  assert.equal(put.status, 404);
  assert.equal(existsSync(file), false);

  writeFileSync(file, ""); // `touch library.excalidrawlib`
  const empty = await call("GET", "/api/library");
  assert.equal(empty.json.shared, true);
  assert.deepEqual(empty.json.library.libraryItems, []);
  const saved = await call("PUT", "/api/library", { body: lib("a"), headers: { "x-base-hash": empty.json.hash } });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.hash, contentHash(readFileSync(file, "utf8")));

  // Based on an older version: the newer one comes back to merge, and the file is left alone.
  const stale = await call("PUT", "/api/library", { body: lib("b"), headers: { "x-base-hash": empty.json.hash } });
  assert.equal(stale.status, 409);
  assert.deepEqual(stale.json.library.libraryItems.map((i: any) => i.id), ["a"]);
  // Not a library: refused, not written.
  const bad = await call("PUT", "/api/library", { body: JSON.stringify({ hello: 1 }), headers: { "x-base-hash": saved.json.hash } });
  assert.equal(bad.status, 400);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).libraryItems.map((i: any) => i.id), ["a"]);
  writeFileSync(file, "{ half");
  assert.equal((await call("GET", "/api/library")).status, 422);
  unlinkSync(file);
});

test("a change to the Library on disk is announced, by file events and by polling", async () => {
  const file = join(root, "library.excalidrawlib");
  await announced("library.excalidrawlib", lib("x"), () => writeFileSync(file, lib("x")));
  await announced("library.excalidrawlib", lib("y"), () => writeAtomic(file, lib("y")));
  const polled = await startServer({ root, port: 0, webDir: web, poll: 100 });
  try {
    await announced("library.excalidrawlib", lib("z"), () => writeFileSync(file, lib("z")), polled);
  } finally {
    await polled.close();
    unlinkSync(file);
  }
});

test("move renames a canvas, into new folders too, and never over another", async () => {
  writeFileSync(join(root, "mv-a.excalidraw"), scene(1));
  writeFileSync(join(root, "mv-b.excalidraw"), scene(2));
  const moved = await call("POST", "/api/canvases/move", { body: JSON.stringify({ from: "mv-a.excalidraw", to: "moved/here/renamed" }) });
  assert.equal(moved.status, 200);
  assert.equal(moved.json.path, "moved/here/renamed.excalidraw");
  assert.equal(existsSync(join(root, "mv-a.excalidraw")), false);
  assert.equal(readFileSync(join(root, "moved/here/renamed.excalidraw"), "utf8"), scene(1));

  const clash = await call("POST", "/api/canvases/move", { body: JSON.stringify({ from: "mv-b.excalidraw", to: "moved/here/renamed.excalidraw" }) });
  assert.equal(clash.status, 409);
  assert.equal(readFileSync(join(root, "moved/here/renamed.excalidraw"), "utf8"), scene(1), "the one there is untouched");
  assert.equal(readFileSync(join(root, "mv-b.excalidraw"), "utf8"), scene(2), "and so is the one that would have moved");

  for (const [from, to] of [["mv-b.excalidraw", "../out"], ["mv-b.excalidraw", ".hidden/x"], ["mv-b.excalidraw", "node_modules/x"], ["../x.excalidraw", "y"], ["team/notes.md", "y"]]) {
    assert.equal((await call("POST", "/api/canvases/move", { body: JSON.stringify({ from, to }) })).status, 400, `${from} → ${to}`);
  }
  assert.equal((await call("POST", "/api/canvases/move", { body: JSON.stringify({ from: "nope.excalidraw", to: "y" }) })).status, 404);

  // Another name for the same file (a hard link) is still a name that's taken: both stay.
  linkSync(join(root, "mv-b.excalidraw"), join(root, "mv-c.excalidraw"));
  assert.equal((await call("POST", "/api/canvases/move", { body: JSON.stringify({ from: "mv-b.excalidraw", to: "mv-c" }) })).status, 409);
  assert.equal(existsSync(join(root, "mv-b.excalidraw")) && existsSync(join(root, "mv-c.excalidraw")), true);
});

test("delete moves a canvas into .localidraw/trash, and restore brings it back, never over another", async () => {
  writeFileSync(join(root, "doomed.excalidraw"), scene(3));
  const trashed = await call("POST", "/api/canvases/trash", { body: JSON.stringify({ path: "doomed.excalidraw" }) });
  assert.equal(trashed.status, 200);
  assert.match(trashed.json.trashed, /^\.localidraw\/trash\/\d{4}-\d\d-\d\dT[\d-]+Z-doomed\.excalidraw$/);
  assert.equal(existsSync(join(root, "doomed.excalidraw")), false);
  assert.equal(readFileSync(join(root, trashed.json.trashed), "utf8"), scene(3));
  assert.ok(!listProjects(root).some((p) => p.dir.startsWith(".localidraw")), "the trash isn't a project");

  // Another canvas has taken the name meanwhile: restoring refuses, and both stay as they are.
  writeFileSync(join(root, "doomed.excalidraw"), scene(1));
  const clash = await call("POST", "/api/canvases/restore", { body: JSON.stringify({ trashed: trashed.json.trashed, path: "doomed.excalidraw" }) });
  assert.equal(clash.status, 409);
  rmSync(join(root, "doomed.excalidraw"));
  const back = await call("POST", "/api/canvases/restore", { body: JSON.stringify({ trashed: trashed.json.trashed, path: "doomed.excalidraw" }) });
  assert.equal(back.status, 200);
  assert.equal(readFileSync(join(root, "doomed.excalidraw"), "utf8"), scene(3));

  // Only a canvas in the trash comes out of it.
  for (const t of [".localidraw/trash/../../top.excalidraw", ".localidraw/trash/x/y.excalidraw", "top.excalidraw", ".localidraw/trash/notes.md", ".git/hidden.excalidraw"]) {
    assert.equal((await call("POST", "/api/canvases/restore", { body: JSON.stringify({ trashed: t, path: "r.excalidraw" }) })).status, 400, t);
  }
  assert.equal((await call("POST", "/api/canvases/trash", { body: JSON.stringify({ path: "../x.excalidraw" }) })).status, 400);
  assert.equal((await call("POST", "/api/canvases/trash", { body: JSON.stringify({ path: "gone.excalidraw" }) })).status, 404);
});
