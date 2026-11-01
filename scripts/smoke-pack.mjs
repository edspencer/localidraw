// Packs the package, installs the tarball into a temporary prefix, starts the installed CLI on a temporary folder
// and checks that it serves the page, the projects and a canvas, as a user's `npx localidraw` would.
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const tmp = mkdtempSync(join(tmpdir(), "localidraw-smoke-"));
const fail = (msg) => { console.error(`smoke: ${msg}`); process.exitCode = 1; };
let child;
try {
  const tarball = execFileSync("npm", ["pack", "--silent", "--pack-destination", tmp], { cwd: root, encoding: "utf8" }).trim().split("\n").pop();
  execFileSync("npm", ["install", "--silent", "--prefix", join(tmp, "prefix"), join(tmp, tarball)], { stdio: "inherit" });
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
  if (!process.exitCode) console.log(`smoke: ${tarball} installs, starts and serves`);
} catch (err) {
  fail(err.message);
} finally {
  child?.kill();
  rmSync(tmp, { recursive: true, force: true });
}
