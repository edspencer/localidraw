#!/usr/bin/env node
// localidraw [folder] [--port <n>] [--open]
import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_PORT, parsePort } from "./port.ts";
import { listProjects } from "./files.ts";
import { startServer } from "./server.ts";

const here = dirname(fileURLToPath(import.meta.url));
// From source (server/) and installed (dist/server/) alike, the package root is the nearest folder with package.json.
const pkgRoot = [resolve(here, ".."), resolve(here, "../..")].find((d) => existsSync(resolve(d, "package.json")))!;
const pkg = JSON.parse(readFileSync(resolve(pkgRoot, "package.json"), "utf8"));
const webDir = resolve(pkgRoot, "dist/web");

const HELP = `localidraw ${pkg.version}: a local Excalidraw for the .excalidraw files in a folder

Usage: localidraw [folder] [options]

  folder            where the canvases are (default: the current folder). Each folder under it that
                    holds .excalidraw files is a project; node_modules and dot-folders are skipped.

Options:
  --port <n>        the port (default ${DEFAULT_PORT}, or $PORT)
  --open            open it in your browser
  -v, --version     print the version
  -h, --help        print this

It listens on 127.0.0.1 only, and saves to the files as you draw.
`;

function fail(message: string): never {
  process.stderr.write(`localidraw: ${message}\n`);
  process.exit(2);
}

const args = process.argv.slice(2);
let folder: string | undefined;
let portArg: string | undefined;
let open = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "-h" || a === "--help") { process.stdout.write(HELP); process.exit(0); }
  else if (a === "-v" || a === "--version") { process.stdout.write(`${pkg.version}\n`); process.exit(0); }
  else if (a === "--open") open = true;
  else if (a === "--port") portArg = args[++i] ?? fail("--port needs a number");
  else if (a.startsWith("--port=")) portArg = a.slice("--port=".length);
  else if (a.startsWith("-")) fail(`unknown option ${a} (see --help)`);
  else if (folder === undefined) folder = a;
  else fail(`one folder only (got ${folder} and ${a})`);
}

const root = resolve(folder ?? ".");
if (!existsSync(root) || !statSync(root).isDirectory()) fail(`${root} isn't a folder`);
if (!existsSync(resolve(webDir, "index.html"))) fail("the page isn't built; run `npm run build` in the localidraw checkout");
const given = portArg ?? process.env.PORT;
const port = given === undefined || given === "" ? DEFAULT_PORT : parsePort(given) ?? fail(`not a port number: ${given}`);

try {
  const { url } = await startServer({ root, port, webDir });
  const count = listProjects(root).reduce((n, p) => n + p.canvases.length, 0);
  process.stdout.write(`Localidraw ${pkg.version}: ${url}\n  ${root} (${count} canvas${count === 1 ? "" : "es"})\n`);
  if (open) {
    const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
    spawn(cmd, [url], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
  }
} catch (err) {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "EADDRINUSE") fail(`port ${port} is in use: is Localidraw already running? (try --port)`);
  throw err;
}
