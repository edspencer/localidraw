# To do

What the first version (0.1.0, an initial spike) doesn't do yet, and what we've already decided should be done.
Roughly in priority order within each section. Strike items out, or delete them, as they land.

## Before the first npm release

- [ ] **Review `AI-DECLARATION.md`.** It's a draft written by Claude in Ed's voice, modelled on Local Review's. Make it
  true and yours.
- [ ] **Publish `localidraw` to npm.** The name was free on 2026-11-01, so `npx localidraw` should then work.
- [ ] **Package size** (15.8 MB packed, 21.7 MB unpacked). Decided: keep Xiaolai, Excalidraw's CJK handwriting font
  (12 of the 13 MB of fonts), so it works fully offline. `npm run smoke:pack` now fails if the package grows past
  16.5 MB packed or 23 MB unpacked. The lazily loaded chunks (7.7 MB, mostly Mermaid) could still be looked at.

## The editor

- [ ] **Large files**: canvases with big embedded images (`files`). The body limit is 64 MB, and every save sends the
  whole scene, images included, so a canvas with a 10 MB photo sends about 13 MB of base64 each time you move a box.
  On localhost that's tolerable; through a proxy to a hosted copy it isn't. Design, not yet built:
  - **Keep the file self-contained.** Images stay in the `.excalidraw` file's `files`, as Excalidraw and the VS Code
    extension expect, so nothing changes on disk. Storing them apart (`<name>.files/`) would break that round-trip.
  - **Send only the images the file doesn't have.** The page knows which file ids the version it last saved or loaded
    had (keep them with `base`). A save sends the scene with `files` holding only the new ids, plus an
    `x-files-kept: <ids>` header listing the ones it left out. The server, under the same base-hash check (a 409 still
    returns the whole file, so the merge sees every image), copies those ids' entries from the file on disk into the
    scene before `writeAtomic`. An id in the header that isn't on disk is a 422, and the page resends in full. So the
    file written is exactly what a full save would have written.
  - **Loading** stays one GET. `Cache-Control` doesn't help, because the hash changes with every save. A later step
    could serve `files` separately (`/api/canvas/files?path=&ids=`) and let the page fetch them lazily.
  - **Tests:** a save that leaves an image out writes the same bytes as a full save; a 409 merge with images on both
    sides; an image deleted on disk meanwhile (the server refuses, the page resends in full); and the body size of a
    save after moving one box.

## Compatibility and platforms

- [ ] **Excalidraw upgrades.** It's pinned at 0.18.1, the version the VS Code extension uses, so files round-trip.
  Before moving to a newer Excalidraw, check that the extension still opens what we save. React stays at 18 until
  Excalidraw's bundled Radix packages accept 19.
- [ ] **Windows**: CI runs it (Node 24) as a best-effort leg that doesn't block. On the first run, typecheck, the
  tests and the build passed; `smoke:pack` failed at once (`spawnSync npm ENOENT`: `scripts/smoke-pack.mjs` runs
  `npm` and `mkdir -p` without a shell, and on Windows npm is `npm.cmd`). Still untested beyond that: paths in the
  page, the recursive `fs.watch` in real use, `explorer` for `--open`. Then make the leg blocking.
- [ ] **Big folders on Linux**: Localidraw watches each folder there (Node's recursive watch went deaf to a file once
  another was renamed over it), skipping dot-folders and `node_modules`. It still watches folders with no canvases, so
  it can see new ones arrive; a tree with many such folders costs an inotify watch each
  (`fs.inotify.max_user_watches`).
- [ ] **Other formats?** `.excalidraw.svg` and `.excalidraw.png` (a scene embedded in an image, as the VS Code
  extension and Obsidian write). (`library.excalidrawlib` at the root is the shared Library.)
- [ ] **`npm audit`**: two findings left in Excalidraw's dependencies (`nanoid` 4 and `katex`, through Mermaid), neither
  reachable as Localidraw uses them, and neither fixable without moving Excalidraw. Triaged in
  [SECURITY.md](SECURITY.md#npm-audit); look again with each Excalidraw upgrade.

## Name

- [ ] Two small GitHub projects already use the name: [theaubmov/Localidraw](https://github.com/theaubmov/Localidraw)
  ("A local workspace manager that adds multi-document functionality to Excalidraw", MIT, 6 stars) and
  [lnotspotl/localidraw](https://github.com/lnotspotl/localidraw) ("folder gallery, offline-first Hugging Face bucket
  sync, CLI"). Neither had published to npm as of 2026-11-01. Look at them as prior art, and decide whether the
  README should mention them.
