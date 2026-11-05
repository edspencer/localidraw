#!/usr/bin/env node
// localidraw [serve] [folder] [--port <n>] [--open] [--host <addr> --allowed-host <name>…] [--poll [ms]]
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { EXIT } from "./contract/exit-codes.ts";
import { createOutput, exitQuietlyOnEpipe, reportUsageError, UsageError } from "./contract/output.ts";
import { DEFAULT_PORT, parsePort } from "./port.ts";
import { listProjects } from "./files.ts";
import { pkg, webDir } from "./package.ts";
import { isLoopbackAddress, parseAllowedHost } from "./security.ts";
import { DEFAULT_HOST, DEFAULT_POLL, startServer } from "./server.ts";

/**
 * The command names, which win over a folder of the same name (SPEC §1): that folder is given as `./service`. Only
 * `serve` is here yet; the rest are reserved now, so a folder called `busy` doesn't change meaning when `busy` comes.
 */
const COMMANDS = ["serve", "service", "update", "upgrade", "busy", "doctor"];

/** How long a stop waits for the requests under way before it cuts them off. */
const DRAIN_MS = 5000;

const USAGE = `Usage: localidraw [serve] [folder] [--port <n>] [--open] [--host <addr> --allowed-host <name>…] [--poll [ms]]
       localidraw --help | --version
`;

const HELP = `localidraw ${pkg.version}: a local Excalidraw for the .excalidraw files in a folder

Usage: localidraw [serve] [folder] [options]

  serve             run it in the foreground, until Ctrl-C. It's the default: \`localidraw ~/notes\` is
                    \`localidraw serve ~/notes\`.
  folder            where the canvases are (default: the current folder). Each folder under it that
                    holds .excalidraw files is a project; node_modules and dot-folders are skipped. A
                    folder named like a command (serve, service, update, busy, doctor) is given as
                    ./service. service, update, busy and doctor are coming in later versions.

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

Ctrl-C or SIGTERM stops it once the saves under way are written, and it exits 0. It exits 1 if it fails (the
port is in use, say), and 2 for a usage error.

By default it listens on 127.0.0.1 only, and it saves to the files as you draw. It has no login of its own: when
you host it, put it behind a reverse proxy that does authentication.
`;

const out = createOutput({ tool: "localidraw" });
exitQuietlyOnEpipe();

/** Reads the arguments and serves. Resolves with an exit code if it ends there, or undefined once it's serving. */
async function main(args: string[]): Promise<number | undefined> {
  let command: string | undefined;
  let folder: string | undefined;
  let portArg: string | undefined;
  let open = false;
  let hostArg: string | undefined;
  let allowedArgs: string[] | undefined;
  let pollArg: string | undefined;
  const value = (i: number, what: string) => {
    if (args[i] === undefined) throw new UsageError(`${args[i - 1]} needs ${what}`);
    return args[i];
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-h" || a === "--help") { out.say(HELP.trimEnd()); return EXIT.OK; }
    else if (a === "-v" || a === "--version") { out.say(pkg.version); return EXIT.OK; }
    else if (a === "--open") open = true;
    else if (a === "--port") portArg = value(++i, "a number");
    else if (a.startsWith("--port=")) portArg = a.slice("--port=".length);
    else if (a === "--host") hostArg = value(++i, "an address");
    else if (a.startsWith("--host=")) hostArg = a.slice("--host=".length);
    else if (a === "--allowed-host") (allowedArgs ??= []).push(value(++i, "a host name"));
    else if (a.startsWith("--allowed-host=")) (allowedArgs ??= []).push(a.slice("--allowed-host=".length));
    else if (a === "--poll") pollArg = /^\d+$/.test(args[i + 1] ?? "") ? args[++i] : "true"; // the ms are optional
    else if (a.startsWith("--poll=")) pollArg = a.slice("--poll=".length);
    else if (a.startsWith("-")) throw new UsageError(`unknown option ${a}`);
    else if (command === undefined && folder === undefined && COMMANDS.includes(a)) {
      command = a;
      if (command !== "serve") {
        throw new UsageError(`\`localidraw ${command}\` is coming in a later version. To serve a folder called ${command}, give it as ./${command}`);
      }
    }
    else if (folder === undefined) folder = a;
    else throw new UsageError(`one folder only (got ${folder} and ${a})`);
  }

  const root = resolve(folder ?? ".");
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new UsageError(`${root} isn't a folder`);
  const given = portArg ?? process.env.PORT;
  let port = DEFAULT_PORT;
  if (given !== undefined && given !== "") {
    const parsed = parsePort(given);
    if (parsed === null) throw new UsageError(`not a port number: ${given}`);
    port = parsed;
  }

  // A flag wins over its environment variable; --allowed-host flags replace $LOCALIDRAW_ALLOWED_HOSTS, not add to it.
  const env = (name: string) => process.env[name]?.trim() || undefined;
  const host = hostArg?.trim() || env("LOCALIDRAW_HOST") || DEFAULT_HOST;
  const allowedHosts = (allowedArgs ?? env("LOCALIDRAW_ALLOWED_HOSTS")?.split(",") ?? [])
    .map((h) => h.trim())
    .filter(Boolean)
    .map((h) => {
      const parsed = parseAllowedHost(h);
      if (!parsed) throw new UsageError(`not a host name: ${h} (give the name alone, without http:// or a port)`);
      return parsed;
    });
  if (!isLoopbackAddress(host) && allowedHosts.length === 0) {
    throw new UsageError(`refusing to listen on ${host} without an allowed host name.
  Anyone who can reach that address could read and change your canvases, and Localidraw has no login.
  Name the host it's reached by, e.g. --allowed-host draw.example.com (or LOCALIDRAW_ALLOWED_HOSTS), and put it
  behind a reverse proxy that does authentication.`);
  }
  const pollValue = pollArg ?? env("LOCALIDRAW_POLL");
  let poll: number | undefined;
  if (pollValue !== undefined && !/^(false|off|no|0)$/i.test(pollValue)) {
    if (/^(true|on|yes)$/i.test(pollValue)) poll = DEFAULT_POLL;
    else if (/^\d+$/.test(pollValue)) poll = Number(pollValue);
    else throw new UsageError(`--poll takes a number of milliseconds, not ${pollValue}`);
    if (poll < 100) throw new UsageError(`--poll ${poll} is too often; give at least 100 ms`);
  }

  if (!existsSync(resolve(webDir, "index.html"))) return out.error("the page isn't built; run `npm run build` in the localidraw checkout");

  let running;
  try {
    running = await startServer({ root, port, webDir, host, allowedHosts, poll });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") return out.error(`port ${port} is in use: is Localidraw already running? (try --port)`);
    throw err;
  }
  const { url, drain } = running;
  // Ctrl-C and SIGTERM (a service manager, `docker stop`) stop it once the requests under way are answered, so a save
  // is never cut off half-written. A save that comes after is refused (503), and the page says "Not saved" and keeps
  // the drawing. A second one stops it at once.
  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) { out.warn(`Stopping now (${signal} again).`); process.exit(EXIT.FAILED); }
    stopping = true;
    const waiting = (n: number) => out.warn(`Stopping: waiting for ${n} request${n === 1 ? "" : "s"} under way (a save, say) to finish.`);
    drain(DRAIN_MS, waiting).then((cut) => {
      process.exitCode = cut === 0 ? EXIT.OK : out.error(`stopped with ${cut} request${cut === 1 ? "" : "s"} still under way after ${DRAIN_MS / 1000} s`);
      process.disconnect?.();
      // Everything is closed, so the process ends by itself; this is for anything that still holds it open.
      setTimeout(() => process.exit(), 1000).unref();
    });
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  // Windows has no SIGTERM to catch: something that stops it there sends Ctrl-C or Ctrl-Break (SIGBREAK), or, when it
  // started Localidraw with an IPC channel (a Node parent, a test), the message "stop". The channel alone doesn't keep
  // it running.
  if (process.platform === "win32") process.on("SIGBREAK", stop);
  if (process.channel) {
    process.on("message", (m) => { if (m === "stop") stop("stop message"); });
    process.channel.unref();
  }

  const count = listProjects(root).reduce((n, p) => n + p.canvases.length, 0);
  const local = isLoopbackAddress(host);
  // The banner is the first line on stdout (SPEC §3): nothing is written there before it.
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
    // On Windows, rundll32's FileProtocolHandler hands the URL to the default browser, as `start` would, without a
    // shell (`explorer <url>` works too, but it exits 1 and mangles some URLs).
    const [cmd, cmdArgs]: [string, string[]] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]] : ["xdg-open", [url]];
    spawn(cmd, cmdArgs, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
  }
  return undefined;
}

try {
  const code = await main(process.argv.slice(2));
  if (code !== undefined) process.exitCode = code;
} catch (err) {
  if (!(err instanceof UsageError)) throw err;
  process.exitCode = reportUsageError(out, err, USAGE);
}
