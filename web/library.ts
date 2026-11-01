// Excalidraw's Library (the reusable shapes in its sidebar). When the folder has a library.excalidrawlib at its root,
// that's where it lives: shared by everyone using the folder, watched, and merged like a canvas. Otherwise it's kept in
// this browser (localStorage). Either way it's written only when the Library actually changes.
import { restoreLibraryItems, serializeLibraryAsJSON } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI, LibraryItems } from "@excalidraw/excalidraw/types";
import { getLibrary, putLibrary, type LibraryFile } from "./api.ts";
import { mergeLibraries } from "./merge.ts";
import { prefs } from "./prefs.ts";

const RETRY_AFTER_MS = 2000;

/** What counts as a change: an item added, removed, renamed, published, or its shapes changed. */
const fingerprint = (items: LibraryItems) =>
  JSON.stringify(items.map((i) => [i.id, i.status, i.name ?? "", i.elements.map((e) => [e.id, e.version])]));
const restore = (file: LibraryFile) => restoreLibraryItems((file.libraryItems ?? file.library ?? []) as never, "unpublished");
const ids = (items: LibraryItems) => new Set(items.map((i) => i.id));

let api: ExcalidrawImperativeAPI | null = null;
let items: LibraryItems = []; // as on screen
let stored = ""; // the fingerprint of what's in the file, or in localStorage
let file: { hash: string; base: Set<string> } | null = null; // the folder's file, when it has one
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

function useLocal() {
  file = null;
  items = restoreLibraryItems(prefs.library() as never, "unpublished");
  stored = fingerprint(items);
}

function useFile(hash: string, lib: LibraryFile) {
  items = restore(lib);
  file = { hash, base: ids(items) };
  stored = fingerprint(items);
}

async function load() {
  const r = await getLibrary().catch(() => ({ shared: false as const }));
  if (r.shared) useFile(r.hash, r.library);
  else useLocal();
}

async function save(): Promise<void> {
  if (!file) {
    prefs.setLibrary(items);
    stored = fingerprint(items);
    return;
  }
  if (saving) { again = true; return; }
  saving = true;
  const sent = items;
  let retry = false;
  try {
    const result = await putLibrary(file.hash, serializeLibraryAsJSON(sent));
    if (result.ok) {
      file = { hash: result.hash, base: ids(sent) };
      stored = fingerprint(sent);
    } else if ("gone" in result) {
      useLocal(); // the file was deleted: back to this browser's own Library
      show(items);
    } else {
      absorb(result.conflict.hash, result.conflict.library);
    }
  } catch {
    retry = true;
  } finally {
    saving = false;
    if (again || heard) {
      again = false;
      if (heard) { heard = false; void library.onDisk(undefined); }
      else void save();
    } else if (retry) setTimeout(() => void save(), RETRY_AFTER_MS);
  }
}

/** The file's newer version into the Library on screen, keeping what was added or removed here since; saved if so. */
function absorb(hash: string, lib: LibraryFile) {
  const remote = restore(lib);
  const merged = file ? mergeLibraries(items, remote, file.base) : remote;
  file = { hash, base: ids(remote) };
  stored = fingerprint(remote);
  show(merged);
  if (fingerprint(merged) !== stored) again = true;
}

export const library = {
  /** The ids of the items on screen, for the test handle. */
  ids: () => items.map((i) => i.id),
  /** An Excalidraw is up: load the Library (the first time), and put it in. */
  async attach(a: ExcalidrawImperativeAPI) {
    api = a;
    await (ready ??= load());
    if (api === a) show(items);
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
  /** The file changed on disk: its new hash, null if it's gone, or undefined if it may have (after a reconnect). */
  async onDisk(hash: string | null | undefined) {
    if (!ready) return;
    await ready;
    if (saving) { heard = true; return; } // looked at once the save is done
    if (hash === null) {
      if (file) { useLocal(); show(items); }
      return;
    }
    if (file && hash === file.hash) return; // our own save
    const r = await getLibrary().catch(() => null);
    if (!r || saving) return;
    if (!r.shared) {
      if (file) { useLocal(); show(items); }
    } else if (!file) {
      useFile(r.hash, r.library); // the folder has one now: use it
      show(items);
    } else if (r.hash !== file.hash) {
      absorb(r.hash, r.library);
      if (again) { again = false; void save(); }
    }
  },
};
