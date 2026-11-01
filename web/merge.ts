// Merging a canvas changed on disk into the one on screen, per element. Pure, so the tests can run it in Node.

/** The fields of an Excalidraw element the merge looks at. */
export type Versioned = { id: string; version: number; versionNonce?: number; index?: string | null; isDeleted?: boolean };

/** Each element's version: what the screen and the file last agreed on. */
export const versionsOf = (elements: readonly Versioned[]) => new Map(elements.map((e) => [e.id, e.version]));

/**
 * The scene on screen with the scene on disk merged in. `base` holds each element's version as of the last load or
 * save, so it says who changed what since:
 * - in both: if it wasn't changed here since, the disk's copy, even an older version (a `git checkout` of the file);
 *   if it was, the higher version wins, and disk wins a tie;
 * - only on screen: kept if it's new here (not in `base`) or was changed here since; otherwise disk removed it;
 * - only on disk: added.
 * The elements are in z-order (Excalidraw's fractional `index`). `replaced` lists the ids of elements changed here
 * whose change lost to a different one on disk (the same element edited on both sides), so the page can say so.
 */
export function mergeScenes<E extends Versioned>(local: readonly E[], remote: readonly E[], base: ReadonlyMap<string, number>): { elements: E[]; replaced: string[] } {
  const merged = new Map<string, E>();
  const replaced: string[] = [];
  const onScreen = new Map(local.map((e) => [e.id, e]));
  for (const r of remote) {
    const l = onScreen.get(r.id);
    const changedHere = l !== undefined && l.version !== base.get(r.id);
    const keep = changedHere && l.version > r.version;
    merged.set(r.id, keep ? l : r);
    // The same version and nonce is the same edit (one already saved), not two.
    if (changedHere && !keep && !(l.version === r.version && l.versionNonce === r.versionNonce)) replaced.push(r.id);
  }
  for (const l of local) {
    if (merged.has(l.id)) continue;
    const was = base.get(l.id);
    if (was === undefined || l.version > was) merged.set(l.id, l);
  }
  const elements = [...merged.values()].sort((a, b) => {
    const x = a.index ?? "", y = b.index ?? "";
    return x < y ? -1 : x > y ? 1 : 0;
  });
  return { elements, replaced };
}

/** Whether anything was drawn since `base`. Opening a canvas and moving around it never counts. */
export function changedSince(elements: readonly Versioned[], base: ReadonlyMap<string, number>): boolean {
  return elements.some((e) => (base.has(e.id) ? base.get(e.id) !== e.version : !e.isDeleted));
}

/**
 * The Library on screen with the Library file merged in, by item (an item's shapes don't change once it's made).
 * `base` holds the ids as of the last load or save:
 * - an item added on either side since is kept (the disk's new ones first, as Excalidraw puts the newest first);
 * - an item removed on either side since is removed;
 * - the rest keep the screen's order.
 */
export function mergeLibraries<I extends { id: string }>(local: readonly I[], remote: readonly I[], base: ReadonlySet<string>): I[] {
  const onDisk = new Set(remote.map((i) => i.id));
  const onScreen = new Set(local.map((i) => i.id));
  const addedThere = remote.filter((i) => !base.has(i.id) && !onScreen.has(i.id));
  const kept = local.filter((i) => !base.has(i.id) || onDisk.has(i.id));
  return [...addedThere, ...kept];
}
