// From edspencer/cli-contract reference/service/index.ts @ 1.0; local changes: none
// The service manager for this OS (SPEC §7), and the lines every tool's `install` and `status` print about it.
// Node built-ins only.

import { createLaunchd } from './launchd.ts';
import { spawnRunner, UnsupportedPlatformError, type LingerState, type Runner, type ServiceIdentity, type ServiceManager } from './manager.ts';
import { createSystemd } from './systemd.ts';

export interface ManagerOptions {
  platform?: NodeJS.Platform;
  run?: Runner;
  homeDir?: string;
  xdgConfigHome?: string;
  /** Injected for tests: launchd's waits. */
  sleep?: (ms: number) => void;
}

/**
 * launchd on macOS, systemd on Linux. Anything else throws `UnsupportedPlatformError`, which a tool reports and exits
 * 1 on. Windows (P3) gets Task Scheduler and a supervisor here, behind the same interface (Hallway's
 * `server/platform/schtasks.ts` is the start of one).
 */
export function serviceManagerFor(id: ServiceIdentity, o: ManagerOptions = {}): ServiceManager {
  const platform = o.platform ?? process.platform;
  const run = o.run ?? spawnRunner;
  if (platform === 'darwin') return createLaunchd(id, { run, ...(o.homeDir !== undefined ? { homeDir: o.homeDir } : {}), ...(o.sleep ? { sleep: o.sleep } : {}) });
  if (platform === 'linux') {
    return createSystemd(id, { run, ...(o.homeDir !== undefined ? { homeDir: o.homeDir } : {}), ...(o.xdgConfigHome !== undefined ? { xdgConfigHome: o.xdgConfigHome } : {}) });
  }
  throw new UnsupportedPlatformError(
    `\`${id.tool} service\` runs on macOS (launchd) and Linux (systemd --user), not ${platform} yet. Run \`${id.tool} serve\` in a terminal instead, or keep it running with whatever this machine uses.`,
  );
}

/**
 * The linger line (SPEC §7), only for the people it applies to: nothing on macOS, nothing when it's on, and nothing
 * when loginctl couldn't answer. `install` says only what it knows; `doctor` reports a check it couldn't make as
 * skipped.
 */
export function lingerAdvice(linger: LingerState, name: string): string | undefined {
  if (!linger.applies || linger.enabled !== false) return undefined;
  return `Linger is off, so the service stops when you log out, SSH sessions included. To keep ${name} running, once:\n    sudo loginctl enable-linger ${linger.user ?? '$USER'}`;
}

export * from './manager.ts';
