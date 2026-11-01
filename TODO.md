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

- [ ] **Excalidraw upgrades.** Pinned at 0.18.1, the version the VS Code extension uses. Before moving, go through
  [AGENTS.md's checklist](AGENTS.md#upgrading-excalidraw).
- [ ] **Other formats: `.excalidraw.svg`, `.excalidraw.png`, other `.excalidrawlib` files.** A design note, not built:
  none of it is cheap, and every save path it adds has to keep "nothing written on disk is lost".
  - **How the scene is embedded** (Excalidraw 0.18.1, `data/encode.ts` and `data/image.ts`). Both hold the scene's
    JSON (`serializeAsJSON`), deflated, as `{ version: "1", encoding: "bstring", compressed: true, encoded }`:
    - **SVG**: base64 of that JSON, in the `<metadata>` between `<!-- payload-start -->` and `<!-- payload-end -->`,
      after `<!-- payload-type:application/vnd.excalidraw+json -->`. Made by `exportToSvg` with `exportEmbedScene`.
    - **PNG**: a `tEXt` chunk with the keyword `application/vnd.excalidraw+json` and that JSON as its text, put just
      before `IEND`. Made by `exportToBlob` with `exportEmbedScene`.
    - Reading either needs nothing beyond Node (`node:zlib`'s `inflateSync`, and a PNG chunk walk), so the server
      can list them, validate them (the 422 path) and hand the page the scene, with the hash taken over the file's
      bytes as now. Excalidraw's own `loadFromBlob` reads both in the page too.
  - **Read-only first.** List them in the sidebar (marked as images), open them with `viewModeEnabled`, and offer
    "Save as a .excalidraw" (a new file, through the existing create path). No new write path; `resolveInRoot` would
    accept the two extensions for reads only. That's the cheap, safe step if anyone asks for it.
  - **Editable is the expensive part.** Every save would re-render the image in the page (`exportToSvg` embeds fonts;
    `exportToBlob` rasterises the whole scene), which is slow for a big canvas at autosave's pace, and sends a body
    the server can't check is a scene without decoding it. It needs: `resolveInRoot`, rename and the trash to keep
    the double extension; the 409 merge to decode the file on disk; the watcher and `--poll` to match the new
    extensions; `writeAtomic` of binary content (writes are JSON-only, so the page would send `{ scene, image }`
    with the image base64'd, or the server would render, which it can't without a browser); and the VS Code
    extension to open the result. Also: the export's settings (padding, background, dark mode, scale) aren't in the
    scene, so a re-render can change how an image someone embedded in a README looks.
  - **Other `.excalidrawlib` files** (a downloaded library, not the root's `library.excalidrawlib`): they're
    Libraries, not canvases, so the natural feature is "Add to Library" (Excalidraw's `importLibrary` /
    `updateLibrary` with `merge: true`) from the sidebar, which writes only the Library, by its existing path.
    Editing one as a document isn't something Excalidraw does.
  - **Obsidian's `.excalidraw.md`** is a different format (Markdown with a compressed-JSON block, plus its own text
    and links); out of scope.
- [ ] **`npm audit`**: two findings left in Excalidraw's dependencies (`nanoid` 4 and `katex`, through Mermaid), neither
  reachable as Localidraw uses them, and neither fixable without moving Excalidraw. Triaged in
  [SECURITY.md](SECURITY.md#npm-audit); look again with each Excalidraw upgrade.

## Name

- [ ] Two small GitHub projects already use the name: [theaubmov/Localidraw](https://github.com/theaubmov/Localidraw)
  ("A local workspace manager that adds multi-document functionality to Excalidraw", MIT, 6 stars) and
  [lnotspotl/localidraw](https://github.com/lnotspotl/localidraw) ("folder gallery, offline-first Hugging Face bucket
  sync, CLI"). Neither had published to npm as of 2026-11-01. Look at them as prior art, and decide whether the
  README should mention them.
