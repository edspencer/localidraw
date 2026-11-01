# To do

What Localidraw doesn't do yet, and what's been decided but not built, as of 0.4. Roughly in priority order within
each section. Delete items as they land; keep the design notes until then.

## For Ed

- [ ] **Review `AI-DECLARATION.md`.** It's a draft written by Claude in Ed's voice, modelled on Local Review's. Make it
  true and yours.
- [ ] **Deprecate the npm placeholder** `localidraw@0.0.1` (RELEASING.md has the command; it needs a logged-in
  maintainer).

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
- [ ] **Who saved what, on a hosted copy.** Decided as "later": an optional `--trust-header <name>` that reads the
  proxy's user header (Authentik's `X-authentik-username`) to show who saved a canvas. Localidraw adds no login of its
  own either way.
- [ ] **Git, built in.** Not planned yet (decision 7: the hosted folder is a NAS mount or a backed-up disk). Today git
  works alongside: checkouts, pulls and `git mv` on the open canvas are merged or followed.
- [ ] **Undo a delete onto a name that's been re-used** leaves the canvas in `.localidraw/trash` and says why. A
  "restore as…" would let it come back under another name.
- [ ] **A canvas moved and edited at once on disk** looks like a delete (the move is recognised by identical content).
  **Save it again** restores it at the old path, so nothing is lost, but it isn't followed.
- [ ] **`source`** in saved files is the page's address (`http://localhost:3729`), as Excalidraw's `serializeAsJSON`
  writes it. Harmless; it could say Localidraw instead.

## Compatibility and platforms

- [ ] **Excalidraw upgrades.** Pinned at 0.18.1, the version the VS Code extension uses. Before moving, go through
  [AGENTS.md's checklist](AGENTS.md#upgrading-excalidraw).
- [ ] **Package size** (15.8 MB packed, 21.8 MB unpacked at 0.4.0). Decided: keep Xiaolai, Excalidraw's CJK
  handwriting font (12 of the 13 MB of fonts), so it works fully offline. `npm run smoke:pack` fails past 16.5 MB
  packed or 23 MB unpacked. The lazily loaded chunks (7.7 MB, mostly Mermaid) could still be looked at.
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
