# Localidraw: working conventions

For agents (and people) developing Localidraw itself.

- **It must look like Excalidraw.** Anything Localidraw adds to the UI follows [docs/AESTHETIC.md](docs/AESTHETIC.md):
  Excalidraw's chrome, never its hand-drawn style. Build from Excalidraw's own components (`DefaultSidebar`,
  `Sidebar.Tab`, `Footer`, `MainMenu`) where one exists, and otherwise style with its CSS variables under
  `.excalidraw`, so dark mode comes free. Check both themes with a screenshot before calling a UI change done.
- **Opening never writes.** A canvas is saved only when an element's version or the background changed
  (`changedSince` in `web/merge.ts`). Excalidraw normalises a scene on load, so comparing serialised JSON would
  rewrite every file you open. Keep it that way.
- **Nothing written on disk is lost.** A save sends the hash it was based on (`x-base-hash`); the server answers 409
  with the current file if it moved on, and the page merges (`mergeScenes`) before saving again. Writes go through
  `writeAtomic` (a temporary file, then a rename). Don't add a write path around either.
- **Only canvases inside the folder.** Every path from the page goes through `resolveInRoot` in `server/files.ts`:
  inside the root, not in a dot-folder or `node_modules`, and a `.excalidraw` file. The server creates and saves
  canvases; it never deletes or renames anything. Renames and deletes are the user's, in their shell or git.
- **The server only binds 127.0.0.1** and refuses non-localhost `Host` and `Origin` headers (`server/security.ts`).
  Don't add a way around that (no `--host`).
- **The default port is one constant**, `DEFAULT_PORT` in `server/port.ts`: 3729, "DRAW" on a phone keypad (not LOCA, 5622, which is Local Review's). The
  README says it too; change both together.
- **The browser keeps preferences, the files keep drawings.** Viewport, theme and sidebar state live in
  `localStorage` (`web/prefs.ts`), never in a `.excalidraw` file.
- **Excalidraw is pinned at 0.18.1**, the version the VS Code extension (`pomdtr.excalidraw-editor`) uses, so files
  round-trip between them. Moving to a newer Excalidraw means checking that the extension can still open what we save.
  React stays at 18: Excalidraw 0.18's bundled Radix packages declare React 18 or below.
- **No runtime dependencies.** The server is plain Node (`node:http`, `node:fs`). The page's libraries are bundled into
  `dist/web` at build time, so they're `devDependencies`.
- Personal, machine-specific rules go in a git-ignored `CLAUDE.local.md` next to this file.

## Layout

- `server/`: the CLI (`cli.ts`), the HTTP server and its events (`server.ts`), the file rules (`files.ts`),
  `security.ts` and `port.ts`. Run from source by `tsx` in tests; compiled to `dist/server` for the package.
- `web/`: the page. `App.tsx` (the open canvas, the projects, the server's events), `CanvasView.tsx` (Excalidraw on
  one file: load, autosave, merge), `CanvasesTab.tsx` (the sidebar tab), `merge.ts` (pure, tested in Node),
  `styles.css`. Bundled by `scripts/build-web.mjs` (esbuild) into `dist/web`, with Excalidraw's fonts.
- `brand/`: the mark, lockups, icons and social cards, all made from `mark.svg` by `generate.mjs` (which also
  writes `web/favicon.svg`). [brand/README.md](brand/README.md) has the rules.
- `demo/`: a neutral folder of canvases, and `tools/docs-media/`, which remakes it and records the README's GIF
  (`docs/media/hero.gif`) on it.
- `test/`: `node:test` suites.
- `e2e/`: Playwright browser tests, and the theme snapshots ([e2e/README.md](e2e/README.md)). They wait on
  `window.localidraw` (`TestHandle` in `web/CanvasView.tsx`), never on sleeps.

## Commands

```sh
npm install
npm start             # build, then run (npm start -- <folder> --port <n>)
npm test              # node:test via tsx
npm run typecheck
npm run build         # dist/web (esbuild) + dist/server (tsc)
npm run smoke:pack    # pack, install into a temp prefix, run it, check it serves and fits its size budget
npm run test:e2e      # the browser tests (npx playwright install chromium, once)
npm run docs:media:hero     # re-record docs/media/hero.gif (tools/docs-media/README.md)
npm run test:e2e:snapshots  # those plus the theme snapshots, in Docker; -- --update-snapshots remakes them
```

Run `npm test` and `npm run typecheck` before committing, and `npm run smoke:pack` when you change the build or
`package.json` (`files`, `bin`, dependencies). Run `npm run test:e2e` when you change the page, and
`npm run test:e2e:snapshots` when you change how it looks.
