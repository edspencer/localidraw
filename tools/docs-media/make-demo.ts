// Remakes demo/, the neutral folder the README's GIF is recorded on. The canvases are drawn by Localidraw itself: each
// starts empty, gets its shapes from Excalidraw's convertToExcalidrawElements in the page (once Excalifont has loaded,
// so the text is measured right), and is saved by the autosave, so the files are exactly what a user's would be.
//
//   npm run docs:media:demo
//
// It rewrites demo/ in place; review the diff before committing.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { chromium } from "@playwright/test";
import { DEFAULT_PORT } from "../../server/port.ts";
import { startServer } from "../../server/server.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const DEMO = join(ROOT, "demo");

// Excalidraw skeletons (https://docs.excalidraw.com/docs/@excalidraw/excalidraw/api/excalidraw-element-skeleton).
const scenes: Record<string, any[]> = {
  "web-app/architecture.excalidraw": [
    { type: "text", x: 0, y: -90, text: "Architecture", fontSize: 28 },
    { type: "rectangle", id: "browser", x: 0, y: 0, width: 180, height: 80, strokeColor: "#1971c2", backgroundColor: "#a5d8ff", fillStyle: "solid", label: { text: "Browser" } },
    { type: "rectangle", id: "api", x: 320, y: 0, width: 180, height: 80, strokeColor: "#2f9e44", backgroundColor: "#b2f2bb", fillStyle: "solid", label: { text: "API" } },
    { type: "rectangle", id: "db", x: 640, y: 0, width: 180, height: 80, strokeColor: "#f08c00", backgroundColor: "#ffec99", fillStyle: "solid", label: { text: "Postgres" } },
    { type: "arrow", x: 180, y: 40, width: 140, height: 0, start: { id: "browser" }, end: { id: "api" }, label: { text: "HTTPS" } },
    { type: "arrow", x: 500, y: 40, width: 140, height: 0, start: { id: "api" }, end: { id: "db" }, label: { text: "SQL" } },
  ],
  "web-app/login-flow.excalidraw": [
    { type: "rectangle", id: "a", x: 0, y: 0, width: 200, height: 70, label: { text: "Sign-in page" } },
    { type: "diamond", id: "b", x: -15, y: 140, width: 230, height: 120, label: { text: "Password ok?" } },
    { type: "rectangle", id: "c", x: 0, y: 330, width: 200, height: 70, backgroundColor: "#b2f2bb", fillStyle: "solid", label: { text: "Dashboard" } },
    { type: "rectangle", id: "d", x: 300, y: 165, width: 180, height: 70, backgroundColor: "#ffc9c9", fillStyle: "solid", label: { text: "Try again" } },
    { type: "arrow", x: 100, y: 70, width: 0, height: 70, points: [[0, 0], [0, 70]], start: { id: "a" }, end: { id: "b" } },
    { type: "arrow", x: 100, y: 260, width: 0, height: 70, points: [[0, 0], [0, 70]], start: { id: "b" }, end: { id: "c" }, label: { text: "yes" } },
    { type: "arrow", x: 215, y: 200, width: 85, height: 0, start: { id: "b" }, end: { id: "d" }, label: { text: "no" } },
  ],
  "notes/ideas.excalidraw": [
    { type: "rectangle", x: 0, y: 0, width: 220, height: 120, backgroundColor: "#ffec99", fillStyle: "solid", strokeColor: "#f08c00", label: { text: "Dark mode\nfor the export" } },
    { type: "rectangle", x: 260, y: 30, width: 220, height: 120, backgroundColor: "#d0bfff", fillStyle: "solid", strokeColor: "#6741d9", label: { text: "Keyboard shortcut\nfor New canvas" } },
    { type: "rectangle", x: 100, y: 180, width: 220, height: 120, backgroundColor: "#a5d8ff", fillStyle: "solid", strokeColor: "#1971c2", label: { text: "Share a canvas\nas a link" } },
  ],
};
const tmp = mkdtempSync(join(tmpdir(), "localidraw-demo-"));
const root = join(tmp, "demo");
const empty = { type: "excalidraw", version: 2, source: "", elements: [], appState: { viewBackgroundColor: "#ffffff" }, files: {} };
for (const path of Object.keys(scenes)) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), JSON.stringify(empty));
}
const app = await startServer({ root, port: 0, webDir: join(ROOT, "dist", "web") });
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  for (const [path, skeleton] of Object.entries(scenes)) {
    await page.goto(`${app.url.replace(/\/$/, "")}/?canvas=${encodeURIComponent(path)}`);
    await page.waitForFunction((p) => window.localidraw?.path === p, path);
    await page.evaluate(() => Promise.all(["16px Excalifont", "20px Excalifont", "28px Excalifont"].map((f) => document.fonts.load(f))));
    await page.evaluate((skeleton) => {
      const h = window.localidraw!;
      h.api.updateScene({ elements: h.convertToExcalidrawElements(skeleton as never, { regenerateIds: false }) });
    }, skeleton);
    await page.waitForFunction(() => { const s = window.localidraw!.saves(); return s.state === "idle" && s.written > 0; }, null, { timeout: 15_000 });
    // Excalidraw writes the page's address as the source; make it what a default run writes, not this run's port.
    const file = join(root, path);
    writeFileSync(file, readFileSync(file, "utf8").replace(/"source": "http:\/\/localhost:\d+"/, `"source": "http://localhost:${DEFAULT_PORT}"`));
    console.log(`demo/${path}`);
  }
} finally {
  await browser.close();
  await app.close();
}
for (const path of Object.keys(scenes)) cpSync(join(root, path), join(DEMO, path));
rmSync(tmp, { recursive: true, force: true });
