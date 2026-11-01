// Merging a canvas changed on disk into the one on screen, per element. Pure, so the tests can run it in Node.

/** The fields of an Excalidraw element the merge looks at. */
export type Versioned = { id: string; version: number; index?: string | null; isDeleted?: boolean };

/** Each element's version: what the screen and the file last agreed on. */
export const versionsOf = (elements: readonly Versioned[]) => new Map(elements.map((e) => [e.id, e.version]));

/**
 * The scene on screen with the scene on disk merged in. `base` holds each element's version as of the last load or
 * save, so it says who changed what since:
 * - in both: if it wasn't changed here since, the disk's copy, even an older version (a `git checkout` of the file);
 *   if it was, the higher version wins, and disk wins a tie;
 * - only on screen: kept if it's new here (not in `base`) or was changed here since; otherwise disk removed it;
 * - only on disk: added.
 * The result is in z-order (Excalidraw's fractional `index`).
 */
export function mergeScenes<E extends Versioned>(local: readonly E[], remote: readonly E[], base: ReadonlyMap<string, number>): E[] {
  const merged = new Map<string, E>();
  const onScreen = new Map(local.map((e) => [e.id, e]));
  for (const r of remote) {
    const l = onScreen.get(r.id);
    const changedHere = l !== undefined && l.version !== base.get(r.id);
    merged.set(r.id, changedHere && l.version > r.version ? l : r);
  }
  for (const l of local) {
    if (merged.has(l.id)) continue;
    const was = base.get(l.id);
    if (was === undefined || l.version > was) merged.set(l.id, l);
  }
  return [...merged.values()].sort((a, b) => {
    const x = a.index ?? "", y = b.index ?? "";
    return x < y ? -1 : x > y ? 1 : 0;
  });
}

/** Whether anything was drawn since `base`. Opening a canvas and moving around it never counts. */
export function changedSince(elements: readonly Versioned[], base: ReadonlyMap<string, number>): boolean {
  return elements.some((e) => (base.has(e.id) ? base.get(e.id) !== e.version : !e.isDeleted));
}
