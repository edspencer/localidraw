// Serving the list of folders (~/.localidraw/config.json) plus Scratch: the config, `add`/`remove`/`folders`, and a
// server that follows the list without a restart.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentHash } from "../server/files.ts";
import { addFolder, defaultName, FolderError, parseConfig, readConfig, removeFolder } from "../server/folders.ts";
import { startServer, type Running } from "../server/server.ts";

const scene = (n: number) => JSON.stringify({ type: "excalidraw", version: 2, elements: Array.from({ length: n }, (_, i) => ({ id: `e${i}`, version: 1 })), appState: {}, files: {} });
const lib = (...ids: string[]) => JSON.stringify({ type: "excalidrawlib", version: 2, libraryItems: ids.map((id) => ({ id, status: "unpublished", elements: [] })) });

let tmp: string;
before(() => { tmp = mkdtempSync(join(tmpdir(), "localidraw-folders-")); });
after(() => rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
let n = 0;
/** A new folder under the test's temp folder, with `files` in it. */
function folder(name: string, files: Record<string, string> = {}) {
  const dir = join(tmp, `${n++}`, name);
  mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) { mkdirSync(join(dir, rel, ".."), { recursive: true }); writeFileSync(join(dir, rel), content); }
  return dir;
}
const newHome = () => join(folder("user"), ".localidraw");

test("the config: names default to the basename, URL-safe, never scratch, and unique", () => {
  assert.equal(defaultName("/a/My Notes!"), "My-Notes");
  assert.equal(defaultName("/a/..."), "folder");
  assert.deepEqual(parseConfig(""), { folders: [] });
  assert.deepEqual(parseConfig(`{"folders":[{"path":"/x/notes"}]}`), { folders: [{ path: "/x/notes", name: "notes" }] });
  for (const bad of [`{`, `[]`, `{"folders":{}}`, `{"folders":[{"path":"rel"}]}`, `{"folders":[{"path":"/a","name":"Scratch"}]}`,
    `{"folders":[{"path":"/a","name":"a b"}]}`, `{"folders":[{"path":"/a/x"},{"path":"/b/x"}]}`]) {
    assert.throws(() => parseConfig(bad), Error, bad);
  }
  const home = newHome();
  assert.deepEqual(readConfig(home), { folders: [] }, "no file is an empty list");
});

test("add refuses what isn't a folder, one inside ~/.localidraw, one listed, and nested ones; remove by name or path", () => {
  const home = newHome();
  const notes = folder("notes"), other = folder("notes"), file = join(notes, "x.txt");
  writeFileSync(file, "");
  assert.deepEqual(addFolder(home, notes), { path: notes, name: "notes" });
  assert.deepEqual(addFolder(home, other), { path: other, name: "notes-2" }, "a taken name gets a number");
  const refused = (path: string, name?: string) => assert.throws(() => addFolder(home, path, name), FolderError, path);
  refused(file);
  refused(join(tmp, "no-such"));
  refused(notes);
  refused(`${notes}/`);
  refused(join(notes, "..", "notes"));
  mkdirSync(join(notes, "sub"));
  refused(join(notes, "sub")); // inside a listed one
  refused(join(notes, "..")); // holding one
  mkdirSync(join(home, "drawings"), { recursive: true });
  refused(join(home, "drawings"));
  refused(folder("x"), "scratch");
  refused(folder("y"), "Notes"); // names are compared without case
  refused(folder("z"), "bad name");
  assert.equal(readConfig(home).folders.length, 2, "nothing written by a refusal");
  assert.deepEqual(removeFolder(home, "notes-2"), { path: other, name: "notes-2" });
  assert.deepEqual(removeFolder(home, notes), { path: notes, name: "notes" });
  assert.throws(() => removeFolder(home, "notes"), FolderError);
  assert.deepEqual(JSON.parse(readFileSync(join(home, "config.json"), "utf8")), { folders: [] });
});

test("add keeps the rest of a hand-edited config, and refuses to write over one that doesn't parse", () => {
  const home = newHome();
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "config.json"), `{"note": "mine", "folders": []}`);
  const notes = folder("notes");
  addFolder(home, notes);
  assert.equal(JSON.parse(readFileSync(join(home, "config.json"), "utf8")).note, "mine");
  writeFileSync(join(home, "config.json"), "{ broken");
  assert.throws(() => addFolder(home, folder("other")), /isn't valid JSON/);
  assert.equal(readFileSync(join(home, "config.json"), "utf8"), "{ broken");
});

/** A request to `app`, as the page makes them. */
function call(app: Running, method: string, path: string, opts: { body?: string; headers?: Record<string, string> } = {}) {
  const { port } = new URL(app.url);
  return new Promise<{ status: number; json: any }>((ok, fail) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers: { host: `localhost:${port}`, ...(opts.body === undefined ? {} : { "content-type": "application/json" }), ...opts.headers } }, (res) => {
      let raw = "";
      res.setEncoding("utf8").on("data", (c) => (raw += c)).on("end", () => { let json: any = raw; try { json = JSON.parse(raw); } catch {} ok({ status: res.statusCode!, json }); });
    });
    req.on("error", fail);
    req.end(opts.body);
  });
}

/** The events `app` sends, collected until `stop()`. */
function listen(app: Running) {
  const { port } = new URL(app.url);
  const events: any[] = [];
  const req = request({ host: "127.0.0.1", port, path: "/api/events", headers: { host: `localhost:${port}` } });
  const open = new Promise<void>((ok) => req.on("response", (res) => {
    res.setEncoding("utf8").on("data", (chunk: string) => { for (const l of chunk.split("\n")) if (l.startsWith("data: ")) events.push(JSON.parse(l.slice(6))); });
    ok();
  }));
  req.on("error", () => {});
  req.end();
  return { events, open, stop: () => req.destroy() };
}

/** Waits for `ok()` to be true, checking every 50 ms, up to `ms`. */
async function until(ok: () => boolean | Promise<boolean>, what: string, ms = 8000) {
  const end = Date.now() + ms;
  while (!(await ok())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const web = () => { const w = folder("web"); writeFileSync(join(w, "index.html"), "<!doctype html>"); return w; };

for (const poll of [undefined, 150]) {
  const how = poll ? "by polling" : "by file events";
  test(`serving the list (${how}): Scratch first and made by its first canvas, then the folders, and paths start with their names`, async () => {
    const home = newHome();
    const notes = folder("notes", { "flow.excalidraw": scene(1), "deep/plan.excalidraw": scene(2) });
    addFolder(home, notes);
    const app = await startServer({ home, port: 0, webDir: web(), poll });
    const ev = listen(app);
    try {
      await ev.open;
      const { json } = await call(app, "GET", "/api/projects");
      assert.equal(json.root, null);
      assert.deepEqual(json.folders.map((f: any) => [f.name, f.scratch, f.missing]), [["scratch", true, false], ["notes", false, false]]);
      assert.deepEqual(json.projects.map((p: any) => [p.folder, p.dir, p.canvases.map((c: any) => c.path)]), [
        ["notes", "notes", ["notes/flow.excalidraw"]], ["notes", "notes/deep", ["notes/deep/plan.excalidraw"]],
      ]);
      assert.equal(existsSync(join(home, "drawings")), false, "starting writes nothing");
      const got = await call(app, "GET", "/api/canvas?path=notes/deep/plan.excalidraw");
      assert.equal(got.json.scene.elements.length, 2);
      for (const bad of ["deep/plan.excalidraw", "nope/plan.excalidraw", "notes/../x.excalidraw", "notes", "/etc/x.excalidraw"]) {
        assert.equal((await call(app, "GET", `/api/canvas?path=${encodeURIComponent(bad)}`)).status, 400, bad);
      }
      // A deleted canvas saved again into a Scratch that isn't there yet makes it, as a new canvas does.
      const again = await call(app, "PUT", "/api/canvas?path=scratch/back.excalidraw", { body: scene(1), headers: { "x-base-hash": "none" } });
      assert.equal(again.status, 200);
      rmSync(join(home, "drawings"), { recursive: true });
      // A canvas with no folder chosen goes in Scratch, which its first canvas makes, and which is watched from then on.
      assert.equal((await call(app, "POST", "/api/canvases", { body: `{"path":"untitled"}` })).status, 400);
      const made = await call(app, "POST", "/api/canvases", { body: `{"path":"scratch/untitled"}` });
      assert.deepEqual([made.status, made.json.path], [201, "scratch/untitled.excalidraw"]);
      assert.ok(existsSync(join(home, "drawings/untitled.excalidraw")));
      await new Promise((r) => setTimeout(r, (poll ?? 0) + 300)); // its watch starts
      writeFileSync(join(home, "drawings/untitled.excalidraw"), scene(3));
      await until(() => ev.events.some((e) => e.type === "changed" && e.path === "scratch/untitled.excalidraw"), "Scratch's change");
      writeFileSync(join(notes, "flow.excalidraw"), scene(4));
      const hash = contentHash(scene(4));
      await until(() => ev.events.some((e) => e.type === "changed" && e.path === "notes/flow.excalidraw" && e.hash === hash), "the folder's change");
      // Saving goes through the same base-hash rule.
      const stale = await call(app, "PUT", "/api/canvas?path=notes/flow.excalidraw", { body: scene(5), headers: { "x-base-hash": "old" } });
      assert.equal(stale.status, 409);
      const saved = await call(app, "PUT", "/api/canvas?path=notes/flow.excalidraw", { body: scene(5), headers: { "x-base-hash": hash } });
      assert.equal(saved.status, 200);
      assert.equal(JSON.parse(readFileSync(join(notes, "flow.excalidraw"), "utf8")).elements.length, 5);
    } finally {
      ev.stop();
      await app.close();
    }
  });

  test(`a folder added or removed shows without a restart, a broken config keeps the last list, and a missing folder comes back (${how})`, async () => {
    const home = newHome();
    const app = await startServer({ home, port: 0, webDir: web(), poll });
    const ev = listen(app);
    const names = async () => (await call(app, "GET", "/api/projects")).json.folders.map((f: any) => `${f.name}${f.missing ? "?" : ""}`).join(",");
    try {
      await ev.open;
      assert.equal(await names(), "scratch");
      const a = folder("alpha", { "a.excalidraw": scene(1) }), b = folder("beta", { "b.excalidraw": scene(1) });
      addFolder(home, a);
      addFolder(home, b);
      await until(async () => (await names()) === "scratch,alpha,beta", "both folders");
      assert.ok(ev.events.some((e) => e.type === "projects"), "the pages were told");
      // A canvas in a folder added since the start is watched.
      writeFileSync(join(b, "b.excalidraw"), scene(2));
      await until(() => ev.events.some((e) => e.type === "changed" && e.path === "beta/b.excalidraw"), "beta's change");
      removeFolder(home, "alpha");
      await until(async () => (await names()) === "scratch,beta", "alpha gone");
      assert.equal((await call(app, "GET", "/api/canvas?path=alpha/a.excalidraw")).status, 400);
      assert.ok(existsSync(join(a, "a.excalidraw")), "remove leaves the folder alone");

      writeFileSync(join(home, "config.json"), "{ not json");
      await until(async () => !!(await call(app, "GET", "/api/projects")).json.warning, "the warning");
      assert.equal(await names(), "scratch,beta", "the last good list");
      writeFileSync(join(home, "config.json"), JSON.stringify({ folders: [{ path: b, name: "beta" }] }));
      await until(async () => !(await call(app, "GET", "/api/projects")).json.warning, "the warning to clear");

      // Gone (an unmounted drive): listed, missing, nothing written there; back when it's back.
      const away = `${b}-away`;
      renameSync(b, away);
      await until(async () => (await names()) === "scratch,beta?", "beta missing");
      const put = await call(app, "PUT", "/api/canvas?path=beta/new.excalidraw", { body: scene(1), headers: { "x-base-hash": "none" } });
      assert.equal(put.status, 410);
      assert.equal((await call(app, "POST", "/api/canvases", { body: `{"path":"beta/new"}` })).status, 404);
      assert.equal(existsSync(b), false, "a save never makes a missing folder");
      renameSync(away, b);
      await until(async () => (await names()) === "scratch,beta", "beta back");
      writeFileSync(join(b, "b.excalidraw"), scene(3));
      await until(() => ev.events.some((e) => e.type === "changed" && e.path === "beta/b.excalidraw" && e.hash === contentHash(scene(3))), "beta watched again");
    } finally {
      ev.stop();
      await app.close();
    }
  });
}

test("serving the list: each folder keeps its own trash, and a move between folders is refused", async () => {
  const home = newHome();
  const a = folder("alpha", { "a.excalidraw": scene(1) }), b = folder("beta", { "b.excalidraw": scene(1) });
  addFolder(home, a);
  addFolder(home, b);
  const app = await startServer({ home, port: 0, webDir: web() });
  try {
    const across = await call(app, "POST", "/api/canvases/move", { body: JSON.stringify({ from: "alpha/a.excalidraw", to: "beta/a" }) });
    assert.equal(across.status, 400);
    assert.match(across.json.error, /from one folder to another/);
    const within = await call(app, "POST", "/api/canvases/move", { body: JSON.stringify({ from: "alpha/a.excalidraw", to: "alpha/sub/a2" }) });
    assert.deepEqual([within.status, within.json.path], [200, "alpha/sub/a2.excalidraw"]);
    const trashed = await call(app, "POST", "/api/canvases/trash", { body: `{"path":"beta/b.excalidraw"}` });
    assert.match(trashed.json.trashed, /^beta\/\.localidraw\/trash\/.+-b\.excalidraw$/);
    assert.equal(readdirSync(join(b, ".localidraw/trash")).length, 1, "in beta's own trash");
    const wrong = await call(app, "POST", "/api/canvases/restore", { body: JSON.stringify({ trashed: trashed.json.trashed, path: "alpha/b.excalidraw" }) });
    assert.equal(wrong.status, 400, "back into its own folder only");
    const back = await call(app, "POST", "/api/canvases/restore", { body: JSON.stringify({ trashed: trashed.json.trashed, path: "beta/b.excalidraw" }) });
    assert.deepEqual([back.status, back.json.path], [200, "beta/b.excalidraw"]);
  } finally {
    await app.close();
  }
});

test("serving the list: Localidraw's own Library is made by the first save, and a folder's own wins for its canvases", async () => {
  const home = newHome();
  const a = folder("alpha", { "a.excalidraw": scene(1), "library.excalidrawlib": lib("mine") }), b = folder("beta", { "b.excalidraw": scene(1) });
  addFolder(home, a);
  addFolder(home, b);
  const app = await startServer({ home, port: 0, webDir: web() });
  const ev = listen(app);
  try {
    await ev.open;
    const forBeta = await call(app, "GET", "/api/library?canvas=beta/b.excalidraw");
    assert.deepEqual(forBeta.json, { shared: false, path: "library.excalidrawlib", creatable: true });
    assert.equal((await call(app, "PUT", "/api/library", { body: lib("x"), headers: { "x-base-hash": "old" } })).status, 404);
    const made = await call(app, "PUT", "/api/library?path=library.excalidrawlib", { body: lib("x"), headers: { "x-base-hash": "none" } });
    assert.equal(made.status, 200);
    assert.ok(existsSync(join(home, "library.excalidrawlib")));
    const again = await call(app, "PUT", "/api/library", { body: lib("y"), headers: { "x-base-hash": "none" } });
    assert.equal(again.status, 409, "made once: a second `none` merges");
    await until(() => ev.events.some((e) => e.type === "library" && e.path === "library.excalidrawlib"), "the home Library's event");

    const forAlpha = await call(app, "GET", "/api/library?canvas=alpha/a.excalidraw");
    assert.equal(forAlpha.json.path, "alpha/library.excalidrawlib");
    assert.equal(forAlpha.json.library.libraryItems[0].id, "mine");
    const saved = await call(app, "PUT", "/api/library?path=alpha/library.excalidrawlib", { body: lib("mine", "more"), headers: { "x-base-hash": forAlpha.json.hash } });
    assert.equal(saved.status, 200);
    assert.equal(JSON.parse(readFileSync(join(a, "library.excalidrawlib"), "utf8")).libraryItems.length, 2);
    assert.equal((await call(app, "PUT", "/api/library?path=beta/library.excalidrawlib", { body: lib("z"), headers: { "x-base-hash": "none" } })).status, 404, "a folder's is never made");
    assert.equal((await call(app, "PUT", "/api/library?path=alpha/x.excalidrawlib", { body: lib("z"), headers: { "x-base-hash": "none" } })).status, 400);
  } finally {
    ev.stop();
    await app.close();
  }
});

// The commands, run as a person would, against a throwaway home.
const CLI = join(import.meta.dirname, "../server/cli.ts");
const TSX = import.meta.resolve("tsx");
function cli(home: string, args: string[], cwd?: string) {
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("LOCALIDRAW_") && k !== "PORT")), HOME: home, USERPROFILE: home };
  return spawnSync(process.execPath, ["--import", TSX, CLI, ...args], { encoding: "utf8", env, cwd, timeout: 30_000 });
}

test("localidraw add, folders and remove edit ~/.localidraw/config.json, with --json and the contract's exit codes", () => {
  const user = folder("user");
  const notes = folder("notes");
  const added = cli(user, ["add", notes, "--json"]);
  assert.equal(added.status, 0, added.stderr);
  assert.deepEqual(JSON.parse(added.stdout), { ok: true, action: "add", folder: { path: notes, name: "notes" } });
  const twice = cli(user, ["add", notes]);
  assert.equal(twice.status, 1);
  assert.match(twice.stderr, /^localidraw: .* is listed already, as notes/);
  const list = cli(user, ["folders", "--json"]);
  assert.deepEqual(JSON.parse(list.stdout).folders, [{ path: notes, name: "notes", missing: false }]);
  assert.equal(JSON.parse(list.stdout).scratch.path, join(user, ".localidraw/drawings"));
  assert.match(cli(user, ["folders"]).stdout, /^scratch {2}.*drawings\nnotes {4}/);
  for (const [args, usage] of [[["add"], "add <folder>"], [["add", "a", "b"], "add <folder>"], [["add", notes, "--name"], "add <folder>"], [["folders", "x"], "folders"], [["remove", "--nope"], "remove"]] as const) {
    const r = cli(user, [...args]);
    assert.equal(r.status, 2, JSON.stringify(args));
    assert.match(r.stderr, new RegExp(`Usage: localidraw ${usage.replace(/[<>|]/g, ".")}`), JSON.stringify(args));
  }
  assert.equal(cli(user, ["remove", "scratch"]).status, 1);
  const removed = cli(user, ["remove", "notes"]);
  assert.equal(removed.status, 0);
  assert.match(removed.stdout, /^Removed notes/);
  assert.match(cli(user, ["add", "--help"]).stdout, /^localidraw add:/);
  // A folder named like a command is a folder when given as ./add.
  const parent = folder("p");
  mkdirSync(join(parent, "add"));
  const served = cli(user, ["add", "./add"], parent);
  assert.equal(served.status, 0, served.stderr);
  assert.match(served.stdout, /as add\./);
});

const built = existsSync(join(import.meta.dirname, "../dist/web/index.html"));
test("localidraw with no folder serves Scratch and the list, and says how to keep a current folder that isn't listed", { skip: built ? false : "the page isn't built (npm run build)", timeout: 60_000 }, async () => {
  const user = folder("user");
  const notes = folder("notes", { "a.excalidraw": scene(1) });
  const here = folder("project", { "docs/flow.excalidraw": scene(1) });
  assert.equal(cli(user, ["add", notes]).status, 0);
  const { spawn } = await import("node:child_process");
  const run = async (cwd: string) => {
    const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("LOCALIDRAW_") && k !== "PORT")), HOME: user, USERPROFILE: user };
    const child = spawn(process.execPath, ["--import", TSX, CLI, "--port", "0"], { cwd, env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    let stdout = "", stderr = "";
    child.stdout!.on("data", (d) => (stdout += d));
    child.stderr!.on("data", (d) => (stderr += d));
    const exited = new Promise<number | null>((ok) => child.on("exit", ok));
    try {
      await until(() => stdout.includes("watching for changes"), "the banner", 20_000);
      await new Promise((r) => setTimeout(r, 200));
    } finally {
      child.send("stop");
    }
    assert.equal(await exited, 0);
    return { stdout, stderr };
  };
  const there = await run(here);
  assert.match(there.stdout, /^Localidraw \S+: http:\/\/localhost:\d+\/\n {2}scratch {2}.*drawings \(nothing yet\)\n {2}notes {4}.*notes \(1 canvas\)\n/);
  assert.match(there.stderr, /`localidraw add \.` keeps it there, and `localidraw \.` opens just it/);
  assert.equal(existsSync(join(user, ".localidraw/drawings")), false, "serving writes no Scratch");
  const listed = await run(notes);
  assert.doesNotMatch(listed.stderr, /localidraw add \./, "a listed folder needs no hint");
});
