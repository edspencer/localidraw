// `localidraw service …` against the machine's REAL service manager: launchd's gui/<uid> domain on macOS, systemd's
// user instance on Linux. The package is used as a user gets it: packed, installed globally into a temporary prefix,
// and run from there.
//
// Modelled on Paddock's scripts/service-real.mjs (cli-contract rollout, wave E2), for Localidraw: one folder per
// service, `~/.localidraw` as the home, and no busy check yet (E3).
//
// CI ONLY. It writes the real ~/Library/LaunchAgents/net.edspencer.localidraw.plist or
// ~/.config/systemd/user/localidraw.service and loads it, under the real label, so it must never run on a machine
// that uses Localidraw as a service. It refuses unless CI=true and LOCALIDRAW_REAL_SERVICE=1, and again if a unit is
// already installed. It removes what it installs.
//
// What it checks, in order:
//   status with nothing installed     exit 4, --json says installed: false
//   install from npx's cache          refused, exit 1, nothing written
//   install <folder> --port <free>    it answers; the unit runs the installed CLI with `serve <folder>`, logging to
//                                     ~/.localidraw/logs/service.log, which gets the banner (so stdout reaches it)
//   status / status --json            exit 0, running and answering, the installed version is the running one
//   runtime.json                      in ~/.localidraw, not group or world readable, naming the supervisor's pid
//   --dry-run                         prints the unit, and leaves the installed one alone
//   logs -n, an unknown flag          exit 0; exit 2
//   SIGKILL                           the manager brings it back (KeepAlive / Restart=always)
//   stop                              exit 0; it stops, runtime.json goes, status 3, and it's still enabled
//   start, restart                    exit 0, answering again
//   install --refresh                 exit 0; the unit is re-written as it was
//   install another folder, hosted    the one service moves there, on 0.0.0.0 with an allowed host, and answers
//   uninstall                         the unit goes; status and logs exit 4; the log and the canvases are kept
import { execFileSync, spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.CI !== "true" || process.env.LOCALIDRAW_REAL_SERVICE !== "1") {
  console.error("service-real: refusing to run outside CI (set CI=true and LOCALIDRAW_REAL_SERVICE=1, on a throwaway machine)");
  process.exit(2);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "localidraw-service-")));
const prefix = path.join(tmp, "prefix");
const work = path.join(tmp, "work");
const canvases = path.join(tmp, "canvases");
const other = path.join(tmp, "other");
for (const d of [prefix, work, path.join(canvases, "project"), other]) fs.mkdirSync(d, { recursive: true });
const canvas = path.join(canvases, "project", "one.excalidraw");
const scene = `${JSON.stringify({ type: "excalidraw", version: 2, source: "service-real", elements: [], appState: {}, files: {} })}\n`;
fs.writeFileSync(canvas, scene);
fs.writeFileSync(path.join(other, "two.excalidraw"), scene);
const step = (s) => console.log(`service-real: ${s}`);

// The real HOME, which is where the service manager looks, and none of serve's variables.
const env = { ...process.env };
for (const k of ["PORT", "HOST", "LOCALIDRAW_HOST", "LOCALIDRAW_ALLOWED_HOSTS", "LOCALIDRAW_POLL", "NODE_OPTIONS", "NODE_ENV"]) delete env[k];
const home = path.join(os.homedir(), ".localidraw");
const bin = path.join(prefix, "bin", "localidraw");

/**
 * Runs the installed CLI: { code, stdout, stderr }, never throwing for an exit code. `spawnSync`, because
 * `execFileSync` only shows stderr by throwing, and every command here puts prose there (SPEC §3).
 */
function localidraw(...args) {
  const r = spawnSync(bin, args, { cwd: work, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 });
  if (r.error !== undefined) throw r.error;
  if (r.status === null) throw new Error(`localidraw ${args.join(" ")} was killed by ${r.signal}\n${r.stdout}\n${r.stderr}`);
  return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function expectExit(code, ...args) {
  const r = localidraw(...args);
  assert.equal(r.code, code, `localidraw ${args.join(" ")} exited ${r.code}, expected ${code}\n${r.stdout}\n${r.stderr}`);
  return r;
}

const statusJson = (code) => JSON.parse(expectExit(code, "service", "status", "--json").stdout);

const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, fn, ms = 60_000) {
  const end = Date.now() + ms;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      /* not yet */
    }
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(500);
  }
}
const health = async (port) => {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok ? await res.json() : undefined;
  } catch {
    return undefined;
  }
};
const projects = async (port) => (await (await fetch(`http://127.0.0.1:${port}/api/projects`)).json()).projects;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whether the manager still starts it at the next login: `stop` must leave that alone (SPEC §1). */
function stillEnabled(unit) {
  if (process.platform === "darwin") {
    const disabled = spawnSync("launchctl", ["print-disabled", `gui/${process.getuid()}`], { encoding: "utf8" }).stdout;
    return fs.existsSync(unit) && !new RegExp(`"net\\.edspencer\\.localidraw" => (true|disabled)`).test(disabled);
  }
  return spawnSync("systemctl", ["--user", "is-enabled", "localidraw.service"], { encoding: "utf8" }).stdout.trim() === "enabled";
}

let installed = false;
try {
  step("pack it, and install it into a temporary prefix");
  const packed = execFileSync("npm", ["pack", "--json", "--pack-destination", tmp], { cwd: root, encoding: "utf8", env: { ...process.env, NODE_ENV: "development" }, stdio: ["ignore", "pipe", "inherit"] });
  const tarball = path.join(tmp, JSON.parse(packed.slice(packed.search(/^\[/m))).at(-1).filename);
  execFileSync("npm", ["install", "--global", "--prefix", prefix, "--no-audit", "--no-fund", tarball], { stdio: ["ignore", "ignore", "inherit"] });
  const cli = fs.realpathSync(path.join(prefix, "lib", "node_modules", "localidraw", "dist", "server", "cli.js"));
  const version = expectExit(0, "--version").stdout.trim();
  assert.match(version, /^\d+\.\d+\.\d+/);
  step(`installed localidraw@${version}`);

  step("status with nothing installed: exit 4");
  const before = statusJson(4);
  assert.equal(before.installed, false, `a service is already installed here (${before.unit}): use a throwaway machine`);
  const unit = before.unit;

  step("install from npx's cache: refused, and nothing written");
  const npx = spawnSync("npx", ["-y", `--package=${tarball}`, "localidraw", "service", "install", canvases], {
    cwd: work, env: { ...env, npm_config_cache: path.join(tmp, "npm-cache") }, encoding: "utf8",
  });
  assert.equal(npx.status, 1, `npx install exited ${npx.status}\n${npx.stdout}\n${npx.stderr}`);
  assert.match(npx.stderr, /npx's cache/);
  assert.ok(!fs.existsSync(unit), "nothing written");

  const port = await freePort();
  step(`service install ${canvases} --port ${port}`);
  installed = true;
  const out = expectExit(0, "service", "install", canvases, "--port", String(port)).stdout;
  assert.match(out, new RegExp(`running at http://localhost:${port}/`));
  const answer = await until("health", () => health(port));
  assert.equal(answer.version, version, "/api/health reports the version it runs (SPEC §8)");
  assert.equal((await projects(port))[0]?.canvases?.[0]?.path, "project/one.excalidraw", "it serves the folder it was given");

  step("the unit runs the installed CLI with serve and the folder, and logs to ~/.localidraw/logs/service.log");
  const unitText = fs.readFileSync(unit, "utf8");
  const logFile = path.join(home, "logs", "service.log");
  assert.ok(unitText.includes(cli), `the unit runs the installed CLI (${cli}):\n${unitText}`);
  const runsServe = process.platform === "darwin"
    ? new RegExp(`<string>serve</string>\\s*<string>${esc(canvases)}</string>`).test(unitText)
    : new RegExp(`^ExecStart=.*${esc(cli)} serve ${esc(canvases)} --port ${port} --host 127\\.0\\.0\\.1$`, "m").test(unitText);
  assert.ok(runsServe, `it runs \`serve <folder>\`:\n${unitText}`);
  assert.ok(unitText.includes(logFile), `it logs to ${logFile}:\n${unitText}`);
  assert.ok(!/fnm_multishells|_npx|node_modules\/\.bin/.test(unitText), "no per-shell PATH entries");
  if (process.platform === "darwin") execFileSync("plutil", ["-lint", unit], { stdio: "inherit" });
  await until(`the banner in ${logFile}`, () => fs.readFileSync(logFile, "utf8").includes(`Localidraw ${version}: http://localhost:${port}/`));

  step("status: exit 0, running, answering, versions agree");
  console.log(expectExit(0, "service", "status").stdout);
  let s = statusJson(0);
  assert.equal(s.running, true);
  assert.equal(s.answering, true);
  assert.equal(s.port, port);
  assert.equal(s.folder, canvases);
  assert.equal(s.cli, cli);
  assert.equal(s.log, logFile);
  assert.equal(s.installedVersion, version);
  assert.equal(s.runningVersion, version);
  assert.deepEqual(s.warnings, [], JSON.stringify(s.warnings));
  if (process.platform === "linux") assert.equal(s.linger, true, "CI enables lingering");
  else assert.equal(s.linger, null, "launchd has no linger");

  step("runtime.json: in ~/.localidraw, not group or world readable, naming the supervisor's pid");
  const runtimeFile = path.join(home, "runtime.json");
  const runtime = JSON.parse(fs.readFileSync(runtimeFile, "utf8"));
  assert.equal(runtime.pid, s.pid);
  assert.equal(runtime.port, port);
  assert.equal(runtime.version, version);
  assert.equal(fs.statSync(runtimeFile).mode & 0o077, 0);

  step("busy: 0 against the real service, then 75 while a write is held half-sent, and stop and restart refuse");
  assert.deepEqual(JSON.parse(expectExit(0, "busy", "--json").stdout).counts, { canvas: 0, library: 0 });
  // A new canvas whose body is held back: the real server counts it from the request's start until it's answered.
  // Its connection belongs to this process, but the server answering it is the service's, so a spawnSync below
  // can't block it (a stand-in server in this process would be blocked, and read as not running).
  const body = JSON.stringify({ path: "project/busy-check" });
  let held;
  const created = new Promise((ok, fail) => {
    held = http.request({ host: "127.0.0.1", port, method: "POST", path: "/api/canvases",
      headers: { host: `localhost:${port}`, "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, (res) => { res.resume(); res.on("end", () => ok(res.statusCode)); });
    held.on("error", fail);
  });
  held.write(body.slice(0, 5));
  const busyNow = async () => (await (await fetch(`http://127.0.0.1:${port}/api/busy`)).json()).busy;
  await until("/api/busy to count the held write", busyNow);
  assert.match(expectExit(75, "busy").stdout, /^Localidraw is busy: 1 canvas save is running\.\n$/);
  for (const verb of ["stop", "restart"]) {
    assert.match(expectExit(75, "service", verb).stderr, /^localidraw: Localidraw is busy: 1 canvas save is running\. Try again/, verb);
  }
  assert.equal(statusJson(0).pid, s.pid, "refused: still the same process, still answering");
  held.end(body.slice(5));
  assert.equal(await created, 201);
  await until("/api/busy to be idle again", async () => !(await busyNow()));
  expectExit(0, "busy");
  fs.rmSync(path.join(canvases, "project", "busy-check.excalidraw"));

  step("--dry-run prints the unit and leaves the installed one alone");
  const mtime = fs.statSync(unit).mtimeMs;
  const dry = expectExit(0, "service", "install", "--dry-run").stdout;
  assert.ok(dry.includes(cli) && dry.includes(String(port)), dry);
  assert.equal(fs.statSync(unit).mtimeMs, mtime);

  step("logs, and an unknown flag");
  assert.ok(expectExit(0, "service", "logs", "-n", "5").stdout.includes(`Localidraw ${version}`));
  const bad = expectExit(2, "service", "status", "--nope");
  assert.match(bad.stderr, /^localidraw: unknown option --nope\n\nUsage: localidraw service/);

  step(`SIGKILL pid ${s.pid}: the manager brings it back`);
  const old = s.pid;
  process.kill(old, "SIGKILL");
  await until("a new process", () => {
    const n = JSON.parse(localidraw("service", "status", "--json").stdout);
    return n.running && n.answering && n.pid !== old;
  });

  step("stop: exit 0, it goes down, runtime.json goes, status 3, and it's still enabled");
  expectExit(0, "service", "stop");
  await until(`nothing on ${port}`, async () => (await health(port)) === undefined);
  s = statusJson(3);
  assert.equal(s.installed, true);
  // The manager's stop is a SIGTERM, which is the clean exit that removes it.
  await until("runtime.json to go", () => !fs.existsSync(runtimeFile));
  assert.ok(stillEnabled(unit), "stop doesn't disable it: the next login starts it again");
  expectExit(0, "service", "logs", "-n", "3");
  expectExit(0, "service", "stop"); // already stopped

  step("start, then restart");
  expectExit(0, "service", "start");
  await until("health after start", () => health(port));
  const startedPid = statusJson(0).pid;
  expectExit(0, "service", "restart");
  await until("health after restart", () => health(port));
  assert.notEqual(statusJson(0).pid, startedPid, "restart started a new process");

  step("install --refresh re-writes the unit as it was");
  const unitBefore = fs.readFileSync(unit, "utf8");
  const refreshMtime = fs.statSync(unit).mtimeMs;
  await sleep(20);
  expectExit(0, "service", "install", "--refresh");
  await until("health after refresh", () => health(port));
  assert.ok(fs.statSync(unit).mtimeMs > refreshMtime, "the unit was re-written");
  assert.equal(fs.readFileSync(unit, "utf8"), unitBefore, "...with nothing about the service changed");

  step("install another folder, hosted: the one service moves there, and answers");
  const pidBefore = statusJson(0).pid;
  const moved = expectExit(0, "service", "install", other, "--host", "0.0.0.0", "--allowed-host", "draw.example").stdout;
  assert.match(moved, /moving it from .* to /);
  assert.match(moved, /has no login/);
  await until("the other folder", async () => (await projects(port))?.[0]?.canvases?.[0]?.path === "two.excalidraw");
  s = statusJson(0);
  assert.equal(s.folder, other);
  assert.equal(s.host, "0.0.0.0");
  assert.deepEqual(s.allowedHosts, ["draw.example"]);
  assert.notEqual(s.pid, pidBefore, "the reinstall replaced the running process, not left it serving");

  step("uninstall: the unit goes; the log and the canvases stay");
  const logBefore = fs.readFileSync(logFile, "utf8");
  expectExit(0, "service", "uninstall");
  installed = false;
  assert.ok(!fs.existsSync(unit), "the unit file is gone");
  await until(`nothing on ${port}`, async () => (await health(port)) === undefined);
  statusJson(4);
  expectExit(4, "service", "logs");
  assert.ok(fs.readFileSync(logFile, "utf8").startsWith(logBefore), "the log is kept");
  await until("runtime.json to go", () => !fs.existsSync(runtimeFile));
  assert.equal(fs.readFileSync(canvas, "utf8"), scene, "serving a canvas never wrote it");
  expectExit(0, "service", "uninstall"); // nothing to do
  step("ok");
} finally {
  if (installed) {
    try {
      localidraw("service", "uninstall");
    } catch (e) {
      console.error(`service-real: cleanup: ${e.message}`);
    }
  }
  try {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (e) {
    console.error(`service-real: cleanup: couldn't remove ${tmp}: ${e.message}`);
  }
}
