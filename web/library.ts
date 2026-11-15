// Excalidraw's Library (the reusable shapes in its sidebar). Which Library it is follows the open canvas:
// - serving one folder: the folder's library.excalidrawlib, when it has one at its root, and otherwise this browser's
//   (localStorage);
// - serving the list: the open canvas's folder's library.excalidrawlib, when it has one, and otherwise Localidraw's
//   own (~/.localidraw/library.excalidrawlib). That one is made by the first change, starting from this browser's.
// A file is shared by everyone using it, watched, and merged like a canvas. Either way it's written only when the
// Library actually changes.
import { restoreLibraryItems, serializeLibraryAsJSON } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI, LibraryItems } from "@excalidraw/excalidraw/types";
import { getLibrary, NO_FILE, putLibrary, type LibraryFile } from "./api.ts";
import { mergeLibraries } from "./merge.ts";
import { prefs } from "./prefs.ts";

const RETRY_AFTER_MS = 2000;
const LIBRARY_FILE = "library.excalidrawlib";

/** What counts as a change: an item added, removed, renamed, published, or its shapes changed. */
const fingerprint = (items: LibraryItems) =>
  JSON.stringify(items.map((i) => [i.id, i.status, i.name ?? "", i.elements.map((e) => [e.id, e.version])]));
const restore = (file: LibraryFile) => restoreLibraryItems((file.libraryItems ?? file.library ?? []) as never, "unpublished");
const ids = (items: LibraryItems) => new Set(items.map((i) => i.id));

let api: ExcalidrawImperativeAPI | null = null;
let items: LibraryItems = []; // as on screen
let stored = ""; // the fingerprint of what's in the file, or in localStorage
/** The Library in use, as the server names it: a file's path, or (with no file) the one a first save would make. */
let id = LIBRARY_FILE;
let file: { hash: string; base: Set<string> } | null = null; // the file, when there is one
let creatable = false; // no file yet, and a change makes one (Localidraw's own, serving the list)
let canvas: string | null = null; // the open canvas, which decides which Library it is
let ready: Promise<void> | null = null;
let echo: string | null = null; // the fingerprint of an update we made, until Excalidraw reports it back
let saving = false, again = false, heard = false;

/** Shows `next` in Excalidraw. Excalidraw reports it back through onLibraryChange, which mustn't count as a change. */
function show(next: LibraryItems) {
  items = next;
  if (!api) return;
  echo = fingerprint(next);
  void api.updateLibrary({ libraryItems: next, merge: false });
}

function useLocal(path = LIBRARY_FILE, canMake = false) {
  id = path;
  file = null;
  creatable = canMake;
  items = restoreLibraryItems(prefs.library() as never, "unpublished");
  stored = fingerprint(items);
}

function useFile(path: string, hash: string, lib: LibraryFile) {
  id = path;
  creatable = false;
  items = restore(lib);
  file = { hash, base: ids(items) };
  stored = fingerprint(items);
}

type Answer = Awaited<ReturnType<typeof getLibrary>>;
const use = (r: Answer) => (r.shared ? useFile(r.path ?? LIBRARY_FILE, r.hash, r.library) : useLocal(r.path, r.creatable === true));

async function load() {
  const r = await getLibrary(canvas).catch(() => ({ shared: false as const }));
  use(r);
}

async function save(): Promise<void> {
  // This browser's Library, while there's no file. Kept there too while the first save that makes one is on its way,
  // so a change can't be lost if that save fails and the page looks again.
  if (!file) prefs.setLibrary(items);
  if (!file && !creatable) {
    stored = fingerprint(items);
    return;
  }
  if (saving) { again = true; return; }
  saving = true;
  const sent = items, to = id;
  let retry = false;
  try {
    // With no file yet, this one makes it (NO_FILE), with everything on screen: this browser's Library and the change.
    const result = await putLibrary(to, file ? file.hash : NO_FILE, serializeLibraryAsJSON(sent));
    if (to !== id) {
      heard = true; // the open canvas moved to another Library meanwhile: look again once this is done
    } else if (result.ok) {
      file = { hash: result.hash, base: ids(sent) };
      creatable = false;
      stored = fingerprint(sent);
    } else if ("gone" in result) {
      heard = true; // the file was deleted: ask which Library it is now (this browser's, or Localidraw's own)
    } else {
      absorb(result.conflict.hash, result.conflict.library);
    }
  } catch {
    retry = true;
  } finally {
    saving = false;
    if (again || heard) {
      again = false;
      if (heard) { heard = false; void library.onDisk(undefined, undefined); }
      else void save();
    } else if (retry) setTimeout(() => void save(), RETRY_AFTER_MS);
  }
}

/** The file's newer version into the Library on screen, keeping what was added or removed here since; saved if so. */
function absorb(hash: string, lib: LibraryFile) {
  const remote = restore(lib);
  // Made by someone else first: everything here counts as added here, so none of it is lost.
  const merged = mergeLibraries(items, remote, file ? file.base : new Set());
  file = { hash, base: ids(remote) };
  creatable = false;
  stored = fingerprint(remote);
  show(merged);
  if (fingerprint(merged) !== stored) again = true;
}

export const library = {
  /** The ids of the items on screen, for the test handle. */
  ids: () => items.map((i) => i.id),
  /** The Library in use (its path, as the server names it) and whether it's a file yet, for the test handle. */
  where: () => ({ path: id, file: file !== null }),
  /** An Excalidraw is up: load the Library (the first time), and put it in. */
  async attach(a: ExcalidrawImperativeAPI) {
    api = a;
    await (ready ??= load());
    if (api === a) show(items);
  },
  /** Another canvas is open: its folder may have a Library of its own, or not. */
  async open(path: string | null) {
    if (path === canvas) return;
    canvas = path;
    if (!ready) return; // attach loads it, for this canvas
    await ready;
    void library.onDisk(undefined, undefined);
  },
  /** Excalidraw's onLibraryChange: saved if it's really a change. */
  changed(next: LibraryItems) {
    const now = fingerprint(next);
    if (echo !== null) {
      // Our own update, reported back: as Excalidraw restored it, which is what later changes are compared with.
      if (echo === stored) stored = now;
      echo = null;
      items = next;
      return;
    }
    if (!ready) return;
    items = next;
    if (now !== stored) void save();
  },
  /**
   * A Library file changed on disk: its path and new hash, null if it's gone; or undefined for both if any may have
   * (after a reconnect, or another canvas opened). Another file than the one in use may be the one to use now.
   */
  async onDisk(path: string | undefined, hash: string | null | undefined) {
    if (!ready) return;
    await ready;
    if (saving) { heard = true; return; } // looked at once the save is done
    if (path === id && file && hash === file.hash) return; // our own save
    const r = await getLibrary(canvas).catch(() => null);
    if (!r || saving) return;
    const at = r.path ?? LIBRARY_FILE;
    if (at !== id || !r.shared || !file) {
      // Another Library (another folder's, or a file made or deleted): show that one. A file only just made with the
      // same items (our own first save, reported back) changes nothing on screen.
      const before = fingerprint(items);
      use(r);
      if (fingerprint(items) !== before) show(items);
    } else if (r.hash !== file.hash) {
      absorb(r.hash, r.library);
      if (again) { again = false; void save(); }
    }
  },
};
