// `localidraw update [--check] [--to <version|tag>] [--yes] [--force] [--json]` (the CLI contract's SPEC §5), and
// `upgrade`, its hidden alias. The sequence is the contract's (contract/update.ts); this is what's Localidraw's: its
// names, its busy check, and its service.
//
// - **The busy check** asks the Localidraw the unit describes, or a `serve` found through ~/.localidraw/runtime.json:
//   a save being written is the only thing a restart would cut short (an open page saves again once it's back).
// - **The service** is the one `localidraw service` installs. It's stopped before npm runs and handed over to the new
//   version through `service install --refresh`, run by the new CLI, which re-writes the unit from what it records.
// - **Its home** is ~/.localidraw, for `update.lock` and `update-check.json` (which `service status` repeats).
import { spawnSync } from "node:child_process";
import { guardBusy } from "./contract/busy-client.ts";
import { waitForVersion } from "./contract/health.ts";
import { UsageError, type Output } from "./contract/output.ts";
import { readLiveRuntimeFile } from "./contract/runtime-file.ts";
import { UnsupportedPlatformError, type ServiceManager } from "./contract/service/index.ts";
import { tailFile } from "./contract/service/logs.ts";
import { serviceLogPath } from "./contract/service/spec.ts";
import { runUpdate, type UpdateOptions, type UpdateProduct, type ServiceSnapshot } from "./contract/update.ts";
import { localidrawHome } from "./options.ts";
import { pkg } from "./package.ts";
import { BUSY_NOUNS, localFetch, managerFor, unitProbeUrl, type ServiceContext } from "./service.ts";

export const PACKAGE_NAME = "localidraw";
export const IMAGE = "ghcr.io/edspencer/localidraw";
export const changelogUrl = (version: string) => `https://github.com/edspencer/localidraw/releases/tag/v${version}`;
/** What a checkout runs to update itself (SPEC §6). */
export const CHECKOUT_COMMAND = "git pull && npm install && npm run build";

export const UPDATE_USAGE = `Usage: localidraw update [--check] [--to <version|tag>] [--yes] [--force] [--json]
`;

export const UPDATE_HELP = `localidraw update: update Localidraw to the latest version, and restart its service

${UPDATE_USAGE}
  --check           say whether there's a newer version, and change nothing
  --to <version|tag>
                    a version (0.6.0) or a dist-tag (next) instead of the latest; the only way to go back
  --yes             don't ask first (needed without a terminal)
  --force           don't wait for the saves under way (the health check and the rollback still run)
  --json            one JSON document on stdout; the rest goes to stderr

It updates a global npm, pnpm, bun or Volta install, and only when a person runs it: Localidraw never asks the
registry by itself. With the service installed it stops it, installs, and starts the new version, and if that
doesn't answer it puts the old one back (exit 6). Docker, npx and a checkout are told the command to run instead
(exit 5). It exits 75, changing nothing, while a canvas is being saved.
`;

/** The arguments after `update`. Returns "help" for `--help`. */
export function parseUpdateArgs(args: readonly string[]): UpdateOptions | "help" {
  if (args.some((a) => a === "-h" || a === "--help")) return "help";
  const o: UpdateOptions = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--check") o.check = true;
    else if (a === "--yes" || a === "-y") o.yes = true;
    else if (a === "--force") o.force = true;
    else if (a === "--json") o.json = true;
    else if (a === "--to" || a.startsWith("--to=")) {
      const v = a === "--to" ? args[++i] : a.slice("--to=".length);
      if (!v) throw new UsageError("--to needs a version or a dist-tag");
      o.to = v;
    } else if (a.startsWith("-")) throw new UsageError(`unknown option ${a}`);
    else throw new UsageError(`\`update\` takes no ${/^\d/.test(a) ? `version on its own (did you mean --to ${a}?)` : `argument (got ${a})`}`);
  }
  return o;
}

/** The service manager, or null where there's none yet (Windows): then there's only ever a `serve` to find. */
function managerOrNull(ctx: ServiceContext): ServiceManager | null {
  try {
    return managerFor(ctx);
  } catch (err) {
    if (err instanceof UnsupportedPlatformError) return null;
    throw err;
  }
}

/** Localidraw, as the contract's update sequence sees it. */
export function localidrawProduct(ctx: ServiceContext, o: { out: Output; entry: string; askLocally: Set<string> }): UpdateProduct {
  const home = localidrawHome(ctx.homeDir);
  const manager = managerOrNull(ctx);
  /** Localidraw's own URLs are asked with `Host: localhost` (localFetch); the registry is asked as it is. */
  const local = (url: string) => { o.askLocally.add(new URL(url).origin); return url; };
  const inspect = (): ServiceSnapshot => {
    const state = manager?.status();
    if (state?.registered) {
      return { installed: true, running: state.running, url: local(unitProbeUrl(state.argv)), log: state.logPath ?? serviceLogPath(home) };
    }
    const live = readLiveRuntimeFile(home);
    return { installed: false, running: live !== null, ...(live ? { url: local(live.url) } : {}) };
  };
  return {
    name: "Localidraw",
    tool: "localidraw",
    packageName: PACKAGE_NAME,
    envPrefix: "LOCALIDRAW",
    home,
    currentVersion: pkg.version,
    entry: o.entry,
    binSubpath: "dist/server/cli.js",
    image: IMAGE,
    usage: UPDATE_USAGE,
    changelogUrl,
    guardBusy: ({ force }) => {
      const { url } = inspect();
      return guardBusy({ home, out: o.out, name: "Localidraw", nouns: BUSY_NOUNS, force, fetch: ctx.fetch ?? localFetch, ...(url ? { url } : {}),
        hint: "Try again in a moment, once it's written, or use --force." });
    },
    service: {
      inspect,
      stop() {
        if (!manager) throw new Error("there's no service manager here");
        manager.stop();
      },
      refresh(cliPath) {
        const r = spawnSync(ctx.nodePath, [cliPath, "service", "install", "--refresh"], { encoding: "utf8", windowsHide: true });
        return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? (r.error ? r.error.message : "") };
      },
      tail(lines) {
        const state = manager?.status();
        try {
          return tailFile(state?.logPath ?? serviceLogPath(home), lines);
        } catch {
          return "";
        }
      },
    },
    waitForVersion: ({ url, version, timeoutMs }) => waitForVersion({ url, version, timeoutMs, fetch: ctx.fetch ?? localFetch }),
  };
}

/** A fetch for the update sequence: Localidraw's own URLs with `Host: localhost`, anything else (the registry) as it is. */
export function splitFetch(askLocally: Set<string>, local: typeof fetch = localFetch): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
    return askLocally.has(new URL(url).origin) ? local(url, init) : fetch(input, init);
  }) as typeof fetch;
}

export async function runUpdateCommand(opts: UpdateOptions, ctx: ServiceContext, out: Output, entry: string): Promise<number> {
  const askLocally = new Set<string>();
  const product = localidrawProduct(ctx, { out, entry, askLocally });
  return runUpdate(product, opts, { out, fetch: splitFetch(askLocally, ctx.fetch ?? localFetch) });
}
