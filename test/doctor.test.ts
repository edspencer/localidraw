// `localidraw doctor`'s own checks (server/doctor.ts): the folders it counts, and the list it serves. The CLI tests
// run the whole command.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { countFolders, diagnose, doctorCode, type Check } from "../server/doctor.ts";

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "localidraw-doctor-")));
after(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;

test("the folders to watch are the ones serve watches: itself and its folders, not dot-folders or node_modules", () => {
  const root = join(tmp, "count");
  for (const d of ["a/b", "c", ".git/objects", "node_modules/pkg", "a/.hidden"]) mkdirSync(join(root, d), { recursive: true });
  assert.deepEqual(countFolders(root, 100), { folders: 4, complete: true });
  assert.equal(countFolders(root, 2).complete, false, "it stops counting past the limit");
  assert.equal(countFolders(root, 100, -1).complete, false, "and when its time is up");
});

/** Runs doctor against a made-up home, with no service and nothing listening, and returns its checks by id. */
async function doctor(setup: (home: string, root: string) => void, maxWatches?: number) {
  const root = join(tmp, String(++n));
  const homeDir = join(root, "home");
  mkdirSync(join(homeDir, ".localidraw"), { recursive: true });
  setup(join(homeDir, ".localidraw"), root);
  const { checks } = await diagnose({
    ctx: { platform: "linux", homeDir, nodePath: process.execPath, pkgRoot: join(root, "pkg"), run: () => ({ status: 1, stdout: "", stderr: "" }), fetch: (async () => { throw new Error("refused"); }) as typeof fetch },
    version: "1.2.3", engines: undefined, entry: join(root, "pkg", "dist", "server", "cli.js"), webDir: join(root, "pkg", "dist", "web"),
    offline: true, env: {}, npmGlobalRoot: () => undefined, isListening: async () => false, maxWatches: () => maxWatches,
  });
  const by = (id: string) => checks.filter((c) => c.id === id);
  return { checks, by, one: (id: string): Check => { assert.equal(by(id).length, 1, JSON.stringify(by(id))); return by(id)[0]; } };
}

const listing = (home: string, folders: { path: string; name: string }[]) => writeFileSync(join(home, "config.json"), JSON.stringify({ folders }));

test("doctor: no config.json is an empty list, and Scratch not made yet is fine", async () => {
  const d = await doctor(() => {});
  assert.equal(d.one("config").status, "pass");
  assert.match(d.one("config").message, /no ~\/\.localidraw\/config\.json yet, so it serves Scratch alone/);
  assert.equal(d.one("folders").status, "pass");
  assert.match(d.one("folders").message, /Scratch .* is made with its first canvas/);
  assert.equal(d.one("inotify").status, "skip", "no limit to read here");
  assert.equal(d.by("folder").length, 0, "it no longer looks at the current folder");
});

test("doctor: a config.json that doesn't parse fails, saying what's wrong, and to fix it or delete it", async () => {
  const d = await doctor((home) => writeFileSync(join(home, "config.json"), "{ broken"));
  const c = d.one("config");
  assert.equal(c.status, "fail");
  assert.match(c.message, /^~\/\.localidraw\/config\.json isn't valid JSON/);
  assert.match(c.fix ?? "", /fix ~\/\.localidraw\/config\.json, or delete it/);
  assert.equal(doctorCode(d.checks), 1);
});

test("doctor: a listed folder that isn't there is a warning naming it, with localidraw remove as the fix", async () => {
  const d = await doctor((home, root) => {
    mkdirSync(join(root, "here"));
    listing(home, [{ path: join(root, "here"), name: "here" }, { path: join(root, "gone"), name: "gone" }, { path: join(root, "away"), name: "away" }]);
  });
  assert.equal(d.one("config").status, "pass");
  assert.match(d.one("config").message, /lists 3 folders/);
  const f = d.one("folders");
  assert.equal(f.status, "warn");
  assert.match(f.message, /^2 listed folders aren't there: gone \(.*gone\), away \(.*away\)/);
  assert.equal(f.fix, "mount them again, or take them off the list: localidraw remove gone; localidraw remove away");
  assert.equal(doctorCode(d.checks.filter((c) => c.id !== "page" && c.id !== "install-method")), 0, "a missing folder doesn't fail it");

  const all = await doctor((home, root) => { mkdirSync(join(root, "a")); listing(home, [{ path: join(root, "a"), name: "a" }]); });
  assert.equal(all.one("folders").status, "pass");
  assert.match(all.one("folders").message, /Scratch and the listed folder are there and readable/);
});

test("doctor: the file watches are counted across Scratch and every listed folder, against the limit", async () => {
  const setup = (home: string, root: string) => {
    for (const d of ["drawings/x", "drawings/y"]) mkdirSync(join(home, d), { recursive: true }); // 3
    for (const d of ["a/one", "a/.git/objects", "b/two/three"]) mkdirSync(join(root, d), { recursive: true }); // 2 + 3
    listing(home, [{ path: join(root, "a"), name: "a" }, { path: join(root, "b"), name: "b" }, { path: join(root, "gone"), name: "gone" }]);
  };
  const roomy = await doctor(setup, 1000);
  assert.equal(roomy.one("inotify").status, "pass");
  assert.match(roomy.one("inotify").message, /^8 folders to watch, well inside the limit/);
  const tight = await doctor(setup, 12);
  assert.equal(tight.one("inotify").status, "warn");
  assert.match(tight.one("inotify").message, /^Scratch and the listed folders have 8 folders to watch, more than half/);
  const over = await doctor(setup, 5);
  assert.equal(over.one("inotify").status, "fail");
  assert.match(over.one("inotify").fix ?? "", /max_user_watches=524288/);
});
