// The canvases under the root folder: finding them, and reading and writing them safely.
// A project is a folder that holds at least one canvas; a canvas is a .excalidraw file.
import { createHash } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

export type Canvas = { path: string; name: string };
export type Project = { dir: string; canvases: Canvas[] };

/** Folders never searched for canvases, at any depth. Dot-folders are skipped too. */
export const SKIPPED_DIRS = new Set(["node_modules"]);

export const EMPTY_SCENE = {
  type: "excalidraw",
  version: 2,
  source: "https://github.com/edspencer/localidraw",
  elements: [],
  appState: { viewBackgroundColor: "#ffffff", gridSize: 20 },
  files: {},
};

/**
 * A canvas file's scene. An empty file is an empty canvas, so `touch plan.excalidraw` makes one. Anything else
 * that isn't a scene (half-written JSON, or JSON of another kind) throws, so the page won't open it and draw over it.
 */
export function parseCanvas(content: string): { elements: unknown[] } {
  if (!content.trim()) return structuredClone(EMPTY_SCENE);
  let scene: any;
  try {
    scene = JSON.parse(content);
  } catch (err) {
    throw new Error(`It isn't valid JSON: ${(err as Error).message}.`);
  }
  if (!Array.isArray(scene?.elements)) {
    throw new Error("It's JSON, but not an Excalidraw scene.");
  }
  return scene;
}

/** The folder's shared Library (Excalidraw's reusable shapes), used when it exists. Only ever at the root. */
export const LIBRARY_FILE = "library.excalidrawlib";

export const EMPTY_LIBRARY = { type: "excalidrawlib", version: 2, source: "https://github.com/edspencer/localidraw", libraryItems: [] };

/**
 * A library file's content: version 2 (`libraryItems`) or version 1 (`library`). An empty file is an empty Library,
 * so `touch library.excalidrawlib` starts one. Anything else throws, so the page won't load it and save over it.
 */
export function parseLibrary(content: string): { libraryItems?: unknown[]; library?: unknown[] } {
  if (!content.trim()) return structuredClone(EMPTY_LIBRARY);
  let lib: any;
  try {
    lib = JSON.parse(content);
  } catch (err) {
    throw new Error(`It isn't valid JSON: ${(err as Error).message}.`);
  }
  if (!Array.isArray(lib?.libraryItems) && !Array.isArray(lib?.library)) {
    throw new Error("It's JSON, but not an Excalidraw library.");
  }
  return lib;
}

export const contentHash = (content: string) => createHash("sha256").update(content).digest("hex").slice(0, 16);

const toPosix = (p: string) => p.split(sep).join("/");
const skipped = (name: string) => name.startsWith(".") || SKIPPED_DIRS.has(name);

/**
 * The absolute path of `rel` inside `root`, or undefined when it isn't a canvas path there: outside the root,
 * inside a dot-folder or node_modules, or (for a file) not a .excalidraw file.
 */
export function resolveInRoot(root: string, rel: unknown, kind: "file" | "dir"): string | undefined {
  if (typeof rel !== "string" || rel.includes("\0")) return undefined;
  const abs = resolve(root, rel);
  const r = relative(root, abs);
  if (r === ".." || r.startsWith(`..${sep}`) || isAbsolute(r)) return undefined; // outside, or on another drive
  const parts = r === "" ? [] : r.split(sep);
  if (parts.some(skipped)) return undefined;
  if (kind === "file" && (parts.length === 0 || extname(abs) !== ".excalidraw")) return undefined;
  return abs;
}

/** Every project under `root`, sorted by folder, with its canvases sorted by name. */
export function listProjects(root: string): Project[] {
  const projects: Project[] = [];
  const walk = (abs: string) => {
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return; // unreadable, or removed while walking
    }
    const dir = toPosix(relative(root, abs));
    const canvases = entries
      .filter((e) => e.isFile() && e.name.endsWith(".excalidraw") && !e.name.startsWith("."))
      .map((e) => ({ path: dir ? `${dir}/${e.name}` : e.name, name: e.name.slice(0, -".excalidraw".length) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (canvases.length) projects.push({ dir, canvases });
    for (const e of entries) if (e.isDirectory() && !skipped(e.name)) walk(join(abs, e.name));
  };
  walk(root);
  return projects.sort((a, b) => a.dir.localeCompare(b.dir));
}

/** Writes through a temporary file and a rename, so no reader ever sees half a canvas. */
export function writeAtomic(abs: string, content: string) {
  mkdirSync(dirname(abs), { recursive: true });
  const tmp = join(dirname(abs), `.localidraw-${process.pid}-${Date.now()}.tmp`);
  writeFileSync(tmp, content);
  renameSync(tmp, abs);
}

export const relativePath = (root: string, abs: string) => toPosix(relative(root, abs));

/** Where a deleted canvas goes, under the root: a dot-folder, so it's never listed or watched. */
export const TRASH_DIR = ".localidraw/trash";

/** The error for a name that's taken: a rename never replaces a file. */
const taken = () => Object.assign(new Error("There's already a file there."), { code: "EEXIST" });

/**
 * Renames `from` to `to` (making its folders), and never over an existing file. A hard link refuses an existing name
 * atomically, then the old name is removed: the file itself is never deleted. Where links aren't supported (some
 * network and FAT file systems), and for a change of case only on a case-insensitive disk, it checks, then renames.
 */
export function renameNoReplace(from: string, to: string) {
  mkdirSync(dirname(to), { recursive: true });
  if (existsSync(to)) {
    const a = statSync(from), b = statSync(to);
    if (a.ino !== b.ino || a.dev !== b.dev) throw taken();
    return renameSync(from, to); // the same file: only the case of its name changes
  }
  try {
    linkSync(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") throw taken();
    if (existsSync(to)) throw taken();
    return renameSync(from, to);
  }
  unlinkSync(from);
}

/** Moves a canvas into the trash as `<timestamp>-<name>`, and returns its root-relative path there. */
export function moveToTrash(root: string, abs: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  for (let n = 1; ; n++) {
    const name = `${stamp}${n > 1 ? `-${n}` : ""}-${basename(abs)}`;
    try {
      renameNoReplace(abs, join(root, TRASH_DIR, name));
      return `${TRASH_DIR}/${name}`;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
}

/**
 * The absolute path of a canvas in the trash, or undefined: `rel` must be `.localidraw/trash/<name>.excalidraw`, the
 * way moveToTrash names them, with nothing else in the path. (resolveInRoot refuses dot-folders, so the trash has this.)
 */
export function resolveInTrash(root: string, rel: unknown): string | undefined {
  if (typeof rel !== "string" || !rel.startsWith(`${TRASH_DIR}/`)) return undefined;
  const name = rel.slice(TRASH_DIR.length + 1);
  if (!name || name.includes("/") || name.includes("\\") || name.includes("\0") || name.startsWith(".") || extname(name) !== ".excalidraw") return undefined;
  return join(root, TRASH_DIR, name);
}
