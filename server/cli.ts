#!/usr/bin/env node
// localidraw [folder] [--port <n>] [--open] [--host <addr> --allowed-host <name>…] [--poll [ms]]
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_PORT, parsePort } from "./port.ts";
import { listProjects } from "./files.ts";
import { pkg, webDir } from "./package.ts";
import { isLoopbackAddress, parseAllowedHost } from "./security.ts";
import { DEFAULT_HOST, DEFAULT_POLL, startServer } from "./server.ts";

const HELP = `localidraw ${pkg.version}: a local Excalidraw for the .excalidraw files in a folder

Usage: localidraw [folder] [options]

  folder            where the canvases are (default: the current folder). Each folder under it that
                    holds .excalidraw files is a project; node_modules and dot-folders are skipped.

Options:
  --port <n>        the port (default ${DEFAULT_PORT}, or $PORT)
  --open            open it in your browser
  -v, --version     print the version
  -h, --help        print this

Hosting it (see https://localidraw.edspencer.net/self-hosting/):
  --host <addr>     the address to listen on (default ${DEFAULT_HOST}, or $LOCALIDRAW_HOST). Anything but
                    loopback needs --allowed-host.
  --allowed-host <name>
                    a host name to answer to besides localhost, e.g. draw.example.com; repeat it for more
                    (or $LOCALIDRAW_ALLOWED_HOSTS, comma-separated). Requests for any other name are refused.
  --poll [ms]       look for changes by checking the files every ms (default ${DEFAULT_POLL}) instead of by
                    file events, for a folder on a network mount (NFS, SMB) or a Docker bind mount
                    (or $LOCALIDRAW_POLL: the ms, or true)

By default it listens on 127.0.0.1 only, and it saves to the files as you draw. It has no login of its own: when
you host it, put it behind a reverse proxy that does authentication.
`;

function fail(message: string): never {
  process.stderr.write(`localidraw: ${message}\n`);
  process.exit(2);
}

const args = process.argv.slice(2);
let folder: string | undefined;
let portArg: string | undefined;
let open = false;
let hostArg: string | undefined;
let allowedArgs: string[] | undefined;
let pollArg: string | undefined;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "-h" || a === "--help") { process.stdout.write(HELP); process.exit(0); }
  else if (a === "-v" || a === "--version") { process.stdout.write(`${pkg.version}\n`); process.exit(0); }
  else if (a === "--open") open = true;
  else if (a === "--port") portArg = args[++i] ?? fail("--port needs a number");
  else if (a.startsWith("--port=")) portArg = a.slice("--port=".length);
  else if (a === "--host") hostArg = args[++i] ?? fail("--host needs an address");
  else if (a.startsWith("--host=")) hostArg = a.slice("--host=".length);
  else if (a === "--allowed-host") (allowedArgs ??= []).push(args[++i] ?? fail("--allowed-host needs a host name"));
  else if (a.startsWith("--allowed-host=")) (allowedArgs ??= []).push(a.slice("--allowed-host=".length));
  else if (a === "--poll") pollArg = /^\d+$/.test(args[i + 1] ?? "") ? args[++i] : "true"; // the ms are optional
  else if (a.startsWith("--poll=")) pollArg = a.slice("--poll=".length);
  else if (a.startsWith("-")) fail(`unknown option ${a} (see --help)`);
  else if (folder === undefined) folder = a;
  else fail(`one folder only (got ${folder} and ${a})`);
}

const root = resolve(folder ?? ".");
if (!existsSync(root) || !statSync(root).isDirectory()) fail(`${root} isn't a folder`);
const given = portArg ?? process.env.PORT;
const port = given === undefined || given === "" ? DEFAULT_PORT : parsePort(given) ?? fail(`not a port number: ${given}`);

// A flag wins over its environment variable; --allowed-host flags replace $LOCALIDRAW_ALLOWED_HOSTS, not add to it.
const env = (name: string) => process.env[name]?.trim() || undefined;
const host = hostArg?.trim() || env("LOCALIDRAW_HOST") || DEFAULT_HOST;
const allowedHosts = (allowedArgs ?? env("LOCALIDRAW_ALLOWED_HOSTS")?.split(",") ?? [])
  .map((h) => h.trim())
  .filter(Boolean)
  .map((h) => parseAllowedHost(h) ?? fail(`not a host name: ${h} (give the name alone, without http:// or a port)`));
if (!isLoopbackAddress(host) && allowedHosts.length === 0) {
  fail(`refusing to listen on ${host} without an allowed host name.
  Anyone who can reach that address could read and change your canvases, and Localidraw has no login.
  Name the host it's reached by, e.g. --allowed-host draw.example.com (or LOCALIDRAW_ALLOWED_HOSTS), and put it
  behind a reverse proxy that does authentication.`);
}
const pollValue = pollArg ?? env("LOCALIDRAW_POLL");
let poll: number | undefined;
if (pollValue !== undefined && !/^(false|off|no|0)$/i.test(pollValue)) {
  poll = /^(true|on|yes)$/i.test(pollValue) ? DEFAULT_POLL : /^\d+$/.test(pollValue) ? Number(pollValue) : fail(`--poll takes a number of milliseconds, not ${pollValue}`);
  if (poll < 100) fail(`--poll ${poll} is too often; give at least 100 ms`);
}

if (!existsSync(resolve(webDir, "index.html"))) fail("the page isn't built; run `npm run build` in the localidraw checkout");

try {
  const { url } = await startServer({ root, port, webDir, host, allowedHosts, poll });
  const count = listProjects(root).reduce((n, p) => n + p.canvases.length, 0);
  const local = isLoopbackAddress(host);
  process.stdout.write([
    `Localidraw ${pkg.version}: ${url}`,
    `  ${root} (${count} canvas${count === 1 ? "" : "es"})`,
    `  listening on ${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}:${port || new URL(url).port}${local ? " (this machine only)" : ""}`,
    `  answering to localhost${allowedHosts.map((h) => `, ${h}`).join("")}`,
    `  watching for changes ${poll ? `by checking the files every ${poll} ms` : "by file events"}`,
    ...(local ? [] : [`  Localidraw has no login: anyone who can reach this port can read and change these canvases. Put it behind a reverse proxy that does authentication.`]),
    "",
  ].join("\n"));
  if (open) {
    const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
    spawn(cmd, [url], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
  }
} catch (err) {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "EADDRINUSE") fail(`port ${port} is in use: is Localidraw already running? (try --port)`);
  throw err;
}
