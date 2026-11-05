// The CLI: its commands and exit codes (the CLI contract's SPEC §1–§3), how it stops, and its hosting options: what it
// refuses, and what it says it's doing.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentHash } from "../server/files.ts";

const CLI = join(import.meta.dirname, "../server/cli.ts");
const TSX = import.meta.resolve("tsx"); // as a URL, so the CLI can run from another folder
const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("LOCALIDRAW_") && k !== "PORT"));
const run = (args: string[], env: Record<string, string> = {}) =>
  spawnSync(process.execPath, ["--import", TSX, CLI, ...args], { encoding: "utf8", env: { ...clean, ...env }, timeout: 30_000 });

// The tests that start it need the built page (npm run build); CI builds before it tests.
const built = existsSync(join(import.meta.dirname, "../dist/web/index.html"));
const started = { skip: built ? false : "the page isn't built (npm run build)" };

/**
 * Every child a test starts, killed when the tests end: one a failed assertion left running would hold this file's
 * process open, and the run would wait for it for good (it did on Windows, where a path didn't match).
 */
const children = new Set<ChildProcess>();
after(() => { for (const c of children) c.kill("SIGKILL"); });

/** Every wait here has a limit, so a test that goes wrong fails, with what it was waiting for, rather than hangs. */
function within<T>(promise: Promise<T>, what: string, ms = 15_000): Promise<T> {
  let timer: NodeJS.Timeout;
  const late = new Promise<never>((_, fail) => { timer = setTimeout(() => fail(new Error(`timed out after ${ms} ms waiting for ${what}`)), ms); });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/** Removes a folder; on Windows, a child that has just ended may still hold it for a moment. */
const remove = (dir: string) => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });

/** Starts the CLI with `args`, with an IPC channel to stop it by on any OS, and its output and exit as promises. */
function launch(args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}) {
  const child = spawn(process.execPath, ["--import", TSX, CLI, ...args], { cwd: opts.cwd, env: { ...clean, ...opts.env }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  children.add(child);
  let stdout = "", stderr = "";
  child.stdout!.on("data", (d) => (stdout += d));
  child.stderr!.on("data", (d) => (stderr += d));
  const exited = within(new Promise<number | null>((ok) => child.on("exit", (code) => { children.delete(child); ok(code); })), `${args.join(" ")} to exit`);
  exited.catch(() => {}); // awaited by the tests that stop it; the rest end with the SIGKILL above
  return { child, exited, output: () => ({ stdout, stderr }) };
}

/** Stops a child the way that works everywhere: the "stop" message, which runs the same clean stop as SIGTERM. */
const stop = (child: ChildProcess) => child.send("stop");

/** Starts the CLI on port 0 and resolves with what it printed once it's listening, then stops it. */
async function startup(args: string[], env: Record<string, string> = {}) {
  const folder = mkdtempSync(join(tmpdir(), "localidraw-cli-"));
  const s = launch([folder, "--port", "0", ...args], { env });
  try {
    await within(new Promise<void>((ok, fail) => {
      s.child.stdout!.on("data", () => { if (s.output().stdout.includes("watching for changes")) ok(); });
      s.exited.then((code) => fail(new Error(`exited ${code}: ${s.output().stdout}${s.output().stderr}`)), fail);
    }), "the banner");
    return s.output().stdout;
  } finally {
    stop(s.child);
    await s.exited;
    remove(folder);
  }
}

/** An empty folder to serve, removed when the tests end. */
const empty = mkdtempSync(join(tmpdir(), "localidraw-cli-empty-"));
after(() => remove(empty));

/** Starts the CLI with `args`, and resolves once its banner is out, with the child and the URL. */
function serve(args: string[], opts: { cwd?: string } = {}) {
  const s = launch(args, opts);
  const url = within(new Promise<string>((ok, fail) => {
    s.child.stdout!.on("data", () => { const m = s.output().stdout.match(/^Localidraw \S+: (\S+)\n/); if (m) ok(m[1]); });
    s.exited.then((code) => fail(new Error(`exited ${code}: ${s.output().stdout}${s.output().stderr}`)), fail);
  }), "the banner");
  return { ...s, url };
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

test("serve is the default, and a folder named like a command is reached as ./name", { ...started, timeout: 60_000 }, async () => {
  const tmp = mkdtempSync(join(tmpdir(), "localidraw-cli-"));
  try {
    mkdirSync(join(tmp, "service"));
    writeFileSync(join(tmp, "service/a.excalidraw"), "{}");
    for (const args of [["serve", "./service"], ["./service"], ["serve", "service"]]) {
      const s = serve([...args, "--port", "0"], { cwd: tmp });
      try {
        await s.url;
        assert.match(s.output().stdout, /[\\/]service \(1 canvas\)\n/, JSON.stringify(args));
      } finally {
        stop(s.child);
        await s.exited;
      }
    }
  } finally {
    remove(tmp);
  }
});

test("a port in use exits 1, not 2", { ...started, timeout: 30_000 }, async () => {
  const holder = createServer();
  await within(new Promise<void>((ok) => holder.listen(0, "127.0.0.1", ok)), "a port");
  try {
    const { port } = holder.address() as { port: number };
    const s = launch([empty, "--port", String(port)]);
    assert.equal(await s.exited, 1, s.output().stderr);
    assert.match(s.output().stderr, new RegExp(`^localidraw: port ${port} is in use`));
  } finally {
    holder.close();
  }
});

/** Starts serving a folder with one canvas, and holds a save to it under way until `finish()`. */
async function saveUnderWay() {
  const tmp = mkdtempSync(join(tmpdir(), "localidraw-cli-"));
  const before = JSON.stringify({ type: "excalidraw", version: 2, elements: [], appState: {}, files: {} });
  const after = JSON.stringify({ type: "excalidraw", version: 2, elements: [{ id: "a", version: 1 }], appState: {}, files: {} });
  writeFileSync(join(tmp, "c.excalidraw"), before);
  const s = serve([tmp, "--port", "0"]);
  const { port } = new URL(await s.url);
  let req!: ReturnType<typeof request>;
  const saved = within(new Promise<number>((ok, fail) => {
    req = request({ host: "127.0.0.1", port, method: "PUT", path: "/api/canvas?path=c.excalidraw",
      headers: { host: `localhost:${port}`, "content-type": "application/json", "content-length": after.length, "x-base-hash": contentHash(before) } },
      (res) => { res.resume(); ok(res.statusCode!); });
    req.on("error", fail);
  }), "the save's answer");
  saved.catch(() => {});
  req.write(after.slice(0, 10)); // the save is under way: the server has its headers and is reading the body
  await new Promise((ok) => setTimeout(ok, 300));
  return {
    ...s, saved, finish: () => req.end(after.slice(10)),
    written: () => readFileSync(join(tmp, "c.excalidraw"), "utf8") === `${after}\n`,
    cleanup: () => { s.child.kill("SIGKILL"); req.destroy(); return s.exited.catch(() => {}).then(() => remove(tmp)); },
  };
}

// The clean stop, by the "stop" message, which works on every OS. The signals below are the same stop, on POSIX.
test("the stop message stops it with exit 0, at once when nothing is under way", started, async () => {
  const s = serve([empty, "--port", "0"]);
  await s.url;
  const t = Date.now();
  stop(s.child);
  assert.equal(await s.exited, 0);
  assert.ok(Date.now() - t < 5000, `it took ${Date.now() - t} ms`);
});

test("a save under way when it's told to stop is written, then it exits 0", started, async () => {
  const s = await saveUnderWay();
  try {
    stop(s.child);
    await new Promise((ok) => setTimeout(ok, 300));
    assert.equal(s.child.exitCode, null, "it waits for the save");
    s.finish();
    assert.equal(await s.saved, 200);
    assert.equal(await s.exited, 0);
    assert.ok(s.written());
    assert.match(s.output().stderr, /waiting for 1 request under way/);
  } finally {
    await s.cleanup();
  }
});

// Skipped on Windows, which has no SIGTERM or SIGINT to send: kill() there ends the child at once, without its
// handler. The two tests above check the same stop there, by the "stop" message.
const signals = { timeout: 30_000, skip: !built ? "the page isn't built (npm run build)" : process.platform === "win32" ? "no signals to send on Windows" : false };

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
  const s = await saveUnderWay();
  try {
    s.child.kill("SIGTERM");
    await new Promise((ok) => setTimeout(ok, 300));
    assert.equal(s.child.exitCode, null, "it waits for the save");
    s.finish();
    assert.equal(await s.saved, 200);
    assert.equal(await s.exited, 0);
    assert.ok(s.written());
    assert.match(s.output().stderr, /waiting for 1 request under way/);
  } finally {
    await s.cleanup();
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
