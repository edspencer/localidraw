// `localidraw doctor [--json] [--offline]` (the CLI contract's SPEC §1): one ✓ / ! / ✗ line a check, with a `fix:` line
// under every failure, and exit 1 if any check failed (warnings don't change it).
//
// The spec's checks: Node against `engines`, how it was installed (§6), the unit (there, the Node and CLI it names still
// there, and the same install as this CLI), the running version, the port, linger, the home, and a newer version.
// Then Localidraw's own: the page is built, the folder it serves (the service's, or the current folder) is readable,
// and on Linux, whether the system's limit on file watches covers that folder's folders, since it watches each one.
//
// It only reads, apart from ~/.localidraw/update-check.json: like `update --check`, it writes what it found there, so
// `service status` can repeat it (SPEC §3). It asks the npm registry only because a person ran it; --offline doesn't.
import { accessSync, constants, existsSync, readdirSync, readFileSync, statSync, type Dirent } from "node:fs";
import { connect } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fetchHealth } from "./contract/health.ts";
import { describeInstall, detectInstall, updateCommand, type InstallInfo } from "./contract/install-method.ts";
import { UsageError } from "./contract/output.ts";
import { npmConfigGet, npmGlobalRoot } from "./contract/package-manager.ts";
import { RegistryError, resolveRegistry, resolveTarget } from "./contract/registry.ts";
import { readLiveRuntimeFile } from "./contract/runtime-file.ts";
import { UnsupportedPlatformError, type ServiceManager } from "./contract/service/index.ts";
import { compareVersions, isPrerelease, satisfiesEngines } from "./contract/semver.ts";
import { updateNotice, writeUpdateCheck } from "./contract/update-check.ts";
import { SKIPPED_DIRS } from "./files.ts";
import { localidrawHome } from "./options.ts";
import { DEFAULT_PORT } from "./port.ts";
import { buildStatus, localFetch, managerFor, probeUrlFor, type ServiceContext, type StatusReport } from "./service.ts";
import { DEFAULT_HOST } from "./server.ts";
import { changelogUrl, CHECKOUT_COMMAND, PACKAGE_NAME } from "./update.ts";

export type CheckStatus = "pass" | "warn" | "fail" | "skip";

export interface Check {
  /** Stable, for scripts: the spec's own (node-engines, install-method, unit, running-version, port, linger, data-home, update), then Localidraw's (page, folder, inotify). */
  id: string;
  status: CheckStatus;
  message: string;
  fix?: string;
}

const MARK: Record<CheckStatus, string> = { pass: "✓", warn: "!", fail: "✗", skip: "-" };

export const DOCTOR_USAGE = `Usage: localidraw doctor [--json] [--offline]
`;

export const DOCTOR_HELP = `localidraw doctor: check that Localidraw can run here, with a fix for anything that's wrong

${DOCTOR_USAGE}
  --json            one JSON document on stdout
  --offline         don't ask the npm registry for a newer version

It checks Node, how Localidraw was installed, the service, the version running, the port, linger (Linux), its home
(~/.localidraw), that the page is built, that the folder it serves is readable (the service's, or this one), and
on Linux that the limit on file watches covers that folder. It exits 1 if a check failed.
`;

/** The arguments after `doctor`. Returns "help" for `--help`. */
export function parseDoctorArgs(args: readonly string[]): { json: boolean; offline: boolean } | "help" {
  if (args.some((a) => a === "-h" || a === "--help")) return "help";
  const o = { json: false, offline: false };
  for (const a of args) {
    if (a === "--json") o.json = true;
    else if (a === "--offline") o.offline = true;
    else if (a.startsWith("-")) throw new UsageError(`unknown option ${a}`);
    else throw new UsageError(`\`doctor\` takes no argument (got ${a})`);
  }
  return o;
}

export interface DoctorInput {
  ctx: ServiceContext;
  version: string;
  /** The package's `engines.node`. */
  engines: string | undefined;
  /** process.argv[1], for SPEC §6's walk-up. */
  entry: string;
  /** Where the built page should be. */
  webDir: string;
  /** The folder `localidraw` would serve here: the current folder. */
  cwd: string;
  offline?: boolean;
  env?: NodeJS.ProcessEnv;
  /** Injected for tests. */
  nodeVersion?: string;
  npmGlobalRoot?: () => string | undefined;
  registry?: string;
  isListening?: (url: string) => Promise<boolean>;
  /** fs.inotify.max_user_watches, or undefined where there's no such thing. */
  maxWatches?: () => number | undefined;
  registryFetch?: typeof fetch;
}

const tildify = (p: string, home: string) => (p === home ? "~" : p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p);

export async function diagnose(i: DoctorInput): Promise<{ checks: Check[]; notice?: string }> {
  const checks: Check[] = [];
  const add = (c: Check) => checks.push(c);
  const ctx = i.ctx;
  const env = i.env ?? process.env;
  const home = localidrawHome(ctx.homeDir);
  const t = (p: string) => tildify(p, ctx.homeDir);
  let notice: string | undefined;

  // ---- this Node against the package's engines
  const nodeVersion = i.nodeVersion ?? process.versions.node;
  const engines = satisfiesEngines(nodeVersion, i.engines ? { node: i.engines } : undefined);
  if (engines.ok === false) {
    add({ id: "node-engines", status: "fail", message: `Node ${nodeVersion} is too old: Localidraw ${i.version} needs Node ${i.engines}`, fix: `install Node ${i.engines} (with nvm, fnm, Homebrew, …), then run localidraw with it` });
  } else add({ id: "node-engines", status: "pass", message: `Node ${nodeVersion}${i.engines ? ` (Localidraw needs ${i.engines})` : ""}` });

  // ---- how it was installed (SPEC §6)
  const info: InstallInfo = detectInstall({ packageName: PACKAGE_NAME, envPrefix: "LOCALIDRAW", entry: i.entry, env, npmGlobalRoot: i.npmGlobalRoot ?? (() => npmGlobalRoot({ env })) });
  const how = describeInstall(info, PACKAGE_NAME);
  if (info.canUpdate) add({ id: "install-method", status: "pass", message: `Localidraw ${i.version}, ${how}: \`localidraw update\` can update it` });
  else {
    const cmd = updateCommand(info, { packageName: PACKAGE_NAME, checkoutCommand: CHECKOUT_COMMAND });
    add({ id: "install-method", status: "warn", message: `Localidraw ${i.version}, ${how}: \`localidraw update\` can't update it`, fix: `${cmd.command}${cmd.note ? `    (${cmd.note})` : ""}` });
  }

  // ---- the service: what `service status` warns about
  let manager: ServiceManager | null = null;
  let report: StatusReport | null = null;
  try {
    manager = managerFor(ctx);
    report = (await buildStatus(ctx, manager, home, (url) => fetchHealth({ url, fetch: ctx.fetch ?? localFetch }))).report;
  } catch (err) {
    if (err instanceof UnsupportedPlatformError) add({ id: "unit", status: "skip", message: `${err.message} (a Windows service is planned)` });
    else add({ id: "unit", status: "warn", message: `couldn't ask the service manager: ${(err as Error).message}` });
  }
  if (report && !report.installed) add({ id: "unit", status: "skip", message: "it isn't installed as a service (`localidraw service install <folder>` runs it in the background)" });
  else if (report) {
    // The running-version and linger warnings are their own checks, below.
    const warnings = report.warnings.filter((w) => !/^It's running |^Linger is off/.test(w));
    if (!warnings.length) add({ id: "unit", status: "pass", message: `the service is installed (${report.manager}), serving ${t(report.folder ?? "?")}: ${t(report.unit ?? "")}` });
    for (const w of warnings) {
      add(/isn't there any more/.test(w)
        ? { id: "unit", status: "fail", message: w, fix: /folder it serves/.test(w) ? "`localidraw service install <folder>`" : "`localidraw service restart` (it keeps the folder, port and host)" }
        : /another install of Localidraw/.test(w)
          ? { id: "unit", status: "warn", message: w, fix: "`localidraw service install`, run from the install you mean the service to run (it keeps the folder, port and host)" }
          : { id: "unit", status: "warn", message: w, fix: "`localidraw service restart`" });
    }
  }

  // ---- the running version is the installed one: the service's, or a `serve` in a terminal
  const live = readLiveRuntimeFile(home);
  const running = report?.answering
    ? { version: report.runningVersion, where: report.url!, installed: report.installedVersion, via: "service" as const }
    : live ? { version: live.version, where: live.url, installed: i.version, via: "serve" as const } : null;
  if (!running) add({ id: "running-version", status: "skip", message: "Localidraw isn't running" });
  else if (running.version && running.installed && running.version !== running.installed) {
    add({
      id: "running-version", status: "fail",
      message: `${running.where} is running ${running.version}, but ${running.installed} is installed: it's still running the code it started with`,
      fix: running.via === "service" ? "`localidraw service restart`" : "stop the `localidraw` in its terminal (Ctrl-C) and start it again",
    });
  } else add({ id: "running-version", status: "pass", message: `${running.where} is running ${running.version ?? "an unknown version"}${running.via === "serve" ? " (in a terminal)" : ""}` });

  // ---- the port: free, or held by Localidraw
  const port = report?.port ?? live?.port ?? DEFAULT_PORT;
  const probe = report?.installed ? probeUrlFor(report.host ?? DEFAULT_HOST, port) : probeUrlFor(DEFAULT_HOST, port);
  const listening = await (i.isListening ?? isListening)(probe);
  const health = listening ? await fetchHealth({ url: probe, fetch: ctx.fetch ?? localFetch }) : undefined;
  if (!listening) add({ id: "port", status: "pass", message: `port ${port} is free` });
  else if (health?.ok) add({ id: "port", status: "pass", message: `port ${port} is Localidraw's${health.version ? ` (${health.version})` : ""}` });
  else {
    add({
      id: "port", status: "fail",
      message: `something that isn't Localidraw is listening on port ${port}`,
      fix: report?.installed ? "stop it, or move the service: `localidraw service install --port <n>`" : "stop it, or run Localidraw on another port: `localidraw --port <n>`",
    });
  }

  // ---- linger, on Linux: without it the service stops when you log out
  const linger = manager?.linger();
  if (!linger?.applies) add({ id: "linger", status: "skip", message: "linger is a Linux thing" });
  else {
    const user = linger.user ?? "$USER";
    if (linger.enabled === true) add({ id: "linger", status: "pass", message: `linger is on for ${user}: the service runs while you're logged out, and starts at boot` });
    else if (linger.enabled === false && report?.installed) {
      add({ id: "linger", status: "warn", message: `linger is off for ${user}: the service stops when you log out, and starts only when you log in`, fix: `sudo loginctl enable-linger ${user}` });
    } else if (linger.enabled === false) add({ id: "linger", status: "pass", message: `linger is off for ${user}, which only matters once it's a service (then: sudo loginctl enable-linger ${user})` });
    else add({ id: "linger", status: "skip", message: "couldn't ask loginctl about linger" });
  }

  // ---- the home: runtime.json, the update lock and check, the service's log
  const writable = writableOrCreatable(home);
  if (writable === true) add({ id: "data-home", status: "pass", message: `its home ${t(home)} is writable` });
  else if (writable === "creatable") add({ id: "data-home", status: "pass", message: `its home ${t(home)} doesn't exist yet; it's made the first time Localidraw runs` });
  else add({ id: "data-home", status: "fail", message: `its home ${t(home)} isn't writable: ${writable}`, fix: `check the permissions of ${t(home)} (Localidraw keeps runtime.json and the service's log there, never drawings)` });

  // ---- Localidraw's own: the page is built
  if (existsSync(join(i.webDir, "index.html"))) add({ id: "page", status: "pass", message: "the page is built" });
  else {
    add({ id: "page", status: "fail", message: `the page isn't built (${t(i.webDir)} has no index.html)`,
      fix: info.method === "checkout" ? "`npm run build` in the checkout" : `install it again: npm install -g ${PACKAGE_NAME}` });
  }

  // ---- the folder it serves: the service's, or the current folder, readable
  const folder = report?.installed && report.folder ? report.folder : i.cwd;
  const whose = report?.installed && report.folder ? "the service's folder" : "this folder";
  let readable = false;
  try {
    if (!statSync(folder).isDirectory()) throw new Error("it isn't a folder");
    accessSync(folder, constants.R_OK | constants.X_OK);
    readdirSync(folder);
    readable = true;
    add({ id: "folder", status: "pass", message: `${whose}, ${t(folder)}, is readable` });
  } catch (err) {
    const why = (err as NodeJS.ErrnoException).code === "ENOENT" ? "it isn't there" : (err as Error).message;
    add({ id: "folder", status: "fail", message: `${whose}, ${t(folder)}, can't be read: ${why}`,
      fix: report?.installed && report.folder ? "`localidraw service install <folder>` on a folder that's there" : "run localidraw on a folder you can read: `localidraw <folder>`" });
  }

  // ---- on Linux, the limit on file watches: one a folder, as it watches each (server.ts's watchTree)
  const max = (i.maxWatches ?? maxUserWatches)();
  if (ctx.platform !== "linux" || max === undefined) add({ id: "inotify", status: "skip", message: "the limit on file watches is a Linux thing" });
  else if (!readable) add({ id: "inotify", status: "skip", message: "the folder can't be read, so its folders weren't counted" });
  else if (report?.installed && report.poll !== null) add({ id: "inotify", status: "pass", message: `the service checks the files every ${report.poll} ms (--poll), so it needs no file watches` });
  else {
    const { folders, complete } = countFolders(folder, max);
    const fix = `raise it: sudo sysctl fs.inotify.max_user_watches=524288 (and put that in /etc/sysctl.d/ to keep it), or serve with --poll`;
    if (!complete && folders <= max / 2) add({ id: "inotify", status: "skip", message: `${t(folder)} has more than ${folders} folders, too many to count quickly; the system's limit is ${max} (fs.inotify.max_user_watches)` });
    else if (folders > max) add({ id: "inotify", status: "fail", message: `${t(folder)} has more than ${max} folders to watch, past the system's limit (fs.inotify.max_user_watches = ${max}): changes in some won't show`, fix });
    else if (folders > max / 2) add({ id: "inotify", status: "warn", message: `${t(folder)} has ${folders} folders to watch, more than half the system's limit (fs.inotify.max_user_watches = ${max}), which every program shares`, fix });
    else add({ id: "inotify", status: "pass", message: `${folders} folder${folders === 1 ? "" : "s"} to watch, well inside the limit (fs.inotify.max_user_watches = ${max})` });
  }

  // ---- a newer version (SPEC §1): the only check that asks the network, and --offline skips it
  if (i.offline) add({ id: "update", status: "skip", message: "not asking the registry for a newer version (--offline)" });
  else {
    try {
      const target = await resolveTarget({ packageName: PACKAGE_NAME, registry: i.registry ?? resolveRegistry(env, (k) => npmConfigGet(k, { env })), ...(i.registryFetch ? { fetch: i.registryFetch } : {}) });
      const cmp = compareVersions(target.version, i.version);
      const available = cmp > 0 && !isPrerelease(target.version);
      const cmd = info.canUpdate ? { command: "localidraw update" } : updateCommand(info, { packageName: PACKAGE_NAME, target: target.version, image: "ghcr.io/edspencer/localidraw", checkoutCommand: CHECKOUT_COMMAND });
      writeUpdateCheck(home, {
        name: PACKAGE_NAME,
        current: i.version,
        target: target.version,
        tag: target.tag,
        updateAvailable: available,
        installMethod: info.method,
        canUpdate: info.canUpdate,
        command: available ? cmd.command : null,
        engines: target.engines,
        nodeOk: satisfiesEngines(nodeVersion, target.engines !== null ? { node: target.engines } : undefined).ok !== false,
        changelog: changelogUrl(target.version),
        checkedAt: new Date().toISOString(),
      });
      if (available) {
        notice = updateNotice({ name: "Localidraw", current: i.version, target: target.version, command: cmd.command, ...(cmd.note ? { note: cmd.note } : {}), changelog: changelogUrl(target.version) });
        add({ id: "update", status: "warn", message: `Localidraw ${target.version} is available (you have ${i.version})`, fix: cmd.command });
      } else add({ id: "update", status: "pass", message: cmp < 0 ? `${i.version} is newer than the registry's latest (${target.version})` : `${i.version} is the latest` });
    } catch (err) {
      add({ id: "update", status: "warn", message: `couldn't ask the registry for a newer version: ${err instanceof RegistryError ? `${err.message} (${err.url})` : (err as Error).message}`, fix: "check your network, or skip this check with --offline" });
    }
  }
  return { checks, ...(notice ? { notice } : {}) };
}

/** The checklist, for a person. */
export function renderChecks(checks: Check[]): string {
  return `${checks.map((c) => `${MARK[c.status]} ${c.message}${c.fix && c.status !== "pass" && c.status !== "skip" ? `\n    fix: ${c.fix}` : ""}`).join("\n")}\n`;
}

export const doctorCode = (checks: Check[]) => (checks.some((c) => c.status === "fail") ? 1 : 0);

/** True if `dir` is writable; "creatable" if it doesn't exist but its nearest existing parent is; else why not. */
function writableOrCreatable(dir: string): true | "creatable" | string {
  let probe = dir;
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) return "no part of it exists";
    probe = parent;
  }
  try {
    if (!statSync(probe).isDirectory()) return `${probe} isn't a folder`;
    accessSync(probe, constants.W_OK);
    return probe === dir ? true : "creatable";
  } catch (err) {
    return (err as Error).message;
  }
}

/**
 * The folders `serve` would watch under `root`, itself included, skipping dot-folders and node_modules. It stops
 * counting past `limit`, or after `budgetMs` (a home folder can hold millions), and says whether it got to the end.
 */
export function countFolders(root: string, limit: number, budgetMs = 3000): { folders: number; complete: boolean } {
  let n = 0;
  const stack = [resolve(root)];
  const until = Date.now() + budgetMs;
  while (stack.length && n <= limit && (n % 256 !== 0 || Date.now() < until)) {
    const dir = stack.pop()!;
    n++;
    let entries: Dirent[] = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch {}
    for (const e of entries) if (e.isDirectory() && !e.name.startsWith(".") && !SKIPPED_DIRS.has(e.name)) stack.push(join(dir, e.name));
  }
  return { folders: n, complete: stack.length === 0 };
}

function maxUserWatches(): number | undefined {
  try {
    const n = Number(readFileSync("/proc/sys/fs/inotify/max_user_watches", "utf8").trim());
    return Number.isInteger(n) && n > 0 ? n : undefined;
  } catch {
    return undefined;
  }
}

function isListening(url: string): Promise<boolean> {
  const u = new URL(url);
  return new Promise((ok) => {
    const s = connect({ host: u.hostname.replace(/^\[(.*)\]$/, "$1"), port: Number(u.port) });
    s.setTimeout(1000);
    s.once("connect", () => { s.destroy(); ok(true); });
    s.once("timeout", () => { s.destroy(); ok(false); });
    s.once("error", () => ok(false));
  });
}
