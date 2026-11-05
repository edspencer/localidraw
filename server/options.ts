// The hosting options, read the same way by `serve` and `service install`: the allowed hosts, --poll, and the refusal
// to listen beyond loopback without an allowed host (AGENTS.md).
import { homedir } from "node:os";
import { join } from "node:path";
import { UsageError } from "./contract/output.ts";
import { isLoopbackAddress, parseAllowedHost } from "./security.ts";
import { DEFAULT_POLL } from "./server.ts";

/** The allowed hosts, normalised; a usage error for anything that isn't a bare host name or address. */
export function parseAllowedHosts(values: readonly string[]): string[] {
  return values
    .map((h) => h.trim())
    .filter(Boolean)
    .map((h) => {
      const parsed = parseAllowedHost(h);
      if (!parsed) throw new UsageError(`not a host name: ${h} (give the name alone, without http:// or a port)`);
      return parsed;
    });
}

/** --poll's value: the ms, `true` for the default, or off. Undefined means watch by file events. */
export function parsePoll(value: string | undefined): number | undefined {
  if (value === undefined || /^(false|off|no|0)$/i.test(value)) return undefined;
  let poll: number;
  if (/^(true|on|yes)$/i.test(value)) poll = DEFAULT_POLL;
  else if (/^\d+$/.test(value)) poll = Number(value);
  else throw new UsageError(`--poll takes a number of milliseconds, not ${value}`);
  if (poll < 100) throw new UsageError(`--poll ${poll} is too often; give at least 100 ms`);
  return poll;
}

/** Refuses an address beyond loopback with no allowed host: anyone who can reach it could change the canvases. */
export function requireAllowedHost(host: string, allowedHosts: readonly string[]): void {
  if (isLoopbackAddress(host) || allowedHosts.length > 0) return;
  throw new UsageError(`refusing to listen on ${host} without an allowed host name.
  Anyone who can reach that address could read and change your canvases, and Localidraw has no login.
  Name the host it's reached by, e.g. --allowed-host draw.example.com (or LOCALIDRAW_ALLOWED_HOSTS), and put it
  behind a reverse proxy that does authentication.`);
}

/** `os.homedir()`, which throws on a machine with no passwd entry. */
export function safeHomeDir(): string {
  try {
    return homedir();
  } catch {
    return process.env.HOME ?? process.env.USERPROFILE ?? ".";
  }
}

/**
 * Localidraw's own home, `~/.localidraw`: `runtime.json`, the service's log and working folder, and (from `update`)
 * its lock. Never drawings: those stay in the folder it serves.
 */
export function localidrawHome(homeDir: string = safeHomeDir()): string {
  return join(homeDir, ".localidraw");
}
