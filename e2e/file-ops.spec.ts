// Renaming, moving and deleting canvases from the sidebar: atomic, never over another file, a delete only ever a move
// into .localidraw/trash, and whatever was drawn saved first so it goes with the file.
import { existsSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { drawRectangle, expect, onScreen, saves, settled, test, waitForCanvas } from "./fixtures.ts";

const menu = async (page: Page, name: string) => {
  await page.locator(".ld-canvas", { hasText: name }).first().hover();
  await page.getByRole("button", { name: `More for ${name}`, exact: true }).click();
};
const renameTo = async (page: Page, name: string, to: string) => {
  await menu(page, name);
  await page.getByRole("menuitem", { name: "Rename or move" }).click();
  const field = page.getByLabel(`New path for ${name}`);
  await field.fill(to);
  await field.press("Enter");
};
const trashFiles = (root: string) => (existsSync(join(root, ".localidraw/trash")) ? readdirSync(join(root, ".localidraw/trash")) : []);

test("renaming the open canvas saves what was drawn first, moves the file, and follows it", async ({ page, folder, open }) => {
  await open("notes.excalidraw");
  await drawRectangle(page);
  await expect.poll(async () => (await saves(page)).state).toBe("due");
  await renameTo(page, "notes", "archive/old-notes");
  await waitForCanvas(page, "archive/old-notes.excalidraw");
  expect(new URL(page.url()).searchParams.get("canvas")).toBe("archive/old-notes.excalidraw");
  expect(folder.elements("archive/old-notes.excalidraw").map((e) => e.type)).toEqual(["rectangle", "rectangle"]);
  expect(await onScreen(page)).toHaveLength(2);
  await settled(page);
  expect(existsSync(join(folder.root, "notes.excalidraw"))).toBe(false); // nothing saved back at the old path
  await expect(page.locator(".ld-canvas", { hasText: "old-notes" })).toBeVisible();
  // It stayed on screen rather than being opened afresh, so its undo came with it.
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(async () => (await onScreen(page)).length).toBe(1);
});

test("a rename never replaces another canvas", async ({ page, folder, open }) => {
  const notes = folder.read("notes.excalidraw"), plan = folder.read("plan.excalidraw");
  await open("plan.excalidraw");
  await renameTo(page, "notes", "plan");
  await expect(page.locator(".ld-hint--error")).toHaveText("There's already a canvas there.");
  await page.getByLabel("New path for notes").press("Escape");
  expect(folder.read("notes.excalidraw")).toBe(notes);
  expect(folder.read("plan.excalidraw")).toBe(plan);
  // And a path outside the folder is refused too.
  await renameTo(page, "notes", "../escaped");
  await expect(page.locator(".ld-hint--error")).toHaveText("That isn't a path inside the folder.");
  expect(existsSync(join(folder.root, "..", "escaped.excalidraw"))).toBe(false);
});

test("moving another canvas into a folder leaves the open one alone", async ({ page, folder, open }) => {
  await open("plan.excalidraw");
  await renameTo(page, "blank", "drafts/blank-moved");
  await expect(page.locator(".ld-canvas", { hasText: "blank-moved" })).toBeVisible();
  await expect(page.locator(".ld-project__name", { hasText: "drafts" })).toBeVisible();
  expect(existsSync(join(folder.root, "drafts/blank-moved.excalidraw"))).toBe(true);
  expect(existsSync(join(folder.root, "team/blank.excalidraw"))).toBe(false);
  expect((await page.evaluate(() => window.localidraw!.path))).toBe("plan.excalidraw");
});

test("delete asks first, moves the file into the trash, and Undo puts it back", async ({ page, folder, open }) => {
  const notes = folder.read("notes.excalidraw");
  await open("plan.excalidraw");
  await menu(page, "notes");
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await expect(page.getByRole("alertdialog", { name: "Delete notes?" })).toBeVisible();
  await page.getByRole("alertdialog").getByRole("button", { name: "Cancel" }).click(); // the first time, think better of it
  expect(folder.read("notes.excalidraw")).toBe(notes);

  await menu(page, "notes");
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
  await expect(page.locator(".ld-trashed")).toContainText("Deleted notes.");
  await expect(page.locator(".ld-canvas", { hasText: "notes" })).toHaveCount(0);
  expect(existsSync(join(folder.root, "notes.excalidraw"))).toBe(false);
  const [trashed] = trashFiles(folder.root);
  expect(trashed).toMatch(/-notes\.excalidraw$/);
  expect(folder.read(`.localidraw/trash/${trashed}`)).toBe(notes); // moved, not rewritten

  await page.getByRole("button", { name: "Undo the delete" }).click();
  await waitForCanvas(page, "notes.excalidraw");
  expect(folder.read("notes.excalidraw")).toBe(notes);
  expect(trashFiles(folder.root)).toEqual([]);
  await expect(page.locator(".ld-trashed")).toHaveCount(0);
});

test("deleting the open canvas saves it first and opens a neighbour; deleting the last one leaves the empty folder, with Undo", async ({ page, folder, open }) => {
  await open("team/blank.excalidraw");
  await drawRectangle(page);
  await expect.poll(async () => (await saves(page)).state).toBe("due");
  await menu(page, "blank");
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
  await waitForCanvas(page, "notes.excalidraw"); // the team folder is empty now, so the first canvas there is
  const [trashed] = trashFiles(folder.root);
  expect(folder.elements(`.localidraw/trash/${trashed}`).map((e) => e.type)).toEqual(["rectangle"]); // saved first
  expect(existsSync(join(folder.root, "team/blank.excalidraw"))).toBe(false);

  for (const name of ["notes", "plan"]) {
    await menu(page, name);
    await page.getByRole("menuitem", { name: "Delete" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
    await expect(page.locator(".ld-trashed")).toContainText(`Deleted ${name}.`);
  }
  await expect(page.getByRole("button", { name: "Make the first one" })).toBeVisible();
  await page.getByRole("button", { name: "Undo the delete" }).click();
  await waitForCanvas(page, "plan.excalidraw");
  expect(trashFiles(folder.root)).toHaveLength(2);
});

test("the menu opens on a right-click too, and Escape closes it without doing anything", async ({ page, folder, open }) => {
  await open("plan.excalidraw");
  await settled(page);
  await page.locator(".ld-canvas", { hasText: "notes" }).click({ button: "right" });
  await expect(page.getByRole("menu")).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Rename or move" })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menuitem", { name: "Delete" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  expect((await saves(page)).written).toBe(0);
  expect(trashFiles(folder.root)).toEqual([]);
});

// The open canvas deleted or moved on disk, by an agent, a shell or git, rather than from the sidebar.

test("the open canvas moved on disk (a git mv) is followed, and saves go to its new path", async ({ page, folder, open }) => {
  await open("notes.excalidraw");
  await settled(page);
  mkdirSync(join(folder.root, "archive"));
  renameSync(join(folder.root, "notes.excalidraw"), join(folder.root, "archive/notes.excalidraw"));
  await page.waitForFunction(() => window.localidraw?.path === "archive/notes.excalidraw");
  await expect.poll(() => new URL(page.url()).searchParams.get("canvas")).toBe("archive/notes.excalidraw");
  await expect(page.locator(".ld-notice")).toHaveCount(0);
  await drawRectangle(page);
  await expect.poll(() => folder.elements("archive/notes.excalidraw").length).toBe(2);
  expect(existsSync(join(folder.root, "notes.excalidraw"))).toBe(false); // no copy left behind
});

test("the open canvas deleted on disk says so, isn't written back, and is saved again only when asked", async ({ page, folder, open }) => {
  await open("notes.excalidraw");
  await settled(page);
  folder.remove("notes.excalidraw");
  const notice = page.locator(".ld-notice", { hasText: "deleted or moved on disk" });
  await expect(notice).toBeVisible();
  await drawRectangle(page); // drawing on: kept on screen, not saved
  await settled(page, (await saves(page)).checked);
  expect(existsSync(join(folder.root, "notes.excalidraw"))).toBe(false);
  await expect(page.locator(".ld-status")).toHaveText("Not saved");

  await notice.getByRole("button", { name: "Save it again" }).click();
  await expect.poll(() => existsSync(join(folder.root, "notes.excalidraw")) && folder.elements("notes.excalidraw").length).toBe(2);
  await expect(notice).toHaveCount(0);
  await drawRectangle(page, { x: 450, y: 250 }); // and it autosaves again from there
  await expect.poll(() => folder.elements("notes.excalidraw").length).toBe(3);
});

test("the open canvas put back on disk (a checkout) picks up again, keeping what was drawn meanwhile", async ({ page, folder, open }) => {
  const notes = folder.read("notes.excalidraw");
  await open("notes.excalidraw");
  await settled(page);
  folder.remove("notes.excalidraw");
  await expect(page.locator(".ld-notice", { hasText: "deleted or moved on disk" })).toBeVisible();
  await drawRectangle(page);
  folder.writeRaw("notes.excalidraw", notes);
  await expect(page.locator(".ld-notice")).toHaveCount(0);
  await expect.poll(() => folder.elements("notes.excalidraw").length).toBe(2);
});
