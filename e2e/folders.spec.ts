// Serving the list: Scratch and the folders in ~/.localidraw/config.json, grouped in the sidebar, following the list
// without a reload, and the Library that goes with the open canvas. Each test has its own home and server.
import { test as base, type Page } from "@playwright/test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addFolder, removeFolder } from "../server/folders.ts";
import { startServer } from "../server/server.ts";
import { expect, fromSkeletons, waitForCanvas } from "./fixtures.ts";

const WEB = join(import.meta.dirname, "../dist/web");
const DRAWINGS = join(import.meta.dirname, "folders/drawings");

const test = base.extend<{ tmp: string; home: string; url: string }>({
  tmp: async ({}, use) => {
    const tmp = mkdtempSync(join(tmpdir(), "localidraw-e2e-folders-"));
    await use(tmp);
    rmSync(tmp, { recursive: true, force: true });
  },
  home: async ({ tmp }, use) => use(join(tmp, "user/.localidraw")),
  url: async ({ home }, use) => {
    const app = await startServer({ home, port: 0, webDir: WEB });
    await use(app.url);
    await app.close();
  },
});

/** A copy of e2e/folders/drawings under the test's temp folder, as `name`. */
function project(tmp: string, name: string) {
  const dir = join(tmp, "projects", name);
  cpSync(DRAWINGS, dir, { recursive: true });
  return dir;
}

async function go(page: Page, url: string, canvas?: string) {
  const events = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/events");
  await page.goto(canvas ? `${url}?canvas=${encodeURIComponent(canvas)}` : url);
  await events;
  if (canvas) await waitForCanvas(page, canvas);
}

const headers = (page: Page) => page.locator(".ld-folder > .ld-project__header .ld-project__name").allInnerTexts();

test("a brand-new install: nothing written by opening, Start drawing makes a canvas in Scratch, and the card offers the command", async ({ page, url, home }) => {
  await go(page, url);
  await expect(page.getByRole("heading", { name: "Nothing to open yet" })).toBeVisible();
  await expect(page.locator(".ld-command code")).toHaveText("localidraw add ~/path/to/project");
  expect(existsSync(join(home, "drawings"))).toBe(false);
  await page.getByRole("button", { name: "Start drawing" }).click();
  await waitForCanvas(page, "scratch/untitled.excalidraw");
  expect(existsSync(join(home, "drawings/untitled.excalidraw"))).toBe(true);
  expect(await headers(page)).toEqual(["Scratch"]);
  // The card, in the sidebar while no folder is listed, until it's dismissed; then the small link.
  await expect(page.locator(".ld-card")).toBeVisible();
  await page.locator(".ld-card").getByRole("button", { name: "Dismiss" }).click();
  await expect(page.locator(".ld-card")).toHaveCount(0);
  await page.reload();
  await waitForCanvas(page, "scratch/untitled.excalidraw");
  await expect(page.locator(".ld-card")).toHaveCount(0);
  await page.getByRole("button", { name: "Add a folder" }).click();
  await expect(page.locator(".ld-add-hint code")).toHaveText("localidraw add ~/path/to/project");
});

test("folders added and removed show without a reload, grouped with Scratch first; a missing one is greyed and comes back", async ({ page, url, home, tmp }) => {
  mkdirSync(join(home, "drawings"), { recursive: true });
  writeFileSync(join(home, "drawings/sketch.excalidraw"), readFileSync(join(DRAWINGS, "notes.excalidraw")));
  await go(page, url, "scratch/sketch.excalidraw");
  const alpha = project(tmp, "alpha"), beta = project(tmp, "beta");
  addFolder(home, alpha);
  addFolder(home, beta);
  await expect.poll(() => headers(page)).toEqual(["Scratch", "alpha", "beta"]);
  // A folder's own canvases sit under its name; its projects are smaller headers.
  const alphaSection = page.locator('section.ld-folder[aria-label="alpha"]');
  await expect(alphaSection.locator(".ld-row", { hasText: "notes" })).toBeVisible();
  await expect(alphaSection.locator(".ld-project--sub .ld-project__name").first()).toBeVisible();
  // New canvas goes in the open canvas's folder: Scratch here.
  await page.getByRole("button", { name: "New canvas", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "New canvas path" })).toHaveValue("scratch/untitled");
  await page.keyboard.press("Escape");
  await alphaSection.locator(".ld-row", { hasText: "notes" }).first().click();
  await waitForCanvas(page, "alpha/notes.excalidraw");
  await page.getByRole("button", { name: "New canvas", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "New canvas path" })).toHaveValue("alpha/untitled");
  await page.keyboard.press("Escape");

  renameSync(beta, `${beta}-away`);
  await expect(page.locator('section.ld-folder--missing[aria-label="beta"]')).toContainText("It isn't there right now");
  renameSync(`${beta}-away`, beta);
  await expect(page.locator("section.ld-folder--missing")).toHaveCount(0);
  await expect(page.locator('section.ld-folder[aria-label="beta"] .ld-row').first()).toBeVisible();

  removeFolder(home, "beta");
  await expect.poll(() => headers(page)).toEqual(["Scratch", "alpha"]);
  writeFileSync(join(home, "config.json"), "{ nope");
  await expect(page.locator(".ld-warning")).toContainText("~/.localidraw/config.json isn't valid JSON");
  await expect.poll(() => headers(page)).toEqual(["Scratch", "alpha"]);
});

test("the Library: Localidraw's own, made by the first change; a folder's own wins while one of its canvases is open", async ({ page, url, home, tmp }) => {
  const alpha = project(tmp, "alpha"), beta = project(tmp, "beta");
  writeFileSync(join(beta, "library.excalidrawlib"), JSON.stringify({ type: "excalidrawlib", version: 2, libraryItems: [] }));
  addFolder(home, alpha);
  addFolder(home, beta);
  await page.addInitScript(() => {
    // This browser's Library from before: the first save of Localidraw's own starts with it.
    if (!localStorage.getItem("localidraw:seeded")) {
      localStorage.setItem("localidraw:library", JSON.stringify([{ id: "old", status: "unpublished", created: 1, elements: [{ id: "r1", type: "rectangle", x: 0, y: 0, width: 80, height: 40, version: 3, versionNonce: 1, isDeleted: false, seed: 1, angle: 0, strokeColor: "#1e1e1e", backgroundColor: "transparent", fillStyle: "solid", strokeWidth: 2, strokeStyle: "solid", roughness: 1, opacity: 100, groupIds: [], frameId: null, roundness: null, boundElements: null, updated: 1, link: null, locked: false }] }]));
      localStorage.setItem("localidraw:seeded", "1");
    }
  });
  await go(page, url);
  await expect.poll(() => headers(page)).toEqual(["Scratch", "alpha", "beta"]); // the server has seen the list
  await go(page, url, "alpha/notes.excalidraw");
  const at = () => page.evaluate(() => window.localidraw!.libraryAt());
  const ids = () => page.evaluate(() => window.localidraw!.library().slice().sort());
  await expect.poll(at).toEqual({ path: "library.excalidrawlib", file: false });
  expect(existsSync(join(home, "library.excalidrawlib"))).toBe(false);
  const elements = await fromSkeletons(page, [{ type: "rectangle", x: 0, y: 0, width: 80, height: 40 }]);
  await page.evaluate((e) => window.localidraw!.api.updateLibrary({ libraryItems: [{ id: "new", status: "unpublished", created: 2, elements: e as never }], merge: true }), elements);
  await expect.poll(at).toEqual({ path: "library.excalidrawlib", file: true });
  const own = JSON.parse(readFileSync(join(home, "library.excalidrawlib"), "utf8"));
  expect(own.libraryItems.map((i: { id: string }) => i.id).sort()).toEqual(["new", "old"]);

  // beta has its own: it's the one while beta's canvas is open, and alpha's goes back to Localidraw's own.
  await page.locator('section.ld-folder[aria-label="beta"] .ld-row', { hasText: "notes" }).first().click();
  await waitForCanvas(page, "beta/notes.excalidraw");
  await expect.poll(at).toEqual({ path: "beta/library.excalidrawlib", file: true });
  await expect.poll(ids).toEqual([]);
  await page.locator('section.ld-folder[aria-label="alpha"] .ld-row', { hasText: "notes" }).first().click();
  await waitForCanvas(page, "alpha/notes.excalidraw");
  await expect.poll(at).toEqual({ path: "library.excalidrawlib", file: true });
  await expect.poll(ids).toEqual(["new", "old"]);
  expect(JSON.parse(readFileSync(join(beta, "library.excalidrawlib"), "utf8")).libraryItems).toEqual([]);
});
