// Packs the package, installs the tarball into a temporary prefix, starts the installed CLI on a temporary folder
// and checks that it serves the page, the projects and a canvas, as a user's `npx localidraw` would. It also holds
// the package to a size budget.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The package is big because it works offline: 12 of its 13 MB of fonts are Xiaolai, Excalidraw's CJK handwriting
// font, which we keep. These budgets stop it growing unnoticed. At 0.1.0 it was 15.8 MB packed and 21.7 MB
// unpacked. If a change genuinely needs more, raise them in that PR and say why.
const MAX_PACKED = 16.5e6;
const MAX_UNPACKED = 23e6;
const mb = (bytes) => `${(bytes / 1e6).toFixed(1)} MB`;
const sizeOf = (path) => statSync(path).isDirectory() ? readdirSync(path).reduce((n, f) => n + sizeOf(join(path, f)), 0) : statSync(path).size;

const root = join(import.meta.dirname, "..");
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const tmp = mkdtempSync(join(tmpdir(), "localidraw-smoke-"));
const windows = process.platform === "win32";
// npm through its own CLI when this runs as an npm script (npm_execpath), so no shell is needed: on Windows, npm is
// npm.cmd, which execFile can't start without one. Run directly, it falls back to the shell's npm.
const npm = (args, opts) => process.env.npm_execpath
  ? execFileSync(process.execPath, [process.env.npm_execpath, ...args], opts)
  : execFileSync(windows ? "npm.cmd" : "npm", args, { ...opts, shell: windows });
const fail = (msg) => { console.error(`smoke: ${msg}`); process.exitCode = 1; };
let child;
try {
  const tarball = npm(["pack", "--silent", "--pack-destination", tmp], { cwd: root, encoding: "utf8" }).trim().split(/\r?\n/).pop();
  npm(["install", "--silent", "--prefix", join(tmp, "prefix"), join(tmp, tarball)], { stdio: "inherit" });
  const packed = statSync(join(tmp, tarball)).size;
  const unpacked = sizeOf(join(tmp, "prefix/node_modules/localidraw"));
  if (packed > MAX_PACKED) fail(`the package is ${mb(packed)} packed, over its ${mb(MAX_PACKED)} budget`);
  if (unpacked > MAX_UNPACKED) fail(`the package is ${mb(unpacked)} unpacked, over its ${mb(MAX_UNPACKED)} budget`);
  const folder = join(tmp, "drawings");
  mkdirSync(join(folder, "project"), { recursive: true });
  writeFileSync(join(folder, "project/one.excalidraw"), JSON.stringify({ type: "excalidraw", version: 2, elements: [], appState: {}, files: {} }));
  // The installed command, as a user's shell finds it. On Windows that's a .cmd shim, which needs a shell to start (and
  // killing the shell would leave the server running), so there the check is that the shim is there, and the script
  // it points at is run with node.
  const bin = join(tmp, "prefix/node_modules/.bin", windows ? "localidraw.cmd" : "localidraw");
  if (!existsSync(bin)) throw new Error(`npm didn't install the command (${bin})`);
  const installed = join(tmp, "prefix/node_modules/localidraw");
  const [cmd, ...cmdArgs] = windows ? [process.execPath, join(installed, JSON.parse(readFileSync(join(installed, "package.json"), "utf8")).bin.localidraw)] : [bin];
  const port = String(20000 + Math.floor(Math.random() * 20000));
  // A throwaway home: serve writes ~/.localidraw/runtime.json, and service looks for its unit under it.
  const home = join(tmp, "home");
  mkdirSync(home);
  const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config") };
  const status = spawnSync(cmd, [...cmdArgs, "service", "status", "--json"], { env, encoding: "utf8" });
  if (status.status !== 4 || JSON.parse(status.stdout).installed !== false) fail(`service status exited ${status.status}, not 4: ${status.stdout}${status.stderr}`);
  child = spawn(cmd, [...cmdArgs, folder, "--port", port], { stdio: ["ignore", "pipe", "inherit"], env });
  const started = await new Promise((ok) => {
    child.stdout.on("data", (d) => { if (String(d).includes(`localhost:${port}`)) ok(true); });
    child.on("exit", () => ok(false));
    setTimeout(() => ok(false), 15000);
  });
  if (!started) throw new Error("the CLI didn't start");
  const base = `http://localhost:${port}`;
  const page = await fetch(`${base}/`);
  const html = page.ok ? await page.text() : "";
  // The page's script and stylesheet have a hash in their names (scripts/build-web.mjs).
  const assets = [...html.matchAll(/(?:src|href)="(\/static\/[^"]+)"/g)].map((m) => m[1]);
  if (!assets.some((a) => /\/static\/app-\w+\.js$/.test(a)) || !assets.some((a) => /\/static\/app-\w+\.css$/.test(a))) fail("no page");
  for (const asset of assets) {
    if (!(await fetch(base + asset)).ok) fail(`missing ${asset}`);
  }
  const health = await (await fetch(`${base}/api/health`)).json();
  if (health.ok !== true || health.version !== version) fail(`unexpected health: ${JSON.stringify(health)}`);
  const runtime = JSON.parse(readFileSync(join(home, ".localidraw", "runtime.json"), "utf8"));
  if (runtime.pid !== child.pid && !windows) fail(`runtime.json names pid ${runtime.pid}, not ${child.pid}`);
  if (runtime.version !== version || runtime.port !== Number(port)) fail(`unexpected runtime.json: ${JSON.stringify(runtime)}`);
  const { projects } = await (await fetch(`${base}/api/projects`)).json();
  if (projects?.[0]?.canvases?.[0]?.path !== "project/one.excalidraw") fail(`unexpected projects: ${JSON.stringify(projects)}`);
  const canvas = await fetch(`${base}/api/canvas?path=project/one.excalidraw`);
  if (!canvas.ok) fail("can't read the canvas");
  if (!process.exitCode) console.log(`smoke: ${tarball} installs, starts and serves (${mb(packed)} packed, ${mb(unpacked)} unpacked)`);
} catch (err) {
  fail(err.message);
} finally {
  // Windows won't remove a folder a running process still has open, so wait for the server to exit first.
  if (child && child.exitCode === null && child.signalCode === null) await new Promise((done) => { child.once("exit", done); child.kill(); });
  rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
}
