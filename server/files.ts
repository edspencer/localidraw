// The canvases under the root folder: finding them, and reading and writing them safely.
// A project is a folder that holds at least one canvas; a canvas is a .excalidraw file.
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

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
