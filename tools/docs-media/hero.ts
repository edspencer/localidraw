// The README's hero GIF: someone draws on a canvas while a script edits the same file the way a coding agent does, and
// both changes end up on the canvas and in the file.
//
//   npm run docs:media:hero                 build the page, record, encode docs/media/hero.gif (and the docs site's copy)
//   npm run docs:media:hero -- --skip-shoot re-encode the frames from the last run
//
// It runs on a fresh copy of demo/ in the system temp dir (never demo/ itself), with its own server on a free port.
// Frames are 2x screenshots of each beat, with a drawn pointer (screenshots have none), each held for a set time, then
// encoded by ffmpeg with one shared palette. Needs Chromium (`npx playwright install chromium`) and ffmpeg on PATH.
//
// What's real: the editor, the drawing (real mouse events), the file write, and the merge the page does when the file
// changes. What's staged: the pointer, and the caption naming the steps, which is laid over the page.
import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "@playwright/test";
import { startServer } from "../../server/server.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const WORK = join(tmpdir(), "localidraw-hero");
const FRAMES = join(WORK, "frames");
const OUT = join(ROOT, "docs", "media", "hero.gif");
/** The docs site's copy, for its home page (Cloudflare builds website/ on its own, so it can't reach docs/). */
const SITE_COPY = join(ROOT, "website", "public", "demo", "hero.gif");
const SKIP_SHOOT = process.argv.includes("--skip-shoot");

const CANVAS = "web-app/architecture.excalidraw";
/** The window it's shot in (CSS px, at 2x), and the width the GIF is scaled to. */
const VIEWPORT = { width: 1180, height: 640 };
const GIF_WIDTH = 1180;
const MAX_BYTES = 3 * 1024 * 1024;

interface Frame { file: string; hold: number } // hold: seconds

const STILL_CSS = `
*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }
.excalidraw .HintViewer { visibility: hidden; }
#hero-cursor { position: fixed; z-index: 99999; width: 22px; height: 22px; pointer-events: none; left: -40px; top: -40px;
  filter: drop-shadow(0 1px 1.5px rgb(0 0 0 / .35)); }
#hero-caption { position: fixed; z-index: 99998; left: 50%; top: 104px; transform: translateX(-50%); pointer-events: none;
  font: 500 15px/1.4 Assistant, system-ui, sans-serif; color: #fff; background: rgb(27 27 31 / .88); padding: 8px 14px;
  border-radius: 8px; white-space: nowrap; display: none; }
#hero-caption code { font: 500 14px ui-monospace, Menlo, monospace; color: #c9c7f5; }
`;
const CURSOR_SVG = `<svg viewBox="0 0 22 22" xmlns="http://www.w3.org/2000/svg"><path d="M3 2 L3 18 L7.5 14 L10.5 20.5 L13 19.4 L10.1 13 L16 13 Z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>`;

// ------------------------------------------------------------------------------------------------ the agent

const rand = () => Math.floor(Math.random() * 2 ** 31);

/**
 * Edits the canvas the way a coding agent does: read the JSON, add a box with a label and an arrow to it from the
 * API, and write the whole file. It follows the rules in the docs ("Working with coding agents"): new elements have
 * new ids, version 1 and no `index`; the one existing element it changes (the API box, which gains a bound arrow)
 * gets its `version` bumped. Elements are copied from ones already in the file, as an agent would.
 */
function agentAddsACache(file: string) {
  const scene = JSON.parse(readFileSync(file, "utf8"));
  const els: any[] = scene.elements;
  const api = els.find((e) => e.id === "api");
  const label = els.find((e) => e.type === "text" && e.containerId === "api");
  const arrow = els.find((e) => e.type === "arrow");
  if (!api || !label || !arrow) throw new Error(`demo/${CANVAS} isn't the scene this script expects`);
  const strip = ({ index, ...e }: any) => ({ ...e, version: 1, versionNonce: rand(), seed: rand(), updated: Date.now() });

  const box = { ...strip(api), id: "cache", x: 640, y: 180, strokeColor: "#e03131", backgroundColor: "#ffc9c9", boundElements: [{ type: "text", id: "cache-label" }, { type: "arrow", id: "api-cache" }] };
  // An agent can't measure Excalifont, and Excalidraw draws a text element at the size the file gives it, so estimate
  // generously: about 0.6 of the font size per character, and 1.25 lines.
  const words = "Redis cache";
  const text = {
    ...strip(label), id: "cache-label", containerId: "cache", text: words, originalText: words, strokeColor: box.strokeColor,
    width: Math.ceil(words.length * label.fontSize * 0.6), height: Math.ceil(label.fontSize * 1.25),
  };
  text.x = box.x + (box.width - text.width) / 2;
  text.y = box.y + (box.height - text.height) / 2;
  const link = {
    ...strip(arrow), id: "api-cache", x: 500, y: 60, width: 140, height: 160, points: [[0, 0], [140, 160]],
    startBinding: { elementId: "api", focus: 0, gap: 1 }, endBinding: { elementId: "cache", focus: 0, gap: 1 }, boundElements: [],
  };
  api.boundElements = [...(api.boundElements ?? []), { type: "arrow", id: "api-cache" }];
  api.version += 1;
  api.versionNonce = rand();
  scene.elements = [...els, box, text, link];
  writeFileSync(`${file}.tmp`, `${JSON.stringify(scene, null, 2)}\n`);
  renameSync(`${file}.tmp`, file);
}

// ------------------------------------------------------------------------------------------------ the shoot

async function shoot(): Promise<Frame[]> {
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(FRAMES, { recursive: true });
  // A folder named "demo", so the empty-folder text and the like would say "demo", as they do for a user's folder.
  const root = join(WORK, "demo");
  cpSync(join(ROOT, "demo"), root, { recursive: true });
  const app = await startServer({ root, port: 0, webDir: join(ROOT, "dist", "web") });
  const base = app.url.replace(/\/$/, "");
  const browser = await chromium.launch();
  const frames: Frame[] = [];
  try {
    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2, colorScheme: "light", reducedMotion: "reduce", locale: "en-US", timezoneId: "UTC" });
    await context.addInitScript("globalThis.__name = (f) => f;");
    const page = await context.newPage();
    let n = 0;
    const snap = async (hold: number) => {
      await leakCheck(page);
      const file = join(FRAMES, `${String(n++).padStart(3, "0")}.png`);
      await page.screenshot({ path: file });
      frames.push({ file, hold });
    };
    let at = { x: VIEWPORT.width - 40, y: VIEWPORT.height - 40 };
    const cursorTo = async (x: number, y: number) => {
      at = { x, y };
      await page.mouse.move(x, y);
      await page.evaluate(([x, y, svg]) => {
        let c = document.getElementById("hero-cursor");
        if (!c) {
          c = document.createElement("div");
          c.id = "hero-cursor";
          c.innerHTML = svg as string;
          document.body.appendChild(c);
        }
        c.style.left = `${(x as number) - 3}px`;
        c.style.top = `${(y as number) - 2}px`;
      }, [x, y, CURSOR_SVG] as const);
    };
    /** Moves the pointer in `steps` frames (a few in-between frames make its travel readable without filming it). */
    const glide = async (x: number, y: number, steps: number, hold = 0.05) => {
      const from = at;
      for (let i = 1; i <= steps; i++) {
        await cursorTo(from.x + ((x - from.x) * i) / steps, from.y + ((y - from.y) * i) / steps);
        if (i < steps) await snap(hold);
      }
    };
    const caption = (html: string | null) =>
      page.evaluate((html) => {
        let c = document.getElementById("hero-caption");
        if (!c) {
          c = document.createElement("div");
          c.id = "hero-caption";
          document.body.appendChild(c);
        }
        c.innerHTML = html ?? "";
        c.style.display = html ? "block" : "none";
      }, html);
    /** Where a scene point is on screen. */
    const screen = (x: number, y: number) =>
      page.evaluate(([x, y]) => {
        const s = window.localidraw!.api.getAppState();
        return { x: (x + s.scrollX) * s.zoom.value + s.offsetLeft, y: (y + s.scrollY) * s.zoom.value + s.offsetTop };
      }, [x, y] as const);
    /** A click on empty canvas, so nothing is selected and the properties panel closes. */
    const deselect = async () => {
      const p = await screen(160, 260);
      await glide(p.x, p.y, 4);
      await page.mouse.down();
      await page.mouse.up();
    };

    await page.goto(`${base}/?canvas=${encodeURIComponent(CANVAS)}`);
    await page.waitForFunction((p) => window.localidraw?.path === p, CANVAS);
    await page.addStyleTag({ content: STILL_CSS });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(400); // the first paint of the canvas after the fit
    await cursorTo(at.x, at.y);

    // 0. The canvas, with the folder's projects and canvases in the sidebar.
    await snap(1.8);

    // 1. Draw a box under the API: the rectangle tool, then a drag.
    const tool = (await page.locator('[data-testid="toolbar-rectangle"]').boundingBox())!;
    await glide(tool.x + tool.width / 2, tool.y + tool.height / 2, 6);
    await page.mouse.down();
    await page.mouse.up();
    await snap(0.4);
    const from = await screen(320, 180);
    const to = await screen(500, 260);
    await glide(from.x, from.y, 6);
    await snap(0.2);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) {
      await cursorTo(from.x + ((to.x - from.x) * i) / 8, from.y + ((to.y - from.y) * i) / 8);
      await snap(0.05);
    }
    await page.mouse.up();
    await snap(0.3);
    // Enter edits the new box's label.
    await page.keyboard.press("Enter");
    for (const word of ["Wor", "ker"]) {
      await page.keyboard.type(word);
      await snap(0.12);
    }
    await page.keyboard.press("Escape");
    await deselect();
    await page.waitForFunction(() => { const s = window.localidraw!.saves(); return s.state === "idle" && s.written > 0; }, null, { timeout: 15_000 });
    await snap(1.2);

    // 2. The agent edits the same file.
    await caption(`A coding agent edits <code>${CANVAS}</code>…`);
    await snap(1.4);
    const before = await page.evaluate(() => window.localidraw!.api.getSceneElements().length);
    agentAddsACache(join(root, CANVAS));
    await page.waitForFunction((n) => window.localidraw!.api.getSceneElements().length > n, before, { timeout: 15_000 });
    await page.waitForTimeout(250);
    await caption("…and its change merges in, with your drawing kept");
    await snap(3.2);
    await caption(null);

    // 3. Carry on: an arrow from the API to the new box.
    const a = await screen(410, 82);
    const b = await screen(410, 178);
    const arrowTool = (await page.locator('[data-testid="toolbar-arrow"]').boundingBox())!;
    await glide(arrowTool.x + arrowTool.width / 2, arrowTool.y + arrowTool.height / 2, 5);
    await page.mouse.down();
    await page.mouse.up();
    await snap(0.3);
    await glide(a.x, a.y, 5);
    await page.mouse.down();
    for (let i = 1; i <= 5; i++) {
      await cursorTo(a.x, a.y + ((b.y - a.y) * i) / 5);
      await snap(0.05);
    }
    await page.mouse.up();
    await snap(0.4);
    await deselect();
    await page.waitForFunction(() => { const s = window.localidraw!.saves(); return s.state === "idle"; }, null, { timeout: 15_000 });
    await page.waitForTimeout(300);
    await snap(3.5);

    // The file has both: the box drawn here and the agent's cache.
    const saved = JSON.parse(readFileSync(join(root, CANVAS), "utf8")).elements.filter((e: any) => !e.isDeleted);
    const texts = saved.filter((e: any) => e.type === "text").map((e: any) => e.text);
    for (const t of ["Worker", "Redis cache"]) if (!texts.includes(t)) throw new Error(`the saved file has no "${t}": ${texts.join(", ")}`);
  } finally {
    await browser.close();
    await app.close();
  }
  writeFileSync(join(WORK, "frames.json"), JSON.stringify(frames));
  return frames;
}

/** Refuses a frame whose page text shows anything of this machine: an absolute path, or a localhost URL. */
async function leakCheck(page: Page) {
  const text = await page.evaluate(() => document.body.innerText);
  const leak = text.match(/(\/(tmp|home|Users|var|data|private)\/|[A-Z]:\\|localhost:\d+|127\.0\.0\.1)/);
  if (leak) throw new Error(`the page shows "${leak[0]}"; not recording that`);
}

// ------------------------------------------------------------------------------------------------ the encode

function encode(frames: Frame[]) {
  // ffmpeg's concat demuxer: each frame with its duration, the last listed twice (it ignores the last duration).
  const list = join(WORK, "frames.txt");
  writeFileSync(list, [...frames.map((f) => `file '${f.file}'\nduration ${f.hold}`), `file '${frames.at(-1)!.file}'`].join("\n") + "\n");
  const scale = `scale=${GIF_WIDTH}:-1:flags=lanczos`;
  const palette = join(WORK, "palette.png");
  execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", list, "-vf", `${scale},palettegen=max_colors=96:stats_mode=diff`, palette]);
  mkdirSync(join(ROOT, "docs", "media"), { recursive: true });
  execFileSync("ffmpeg", [
    "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", list, "-i", palette,
    "-lavfi", `${scale},fps=20 [v]; [v][1:v] paletteuse=dither=none:diff_mode=rectangle`, "-loop", "0", OUT,
  ]);
  const size = statSync(OUT).size;
  const seconds = frames.reduce((s, f) => s + f.hold, 0);
  console.log(`hero: ${frames.length} frames, ${seconds.toFixed(1)} s, ${(size / 1024 / 1024).toFixed(2)} MB -> docs/media/hero.gif`);
  if (size > MAX_BYTES) throw new Error(`docs/media/hero.gif is ${(size / 1024 / 1024).toFixed(2)} MB, over the 3 MB budget`);
  mkdirSync(join(SITE_COPY, ".."), { recursive: true });
  copyFileSync(OUT, SITE_COPY);
  console.log("hero: copied to website/public/demo/hero.gif");
}

const frames: Frame[] = SKIP_SHOOT ? JSON.parse(readFileSync(join(WORK, "frames.json"), "utf8")) : await shoot();
if (!frames.length || !readdirSync(FRAMES).length) throw new Error("no frames");
encode(frames);
