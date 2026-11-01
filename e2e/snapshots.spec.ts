// What Localidraw adds to Excalidraw's UI, in both themes, against committed baselines (docs/AESTHETIC.md).
// These run only inside the official Playwright image, where the baselines were made: see e2e/README.md.
import { join } from "node:path";
import { expect, settled, test } from "./fixtures.ts";

// Hides the drawing, which isn't under test: only the chrome on top of it is.
const chrome = { stylePath: join(import.meta.dirname, "snapshots.css") };

for (const theme of ["light", "dark"] as const) {
  test.describe(`${theme} theme`, () => {
    test.beforeEach(async ({ page }) => {
      await page.addInitScript((t) => localStorage.setItem("localidraw:theme", JSON.stringify(t)), theme);
    });

    test("the Canvases tab", async ({ page, open }) => {
      await open("plan.excalidraw");
      await settled(page);
      await expect(page.locator(".excalidraw .sidebar")).toHaveScreenshot(`canvases-tab-${theme}.png`, chrome);
    });

    test("the new-canvas field", async ({ page, open }) => {
      await open("team/blank.excalidraw");
      await page.getByRole("button", { name: "New canvas", exact: true }).click();
      await expect(page.getByLabel("New canvas path")).toBeFocused();
      await page.mouse.move(600, 400); // off the sidebar, so nothing in it is hovered
      await expect(page.locator(".excalidraw .sidebar")).toHaveScreenshot(`new-canvas-${theme}.png`, chrome);
    });

    test("the footer's status", async ({ page, folder, open }) => {
      await open("notes.excalidraw");
      await settled(page);
      // Moved by another program: no new elements, so nothing for Excalidraw to renumber and save afterwards.
      const scene = folder.scene("notes.excalidraw");
      folder.write("notes.excalidraw", { ...scene, elements: scene.elements.map((e) => ({ ...e, x: e.x + 40, version: e.version + 1 })) });
      await expect(page.locator(".ld-status")).toHaveText("Updated from disk");
      await page.mouse.move(600, 400);
      await expect(page.locator(".layer-ui__wrapper__footer")).toHaveScreenshot(`footer-status-${theme}.png`, chrome);
    });

    test.describe("an empty folder", () => {
      test.use({ folderName: null });
      test("offers to make the first canvas", async ({ page, open }) => {
        await open();
        await expect(page.getByRole("button", { name: "Make the first one" })).toBeVisible();
        await page.evaluate(() => document.fonts.ready);
        await expect(page).toHaveScreenshot(`empty-folder-${theme}.png`, chrome);
      });
    });
  });
}
