// Excalidraw's Library: in the browser's storage, or in the folder's library.excalidrawlib when there is one (shared,
// watched and merged like a canvas). Written only when the Library actually changes.
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, fromSkeletons, test, waitForCanvas } from "./fixtures.ts";

const FILE = "library.excalidrawlib";
type Item = { id: string; status: string; created: number; elements: unknown[] };
type Lib = { type: string; version: number; source?: string; libraryItems: Item[] };

/** A Library item made of one rectangle, as the Library panel's "Add to library" makes one. */
async function item(page: Page, id: string): Promise<Item> {
  const elements = await fromSkeletons(page, [{ type: "rectangle", x: 0, y: 0, width: 80, height: 40 }]);
  return { id, status: "unpublished", created: 1, elements };
}
/** Adds to the Library as the user does: through Excalidraw, which tells the page it changed. */
const addToLibrary = (page: Page, items: Item[]) =>
  page.evaluate((i) => window.localidraw!.api.updateLibrary({ libraryItems: i as never, merge: true }), items);
const onScreen = (page: Page) => page.evaluate(() => window.localidraw!.library().slice().sort());
const libraryWrites = (page: Page) => {
  const writes: string[] = [];
  page.on("request", (r) => { if (r.method() !== "GET" && new URL(r.url()).pathname === "/api/library") writes.push(r.method()); });
  return writes;
};

test("with no library file, the Library is kept in the browser, and no file is made", async ({ page, folder, open }) => {
  const writes = libraryWrites(page);
  await open("notes.excalidraw");
  await addToLibrary(page, [await item(page, "mine")]);
  await expect.poll(() => page.evaluate(() => localStorage.getItem("localidraw:library"))).toContain('"mine"');
  await page.reload();
  await waitForCanvas(page, "notes.excalidraw");
  await expect.poll(() => onScreen(page)).toEqual(["mine"]);
  expect(existsSync(join(folder.root, FILE))).toBe(false);
  expect(writes).toEqual([]);
});

test.describe("with library.excalidrawlib in the folder", () => {
  test.beforeEach(({ folder }) => {
    // A Library made elsewhere (a teammate, or exported from excalidraw.com), with one item.
    const lib: Lib = { type: "excalidrawlib", version: 2, source: "https://excalidraw.com", libraryItems: [
      { id: "theirs", status: "unpublished", created: 1, elements: [{ id: "r1", type: "rectangle", x: 0, y: 0, width: 80, height: 40, version: 3, versionNonce: 1, isDeleted: false, seed: 1, angle: 0, strokeColor: "#1e1e1e", backgroundColor: "transparent", fillStyle: "solid", strokeWidth: 2, strokeStyle: "solid", roughness: 1, opacity: 100, groupIds: [], frameId: null, roundness: null, boundElements: null, updated: 1, link: null, locked: false }] },
    ] };
    folder.writeRaw(FILE, `${JSON.stringify(lib, null, 2)}\n`);
  });

  test("opening and switching canvases doesn't write it", async ({ page, folder, open }) => {
    const before = folder.read(FILE);
    const writes = libraryWrites(page);
    await open("notes.excalidraw");
    await expect.poll(() => onScreen(page)).toEqual(["theirs"]);
    await page.locator(".ld-row", { hasText: "plan" }).click();
    await waitForCanvas(page, "plan.excalidraw");
    await page.reload();
    await waitForCanvas(page, "plan.excalidraw");
    await expect.poll(() => onScreen(page)).toEqual(["theirs"]);
    expect(writes).toEqual([]);
    expect(folder.read(FILE)).toBe(before);
  });

  test("adding to the Library saves it there, and an agent's addition on disk appears", async ({ page, folder, open }) => {
    await open("notes.excalidraw");
    await expect.poll(() => onScreen(page)).toEqual(["theirs"]);
    await addToLibrary(page, [await item(page, "mine")]);
    const ids = () => (JSON.parse(folder.read(FILE)) as Lib).libraryItems.map((i) => i.id).sort();
    await expect.poll(ids).toEqual(["mine", "theirs"]);

    const lib = JSON.parse(folder.read(FILE)) as Lib;
    folder.writeRaw(FILE, JSON.stringify({ ...lib, libraryItems: [await item(page, "agent"), ...lib.libraryItems] }));
    await expect.poll(() => onScreen(page)).toEqual(["agent", "mine", "theirs"]);
    expect(ids()).toEqual(["agent", "mine", "theirs"]); // and not written again
  });

  test("an addition here and one on disk at the same moment both survive (409)", async ({ page, folder, open }) => {
    await open("notes.excalidraw");
    await expect.poll(() => onScreen(page)).toEqual(["theirs"]);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let first = true;
    await page.route("**/api/library", async (route) => {
      if (route.request().method() === "PUT" && first) { first = false; await held; }
      await route.continue();
    });
    const conflict = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/library" && r.status() === 409);
    const saved = page.waitForRequest((r) => new URL(r.url()).pathname === "/api/library" && r.method() === "PUT");
    await addToLibrary(page, [await item(page, "mine")]);
    await saved;
    const lib = JSON.parse(folder.read(FILE)) as Lib;
    folder.writeRaw(FILE, JSON.stringify({ ...lib, libraryItems: [await item(page, "agent"), ...lib.libraryItems] }));
    release();
    await conflict;
    const ids = () => (JSON.parse(folder.read(FILE)) as Lib).libraryItems.map((i) => i.id).sort();
    await expect.poll(ids).toEqual(["agent", "mine", "theirs"]);
    await expect.poll(() => onScreen(page)).toEqual(["agent", "mine", "theirs"]);
  });

  test("deleting the file goes back to the browser's own Library; making it again uses it", async ({ page, folder, open }) => {
    await open("notes.excalidraw");
    await expect.poll(() => onScreen(page)).toEqual(["theirs"]);
    const content = folder.read(FILE);
    folder.remove(FILE);
    await expect.poll(() => onScreen(page)).toEqual([]);
    folder.writeRaw(FILE, content);
    await expect.poll(() => onScreen(page)).toEqual(["theirs"]);
    expect(folder.read(FILE)).toBe(content);
  });
});
