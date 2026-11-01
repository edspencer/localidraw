// The editor against a real server and real files: the checks the 0.1.0 spike did by hand (TODO.md, "The editor").
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { startServer } from "../server/server.ts";
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

test("a canvas that won't open lists the others, and opens once it's mended", async ({ page, folder }) => {
  const plan = folder.read("plan.excalidraw");
  writeFileSync(join(folder.root, "plan.excalidraw"), '{"type":"excalidraw","elements":['); // half-written
  const events = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/events");
  await page.goto("/?canvas=plan.excalidraw");
  await events; // so the page hears the file mended
  await expect(page.getByRole("heading", { name: "Couldn't open plan.excalidraw" })).toBeVisible();
  await expect(page.getByText(/^It isn't valid JSON/)).toBeVisible();

  writeFileSync(join(folder.root, "plan.excalidraw"), plan);
  await waitForCanvas(page, "plan.excalidraw");
  expect((await onScreen(page)).length).toBeGreaterThan(0);
  expect(folder.read("plan.excalidraw")).toBe(plan);
});

test("a link to a canvas that isn't there isn't a dead end", async ({ page }) => {
  await page.goto("/?canvas=gone.excalidraw");
  await expect(page.getByRole("heading", { name: "Couldn't open gone.excalidraw" })).toBeVisible();
  await page.locator(".ld-row", { hasText: "notes" }).click();
  await waitForCanvas(page, "notes.excalidraw");
});

test("after the server comes back, the page catches up with what changed while it was away", async ({ page, folder }) => {
  // Its own server, so the test can stop it and start it again on the same port.
  let app = await startServer({ root: folder.root, port: 0, webDir: join(import.meta.dirname, "../dist/web") });
  const { port } = new URL(app.url);
  const events = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/events");
  await page.goto(`${app.url}?canvas=notes.excalidraw`);
  await events;
  await waitForCanvas(page, "notes.excalidraw");
  await settled(page);

  // Stopped the way a killed process stops: every connection drops, keep-alive ones included.
  const stopped = app.close();
  app.server.closeAllConnections();
  await stopped;
  await expect(page.locator(".ld-offline")).toBeVisible();
  // Changed while nothing was watching: a git pull, an agent, another editor.
  const scene = folder.scene("notes.excalidraw");
  const added = await fromSkeletons(page, [{ type: "rectangle", x: 0, y: 300, width: 200, height: 80 }]);
  folder.write("notes.excalidraw", { ...scene, elements: [...scene.elements, ...added] });
  folder.write("later.excalidraw", { ...scene, elements: [] });
  app = await startServer({ root: folder.root, port: Number(port), webDir: join(import.meta.dirname, "../dist/web") });

  await expect(page.locator(".ld-offline")).toBeHidden({ timeout: 15_000 });
  await expect.poll(async () => (await onScreen(page)).length).toBe(2);
  await expect(page.locator(".ld-row", { hasText: "later" })).toBeVisible();
  await app.close();
});

// Behind a reverse proxy, a stopped server doesn't refuse the connection: the proxy answers for it with a 502, which
// an EventSource takes as final. The page has to start it again itself.
test("after a proxy answered 502 for the stopped server, the page still reconnects", async ({ page, folder }) => {
  let app = await startServer({ root: folder.root, port: 0, webDir: join(import.meta.dirname, "../dist/web") });
  const { port } = new URL(app.url);
  const events = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/events");
  await page.goto(`${app.url}?canvas=notes.excalidraw`);
  await events;
  await waitForCanvas(page, "notes.excalidraw");
  await settled(page);

  let proxyDown = true;
  const refused = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/events" && r.status() === 502);
  await page.route("**/api/events", (route) => (proxyDown ? route.fulfill({ status: 502, body: "Bad Gateway" }) : route.continue()));
  const stopped = app.close();
  app.server.closeAllConnections();
  await stopped;
  await refused; // the browser's own reconnect met the 502, and it won't try again by itself
  await expect(page.locator(".ld-offline")).toBeVisible();

  const scene = folder.scene("notes.excalidraw");
  const added = await fromSkeletons(page, [{ type: "rectangle", x: 0, y: 300, width: 200, height: 80 }]);
  folder.write("notes.excalidraw", { ...scene, elements: [...scene.elements, ...added] });
  app = await startServer({ root: folder.root, port: Number(port), webDir: join(import.meta.dirname, "../dist/web") });
  proxyDown = false;

  await expect(page.locator(".ld-offline")).toBeHidden({ timeout: 15_000 });
  await expect.poll(async () => (await onScreen(page)).length).toBe(2);
  await app.close();
});

test("putting an older version of the file back (git checkout) sticks", async ({ page, folder, open }) => {
  const original = folder.read("notes.excalidraw");
  await open("notes.excalidraw");
  await settled(page);
  // Move everything a little: the elements' versions go up, and it's saved.
  await page.mouse.click(700, 650);
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Escape");
  await expect.poll(() => folder.read("notes.excalidraw")).not.toBe(original);
  await settled(page);
  const { written } = await saves(page);

  writeFileSync(join(folder.root, "notes.excalidraw"), original); // what `git checkout -- notes.excalidraw` does
  const x = folder.elements("notes.excalidraw")[0].x;
  await expect.poll(async () => page.evaluate(() => window.localidraw!.api.getSceneElements()[0].x)).toBe(x);
  await settled(page, (await saves(page)).checked);
  expect((await saves(page)).written).toBe(written);
  expect(folder.read("notes.excalidraw")).toBe(original);
});

test.describe("an edit of yours that lost to a change on disk", () => {
  /** Moves one element a step right, as the user does: selected, then an arrow key. */
  const nudge = async (page: import("@playwright/test").Page, id: string) => {
    await page.evaluate((i) => window.localidraw!.api.updateScene({ appState: { selectedElementIds: { [i]: true } } }), id);
    await page.keyboard.press("ArrowRight");
  };
  /** The agent's edit: the element moved far down, at a higher version, written over the file. */
  const agentMoves = (folder: import("./fixtures.ts").Folder, id: string) => {
    const scene = folder.scene("plan.excalidraw");
    folder.write("plan.excalidraw", { ...scene, elements: scene.elements.map((e) => (e.id === id ? { ...e, y: e.y + 500, version: e.version + 10 } : e)) });
  };
  const holdFirstSave = async (page: import("@playwright/test").Page) => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let first = true;
    await page.route("**/api/canvas?*", async (route) => {
      if (route.request().method() === "PUT" && first) { first = false; await held; }
      await route.continue();
    });
    return release;
  };

  test("is pointed out in the footer, and Show selects it", async ({ page, folder, open }) => {
    await open("plan.excalidraw");
    await settled(page);
    const release = await holdFirstSave(page);
    const conflict = page.waitForResponse((r) => r.request().method() === "PUT" && r.status() === 409);
    await nudge(page, "box-a");
    await expect.poll(async () => (await saves(page)).state).toBe("saving");
    agentMoves(folder, "box-a");
    release();
    await conflict;

    const notice = page.locator(".ld-notice");
    await expect(notice).toHaveText(/An edit of yours was replaced by a change on disk/);
    await settled(page);
    // Nothing of ours was left to save, so the status says what happened rather than "Saving…" for good.
    await expect(page.locator(".ld-status")).toHaveText("Updated from disk");
    const boxA = folder.elements("plan.excalidraw").find((e) => e.id === "box-a")!;
    expect(boxA.y).toBe(500); // the disk's version, on disk and on screen
    expect(await page.evaluate(() => window.localidraw!.api.getSceneElements().find((e) => e.id === "box-a")!.y)).toBe(500);

    await page.evaluate(() => window.localidraw!.api.updateScene({ appState: { selectedElementIds: {} } }));
    await notice.getByRole("button", { name: "Show" }).click();
    await expect.poll(() => page.evaluate(() => Object.keys(window.localidraw!.api.getAppState().selectedElementIds))).toEqual(["box-a"]);
    await notice.getByRole("button", { name: "Dismiss" }).click();
    await expect(notice).toBeHidden();
  });

  test("isn't claimed when the disk changed a different element", async ({ page, folder, open }) => {
    await open("plan.excalidraw");
    await settled(page);
    const release = await holdFirstSave(page);
    const conflict = page.waitForResponse((r) => r.request().method() === "PUT" && r.status() === 409);
    const boxB = folder.elements("plan.excalidraw").find((e) => e.id === "box-b")!;
    await nudge(page, "box-a");
    await expect.poll(async () => (await saves(page)).state).toBe("saving");
    agentMoves(folder, "box-b");
    release();
    await conflict;
    await settled(page);
    const onDisk = folder.elements("plan.excalidraw");
    expect(onDisk.find((e) => e.id === "box-a")!.x).toBeGreaterThan(0); // mine
    expect(onDisk.find((e) => e.id === "box-b")!.y).toBe(boxB.y + 500); // theirs
    await expect(page.locator(".ld-notice")).toHaveCount(0);
  });
});
