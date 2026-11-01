// What every browser test starts from: its own server, on port 0, over a temporary copy of a folder in e2e/folders.
// The page exposes `window.localidraw` (web/CanvasView.tsx) so the tests wait on real state, never on a sleep.
import { test as base, expect, type Page } from "@playwright/test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { startServer } from "../server/server.ts";

const ROOT = join(import.meta.dirname, "..");
const WEB = join(ROOT, "dist/web");

export type Element = { id: string; type: string; x: number; y: number; width: number; height: number; version: number; isDeleted?: boolean; text?: string };
export type Scene = { elements: Element[]; appState?: Record<string, unknown>; files?: Record<string, unknown> };

export class Folder {
  constructor(readonly root: string) {}
  read(path: string): string { return readFileSync(join(this.root, path), "utf8"); }
  scene(path: string): Scene { return JSON.parse(this.read(path)); }
  /** Live elements: what's drawn, leaving out the deleted ones Excalidraw keeps as tombstones. */
  elements(path: string): Element[] { return this.scene(path).elements.filter((e) => !e.isDeleted); }
  /** Writes a file as another program would (a coding agent, an editor): straight over it. */
  write(path: string, scene: Scene) {
    mkdirSync(dirname(join(this.root, path)), { recursive: true });
    writeFileSync(join(this.root, path), `${JSON.stringify(scene, null, 2)}\n`);
  }
  /** Writes any content straight over a file. */
  writeRaw(path: string, content: string) { writeFileSync(join(this.root, path), content); }
  remove(path: string) { rmSync(join(this.root, path)); }
}

type Fixtures = {
  /** The folder the server is serving: a copy of `folderName`, or empty. */
  folder: Folder;
  folderName: string | null;
  /** Opens the page on one canvas (or on none) and waits until Excalidraw is up on it. */
  open: (canvas?: string) => Promise<void>;
};

export const test = base.extend<Fixtures>({
  folderName: ["drawings", { option: true }],
  folder: async ({ folderName }, use) => {
    const tmp = mkdtempSync(join(tmpdir(), "localidraw-e2e-"));
    const root = join(tmp, "diagrams");
    if (folderName) cpSync(join(import.meta.dirname, "folders", folderName), root, { recursive: true });
    else mkdirSync(root);
    await use(new Folder(root));
    rmSync(tmp, { recursive: true, force: true });
  },
  baseURL: async ({ folder }, use) => {
    const app = await startServer({ root: folder.root, port: 0, webDir: WEB });
    await use(app.url);
    await app.close();
  },
  open: async ({ page }, use) => {
    await use(async (canvas) => {
      // The response to /api/events means the server has this page on its list for changes on disk.
      const events = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/events");
      await page.goto(canvas ? `/?canvas=${encodeURIComponent(canvas)}` : "/");
      await events;
      if (canvas) await waitForCanvas(page, canvas);
    });
  },
});

export { expect };

/** Waits until Excalidraw is showing `path` and its fonts are in. */
export async function waitForCanvas(page: Page, path: string) {
  await page.waitForFunction((p) => window.localidraw?.path === p, path);
  await page.evaluate(() => document.fonts.ready);
}

/** The scene on screen, without deleted elements. */
export const onScreen = (page: Page) =>
  page.evaluate(() => window.localidraw!.api.getSceneElements().map((e) => ({ id: e.id, type: e.type, version: e.version, text: "text" in e ? e.text : undefined })));

export const saves = (page: Page) => page.evaluate(() => window.localidraw!.saves());

/** Waits until the autosave has nothing due or in flight, and has checked for changes more than `after` times. */
export async function settled(page: Page, after = 0) {
  await expect.poll(async () => { const s = await saves(page); return s.state === "idle" && s.checked > after; }).toBe(true);
}

/** Draws a rectangle with the mouse, clear of the shape properties that open on the left and the docked sidebar on the right. */
export async function drawRectangle(page: Page, at = { x: 450, y: 450 }) {
  await page.keyboard.press("r");
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.move(at.x + 120, at.y + 80, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.press("Escape");
}

/** Skeletons, as a coding agent would write them, made into full elements by Excalidraw's own converter. */
export const fromSkeletons = (page: Page, skeletons: object[]) =>
  page.evaluate((s) => window.localidraw!.convertToExcalidrawElements(s as never) as unknown as Element[], skeletons);
