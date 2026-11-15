// The list of folders one Localidraw serves: `~/.localidraw/config.json`, read by the server (which watches it) and
// edited by `localidraw add`, `remove` and `folders`, which need no server running. Plus Scratch,
// `~/.localidraw/drawings`, which is always there and listed first.
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { writeAtomic } from "./files.ts";

/** A listed folder: where it is, and its name, the first part of its canvases' paths in the URL and the API. */
export type FolderEntry = { path: string; name: string };
export type Config = { folders: FolderEntry[] };

/** Scratch's name, which no listed folder may take. */
export const SCRATCH = "scratch";

export const configPath = (home: string) => join(home, "config.json");
export const scratchDir = (home: string) => join(home, "drawings");

/** A name is a URL-safe word: letters, digits, `-` and `_`, starting with a letter or digit, up to 64. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Why `name` can't be a folder's name, or undefined if it can. */
export function badName(name: string): string | undefined {
  if (!NAME.test(name)) return `a folder's name is letters, digits, - and _ (starting with a letter or digit, up to 64): not ${JSON.stringify(name)}`;
  if (name.toLowerCase() === SCRATCH) return `"${SCRATCH}" is Scratch's name; give the folder another with --name`;
  return undefined;
}

/** A folder's basename as a name: anything that isn't URL-safe becomes `-`. */
export function defaultName(path: string): string {
  const slug = basename(path).replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^[-_]+|-+$/g, "").slice(0, 64);
  return slug || "folder";
}

/** The config's folders, checked. Throws an Error saying what's wrong with it; a missing file is an empty list. */
export function readConfig(home: string): Config {
  const file = configPath(home);
  if (!existsSync(file)) return { folders: [] };
  return parseConfig(readFileSync(file, "utf8"), file);
}

export function parseConfig(content: string, file = "config.json"): Config {
  if (!content.trim()) return { folders: [] };
  let raw: any;
  try {
    raw = JSON.parse(content);
  } catch (err) {
    throw new Error(`${file} isn't valid JSON: ${(err as Error).message}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(`${file} should be an object, { "folders": [...] }`);
  const list = raw.folders ?? [];
  if (!Array.isArray(list)) throw new Error(`${file}: "folders" should be a list`);
  const folders: FolderEntry[] = [];
  const names = new Set<string>();
  for (const [i, f] of list.entries()) {
    if (typeof f?.path !== "string" || !isAbsolute(f.path)) throw new Error(`${file}: folders[${i}] needs an absolute "path"`);
    const name = f.name === undefined ? defaultName(f.path) : f.name;
    if (typeof name !== "string") throw new Error(`${file}: folders[${i}]'s "name" should be a string`);
    const why = badName(name);
    if (why) throw new Error(`${file}: folders[${i}]: ${why}`);
    if (names.has(name.toLowerCase())) throw new Error(`${file}: two folders are named ${name}`);
    names.add(name.toLowerCase());
    folders.push({ path: resolve(f.path), name });
  }
  return { folders };
}

/** Writes the list, keeping anything else a person put in the file. */
function writeConfig(home: string, folders: FolderEntry[]) {
  const file = configPath(home);
  let rest: Record<string, unknown> = {};
  try { rest = JSON.parse(readFileSync(file, "utf8")); } catch {}
  writeAtomic(file, `${JSON.stringify({ ...rest, folders }, null, 2)}\n`);
}

/** The real path, for comparing: symlinks and `..` resolved, as far as the path exists. */
function real(path: string): string {
  try { return realpathSync.native(path); } catch { return resolve(path); }
}

const within = (outer: string, inner: string) => {
  const r = relative(outer, inner);
  return r === "" || (!r.startsWith(`..${sep}`) && r !== ".." && !isAbsolute(r));
};

/** A refusal from `add` or `remove`: said as it is, and exit 1. */
export class FolderError extends Error {}

/** `localidraw add`: the folder, checked against the list, added to it. Returns the entry it added. */
export function addFolder(home: string, path: string, name?: string): FolderEntry {
  const abs = resolve(path);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new FolderError(`${abs} isn't a folder`);
  const at = real(abs);
  if (within(real(home), at)) throw new FolderError(`${abs} is inside ${home}, Localidraw's own folder; drawings there go in Scratch`);
  const { folders } = readConfig(home);
  for (const f of folders) {
    const other = real(f.path);
    if (other === at) throw new FolderError(`${abs} is listed already, as ${f.name}`);
    if (within(other, at)) throw new FolderError(`${abs} is inside ${f.path} (${f.name}), which is listed already: its canvases show there`);
    if (within(at, other)) throw new FolderError(`${abs} holds ${f.path} (${f.name}), which is listed already; remove that first (localidraw remove ${f.name})`);
  }
  const taken = new Set(folders.map((f) => f.name.toLowerCase()));
  let chosen: string;
  if (name !== undefined) {
    const why = badName(name);
    if (why) throw new FolderError(why);
    if (taken.has(name.toLowerCase())) throw new FolderError(`the name ${name} is taken; give another with --name`);
    chosen = name;
  } else {
    // The basename, and a number after it if that's taken (or is Scratch's).
    const base = defaultName(abs);
    chosen = base;
    for (let n = 2; taken.has(chosen.toLowerCase()) || chosen.toLowerCase() === SCRATCH; n++) chosen = `${base.slice(0, 60)}-${n}`;
  }
  const entry = { path: abs, name: chosen };
  writeConfig(home, [...folders, entry]);
  return entry;
}

/** `localidraw remove`: by name, or by path. Returns the entry it removed. The folder itself is left alone. */
export function removeFolder(home: string, which: string): FolderEntry {
  const { folders } = readConfig(home);
  const byName = folders.find((f) => f.name.toLowerCase() === which.toLowerCase());
  const abs = resolve(which);
  const found = byName ?? folders.find((f) => f.path === abs || real(f.path) === real(abs));
  if (!found) throw new FolderError(`${which} isn't in the list (localidraw folders lists them)`);
  writeConfig(home, folders.filter((f) => f !== found));
  return found;
}

/** Is the folder there? A listed folder that isn't (an unmounted drive, a deleted clone) stays listed, as missing. */
export function isThere(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

/** The listed folder that holds `dir`, if any: for `serve`'s hint about the current folder. */
export function listedFolderHolding(folders: readonly FolderEntry[], dir: string): FolderEntry | undefined {
  const at = real(dir);
  return folders.find((f) => within(real(f.path), at));
}
