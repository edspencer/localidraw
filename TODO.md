# To do

What the first version (0.1.0, an initial spike) doesn't do yet, and what we've already decided should be done.
Roughly in priority order within each section. Strike items out, or delete them, as they land.

## Before the first npm release

- [ ] **Review `AI-DECLARATION.md`.** It's a draft written by Claude in Ed's voice, modelled on Local Review's. Make it
  true and yours.
- [ ] **Publish `localidraw` to npm.** The name was free on 2026-11-01, so `npx localidraw` should then work.
- [ ] **README hero image** from a neutral demo folder. The spike's screenshots were of private diagrams, so none
  are committed. Maybe a short GIF of drawing while an agent edits the same canvas.
- [ ] **Brand**: a mark, a light and a dark lockup, a social preview. `web/favicon.svg` is a placeholder (Tabler's
  pencil on Excalidraw's violet).
- [ ] **Package size** (15.8 MB packed, 21.7 MB unpacked). Decided: keep Xiaolai, Excalidraw's CJK handwriting font
  (12 of the 13 MB of fonts), so it works fully offline. `npm run smoke:pack` now fails if the package grows past
  16.5 MB packed or 23 MB unpacked. The lazily loaded chunks (7.7 MB, mostly Mermaid) could still be looked at.

## Hosting (a Docker image)

Packaging is easy (Node 22, about 22 MB of built files, no runtime dependencies, canvases on a mounted volume). But
today the server is deliberately for one person on their own machine, so a container can't be reached and mustn't
be exposed. Needed:

- [ ] **Decide the security model first**: auth built in (a shared token, or more), or documented as the reverse
  proxy's job (basic auth, SSO, Tailscale, Cloudflare Access).
- [ ] **`--host`** to listen beyond 127.0.0.1, and **an allowed-hosts list** for the `Host`/`Origin` check in
  `server/security.ts` (which today allows only localhost, against DNS rebinding). Then rewrite the "localhost only"
  rule in `AGENTS.md` and the README to say what holds when hosted.
- [ ] **The Dockerfile** (and maybe a compose file): a volume for the canvases, a non-root user, a health check (a
  `/healthz` route).
- [ ] **Document the limits**: one instance per folder (the change events come from the one server watching it),
  changes arrive on save rather than live (there's no collaboration server), and file watching through Docker
  Desktop bind mounts from macOS can miss events.

## The editor

- [ ] **Browser tests in the repo** (Playwright). The spike checked these by hand in headless Chrome, and they should
  become tests:
  - opening and scrolling a canvas doesn't write it;
  - drawing autosaves;
  - an external edit (a skeleton applied with `convertToExcalidrawElements`) appears and keeps the drawing;
  - a drawing and an edit on disk made at the same moment both survive;
  - a deletion on disk sticks;
  - shortcuts work straight after a sidebar click, and ⌘S and ⌘Z save;
  - a first open fits the drawing beside the docked sidebar;
  - an empty canvas doesn't zoom in.

  Only `web/merge.ts` is tested today.
- [ ] **Screenshot checks of both themes** for UI changes (see `docs/AESTHETIC.md`), perhaps as visual-regression
  snapshots.
- [ ] **Rename, move and delete canvases from the sidebar.** Today that's `git mv`/`git rm` (or Finder), and the
  server only creates and saves. Deleting needs a decision about safety (a trash folder? git only?).
- [ ] **No remount when switching canvases.** Each switch mounts a new Excalidraw, so the canvas and sidebar flash.
  Keep one instance and swap scenes (`updateScene`, then clear the undo history), keeping the per-canvas state right.
- [ ] **Excalidraw's Library is lost on reload.** Persist it, in `localStorage` or as a `.excalidrawlib` in the
  folder, so a project can share one.
- [ ] **Tell the user when a change of theirs lost** to a change on disk (the same element edited on both sides at
  once). The merge resolves it silently today.
- [ ] **Show empty folders as projects?** Folders with no canvases are hidden, and git doesn't keep empty folders
  anyway.
- [ ] **Large files**: canvases with big embedded images (`files`). The body limit is 64 MB, and every save sends the
  whole scene. Images could be stored apart, or only sent when they change.
- [ ] **A dev mode with hot reload** (`npm run dev`). Today it's `npm start`, which builds and runs.

## Compatibility and platforms

- [ ] **Excalidraw upgrades.** It's pinned at 0.18.1, the version the VS Code extension uses, so files round-trip.
  Before moving to a newer Excalidraw, check that the extension still opens what we save. React stays at 18 until
  Excalidraw's bundled Radix packages accept 19.
- [ ] **Windows**: CI runs it (Node 24) as a best-effort leg that doesn't block. On the first run, typecheck, the
  tests and the build passed; `smoke:pack` failed at once (`spawnSync npm ENOENT`: `scripts/smoke-pack.mjs` runs
  `npm` and `mkdir -p` without a shell, and on Windows npm is `npm.cmd`). Still untested beyond that: paths in the
  page, the recursive `fs.watch` in real use, `explorer` for `--open`. Then make the leg blocking.
- [ ] **Big folders on Linux**: Node's recursive `fs.watch` there walks the whole tree, `node_modules` included (it's
  only skipped when events arrive). Watching just the folders that hold canvases would be cheaper.
- [ ] **Other formats?** `.excalidraw.svg` and `.excalidraw.png` (a scene embedded in an image, as the VS Code
  extension and Obsidian write), and `.excalidrawlib`.
- [ ] **11 `npm audit` warnings**, all in devDependencies (Excalidraw's own dependencies). The package ships none,
  but keep an eye on them.

## Name

- [ ] Two small GitHub projects already use the name: [theaubmov/Localidraw](https://github.com/theaubmov/Localidraw)
  ("A local workspace manager that adds multi-document functionality to Excalidraw", MIT, 6 stars) and
  [lnotspotl/localidraw](https://github.com/lnotspotl/localidraw) ("folder gallery, offline-first Hugging Face bucket
  sync, CLI"). Neither had published to npm as of 2026-11-01. Look at them as prior art, and decide whether the
  README should mention them.
