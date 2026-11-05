// `localidraw service install | uninstall | start | stop | restart | status | logs` (the CLI contract's SPEC §1, §7):
// Localidraw as a per-user service, a launchd LaunchAgent on macOS and a systemd --user unit on Linux, serving one
// folder from login on.
//
// - **One service per machine.** The unit is `net.edspencer.localidraw` / `localidraw.service`, and the folder it
//   serves is recorded in it, as `serve <folder>`. Installing another folder moves the service there.
// - **The unit records everything it runs with**: the folder, the port, the host, the allowed hosts and --poll, as
//   flags. Not the environment: `LOCALIDRAW_HOST` and the rest are `serve`'s, and a service that read them from
//   wherever it was installed would change when that shell did. So `install --refresh` (and `update`, which runs it
//   through the new CLI) re-renders a unit from the unit itself.
// - **Its home is `~/.localidraw`**: the log (`logs/service.log`), its working folder (`service/`) and `runtime.json`.
//   Never drawings. A folder inside it is refused.
// - **The hosting rules hold here too** (AGENTS.md): it listens on 127.0.0.1 unless `--host` says otherwise, and a
//   host beyond loopback needs `--allowed-host`, at install as at `serve`.
//
// The service managers themselves are the contract's reference code (contract/service/); this file is the commands
// around them and what they print. Everything that touches the machine comes in through `ServiceContext`, so the
// whole lifecycle is tested with a fake runner on any OS (test/service.test.ts), and for real in CI
// (scripts/service-real.mjs).
import { existsSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { request } from "node:http";
import { connect } from "node:net";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { EXIT } from "./contract/exit-codes.ts";
import { createOutput, UsageError, type Output, type OutputStream } from "./contract/output.ts";
import { guardBusy, type Nouns } from "./contract/busy-client.ts";
import { fetchHealth, waitForReady, type HealthAnswer } from "./contract/health.ts";
import { isEphemeralCachePath, underNodeModules } from "./contract/install-method.ts";
import { lingerAdvice, serviceManagerFor, UnsupportedPlatformError, type Runner, type ServiceIdentity, type ServiceManager, type ServiceState } from "./contract/service/index.ts";
import { renderPlist } from "./contract/service/launchd.ts";
import { DEFAULT_LOG_LINES, followFile, sizeOf, tailFile } from "./contract/service/logs.ts";
import { missingPaths } from "./contract/service/path-env.ts";
import { buildSpec, serviceLogPath } from "./contract/service/spec.ts";
import { renderUnit } from "./contract/service/systemd.ts";
import { readUpdateCheck, updateNotice, updateSummary, type UpdateSummary } from "./contract/update-check.ts";
import { localidrawHome, parseAllowedHosts, parsePoll, requireAllowedHost } from "./options.ts";
import { pkg } from "./package.ts";
import { DEFAULT_PORT, parsePort } from "./port.ts";
import { isLoopbackAddress } from "./security.ts";
import { DEFAULT_HOST } from "./server.ts";

export const LOCALIDRAW_SERVICE: ServiceIdentity = {
  name: "Localidraw",
  tool: "localidraw",
  label: "net.edspencer.localidraw",
  unit: "localidraw.service",
  description: "Localidraw: a local Excalidraw for a folder of .excalidraw files",
  documentation: "https://localidraw.edspencer.net/service/",
};

const ACTIONS = ["install", "uninstall", "start", "stop", "restart", "status", "logs"] as const;
type Action = (typeof ACTIONS)[number];

export const SERVICE_USAGE = `Usage: localidraw service install [folder] [--port <n>] [--host <addr> --allowed-host <name>…] [--poll [ms]]
                                 [--refresh] [--dry-run] [--from-checkout]
       localidraw service uninstall | start | stop [--force] | restart [--force]
       localidraw service status [--json]
       localidraw service logs [-f] [-n <lines>]
`;

export const SERVICE_HELP = `localidraw service: run Localidraw in the background, from login on, serving one folder

${SERVICE_USAGE}
  install [folder]  write the service (a launchd LaunchAgent on macOS, a systemd --user unit on Linux), start it,
                    and wait until it answers. There's one per machine; installing another folder moves it there.
                    A reinstall keeps the folder, port and host it finds unless you give new ones.
    --port <n>      the port (default ${DEFAULT_PORT})
    --host <addr>   the address to listen on (default ${DEFAULT_HOST}). Anything but loopback needs --allowed-host.
    --allowed-host <name>
                    a host name to answer to besides localhost; repeat it for more
    --poll [ms]     check the files every ms instead of watching for file events (network mounts)
    --refresh       re-write the installed service from what it records (\`update\` runs this)
    --dry-run       print the unit file it would write, and write nothing
    --from-checkout install from a git checkout rather than an installed package
  uninstall         stop it and remove the unit. The log and your canvases stay.
  start             start it, and wait until it answers
  stop              stop it until \`service start\`, or the next login. It stays installed.
  restart           stop and start it, re-writing the unit first if the Node or Localidraw it names has gone
  status [--json]   installed? running? answering? which version, folder and port? Exits 0, 3 (not running)
                    or 4 (not installed).
  logs [-f] [-n <lines>]
                    the last lines of ~/.localidraw/logs/service.log (default ${DEFAULT_LOG_LINES}); -f follows it

The service reads only its flags, not $LOCALIDRAW_HOST and the rest. Its log, its working folder and runtime.json
are in ~/.localidraw; your canvases stay in the folder it serves. More: https://localidraw.edspencer.net/service/
`;

/** What `service install` and the unit agree on: everything `serve` is run with. */
export interface Settings {
  folder: string;
  port: number;
  host: string;
  allowedHosts: string[];
  poll?: number;
}

/** `serve` and its flags, as the unit runs them. Every one is named, so a later default can't move the service. */
export function serveArgs(s: Settings): string[] {
  return [
    "serve", s.folder,
    "--port", String(s.port),
    "--host", s.host,
    ...s.allowedHosts.flatMap((h) => ["--allowed-host", h]),
    ...(s.poll !== undefined ? ["--poll", String(s.poll)] : []),
  ];
}

/** The settings an installed unit records, read back from its arguments (Node and the script already taken off). */
export function settingsOf(argv: readonly string[]): Partial<Settings> {
  const out: Partial<Settings> = {};
  let i = 0;
  if (argv[0] === "serve") i = 1;
  for (; i < argv.length; i++) {
    const a = argv[i];
    const [flag, inline] = a.startsWith("--") && a.includes("=") ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a, undefined];
    const next = () => inline ?? argv[++i];
    if (flag === "--port") { const p = parsePort(next() ?? ""); if (p !== null) out.port = p; }
    else if (flag === "--host") out.host = next();
    else if (flag === "--allowed-host") { const h = next(); if (h !== undefined) (out.allowedHosts ??= []).push(h); }
    else if (flag === "--poll") { const v = inline ?? (/^\d+$/.test(argv[i + 1] ?? "") ? argv[++i] : "true"); try { out.poll = parsePoll(v); } catch { /* not ours to judge here */ } }
    else if (!a.startsWith("-") && out.folder === undefined) out.folder = a;
  }
  return out;
}

/** The URL a person opens: localhost for loopback and every-address binds, as `serve`'s banner says. */
export function urlFor(host: string, port: number): string {
  const local = isLoopbackAddress(host) || host === "0.0.0.0" || host === "::" || host === "[::]";
  const at = local ? "localhost" : host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${at}:${port}/`;
}

/** Where the CLI connects to ask it: an address, not a name, and loopback for an every-address bind. */
export function probeUrlFor(host: string, port: number): string {
  const h = host.replace(/^\[(.*)\]$/, "$1");
  const at = h === "0.0.0.0" || h === "::" ? "127.0.0.1" : h.includes(":") ? `[${h}]` : h;
  return `http://${at}:${port}/`;
}

/**
 * A `fetch` that sends `Host: localhost`. `fetch` itself won't set a Host header, and a service bound to one LAN
 * address, asked by that address, would get the guard's 403 (the address isn't an allowed host): so its health
 * would read as "not answering" when it's up. localhost is always allowed, and this only ever asks Localidraw's own
 * `/api/health` and `/api/busy`.
 */
export const localFetch = ((input: string | URL, init?: { signal?: AbortSignal | null }) =>
  new Promise<Response>((ok, fail) => {
    const u = new URL(String(input));
    const req = request(u, { headers: { host: `localhost:${u.port}` }, signal: init?.signal ?? undefined }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => ok(new Response(Buffer.concat(chunks), { status: res.statusCode ?? 500 })));
      res.on("error", fail);
    });
    req.on("error", fail);
    req.end();
  })) as typeof fetch;

/** Whether something accepts connections at the address and port. */
function portTaken(probeUrl: string): Promise<boolean> {
  const u = new URL(probeUrl);
  return new Promise((ok) => {
    const socket = connect({ host: u.hostname.replace(/^\[(.*)\]$/, "$1"), port: Number(u.port) });
    const done = (taken: boolean) => { socket.destroy(); ok(taken); };
    socket.setTimeout(1000, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

export interface ServiceContext {
  platform: NodeJS.Platform;
  homeDir: string;
  xdgConfigHome?: string;
  /** `process.execPath`, which the unit names (realpath'd). */
  nodePath: string;
  /** The package's root folder: the unit runs `<root>/dist/server/cli.js`. */
  pkgRoot: string;
  /** The installing shell's PATH, cleaned up for the unit (path-env.ts). */
  pathEnv?: string;
  run?: Runner;
  sleep?: (ms: number) => void;
  stdout?: OutputStream;
  stderr?: OutputStream;
  /** Injected for tests: what `/api/health` says, asked at a probe URL. */
  probe?: (url: string) => Promise<HealthAnswer | undefined>;
  /** Injected for tests: waits until it answers. */
  waitReady?: (url: string) => Promise<"ready" | "timeout">;
  /** Injected for tests: whether the port is held. */
  portTaken?: (url: string) => Promise<boolean>;
  /** Injected for tests: how the busy check asks `/api/busy` (default localFetch). */
  fetch?: typeof fetch;
}

/** What `/api/busy` counts (server.ts's BusyCounts), as the CLI says them: `Localidraw is busy: 1 canvas save is running.` */
export const BUSY_NOUNS: Nouns = { canvas: ["canvas save", "canvas saves"], library: ["Library save", "Library saves"] };

interface Options {
  action: Action;
  folder?: string;
  port?: number;
  host?: string;
  allowedHosts?: string[];
  poll?: string;
  refresh: boolean;
  dryRun: boolean;
  fromCheckout: boolean;
  force: boolean;
  json: boolean;
  follow: boolean;
  lines?: number;
}

/** Which flags each command can act on. Anything else is a usage error (SPEC §1), not parsed and dropped. */
const SCOPED: Record<string, readonly Action[]> = {
  "--port": ["install"], "--host": ["install"], "--allowed-host": ["install"], "--poll": ["install"],
  "--refresh": ["install"], "--dry-run": ["install"], "--from-checkout": ["install"],
  "--force": ["stop", "restart"],
  "--json": ["status"],
  "--follow": ["logs"], "--lines": ["logs"],
};
const ALIASES: Record<string, string> = { "-f": "--follow", "-n": "--lines" };

/** The arguments after `service`. Returns "help" for `--help`. */
export function parseServiceArgs(args: readonly string[]): Options | "help" {
  if (args.some((a) => a === "-h" || a === "--help")) return "help";
  const [action, ...rest] = args;
  if (action === undefined) throw new UsageError(`which one? ${ACTIONS.join(", ")}`);
  if (!(ACTIONS as readonly string[]).includes(action)) {
    throw new UsageError(action.startsWith("-") ? `\`service\` takes a command first (${ACTIONS.join(", ")})` : `unknown service command ${action}`);
  }
  const o: Options = { action: action as Action, refresh: false, dryRun: false, fromCheckout: false, force: false, json: false, follow: false };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const eq = a.startsWith("--") ? a.indexOf("=") : -1;
    const flag = ALIASES[a] ?? (eq > 0 ? a.slice(0, eq) : a);
    const inline = eq > 0 ? a.slice(eq + 1) : undefined;
    const value = (what: string) => {
      const v = inline ?? rest[++i];
      if (v === undefined) throw new UsageError(`${flag} needs ${what}`);
      return v;
    };
    if (!flag.startsWith("-")) {
      if (o.action !== "install") throw new UsageError(`\`service ${o.action}\` takes no folder (got ${a})`);
      if (o.folder !== undefined) throw new UsageError(`one folder only (got ${o.folder} and ${a})`);
      o.folder = a;
      continue;
    }
    const scope = SCOPED[flag];
    if (scope === undefined) throw new UsageError(`unknown option ${a}`);
    if (!scope.includes(o.action)) throw new UsageError(`${flag} doesn't apply to \`service ${o.action}\``);
    if (flag === "--port") {
      const v = value("a number");
      const p = parsePort(v);
      if (p === null || p === 0) throw new UsageError(`not a port number: ${v}`);
      o.port = p;
    } else if (flag === "--host") o.host = value("an address").trim();
    else if (flag === "--allowed-host") (o.allowedHosts ??= []).push(value("a host name"));
    else if (flag === "--poll") o.poll = inline ?? (/^\d+$/.test(rest[i + 1] ?? "") ? rest[++i] : "true");
    else if (flag === "--lines") {
      const v = value("a number of lines");
      if (!/^\d+$/.test(v) || Number(v) < 1) throw new UsageError(`-n takes a number of lines, not ${v}`);
      o.lines = Number(v);
    } else if (inline !== undefined) throw new UsageError(`${flag} takes no value`);
    else if (flag === "--refresh") o.refresh = true;
    else if (flag === "--dry-run") o.dryRun = true;
    else if (flag === "--from-checkout") o.fromCheckout = true;
    else if (flag === "--force") o.force = true;
    else if (flag === "--json") o.json = true;
    else if (flag === "--follow") o.follow = true;
  }
  if (o.refresh && o.dryRun) throw new UsageError("--refresh and --dry-run don't go together: --dry-run on its own prints what a reinstall would write");
  return o;
}

/** The version of the Localidraw a unit runs: the package.json above the CLI it names. */
export function installedVersionOf(cliPath: string | undefined): string | undefined {
  if (cliPath === undefined) return undefined;
  let dir = dirname(cliPath);
  for (;;) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest)) {
      try {
        return (JSON.parse(readFileSync(manifest, "utf8")) as { version?: string }).version;
      } catch {
        return undefined;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** What `service status` knows, in one shape for the prose and the JSON, so they can't disagree. */
export interface StatusReport {
  installed: boolean;
  running: boolean;
  answering: boolean;
  installedVersion: string | null;
  runningVersion: string | null;
  port: number | null;
  url: string | null;
  pid: number | null;
  unit: string | null;
  log: string | null;
  manager: "launchd" | "systemd" | null;
  folder: string | null;
  host: string | null;
  allowedHosts: string[];
  poll: number | null;
  home: string;
  node: string | null;
  cli: string | null;
  /** Linux only; null where there's no such thing, or the check couldn't answer. */
  linger: boolean | null;
  warnings: string[];
  /** What the last `update --check` or `doctor` found (~/.localidraw/update-check.json); left out when there's nothing to repeat. */
  update?: UpdateSummary;
}

const describe = (m: ServiceManager) => (m.platform === "darwin" ? "LaunchAgent" : "user service");

export async function runService(args: readonly string[], ctx: ServiceContext): Promise<number> {
  const parsed = parseServiceArgs(args);
  const out = createOutput({ tool: "localidraw", json: parsed !== "help" && parsed.json, ...(ctx.stdout ? { stdout: ctx.stdout } : {}), ...(ctx.stderr ? { stderr: ctx.stderr } : {}) });
  if (parsed === "help") { out.say(SERVICE_HELP.trimEnd()); return EXIT.OK; }
  const o = parsed;
  const home = localidrawHome(ctx.homeDir);
  const probe = ctx.probe ?? ((url: string) => fetchHealth({ url, fetch: localFetch }));
  const waitReady = ctx.waitReady ?? ((url: string) => waitForReady({ url, fetch: localFetch }));

  let manager: ServiceManager;
  try {
    manager = managerFor(ctx);
  } catch (err) {
    if (!(err instanceof UnsupportedPlatformError)) throw err;
    // Windows (P3). `status` still answers truthfully, that nothing's installed (4), so a script can ask it anywhere;
    // everything else can't do what it was asked, and exits 1.
    if (o.action !== "status") return out.error(`${err.message.replace(/^`localidraw service`/, `\`localidraw service ${o.action}\``)} (A Windows service is planned.)`);
    const report = withUpdate(emptyReport(home, null, null, [err.message]), home);
    out.result(report);
    if (!o.json) out.say(`Localidraw isn't installed as a service: ${err.message}`);
    sayUpdate(out, home);
    return EXIT.NOT_INSTALLED;
  }

  try {
    switch (o.action) {
      case "install": return await install(o, ctx, manager, out, home, probe, waitReady);
      case "uninstall": return uninstall(manager, out, home);
      case "status": return await status(o, ctx, manager, out, home, probe);
      case "start": case "restart": return await startOrRestart(o, ctx, manager, out, home, waitReady);
      case "stop": return await stop(o, ctx, manager, out, home);
      case "logs": return await logs(o, manager, out, home, ctx.stdout ?? process.stdout);
    }
  } catch (err) {
    if (err instanceof UsageError) throw err;
    // launchctl's and systemctl's own words, as the reference reports them.
    return out.error(err instanceof Error ? err.message : String(err));
  }
}

/** The service manager for this machine: launchd or systemd. Throws UnsupportedPlatformError elsewhere (Windows). */
export function managerFor(ctx: ServiceContext): ServiceManager {
  return serviceManagerFor(LOCALIDRAW_SERVICE, {
    platform: ctx.platform,
    homeDir: ctx.homeDir,
    ...(ctx.xdgConfigHome !== undefined ? { xdgConfigHome: ctx.xdgConfigHome } : {}),
    ...(ctx.run ? { run: ctx.run } : {}),
    ...(ctx.sleep ? { sleep: ctx.sleep } : {}),
  });
}

/** Where the installed unit's Localidraw is asked, from the settings it records. */
export function unitProbeUrl(argv: readonly string[]): string {
  const s = settingsOf(argv);
  return probeUrlFor(s.host ?? DEFAULT_HOST, s.port ?? DEFAULT_PORT);
}

/**
 * The busy check before `stop` and `restart` (SPEC §1, §4), asking the Localidraw the unit describes: null to go ahead,
 * or 75 having said what's under way. A save takes a moment, so trying again is the usual answer.
 */
function refuseIfBusy(o: Options, ctx: ServiceContext, out: Output, home: string, argv: readonly string[]): Promise<number | null> {
  return guardBusy({ home, url: unitProbeUrl(argv), out, name: "Localidraw", nouns: BUSY_NOUNS, force: o.force, fetch: ctx.fetch ?? localFetch,
    hint: "Try again in a moment, once it's written, or use --force." });
}

/** `status`'s report with the last update check in it, when there's one to repeat (SPEC §1: absent, never null). */
function withUpdate(report: StatusReport, home: string): StatusReport {
  const update = updateSummary(home, { currentVersion: pkg.version });
  return update ? { ...report, update } : report;
}

/** Repeats the last update check's notice on stderr (SPEC §3), if it found a newer version. Never asks the registry. */
function sayUpdate(out: Output, home: string) {
  const summary = updateSummary(home, { currentVersion: pkg.version });
  const check = readUpdateCheck(home);
  if (!summary?.updateAvailable || !check) return;
  out.warn(updateNotice({ name: "Localidraw", current: check.current, target: check.target, command: check.command ?? "localidraw update", changelog: check.changelog }));
}

function notInstalled(manager: ServiceManager, out: Output): number {
  out.say(`Localidraw isn't installed as a service (looked for ${manager.unitPath}).\n  To install it: localidraw service install <folder>`);
  return EXIT.NOT_INSTALLED;
}

/** The settings to install with: the flags, then what the installed unit records, then the defaults. */
function resolveSettings(o: Options, recorded: Partial<Settings>, home: string): Settings {
  const given = o.folder ?? recorded.folder;
  if (given === undefined) throw new UsageError("which folder? `localidraw service install <folder>` (the folder of canvases it serves)");
  const abs = resolve(given);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new UsageError(`${abs} isn't a folder`);
  const folder = realpathSync(abs);
  const rel = relative(realpathOrSelf(home), folder);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    throw new UsageError(`${folder} is ${rel === "" ? "" : `inside ${home}, `}Localidraw's own folder (logs and runtime files). Keep your canvases somewhere else.`);
  }
  const host = o.host || recorded.host || DEFAULT_HOST;
  // New --allowed-host flags replace the recorded ones, as they replace $LOCALIDRAW_ALLOWED_HOSTS for serve.
  const allowedHosts = parseAllowedHosts(o.allowedHosts ?? recorded.allowedHosts ?? []);
  requireAllowedHost(host, allowedHosts);
  const poll = o.poll !== undefined ? parsePoll(o.poll) : recorded.poll;
  return { folder, port: o.port ?? recorded.port ?? DEFAULT_PORT, host, allowedHosts, ...(poll !== undefined ? { poll } : {}) };
}

function realpathOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** Refuses a CLI that won't be there later (npx's cache), or a checkout without --from-checkout (SPEC §1). */
function checkWhereFrom(o: Options, ctx: ServiceContext): string {
  const root = realpathOrSelf(ctx.pkgRoot);
  if (isEphemeralCachePath(root)) {
    throw new Error(`this Localidraw is running from npx's cache (${root}), which npm clears, and the service would stop working when it did.
  Install it first, then install the service from that:
    npm install -g localidraw
    localidraw service install <folder>`);
  }
  if (!underNodeModules(root) && !o.fromCheckout) {
    throw new Error(`this Localidraw is a checkout (${root}), not an installed package: a service would run whatever is built here next.
  Install the package (npm install -g localidraw) and install the service from that, or add --from-checkout if this is what you want.`);
  }
  const script = join(root, "dist", "server", "cli.js");
  if (!existsSync(script) || !existsSync(join(root, "dist", "web", "index.html"))) {
    throw new Error(`${join(root, "dist")} isn't built; run \`npm run build\` first`);
  }
  return script;
}

async function install(o: Options, ctx: ServiceContext, manager: ServiceManager, out: Output, home: string,
  probe: (url: string) => Promise<HealthAnswer | undefined>, waitReady: (url: string) => Promise<"ready" | "timeout">): Promise<number> {
  const existing = manager.status();
  // --refresh re-renders what's installed (SPEC §1): with nothing installed it exits 4, rather than installing from
  // defaults. `update` runs it through the new CLI, and a quiet first install would be a service nobody asked for.
  if (o.refresh && !existing.registered) return notInstalled(manager, out);
  const recorded = existing.registered ? settingsOf(existing.argv) : {};
  const settings = resolveSettings(o, recorded, home);
  const scriptPath = checkWhereFrom(o, ctx);
  const spec = buildSpec({ nodePath: ctx.nodePath, scriptPath, args: serveArgs(settings), home, ...(ctx.pathEnv !== undefined ? { pathEnv: ctx.pathEnv } : {}) });

  if (o.dryRun) {
    out.say(`# ${manager.unitPath} (not written: --dry-run)`);
    out.say(manager.platform === "darwin" ? renderPlist(LOCALIDRAW_SERVICE, spec) : renderUnit(LOCALIDRAW_SERVICE, spec));
    return EXIT.OK;
  }

  // The port must be free, or held by this service itself (a reinstall). Anything else holding it would leave the
  // service failing to start, again and again, with only its log saying why.
  const probeUrl = probeUrlFor(settings.host, settings.port);
  const ours = existing.registered && existing.running && recorded.port === settings.port;
  if (!ours && (await (ctx.portTaken ?? portTaken)(probeUrl))) {
    const answer = await probe(probeUrl);
    return out.error(answer?.ok
      ? `port ${settings.port} is in use by another Localidraw${answer.version ? ` (${answer.version})` : ""}, probably a \`localidraw serve\` in a terminal. Stop it first, or give the service another --port.`
      : `port ${settings.port} is in use by something else. Give the service another --port.`);
  }

  if (o.refresh) out.say(`Re-writing ${manager.unitPath}\n  Keeping: localidraw ${spec.args.join(" ")}`);
  else if (existing.registered && recorded.folder !== undefined && recorded.folder !== settings.folder) {
    out.say(`There's one Localidraw service per machine: moving it from ${recorded.folder} to ${settings.folder}.`);
  }
  out.say(manager.platform === "darwin"
    ? "Installing the LaunchAgent and starting Localidraw (macOS may take a few seconds to allow the background item)…"
    : "Installing the user service and starting Localidraw…");
  try {
    manager.install(spec);
  } catch (err) {
    // The reference writes the unit before it asks the manager to load it. A first install the manager refused (no
    // systemd here, say) mustn't leave a unit behind, or `status` would report a service that never existed.
    if (!existing.registered) rmSync(manager.unitPath, { force: true });
    throw err;
  }

  const url = urlFor(settings.host, settings.port);
  const readiness = await waitReady(probeUrl);
  const linger = lingerAdvice(manager.linger(), "Localidraw");
  if (readiness !== "ready") {
    out.say(`Localidraw is installed as a ${describe(manager)}, but it didn't answer at ${url}. The last lines of its log:`);
    out.say(lastLines(spec.logPath));
    return EXIT.FAILED;
  }
  out.say([
    `✓ Localidraw is installed as a ${describe(manager)}, and running at ${url}`,
    `  Folder: ${settings.folder}`,
    `  Unit:   ${manager.unitPath}`,
    `  Log:    ${spec.logPath}   (localidraw service logs -f)`,
    ...(isLoopbackAddress(settings.host) ? [] : [`  Localidraw has no login: anyone who can reach ${settings.host}:${settings.port} can read and change these canvases. Put it behind a reverse proxy that does authentication.`]),
    "",
    `It starts again when you log in. \`localidraw service status\` says how it is; \`localidraw service uninstall\` removes it.`,
    ...(linger !== undefined ? ["", linger] : []),
  ].join("\n"));
  return EXIT.OK;
}

function lastLines(file: string, n = 20): string {
  try {
    return tailFile(file, n) || `  (${file} is empty)`;
  } catch {
    return `  (nothing in ${file} yet)`;
  }
}

function uninstall(manager: ServiceManager, out: Output, home: string): number {
  const existed = manager.uninstall();
  out.say(existed
    ? `Localidraw's ${describe(manager)} is stopped and removed (${manager.unitPath}).\n  Your canvases are untouched, and the log is kept in ${join(home, "logs")}.`
    : `No Localidraw service was installed (${manager.unitPath}). Nothing to do.`);
  // 0 either way: nothing installed is what was asked for, so a teardown script can run it without asking first.
  return EXIT.OK;
}

function emptyReport(home: string, unit: string | null, manager: StatusReport["manager"], warnings: string[], linger: boolean | null = null): StatusReport {
  return {
    installed: false, running: false, answering: false, installedVersion: null, runningVersion: null, port: null, url: null,
    pid: null, unit, log: null, manager, folder: null, host: null, allowedHosts: [], poll: null, home, node: null, cli: null, linger, warnings,
  };
}

/** What the unit's settings, its files and `/api/health` say, and what's wrong with them. */
export async function buildStatus(ctx: ServiceContext, manager: ServiceManager, home: string, probe: (url: string) => Promise<HealthAnswer | undefined>): Promise<{ report: StatusReport; state: ServiceState; stale: boolean }> {
  const state = manager.status();
  const kind = manager.platform === "darwin" ? "launchd" : "systemd";
  const lingerState = manager.linger();
  const linger = lingerState.applies ? (lingerState.enabled ?? null) : null;
  if (!state.registered) return { report: emptyReport(home, manager.unitPath, kind, [], linger), state, stale: false };

  const s = settingsOf(state.argv);
  const port = s.port ?? DEFAULT_PORT;
  const host = s.host ?? DEFAULT_HOST;
  const health = await probe(probeUrlFor(host, port));
  const installedVersion = installedVersionOf(state.cliPath);
  const log = state.logPath ?? serviceLogPath(home);
  const warnings: string[] = [];
  const gone = missingPaths([state.nodePath, state.cliPath]);
  for (const p of gone) {
    warnings.push(`The unit runs ${p}, which isn't there any more (a Node version removed by nvm, fnm or volta, or Localidraw reinstalled elsewhere). \`localidraw service restart\` re-writes it.`);
  }
  // A unit an older Localidraw wrote: one that doesn't restart after a clean exit, or logs somewhere else.
  const oldFormat = !state.keepsAlive || log !== serviceLogPath(home);
  if (oldFormat) warnings.push("The unit was written by an older Localidraw. `localidraw service restart` re-writes it.");
  if (s.folder !== undefined && !existsSync(s.folder)) {
    warnings.push(`The folder it serves, ${s.folder}, isn't there any more, so it can't start. Install it on another folder: localidraw service install <folder>`);
  }
  if (installedVersion !== undefined && health?.version !== undefined && installedVersion !== health.version) {
    warnings.push(`It's running ${health.version}, but ${installedVersion} is installed: \`localidraw service restart\` to run the new one.`);
  }
  if (lingerState.applies && lingerState.enabled === false) {
    warnings.push(`Linger is off, so the service stops when you log out. To keep it running: sudo loginctl enable-linger ${lingerState.user ?? "$USER"}`);
  }
  const report: StatusReport = {
    installed: true,
    running: state.running,
    answering: health?.ok === true,
    installedVersion: installedVersion ?? null,
    runningVersion: health?.version ?? null,
    port,
    url: urlFor(host, port),
    pid: state.pid !== undefined ? Number(state.pid) : null,
    unit: manager.unitPath,
    log,
    manager: kind,
    folder: s.folder ?? null,
    host,
    allowedHosts: s.allowedHosts ?? [],
    poll: s.poll ?? null,
    home,
    node: state.nodePath ?? null,
    cli: state.cliPath ?? null,
    linger,
    warnings,
  };
  return { report, state, stale: gone.length > 0 || oldFormat };
}

async function status(o: Options, ctx: ServiceContext, manager: ServiceManager, out: Output, home: string, probe: (url: string) => Promise<HealthAnswer | undefined>): Promise<number> {
  const report = withUpdate((await buildStatus(ctx, manager, home, probe)).report, home);
  const code = !report.installed ? EXIT.NOT_INSTALLED : report.running && report.answering ? EXIT.OK : EXIT.NOT_RUNNING;
  out.result(report);
  if (o.json) { sayUpdate(out, home); return code; }
  if (!report.installed) { notInstalled(manager, out); sayUpdate(out, home); return code; }
  const pid = report.pid !== null ? ` (pid ${report.pid})` : "";
  const headline = report.running
    ? report.answering ? `Localidraw is running${pid} and answering at ${report.url}` : `Localidraw is running${pid}, but ${report.url} isn't answering.`
    : report.answering
      ? `The service isn't running, but something is answering at ${report.url}: a \`localidraw serve\` in a terminal, probably. The service can't start while that holds the port.`
      : "Localidraw is installed as a service, but isn't running. `localidraw service start` starts it.";
  const version = report.runningVersion !== null && report.runningVersion !== report.installedVersion
    ? `${report.runningVersion} running, ${report.installedVersion ?? "unknown"} installed`
    : report.runningVersion ?? report.installedVersion ?? "unknown";
  out.say([
    headline,
    `  Version: ${version}`,
    `  Folder:  ${report.folder ?? "unknown"}`,
    `  Listens: ${report.host}:${report.port}${report.allowedHosts.length ? `, answering to localhost, ${report.allowedHosts.join(", ")}` : ""}`,
    `  Watches: ${report.poll !== null ? `by checking the files every ${report.poll} ms` : "by file events"}`,
    `  Unit:    ${report.unit}`,
    `  Log:     ${report.log}   (localidraw service logs -f)`,
    ...report.warnings.map((w) => `  ! ${w}`),
  ].join("\n"));
  sayUpdate(out, home);
  return code;
}

async function startOrRestart(o: Options, ctx: ServiceContext, manager: ServiceManager, out: Output, home: string,
  waitReady: (url: string) => Promise<"ready" | "timeout">): Promise<number> {
  const state = manager.status();
  if (!state.registered) return notInstalled(manager, out);
  const s = settingsOf(state.argv);
  const probeUrl = probeUrlFor(s.host ?? DEFAULT_HOST, s.port ?? DEFAULT_PORT);
  const url = urlFor(s.host ?? DEFAULT_HOST, s.port ?? DEFAULT_PORT);
  if (o.action === "start" && state.running) {
    out.say(`Localidraw is already running${state.pid !== undefined ? ` (pid ${state.pid})` : ""} at ${url}`);
    return EXIT.OK;
  }
  if (o.action === "restart") {
    // Not while a save is being written (SPEC §4). A SIGTERM would finish it anyway (cli.ts); this says so first.
    const busy = await refuseIfBusy(o, ctx, out, home, state.argv);
    if (busy !== null) return busy;
    // A unit whose Node or Localidraw has gone, or that an older Localidraw wrote, is re-written first (SPEC §1).
    // Installing it again is a restart in both managers.
    const gone = missingPaths([state.nodePath, state.cliPath]).length > 0;
    const old = !state.keepsAlive || (state.logPath ?? serviceLogPath(home)) !== serviceLogPath(home);
    if (gone || old) {
      const settings = resolveSettings({ ...emptyOptions("install") }, s, home);
      const scriptPath = checkWhereFrom({ ...emptyOptions("install"), fromCheckout: true }, ctx);
      const spec = buildSpec({ nodePath: ctx.nodePath, scriptPath, args: serveArgs(settings), home, ...(ctx.pathEnv !== undefined ? { pathEnv: ctx.pathEnv } : {}) });
      out.say(`Re-writing ${manager.unitPath}, which ${gone ? "names a Node or a Localidraw that has gone" : "an older Localidraw wrote"}, and restarting…`);
      manager.install(spec);
    } else {
      out.say("Restarting Localidraw…");
      manager.restart();
    }
  } else {
    out.say("Starting Localidraw…");
    manager.start();
  }
  if ((await waitReady(probeUrl)) !== "ready") {
    out.say(`It was ${o.action === "start" ? "started" : "restarted"}, but didn't answer at ${url}. The last lines of its log:`);
    out.say(lastLines(state.logPath ?? serviceLogPath(home)));
    return EXIT.FAILED;
  }
  const after = manager.status();
  out.say(`✓ Localidraw is running${after.pid !== undefined ? ` (pid ${after.pid})` : ""} at ${url}`);
  return EXIT.OK;
}

function emptyOptions(action: Action): Options {
  return { action, refresh: false, dryRun: false, fromCheckout: false, force: false, json: false, follow: false };
}

async function stop(o: Options, ctx: ServiceContext, manager: ServiceManager, out: Output, home: string): Promise<number> {
  const state = manager.status();
  if (!state.registered) return notInstalled(manager, out);
  if (!state.running) {
    out.say(`Localidraw's service is already stopped (${manager.unitPath}).`);
    return EXIT.OK;
  }
  const busy = await refuseIfBusy(o, ctx, out, home, state.argv);
  if (busy !== null) return busy;
  manager.stop();
  out.say("Localidraw is stopped, and still installed. It starts again when you log in, or now with: localidraw service start");
  return EXIT.OK;
}

async function logs(o: Options, manager: ServiceManager, out: Output, home: string, stdout: OutputStream): Promise<number> {
  const state = manager.status();
  if (!state.registered) return notInstalled(manager, out);
  const file = state.logPath ?? serviceLogPath(home);
  if (!existsSync(file)) {
    // On stderr: with -f, this comes before the log itself, which is stdout's.
    out.warn(`localidraw: nothing has been written to ${file} yet.`);
    if (!o.follow) return EXIT.OK;
  } else {
    const tail = tailFile(file, o.lines ?? DEFAULT_LOG_LINES);
    if (tail !== "") stdout.write(`${tail}\n`);
  }
  if (o.follow) {
    out.warn(`localidraw: following ${file}; Ctrl-C to stop.`);
    await followFile(file, { from: sizeOf(file), write: (c) => stdout.write(c) });
  }
  return EXIT.OK;
}

/** The context for a real run. */
export function realContext(pkgRoot: string, homeDir: string): ServiceContext {
  return {
    platform: process.platform,
    homeDir,
    ...(process.env.XDG_CONFIG_HOME ? { xdgConfigHome: process.env.XDG_CONFIG_HOME } : {}),
    nodePath: process.execPath,
    pkgRoot,
    ...(process.env.PATH !== undefined ? { pathEnv: process.env.PATH } : {}),
  };
}

