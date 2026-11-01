// Switching canvases: one Excalidraw for all of them, each canvas's saves going to its own file, and nothing of one
// leaking into another (its view, its undo, a save still on its way).
import type { Page, Route } from "@playwright/test";
import { drawRectangle, expect, fromSkeletons, onScreen, saves, settled, test, waitForCanvas } from "./fixtures.ts";

const pick = async (page: Page, name: string, path: string) => {
  await page.locator(".ld-row", { hasText: name }).click();
  await waitForCanvas(page, path);
};

/** Holds the next save of `path` until it's released; the ones after go straight through. */
async function holdSave(page: Page, path: string) {
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let first = true;
  await page.route("**/api/canvas?*", async (route: Route) => {
    const req = route.request();
    if (req.method() === "PUT" && new URL(req.url()).searchParams.get("path") === path && first) { first = false; await held; }
    await route.continue();
  });
  return release;
}

/** Until every canvas switched away from has finished its last save. */
const allSaved = (page: Page) => expect.poll(async () => (await saves(page)).leaving).toBe(0);

test("switching canvases keeps the one Excalidraw, and writes neither", async ({ page, folder, open }) => {
  const before = { notes: folder.read("notes.excalidraw"), plan: folder.read("plan.excalidraw"), blank: folder.read("team/blank.excalidraw") };
  const writes: string[] = [];
  page.on("request", (r) => { if (r.method() !== "GET") writes.push(`${r.method()} ${r.url()}`); });

  await open("notes.excalidraw");
  await page.evaluate(() => {
    (window as any).firstApi = window.localidraw!.api;
    document.querySelector<HTMLElement>(".excalidraw")!.dataset.first = "yes";
  });
  for (const [name, path] of [["plan", "plan.excalidraw"], ["blank", "team/blank.excalidraw"], ["notes", "notes.excalidraw"]]) {
    await pick(page, name, path);
    await settled(page);
  }
  expect(await page.evaluate(() => (window as any).firstApi === window.localidraw!.api)).toBe(true);
  expect(await page.locator(".excalidraw[data-first=yes]").count()).toBe(1);
  expect((await onScreen(page)).map((e) => e.id)).toEqual(["note"]);
  await allSaved(page);
  expect(writes).toEqual([]);
  expect({ notes: folder.read("notes.excalidraw"), plan: folder.read("plan.excalidraw"), blank: folder.read("team/blank.excalidraw") }).toEqual(before);
});

test("a drawing whose autosave was still due when you switched is saved to its own file", async ({ page, folder, open }) => {
  const plan = folder.read("plan.excalidraw");
  await open("notes.excalidraw");
  await drawRectangle(page);
  await expect.poll(async () => (await saves(page)).state).toBe("due");
  await pick(page, "plan", "plan.excalidraw");
  await allSaved(page);
  expect(folder.elements("notes.excalidraw").map((e) => e.type)).toEqual(["rectangle", "rectangle"]);
  expect(folder.read("plan.excalidraw")).toBe(plan);
  expect((await onScreen(page)).map((e) => e.id).sort()).toEqual(["box-a", "box-b", "box-c"]);
});

test("switching while a save is on its way: it lands in the canvas it came from", async ({ page, folder, open }) => {
  const plan = folder.read("plan.excalidraw");
  await open("notes.excalidraw");
  const release = await holdSave(page, "notes.excalidraw");
  await drawRectangle(page);
  await expect.poll(async () => (await saves(page)).state).toBe("saving");
  await pick(page, "plan", "plan.excalidraw");
  expect((await saves(page)).leaving).toBe(1);
  release();
  await allSaved(page);
  expect(folder.elements("notes.excalidraw")).toHaveLength(2);
  expect(folder.read("plan.excalidraw")).toBe(plan);

  // And drawing on the new canvas saves there, and only there.
  const notes = folder.read("notes.excalidraw");
  await drawRectangle(page, { x: 300, y: 600 });
  await expect.poll(() => folder.elements("plan.excalidraw").length).toBe(4);
  expect(folder.read("notes.excalidraw")).toBe(notes);
});

test("an agent's edit to the canvas you just left, while its save was on its way, is merged, not lost", async ({ page, folder, open }) => {
  await open("notes.excalidraw");
  const release = await holdSave(page, "notes.excalidraw");
  await drawRectangle(page);
  await expect.poll(async () => (await saves(page)).state).toBe("saving");
  const drawn = (await onScreen(page)).find((e) => e.id !== "note")!;
  const scene = folder.scene("notes.excalidraw");
  const added = await fromSkeletons(page, [{ type: "ellipse", x: 400, y: 0, width: 100, height: 100 }]);
  folder.write("notes.excalidraw", { ...scene, elements: [...scene.elements, ...added] });

  await pick(page, "plan", "plan.excalidraw");
  const conflict = page.waitForResponse((r) => r.request().method() === "PUT" && r.status() === 409);
  release();
  await conflict; // the file had moved on under the held save
  await allSaved(page);
  const all = ["note", drawn.id, added[0].id].sort();
  expect(folder.elements("notes.excalidraw").map((e) => e.id).sort()).toEqual(all);
  expect((await onScreen(page)).map((e) => e.id).sort()).toEqual(["box-a", "box-b", "box-c"]); // nothing leaked in

  await pick(page, "notes", "notes.excalidraw");
  await expect.poll(async () => (await onScreen(page)).map((e) => e.id).sort()).toEqual(all);
});

test("going back to a canvas whose save is still on its way picks it up as it was", async ({ page, folder, open }) => {
  await open("notes.excalidraw");
  const release = await holdSave(page, "notes.excalidraw");
  await drawRectangle(page);
  await expect.poll(async () => (await saves(page)).state).toBe("saving");
  const ids = (await onScreen(page)).map((e) => e.id).sort();
  await pick(page, "plan", "plan.excalidraw");
  await pick(page, "notes", "notes.excalidraw");
  expect((await onScreen(page)).map((e) => e.id).sort()).toEqual(ids);
  release();
  await settled(page);
  expect(folder.elements("notes.excalidraw").map((e) => e.id).sort()).toEqual(ids);
});

test("a canvas you left that couldn't be saved keeps trying", async ({ page, folder, open }) => {
  await open("notes.excalidraw");
  let refused = 0;
  await page.route("**/api/canvas?*", (route) => {
    const req = route.request();
    if (req.method() === "PUT" && refused < 2) { refused++; return route.abort("connectionrefused"); }
    return route.continue();
  });
  await drawRectangle(page);
  await expect.poll(() => refused).toBe(1);
  await pick(page, "plan", "plan.excalidraw");
  await expect.poll(() => folder.elements("notes.excalidraw").length, { timeout: 10_000 }).toBe(2);
  await allSaved(page);
  expect(refused).toBe(2);
});

test("undo doesn't cross canvases", async ({ page, folder, open }) => {
  await open("notes.excalidraw");
  await drawRectangle(page);
  await expect.poll(() => folder.elements("notes.excalidraw").length).toBe(2);
  await settled(page);

  await pick(page, "plan", "plan.excalidraw");
  await settled(page);
  const plan = folder.read("plan.excalidraw");
  await page.keyboard.press("ControlOrMeta+z");
  await page.keyboard.press("ControlOrMeta+z");
  await settled(page, (await saves(page)).checked);
  expect((await onScreen(page)).map((e) => e.id).sort()).toEqual(["box-a", "box-b", "box-c"]);
  expect(folder.read("plan.excalidraw")).toBe(plan);

  // Coming back starts a fresh history too, so the rectangle drawn before stays.
  await pick(page, "notes", "notes.excalidraw");
  await page.keyboard.press("ControlOrMeta+z");
  await settled(page, (await saves(page)).checked);
  expect(await onScreen(page)).toHaveLength(2);
  expect(folder.elements("notes.excalidraw")).toHaveLength(2);
});

test("each canvas keeps its own view, and a first open still fits", async ({ page, open }) => {
  const view = () => page.evaluate(() => {
    const { scrollX, scrollY, zoom } = window.localidraw!.api.getAppState();
    return { scrollX: Math.round(scrollX), scrollY: Math.round(scrollY), zoom: zoom.value };
  });
  await open("plan.excalidraw");
  await page.mouse.move(400, 400);
  await page.mouse.wheel(0, 200);
  await settled(page);
  const plan = await view();

  await pick(page, "blank", "team/blank.excalidraw");
  expect(await view()).toEqual({ scrollX: 0, scrollY: 0, zoom: 1 }); // empty: the origin, not plan's view

  await pick(page, "notes", "notes.excalidraw");
  const notes = await view();
  expect(notes).not.toEqual(plan); // fitted to its own drawing
  await page.mouse.wheel(0, -150);
  await settled(page);
  const notesMoved = await view();

  await pick(page, "plan", "plan.excalidraw");
  expect(await view()).toEqual(plan);
  await pick(page, "notes", "notes.excalidraw");
  expect(await view()).toEqual(notesMoved);
});
