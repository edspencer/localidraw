// From edspencer/cli-contract reference/service/spec.ts @ 0.2; local changes: none
// Where a service's files go, and the spec a unit is written from (SPEC §7). Pure: launchd.ts and systemd.ts render
// what this decides, so a macOS plist can be tested on Linux. Node built-ins only.

import fs from 'node:fs';
import path from 'node:path';
import type { ServiceSpec } from './manager.ts';
import { servicePath, type ServicePathOptions } from './path-env.ts';

/** The service's working folder, `<home>/service`: not the user's home, and not among the data. */
export function serviceDir(home: string): string {
  return path.join(home, 'service');
}

/** `<home>/logs`. */
export function logsDir(home: string): string {
  return path.join(home, 'logs');
}

/** `<home>/logs/service.log`: both streams, appended, on every OS. The tool rotates it (copy, then truncate). */
export function serviceLogPath(home: string): string {
  return path.join(logsDir(home), 'service.log');
}

export interface SpecInput extends ServicePathOptions {
  /** `process.execPath`; realpath'd here. */
  nodePath: string;
  /** The CLI's script; realpath'd here. */
  scriptPath: string;
  /** `serve` and the options. Name the port: a unit that relies on a default changes port when the default does. */
  args: string[];
  /** The tool's home: the working folder and the log go under it. */
  home: string;
  /** The installing shell's PATH. */
  pathEnv?: string;
  env?: Record<string, string>;
  realpath?: (p: string) => string;
}

/** The spec for `install`. */
export function buildSpec(input: SpecInput): ServiceSpec {
  const real = (p: string) => {
    try {
      return (input.realpath ?? fs.realpathSync)(p);
    } catch {
      return p;
    }
  };
  const nodePath = real(input.nodePath);
  return {
    nodePath,
    scriptPath: real(input.scriptPath),
    args: [...input.args],
    workingDirectory: serviceDir(input.home),
    logPath: serviceLogPath(input.home),
    pathEnv: servicePath(path.dirname(nodePath), input.pathEnv, {
      ...(input.exists !== undefined ? { exists: input.exists } : {}),
      ...(input.systemDirs !== undefined ? { systemDirs: input.systemDirs } : {}),
    }),
    ...(input.env !== undefined ? { env: { ...input.env } } : {}),
  };
}

/**
 * A flag's value in an installed unit's arguments: what `service install --refresh` keeps (SPEC §5 step 11), and the
 * port `status` reports. Read from the unit, not from today's flags, which may differ.
 */
export function argValue(argv: readonly string[], names: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    if (names.includes(argv[i]) && argv[i + 1] !== undefined) return argv[i + 1];
    const eq = names.find((n) => argv[i].startsWith(`${n}=`));
    if (eq !== undefined) return argv[i].slice(eq.length + 1);
  }
  return undefined;
}
