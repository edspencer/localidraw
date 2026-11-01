import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
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

/** A request with full control of the headers (fetch won't let a test set Host or Origin). */
function call(method: string, path: string, opts: { body?: string; headers?: Record<string, string> } = {}) {
  const { port } = new URL(app.url);
  return new Promise<{ status: number; json: any }>((ok, fail) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers: { host: `localhost:${port}`, ...opts.headers } }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c)).on("end", () => {
        let json: any = data;
        try { json = JSON.parse(data); } catch {}
        ok({ status: res.statusCode!, json });
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

/**
 * Resolves once the server announces `rel` with the content `write` puts there. The watcher can take a moment to
 * start (FSEvents on macOS), so it writes every 300 ms until the change is seen, up to 5 s.
 */
function announced(rel: string, content: string, write: () => void) {
  const { port } = new URL(app.url);
  const events: any[] = [];
  const isThisWrite = (e: any) => e.type === "changed" && e.path === rel && e.hash === contentHash(content);
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

test("canvases in a folder made after the server started are watched", async () => {
  mkdirSync(join(root, "later/deeper"), { recursive: true });
  await announced("later/deeper/c.excalidraw", scene(8), () => writeFileSync(join(root, "later/deeper/c.excalidraw"), scene(8)));
});
