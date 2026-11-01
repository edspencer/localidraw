# docs-media: the demo folder and the README's GIF

```sh
npx playwright install chromium   # once
npm run docs:media:demo           # remake demo/
npm run docs:media:hero           # record docs/media/hero.gif, and copy it to website/public/demo/ (needs ffmpeg)
npm run docs:media:hero -- --skip-shoot   # re-encode the last run's frames
```

Look at the GIF and `git diff --stat` before committing.

## `make-demo.ts`: the demo folder

[demo/](../../demo) is drawn by Localidraw itself: each canvas starts empty, gets its shapes from Excalidraw's
`convertToExcalidrawElements` in the page, and is written by the autosave. It waits for Excalifont to load first, or
the text is measured in a fallback font and comes out clipped. The shapes are Excalidraw skeletons, at the top of the
script. Each run makes new random seeds, so it rewrites every file.

## `hero.ts`: the GIF

About 15 seconds, 1180px wide, well under the 3 MB budget it checks:

1. the architecture canvas opens, with the folder's projects in the Canvases tab;
2. someone draws a box under the API and labels it "Worker";
3. a script edits the same file the way a coding agent does (it adds a "Redis cache" box and an arrow to it, and bumps
   the API box's `version`, which gains the arrow), and the page merges it in, the Worker box kept;
4. they carry on and draw an arrow from the API to the Worker.

It finishes by checking the saved file has both the Worker and the cache, so a GIF of a merge that didn't happen can't
be made.

It runs on a copy of `demo/` in the system temp dir, with its own server on a free port. Frames are 2x screenshots,
each held for a set time, then ffmpeg makes one palette and the GIF.

**What's staged**, and the README's caption says so: the pointer (screenshots have none, so one is drawn), the
caption naming the two steps, and Excalidraw's hint line under the toolbar, which is hidden. The drawing is real
mouse and keyboard input, and the agent's edit is a real write to the file.

**What it mustn't show:** before each frame it reads the page's text and refuses to go on if it sees an absolute path
or a `localhost` URL. It reads the DOM, not pixels, so look at the GIF too.
