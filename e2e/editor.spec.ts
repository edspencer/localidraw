// The editor against a real server and real files: the checks the 0.1.0 spike did by hand (TODO.md, "The editor").
import { drawRectangle, expect, fromSkeletons, onScreen, saves, settled, test, waitForCanvas } from "./fixtures.ts";

test("opening and scrolling a canvas doesn't write it", async ({ page, folder, open }) => {
  const before = folder.read("plan.excalidraw");
  const puts: string[] = [];
  page.on("request", (r) => { if (r.method() !== "GET") puts.push(`${r.method()} ${r.url()}`); });

  await open("plan.excalidraw");
  await settled(page); // the first open fits the drawing, which is a change of view the autosave checks
  const { checked } = await saves(page);
  await page.mouse.move(400, 400);
  await page.mouse.wheel(0, 300);
  await page.mouse.wheel(250, 0);
  await page.keyboard.press("ControlOrMeta+Equal"); // zoom in
  await settled(page, checked);

  expect(puts).toEqual([]);
  expect((await saves(page)).written).toBe(0);
  expect(folder.read("plan.excalidraw")).toBe(before);
});

test("drawing autosaves", async ({ page, folder, open }) => {
  await open("notes.excalidraw");
  await drawRectangle(page);
  await expect.poll(() => folder.elements("notes.excalidraw").length).toBe(2);
  await expect(page.locator(".ld-status")).toHaveText(/^Saved /);
  expect(folder.elements("notes.excalidraw").map((e) => e.type)).toEqual(["rectangle", "rectangle"]);
});

test("an external edit appears and keeps the drawing", async ({ page, folder, open }) => {
  await open("notes.excalidraw");
  await drawRectangle(page);
  await expect.poll(async () => (await saves(page)).written).toBe(1);
  const drawn = (await onScreen(page)).find((e) => e.id !== "note")!;

  // What an agent does: read the file, add elements made from skeletons, write it back.
  const scene = folder.scene("notes.excalidraw");
  const added = await fromSkeletons(page, [{ type: "rectangle", x: 0, y: 300, width: 200, height: 80, label: { text: "From the agent" } }]);
  folder.write("notes.excalidraw", { ...scene, elements: [...scene.elements, ...added] });

  const all = ["note", drawn.id, ...added.map((e) => e.id)].sort();
  await expect.poll(async () => (await onScreen(page)).map((e) => e.id).sort()).toEqual(all);
  expect((await onScreen(page)).find((e) => e.type === "text")?.text).toBe("From the agent");
  // The converter numbers its elements from "a0", as the file's do, so Excalidraw renumbers them and saves that.
  // Whatever it saves keeps everything.
  await settled(page);
  expect(folder.elements("notes.excalidraw").map((e) => e.id).sort()).toEqual(all);
});

test.describe("a drawing and an edit on disk at the same moment both survive", () => {
  test("when the disk changes while the save is on its way (the server answers 409)", async ({ page, folder, open }) => {
    await open("notes.excalidraw");
    // Hold the first save until the file has changed under it.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let first = true;
    await page.route("**/api/canvas?*", async (route) => {
      if (route.request().method() === "PUT" && first) { first = false; await held; }
      await route.continue();
    });
    const conflict = page.waitForResponse((r) => r.request().method() === "PUT" && r.status() === 409);

    await drawRectangle(page);
    await expect.poll(async () => (await saves(page)).state).toBe("saving");
    const scene = folder.scene("notes.excalidraw");
    const added = await fromSkeletons(page, [{ type: "ellipse", x: 400, y: 0, width: 100, height: 100 }]);
    folder.write("notes.excalidraw", { ...scene, elements: [...scene.elements, ...added] });
    release();
    await conflict;

    await expect.poll(async () => (await saves(page)).written).toBe(1);
    const ids = (await onScreen(page)).map((e) => e.id).sort();
    expect(ids).toHaveLength(3);
    expect(ids).toContain(added[0].id);
    expect(folder.elements("notes.excalidraw").map((e) => e.id).sort()).toEqual(ids);
  });

  test("when the disk changes before the autosave is due", async ({ page, folder, open }) => {
    await open("notes.excalidraw");
    await drawRectangle(page);
    await expect.poll(async () => (await saves(page)).state).toBe("due");
    const scene = folder.scene("notes.excalidraw");
    const added = await fromSkeletons(page, [{ type: "diamond", x: 400, y: 0, width: 100, height: 100 }]);
    folder.write("notes.excalidraw", { ...scene, elements: [...scene.elements, ...added] });

    await expect.poll(() => folder.elements("notes.excalidraw").length).toBe(3);
    await settled(page);
    const ids = (await onScreen(page)).map((e) => e.id).sort();
    expect(ids).toContain(added[0].id);
    expect(folder.elements("notes.excalidraw").map((e) => e.id).sort()).toEqual(ids);
  });
});

test("a deletion on disk sticks", async ({ page, folder, open }) => {
  await open("plan.excalidraw");
  await settled(page);
  const scene = folder.scene("plan.excalidraw");
  folder.write("plan.excalidraw", { ...scene, elements: scene.elements.filter((e) => e.id !== "box-b") });
  await expect.poll(async () => (await onScreen(page)).map((e) => e.id)).toEqual(["box-a", "box-c"]);

  // Saving something else doesn't bring it back, and neither does opening the canvas again.
  await drawRectangle(page);
  await expect.poll(async () => (await saves(page)).written).toBe(1);
  expect(folder.elements("plan.excalidraw").map((e) => e.id)).not.toContain("box-b");
  await page.reload();
  await waitForCanvas(page, "plan.excalidraw");
  expect((await onScreen(page)).map((e) => e.id)).not.toContain("box-b");
});

test("shortcuts work straight after a sidebar click", async ({ page, open }) => {
  await open("notes.excalidraw");
  await page.locator(".ld-row", { hasText: "plan" }).click();
  await waitForCanvas(page, "plan.excalidraw");
  await page.keyboard.press("r");
  await expect.poll(() => page.evaluate(() => window.localidraw!.api.getAppState().activeTool.type)).toBe("rectangle");
});

test("⌘S saves at once, without waiting for the autosave", async ({ page, folder, open }) => {
  await open("notes.excalidraw");
  // Look at the autosave the moment ⌘S has been handled: from a listener that runs right after the page's own.
  await page.evaluate(() => window.addEventListener("keydown", (e) => {
    if (e.key.toLowerCase() === "s") (window as any).afterSave = { prevented: e.defaultPrevented, state: window.localidraw!.saves().state };
  }, true));
  await drawRectangle(page);
  await expect.poll(async () => (await saves(page)).state).toBe("due");
  await page.keyboard.press("ControlOrMeta+s");
  expect(await page.evaluate(() => (window as any).afterSave)).toEqual({ prevented: true, state: "saving" });
  await expect.poll(() => folder.elements("notes.excalidraw").length).toBe(2);
});

test("⌘Z undoes, and the undo is saved", async ({ page, folder, open }) => {
  await open("notes.excalidraw");
  await drawRectangle(page);
  await expect.poll(() => folder.elements("notes.excalidraw").length).toBe(2);
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => folder.elements("notes.excalidraw").map((e) => e.id)).toEqual(["note"]);
  expect((await onScreen(page)).map((e) => e.id)).toEqual(["note"]);
});

test("a first open fits the drawing beside the docked sidebar", async ({ page, open }) => {
  await open("plan.excalidraw");
  const sidebar = await page.locator(".excalidraw .sidebar").boundingBox();
  expect(sidebar).not.toBeNull();
  // Each element's box on screen, from the scene's coordinates and the view.
  const boxes = () => page.evaluate(() => {
    const { api } = window.localidraw!;
    const { scrollX, scrollY, zoom } = api.getAppState();
    return api.getSceneElements().map((e) => ({
      left: (e.x + scrollX) * zoom.value, top: (e.y + scrollY) * zoom.value,
      right: (e.x + e.width + scrollX) * zoom.value, bottom: (e.y + e.height + scrollY) * zoom.value,
    }));
  });
  await expect.poll(async () => {
    const b = await boxes();
    return b.every((x) => x.left >= 0 && x.top >= 0 && x.right <= sidebar!.x && x.bottom <= 800);
  }).toBe(true);
  // ...and it's centred in what's left, not crammed into a corner.
  const b = await boxes();
  const left = Math.min(...b.map((x) => x.left)), right = Math.max(...b.map((x) => x.right));
  expect(Math.abs(left - (sidebar!.x - right))).toBeLessThan(2);
});

test("an empty canvas doesn't zoom in", async ({ page, open }) => {
  await open("team/blank.excalidraw");
  // A scroll makes the autosave check, 700 ms on: long after a fit would have run (300 ms after opening).
  await page.mouse.move(400, 400);
  await page.mouse.wheel(0, 100);
  await settled(page);
  expect(await page.evaluate(() => window.localidraw!.api.getAppState().zoom.value)).toBe(1);
});
