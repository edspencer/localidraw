// The CLI's hosting options: what it refuses, and what it says it's doing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dirname, "../server/cli.ts");
const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("LOCALIDRAW_") && k !== "PORT"));
const run = (args: string[], env: Record<string, string> = {}) =>
  spawnSync(process.execPath, ["--import", "tsx", CLI, ...args], { encoding: "utf8", env: { ...clean, ...env } });

// The tests that start it need the built page (npm run build); CI builds before it tests.
const built = existsSync(join(import.meta.dirname, "../dist/web/index.html"));
const started = { skip: built ? false : "the page isn't built (npm run build)" };

/** Starts the CLI on port 0 and resolves with what it printed once it's listening, then stops it. */
function startup(args: string[], env: Record<string, string> = {}) {
  const folder = mkdtempSync(join(tmpdir(), "localidraw-cli-"));
  const child = spawn(process.execPath, ["--import", "tsx", CLI, folder, "--port", "0", ...args], { env: { ...clean, ...env } });
  return new Promise<string>((ok, fail) => {
    let out = "";
    child.stdout.on("data", (d) => { out += d; if (out.includes("watching for changes")) { child.kill(); ok(out); } });
    child.stderr.on("data", (d) => (out += d));
    child.on("exit", (code) => fail(new Error(`exited ${code}: ${out}`)));
  }).finally(() => rmSync(folder, { recursive: true, force: true }));
}

test("a host beyond loopback is refused without an allowed host, by flag and by environment", () => {
  for (const [args, env] of [[["--host", "0.0.0.0"], {}], [[], { LOCALIDRAW_HOST: "0.0.0.0" }], [["--host=::"], { LOCALIDRAW_ALLOWED_HOSTS: " , " }]] as const) {
    const r = run([...args], env);
    assert.equal(r.status, 2, JSON.stringify(args));
    assert.match(r.stderr, /refusing to listen on .* without an allowed host name/);
    assert.match(r.stderr, /no login/);
  }
});

test("bad hosting values are refused, with the reason", () => {
  assert.match(run(["--host", "0.0.0.0", "--allowed-host", "https://draw.example"]).stderr, /not a host name: https:\/\/draw\.example/);
  assert.match(run(["--poll=x"]).stderr, /--poll takes a number of milliseconds/);
  assert.match(run([], { LOCALIDRAW_POLL: "1" }).stderr, /too often/);
});

test("it prints what's in effect: on loopback by default, with file events", started, async () => {
  const out = await startup([]);
  assert.match(out, /listening on 127\.0\.0\.1:\d+ \(this machine only\)/);
  assert.match(out, /answering to localhost\n/);
  assert.match(out, /watching for changes by file events/);
  assert.doesNotMatch(out, /no login/);
});

test("hosted, it says where it listens, which names it answers to, how it watches, and that there's no login", started, async () => {
  const out = await startup(["--host", "0.0.0.0", "--allowed-host", "draw.example", "--allowed-host=Other.Example", "--poll"]);
  assert.match(out, /http:\/\/localhost:\d+\//);
  assert.match(out, /listening on 0\.0\.0\.0:\d+\n/);
  assert.match(out, /answering to localhost, draw\.example, other\.example/);
  assert.match(out, /checking the files every 2000 ms/);
  assert.match(out, /has no login/);
});

test("the environment sets them too, and a flag wins over its variable", started, async () => {
  const env = { LOCALIDRAW_HOST: "0.0.0.0", LOCALIDRAW_ALLOWED_HOSTS: "a.example, b.example", LOCALIDRAW_POLL: "500" };
  const out = await startup([], env);
  assert.match(out, /answering to localhost, a\.example, b\.example/);
  assert.match(out, /every 500 ms/);
  const flagged = await startup(["--allowed-host", "c.example", "--poll", "250"], env);
  assert.match(flagged, /answering to localhost, c\.example\n/);
  assert.match(flagged, /every 250 ms/);
  assert.match(await startup([], { LOCALIDRAW_POLL: "true" }), /every 2000 ms/);
  assert.match(await startup([], { LOCALIDRAW_POLL: "false" }), /by file events/);
});
