// The CLI: its commands and exit codes (the CLI contract's SPEC §1–§3), how it stops, and its hosting options: what it
// refuses, and what it says it's doing.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentHash } from "../server/files.ts";

const CLI = join(import.meta.dirname, "../server/cli.ts");
const TSX = import.meta.resolve("tsx"); // as a URL, so the CLI can run from another folder
const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("LOCALIDRAW_") && k !== "PORT"));
const run = (args: string[], env: Record<string, string> = {}) =>
  spawnSync(process.execPath, ["--import", TSX, CLI, ...args], { encoding: "utf8", env: { ...clean, ...env } });

// The tests that start it need the built page (npm run build); CI builds before it tests.
const built = existsSync(join(import.meta.dirname, "../dist/web/index.html"));
const started = { skip: built ? false : "the page isn't built (npm run build)" };

/** Starts the CLI on port 0 and resolves with what it printed once it's listening, then stops it. */
function startup(args: string[], env: Record<string, string> = {}) {
  const folder = mkdtempSync(join(tmpdir(), "localidraw-cli-"));
  const child = spawn(process.execPath, ["--import", TSX, CLI, folder, "--port", "0", ...args], { env: { ...clean, ...env } });
  return new Promise<string>((ok, fail) => {
    let out = "";
    child.stdout.on("data", (d) => { out += d; if (out.includes("watching for changes")) { child.kill(); ok(out); } });
    child.stderr.on("data", (d) => (out += d));
    child.on("exit", (code) => fail(new Error(`exited ${code}: ${out}`)));
  }).finally(() => rmSync(folder, { recursive: true, force: true }));
}

/** An empty folder to serve, removed when the tests end. */
const empty = mkdtempSync(join(tmpdir(), "localidraw-cli-empty-"));
after(() => rmSync(empty, { recursive: true, force: true }));

/** Starts the CLI with `args`, and resolves once its banner is out, with the child and the URL. */
function serve(args: string[], opts: { cwd?: string } = {}) {
  const child = spawn(process.execPath, ["--import", TSX, CLI, ...args], { cwd: opts.cwd, env: clean });
  let stdout = "", stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  const exited = new Promise<number | null>((ok) => child.on("exit", (code) => ok(code)));
  const url = new Promise<string>((ok, fail) => {
    child.stdout.on("data", () => { const m = stdout.match(/^Localidraw \S+: (\S+)\n/); if (m) ok(m[1]); });
    exited.then((code) => fail(new Error(`exited ${code}: ${stdout}${stderr}`)));
  });
  return { child, url, exited, output: () => ({ stdout, stderr }) };
}

test("an unknown option, a missing value or a bad folder exits 2, with the message and then the usage", () => {
  for (const args of [["--no-such-flag"], ["--port"], ["/no/such/folder"], ["--port", "x"], ["a", "b"]]) {
    const r = run(args);
    assert.equal(r.status, 2, JSON.stringify(args));
    assert.equal(r.stdout, "");
    const [first, , usage] = r.stderr.split("\n");
    assert.match(first, /^localidraw: /, JSON.stringify(args));
    assert.match(usage, /^Usage: localidraw \[serve\] \[folder\]/, JSON.stringify(args));
  }
});

test("--version is bare, and --help exits 0 with the commands, the options and the exit codes", () => {
  for (const flag of ["-v", "--version"]) {
    const r = run([flag]);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, `${JSON.parse(readFileSync(join(import.meta.dirname, "../package.json"), "utf8")).version}\n`);
  }
  for (const args of [["--help"], ["-h"], ["serve", "--help"]]) {
    const r = run(args);
    assert.equal(r.status, 0, JSON.stringify(args));
    assert.match(r.stdout, /^Usage: localidraw \[serve\] \[folder\] \[options\]$/m);
    assert.match(r.stdout, /given as\s+\.\/service/);
    assert.match(r.stdout, /exits 1 if it fails/);
  }
});

test("the commands still to come are reserved: they exit 2 and say how to serve a folder of that name", () => {
  for (const command of ["service", "update", "upgrade", "busy", "doctor"]) {
    const r = run([command, "--help"]);
    assert.equal(r.status, 2, command);
    assert.match(r.stderr, new RegExp(`^localidraw: \`localidraw ${command}\` is coming in a later version. To serve a folder called ${command}, give it as \\./${command}\n`));
    assert.match(r.stderr, /\nUsage: localidraw/);
  }
});

test("serve is the default, and a folder named like a command is reached as ./name", started, async () => {
  const tmp = mkdtempSync(join(tmpdir(), "localidraw-cli-"));
  try {
    mkdirSync(join(tmp, "service"));
    writeFileSync(join(tmp, "service/a.excalidraw"), "{}");
    for (const args of [["serve", "./service"], ["./service"], ["serve", "service"]]) {
      const s = serve([...args, "--port", "0"], { cwd: tmp });
      await s.url;
      assert.match(s.output().stdout, /\/service \(1 canvas\)\n/, JSON.stringify(args));
      s.child.kill("SIGTERM");
      await s.exited;
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("a port in use exits 1, not 2", started, async () => {
  const holder = createServer();
  await new Promise<void>((ok) => holder.listen(0, "127.0.0.1", ok));
  try {
    const { port } = holder.address() as { port: number };
    const r = await new Promise<{ status: number | null; stderr: string }>((ok) => {
      const child = spawn(process.execPath, ["--import", TSX, CLI, empty, "--port", String(port)], { env: clean });
      let stderr = "";
      child.stderr.on("data", (d) => (stderr += d));
      child.on("exit", (status) => ok({ status, stderr }));
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, new RegExp(`^localidraw: port ${port} is in use`));
  } finally {
    holder.close();
  }
});

// Windows has no SIGTERM to send: a child's kill() there ends it at once.
const signals = { skip: !built ? "the page isn't built (npm run build)" : process.platform === "win32" ? "no signals on Windows" : false };

test("SIGTERM and Ctrl-C stop it with exit 0, at once when nothing is under way", signals, async () => {
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    const s = serve([empty, "--port", "0"]);
    await s.url;
    const t = Date.now();
    s.child.kill(signal);
    assert.equal(await s.exited, 0, signal);
    assert.ok(Date.now() - t < 2000, `${signal} took ${Date.now() - t} ms`);
  }
});

test("a save under way when SIGTERM arrives is written, then it exits 0", signals, async () => {
  const tmp = mkdtempSync(join(tmpdir(), "localidraw-cli-"));
  const before = JSON.stringify({ type: "excalidraw", version: 2, elements: [], appState: {}, files: {} });
  const after = JSON.stringify({ type: "excalidraw", version: 2, elements: [{ id: "a", version: 1 }], appState: {}, files: {} });
  writeFileSync(join(tmp, "c.excalidraw"), before);
  const s = serve([tmp, "--port", "0"]);
  try {
    const { port } = new URL(await s.url);
    let req!: ReturnType<typeof request>;
    const saved = new Promise<number>((ok, fail) => {
      req = request({ host: "127.0.0.1", port, method: "PUT", path: "/api/canvas?path=c.excalidraw",
        headers: { host: `localhost:${port}`, "content-type": "application/json", "content-length": after.length, "x-base-hash": contentHash(before) } },
        (res) => { res.resume(); ok(res.statusCode!); });
      req.on("error", fail);
    });
    req.write(after.slice(0, 10)); // the save is under way: the server has its headers and is reading the body
    await new Promise((ok) => setTimeout(ok, 300));
    s.child.kill("SIGTERM");
    await new Promise((ok) => setTimeout(ok, 300));
    assert.equal(s.child.exitCode, null, "it waits for the save");
    req.end(after.slice(10));
    assert.equal(await saved, 200);
    assert.equal(await s.exited, 0);
    assert.equal(readFileSync(join(tmp, "c.excalidraw"), "utf8"), `${after}\n`);
    assert.match(s.output().stderr, /waiting for 1 request under way/);
  } finally {
    s.child.kill("SIGKILL");
    rmSync(tmp, { recursive: true, force: true });
  }
});

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
