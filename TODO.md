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
  whole scene. Images could be stored apart, or only sent when they change.

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
- [ ] **11 `npm audit` warnings**, all in devDependencies (Excalidraw's own dependencies). The package ships none,
  but keep an eye on them.

## Name

- [ ] Two small GitHub projects already use the name: [theaubmov/Localidraw](https://github.com/theaubmov/Localidraw)
  ("A local workspace manager that adds multi-document functionality to Excalidraw", MIT, 6 stars) and
  [lnotspotl/localidraw](https://github.com/lnotspotl/localidraw) ("folder gallery, offline-first Hugging Face bucket
  sync, CLI"). Neither had published to npm as of 2026-11-01. Look at them as prior art, and decide whether the
  README should mention them.
