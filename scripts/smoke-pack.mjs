// Packs the package, installs the tarball into a temporary prefix, starts the installed CLI on a temporary folder
// and checks that it serves the page, the projects and a canvas, as a user's `npx localidraw` would. It also holds
// the package to a size budget.
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
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
const tmp = mkdtempSync(join(tmpdir(), "localidraw-smoke-"));
const fail = (msg) => { console.error(`smoke: ${msg}`); process.exitCode = 1; };
let child;
try {
  const tarball = execFileSync("npm", ["pack", "--silent", "--pack-destination", tmp], { cwd: root, encoding: "utf8" }).trim().split("\n").pop();
  execFileSync("npm", ["install", "--silent", "--prefix", join(tmp, "prefix"), join(tmp, tarball)], { stdio: "inherit" });
  const packed = statSync(join(tmp, tarball)).size;
  const unpacked = sizeOf(join(tmp, "prefix/node_modules/localidraw"));
  if (packed > MAX_PACKED) fail(`the package is ${mb(packed)} packed, over its ${mb(MAX_PACKED)} budget`);
  if (unpacked > MAX_UNPACKED) fail(`the package is ${mb(unpacked)} unpacked, over its ${mb(MAX_UNPACKED)} budget`);
  const folder = join(tmp, "drawings");
  execFileSync("mkdir", ["-p", join(folder, "project")]);
  writeFileSync(join(folder, "project/one.excalidraw"), JSON.stringify({ type: "excalidraw", version: 2, elements: [], appState: {}, files: {} }));
  const bin = join(tmp, "prefix/node_modules/.bin/localidraw");
  const port = String(20000 + Math.floor(Math.random() * 20000));
  child = spawn(bin, [folder, "--port", port], { stdio: ["ignore", "pipe", "inherit"] });
  const started = await new Promise((ok) => {
    child.stdout.on("data", (d) => { if (String(d).includes(`localhost:${port}`)) ok(true); });
    child.on("exit", () => ok(false));
    setTimeout(() => ok(false), 15000);
  });
  if (!started) throw new Error("the CLI didn't start");
  const base = `http://localhost:${port}`;
  const page = await fetch(`${base}/`);
  if (!page.ok || !(await page.text()).includes("/static/app.js")) fail("no page");
  for (const asset of ["/static/app.js", "/static/app.css", "/static/favicon.svg"]) {
    if (!(await fetch(base + asset)).ok) fail(`missing ${asset}`);
  }
  const { projects } = await (await fetch(`${base}/api/projects`)).json();
  if (projects?.[0]?.canvases?.[0]?.path !== "project/one.excalidraw") fail(`unexpected projects: ${JSON.stringify(projects)}`);
  const canvas = await fetch(`${base}/api/canvas?path=project/one.excalidraw`);
  if (!canvas.ok) fail("can't read the canvas");
  if (!process.exitCode) console.log(`smoke: ${tarball} installs, starts and serves (${mb(packed)} packed, ${mb(unpacked)} unpacked)`);
} catch (err) {
  fail(err.message);
} finally {
  child?.kill();
  rmSync(tmp, { recursive: true, force: true });
}
