#!/usr/bin/env node
// localidraw [serve] [folder] [--port <n>] [--open] [--quiet] [--host <addr> --allowed-host <name>…] [--poll [ms]]
// localidraw service install | uninstall | start | stop | restart | status | logs (service.ts)
// localidraw busy [--json] · update [--check] [--to] [--yes] [--force] [--json] (update.ts) · doctor [--json] [--offline] (doctor.ts)
import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { runBusyCommand } from "./contract/busy-client.ts";
import { EXIT } from "./contract/exit-codes.ts";
import { createOutput, exitQuietlyOnEpipe, reportUsageError, UsageError } from "./contract/output.ts";
import { removeRuntimeFile, writeRuntimeFile } from "./contract/runtime-file.ts";
import { startLogRotation } from "./contract/service/rotate.ts";
import { serviceLogPath } from "./contract/service/spec.ts";
import { DEFAULT_PORT, parsePort } from "./port.ts";
import { hasCanvases, listProjects } from "./files.ts";
import { isThere, listedFolderHolding, readConfig, SCRATCH, scratchDir, type FolderEntry } from "./folders.ts";
import { ADD_USAGE, FOLDERS_USAGE, REMOVE_USAGE, runFolders } from "./folders-cli.ts";
import { localidrawHome, parseAllowedHosts, parsePoll, requireAllowedHost, safeHomeDir } from "./options.ts";
import { pkg, pkgRoot, webDir } from "./package.ts";
import { isLoopbackAddress } from "./security.ts";
import { BUSY_NOUNS, localFetch, realContext, runService, SERVICE_USAGE } from "./service.ts";
import { DEFAULT_HOST, DEFAULT_POLL, startServer } from "./server.ts";
import { parseUpdateArgs, runUpdateCommand, UPDATE_HELP, UPDATE_USAGE } from "./update.ts";
import { diagnose, doctorCode, DOCTOR_HELP, DOCTOR_USAGE, parseDoctorArgs, renderChecks } from "./doctor.ts";

/** The command names, which win over a folder of the same name (SPEC §1): that folder is given as `./service`. */
const COMMANDS = ["serve", "add", "remove", "folders", "service", "update", "upgrade", "busy", "doctor"];

/** How long a stop waits for the requests under way before it cuts them off. */
const DRAIN_MS = 5000;

const USAGE = `Usage: localidraw [serve] [folder] [--port <n>] [--open] [-q] [--host <addr> --allowed-host <name>…] [--poll [ms]]
       localidraw add <folder> [--name <name>] · remove <name|folder> · folders   [--json]
       localidraw service install | uninstall | start | stop | restart | status | logs   (localidraw service --help)
       localidraw busy [--json]
       localidraw update [--check] [--to <version|tag>] [--yes] [--force] [--json]
       localidraw doctor [--json] [--offline]
       localidraw --help | --version
`;

const BUSY_USAGE = `Usage: localidraw busy [--json]
`;

const BUSY_HELP = `localidraw busy: is the Localidraw running here in the middle of a save?

${BUSY_USAGE}
  --json            one JSON document on stdout

It exits 0 when it isn't, 75 while a canvas or the Library is being written, and 3 when no Localidraw is running.
For scripts and Watchtower, before a restart. It finds the one running here through ~/.localidraw/runtime.json.
`;

const HELP = `localidraw ${pkg.version}: a local Excalidraw for the .excalidraw files on your machine

Usage: localidraw [serve] [folder] [options]

  serve             run it in the foreground, until Ctrl-C. It's the default: \`localidraw\` is
                    \`localidraw serve\`.
                    With no folder, it serves Scratch (~/.localidraw/drawings) and the folders you've
                    added, and follows the list as it changes: no restart.
  folder            serve this one folder alone instead: no list, no Scratch. Each folder under it
                    that holds .excalidraw files is a project; node_modules and dot-folders are
                    skipped. A folder named like a command (serve, add, service, …) is given as
                    ./service.
  add <folder>      list a folder, so its canvases show too. --name <name> (default: its own name).
  remove <name>     take a folder off the list (its canvases stay where they are).
  folders           the list: Scratch, then the folders you've added. --json.
  service <command> run it in the background from login on, serving the list: install, uninstall,
                    start, stop, restart, status and logs. See \`localidraw service --help\`.
  busy [--json]     is it saving something right now? Exits 0 (no), 75 (yes) or 3 (not running).
  update            update it, and restart the service. --check says whether there's a newer version;
                    --to <version|tag>, --yes, --force, --json. See \`localidraw update --help\`.
  doctor            check that it can run here, with a fix for each problem. --json, --offline.

Options:
  --port <n>        the port (default ${DEFAULT_PORT}, or $PORT)
  --open            open it in your browser
  -q, --quiet       print only the first line, \`Localidraw <version>: <url>\`
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
port is in use, say), and 2 for a usage error. While it runs, ~/.localidraw/runtime.json says where.

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
  let quiet = false;
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
    else if (a === "-q" || a === "--quiet") quiet = true;
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
        if (i > 0) throw new UsageError(`\`${command}\` comes first: localidraw ${command === "service" ? "service <command>" : command} [options]`);
        usage = { service: SERVICE_USAGE, busy: BUSY_USAGE, update: UPDATE_USAGE, upgrade: UPDATE_USAGE, doctor: DOCTOR_USAGE, add: ADD_USAGE, remove: REMOVE_USAGE, folders: FOLDERS_USAGE }[command]!;
        return await runCommand(command, args.slice(1));
      }
    }
    else if (folder === undefined) folder = a;
    else throw new UsageError(`one folder only (got ${folder} and ${a})`);
  }

  // With a folder, that folder alone. Without, the list (~/.localidraw/config.json) and Scratch.
  const root = folder === undefined ? undefined : resolve(folder);
  if (root !== undefined && (!existsSync(root) || !statSync(root).isDirectory())) throw new UsageError(`${root} isn't a folder`);
  const home = localidrawHome();
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
  const allowedHosts = parseAllowedHosts(allowedArgs ?? env("LOCALIDRAW_ALLOWED_HOSTS")?.split(",") ?? []);
  requireAllowedHost(host, allowedHosts);
  const poll = parsePoll(pollArg ?? env("LOCALIDRAW_POLL"));

  if (!existsSync(resolve(webDir, "index.html"))) return out.error("the page isn't built; run `npm run build` in the localidraw checkout");

  let running;
  try {
    running = await startServer({ ...(root !== undefined ? { root } : { home }), port, webDir, host, allowedHosts, poll });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") return out.error(`port ${port} is in use: is Localidraw already running? (try --port)`);
    throw err;
  }
  const { url, drain } = running;
  // ~/.localidraw/runtime.json (SPEC §4): how `localidraw busy` and `update` find this instance. 0600, written once
  // it's listening, and removed on a clean stop if it still names this process. Not being able to write it doesn't
  // stop it serving.
  try {
    writeRuntimeFile(home, { pid: process.pid, port: Number(new URL(url).port), url, version: pkg.version });
  } catch (err) {
    out.warn(`localidraw: couldn't write ${home}/runtime.json (${(err as Error).message}); serving anyway.`);
  }
  process.on("exit", () => { try { removeRuntimeFile(home); } catch { /* it's going anyway */ } });
  // The service's log, ~/.localidraw/logs/service.log (SPEC §7): launchd or systemd appends to it and never trims it,
  // so Localidraw rotates it itself, now and every 15 minutes, past 8 MB, keeping 3. A foreground run has no such file,
  // and this does nothing. The timer is unref'd: it never keeps the process alive.
  startLogRotation(serviceLogPath(home), { warn: (m) => out.warn(`localidraw: ${m}`) });
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

  const count = (dir: string) => listProjects(dir).reduce((n, p) => n + p.canvases.length, 0);
  const canvases = (n: number) => `${n} canvas${n === 1 ? "" : "es"}`;
  /** What it serves, a line each: the folder, or Scratch and the list. */
  const serving: string[] = [];
  if (!quiet && root !== undefined) serving.push(`  ${root} (${canvases(count(root))})`);
  else if (!quiet) {
    let listed: FolderEntry[] = [];
    try { listed = readConfig(home).folders; } catch { /* the server has said why, on stderr */ }
    const width = Math.max(SCRATCH.length, ...listed.map((f) => f.name.length));
    const scratch = scratchDir(home);
    serving.push(`  ${SCRATCH.padEnd(width)}  ${scratch} (${isThere(scratch) ? canvases(count(scratch)) : "nothing yet"})`);
    for (const f of listed) serving.push(`  ${f.name.padEnd(width)}  ${f.path} (${isThere(f.path) ? canvases(count(f.path)) : "missing"})`);
  }
  const local = isLoopbackAddress(host);
  // The banner is the first line on stdout (SPEC §3): nothing is written there before it. --quiet prints that line
  // alone; the warning that a hosted Localidraw has no login still goes out, on stderr.
  const noLogin = `  Localidraw has no login: anyone who can reach this port can read and change these canvases. Put it behind a reverse proxy that does authentication.`;
  if (quiet) {
    process.stdout.write(`Localidraw ${pkg.version}: ${url}\n`);
    if (!local) process.stderr.write(`${noLogin.trim()}\n`);
  } else process.stdout.write([
    `Localidraw ${pkg.version}: ${url}`,
    ...serving,
    `  listening on ${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}:${port || new URL(url).port}${local ? " (this machine only)" : ""}`,
    `  answering to localhost${allowedHosts.map((h) => `, ${h}`).join("")}`,
    `  watching for changes ${poll ? `by checking the files every ${poll} ms` : "by file events"}`,
    ...(local ? [] : [noLogin]),
    "",
  ].join("\n"));
  if (root === undefined) hintAboutHere(home);

  if (open) {
    // On Windows, rundll32's FileProtocolHandler hands the URL to the default browser, as `start` would, without a
    // shell (`explorer <url>` works too, but it exits 1 and mangles some URLs).
    const [cmd, cmdArgs]: [string, string[]] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]] : ["xdg-open", [url]];
    spawn(cmd, cmdArgs, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
  }
  return undefined;
}

/**
 * Serving the list from a folder that has canvases but isn't in it (someone ran `localidraw` in a project): say on
 * stderr how to keep it, or how to open just it.
 */
function hintAboutHere(home: string) {
  const here = process.cwd();
  let listed: FolderEntry[];
  try { listed = readConfig(home).folders; } catch { return; }
  if (listedFolderHolding(listed, here) || listedFolderHolding([{ path: home, name: "" }], here)) return;
  if (!hasCanvases(here)) return;
  process.stderr.write(`This folder has canvases, but isn't in the list: \`localidraw add .\` keeps it there, and \`localidraw .\` opens just it.\n`);
}

/** `service`, `busy`, `update` (and `upgrade`, its hidden alias) and `doctor`, with the arguments after the name. */
async function runCommand(command: string, rest: string[]): Promise<number> {
  if (command === "add" || command === "remove" || command === "folders") return runFolders(command, rest, localidrawHome());
  const ctx = realContext(pkgRoot, safeHomeDir());
  if (command === "service") return runService(rest, ctx);
  if (command === "busy") {
    const json = rest.includes("--json");
    if (rest.some((a) => a === "-h" || a === "--help")) { out.say(BUSY_HELP.trimEnd()); return EXIT.OK; }
    const extra = rest.find((a) => a !== "--json");
    if (extra !== undefined) throw new UsageError(extra.startsWith("-") ? `unknown option ${extra}` : `\`busy\` takes no argument (got ${extra})`);
    return runBusyCommand({ home: localidrawHome(ctx.homeDir), out: createOutput({ tool: "localidraw", json }), name: "Localidraw", nouns: BUSY_NOUNS, fetch: localFetch });
  }
  if (command === "update" || command === "upgrade") {
    const opts = parseUpdateArgs(rest);
    if (opts === "help") { out.say(UPDATE_HELP.trimEnd()); return EXIT.OK; }
    return runUpdateCommand(opts, ctx, createOutput({ tool: "localidraw", json: opts.json === true }), process.argv[1]);
  }
  const opts = parseDoctorArgs(rest);
  if (opts === "help") { out.say(DOCTOR_HELP.trimEnd()); return EXIT.OK; }
  const manifest = JSON.parse(readFileSync(resolve(pkgRoot, "package.json"), "utf8")) as { engines?: { node?: string } };
  const { checks, notice } = await diagnose({ ctx, version: pkg.version, engines: manifest.engines?.node, entry: process.argv[1], webDir, cwd: process.cwd(), offline: opts.offline });
  const code = doctorCode(checks);
  if (opts.json) process.stdout.write(`${JSON.stringify({ ok: code === 0, version: pkg.version, checks }, null, 2)}\n`);
  else process.stdout.write(renderChecks(checks));
  if (notice) process.stderr.write(`\n${notice}\n`);
  return code;
}

/** The usage printed after a usage error: the command's own, once there is one. */
let usage = USAGE;

try {
  const code = await main(process.argv.slice(2));
  if (code !== undefined) process.exitCode = code;
} catch (err) {
  if (!(err instanceof UsageError)) throw err;
  process.exitCode = reportUsageError(out, err, usage);
}
