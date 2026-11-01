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
- **Localhost by default; hosting is opt-in, and never without allowed hosts.** The server binds 127.0.0.1 unless
  `--host` says otherwise, and `startServer` and the CLI both refuse a non-loopback `--host` without at least one
  `--allowed-host`. Every request goes through `guard` in `server/security.ts`: the `Host` must be loopback or an
  allowed host, an `Origin` must be `http(s)://` plus that same host, the API refuses cross-site and same-site
  `Sec-Fetch-Site`, and writes must be `application/json` (415 otherwise). Localidraw has no login: authentication is
  the reverse proxy's job, and the docs and the startup output say so. Don't add a route around `guard`, a wildcard
  allowed host, or CORS headers.
- **The default port is one constant**, `DEFAULT_PORT` in `server/port.ts`: 3729, "DRAW" on a phone keypad (not LOCA, 5622, which is Local Review's). The
  README and the docs site (`website/src/site.mjs`) say it too; change them together (`test/docs.test.ts` checks).
- **The browser keeps preferences, the files keep drawings.** Viewport, theme and sidebar state live in
  `localStorage` (`web/prefs.ts`), never in a `.excalidraw` file.
- **Excalidraw is pinned at 0.18.1**, the version the VS Code extension (`pomdtr.excalidraw-editor`) uses, so files
  round-trip between them. Moving to a newer Excalidraw means checking that the extension can still open what we save.
  React stays at 18: Excalidraw 0.18's bundled Radix packages declare React 18 or below.
- **No runtime dependencies.** The server is plain Node (`node:http`, `node:fs`). The page's libraries are bundled into
  `dist/web` at build time, so they're `devDependencies`.
- Personal, machine-specific rules go in a git-ignored `CLAUDE.local.md` next to this file.

## Layout

- `server/`: the CLI (`cli.ts`), the HTTP server, its events and `--poll` (`server.ts`), sending the page's files
  with caching and compression (`static.ts`), the file rules (`files.ts`), `security.ts`, `port.ts` and
  `package.ts` (the version, and where the built page is). Run from source by `tsx` in tests; compiled to
  `dist/server` for the package.
- `web/`: the page. `App.tsx` (the open canvas, the projects, the server's events), `CanvasView.tsx` (the one
  Excalidraw, swapping canvases in and out of it: load, autosave, merge), `CanvasesTab.tsx` (the sidebar tab), `merge.ts` (pure, tested in Node),
  `styles.css`. Bundled by `scripts/build-web.mjs` (esbuild) into `dist/web`, with Excalidraw's fonts.
- `brand/`: the mark, lockups, icons and social cards, all made from `mark.svg` by `generate.mjs` (which also
  writes `web/favicon.svg`). [brand/README.md](brand/README.md) has the rules.
- `demo/`: a neutral folder of canvases, and `tools/docs-media/`, which remakes it and records the README's GIF
  (`docs/media/hero.gif`) on it.
- `website/`: the docs site (Astro + Starlight), a separate private package that Cloudflare Pages builds
  ([website/README.md](website/README.md)). It's the reference documentation: when behaviour, the options or the
  file rules change, change its pages too. Its sidebar is hand-maintained, and `src/site.mjs` copies `DEFAULT_PORT`.
- `Dockerfile`, `compose.yaml` and `scripts/smoke-image.sh`: the image (`ghcr.io/edspencer/localidraw`, built and
  pushed by `release.yml`) and its check, which CI runs on every PR. The image listens on `0.0.0.0`, so it relies on
  the allowed-hosts refusal: keep `LOCALIDRAW_HOST` there, and the refusal in the CLI.
- `test/`: `node:test` suites.
- `e2e/`: Playwright browser tests, and the theme snapshots ([e2e/README.md](e2e/README.md)). They wait on
  `window.localidraw` (`TestHandle` in `web/CanvasView.tsx`), never on sleeps.

## Commands

```sh
npm install
npm start             # build, then run (npm start -- <folder> --port <n>)
npm run dev           # the same, rebuilding the page and restarting the server as you edit (CONTRIBUTING.md)
npm test              # node:test via tsx
npm run typecheck
npm run build         # dist/web (esbuild) + dist/server (tsc)
npm run smoke:pack    # pack, install into a temp prefix, run it, check it serves and fits its size budget
npm run test:e2e      # the browser tests (npx playwright install chromium, once)
(cd website && npm install && npm run build && npm run check-links)  # the docs site
npm run docs:media:hero     # re-record docs/media/hero.gif (tools/docs-media/README.md)
npm run test:e2e:snapshots  # those plus the theme snapshots, in Docker; -- --update-snapshots remakes them
docker build -t localidraw:smoke . && scripts/smoke-image.sh localidraw:smoke <version>  # the image
```

Run `npm test` and `npm run typecheck` before committing, and `npm run smoke:pack` when you change the build or
`package.json` (`files`, `bin`, dependencies). Run `npm run test:e2e` when you change the page, and
`npm run test:e2e:snapshots` when you change how it looks. Build the image and run `scripts/smoke-image.sh` when you
change the `Dockerfile`, the CLI's options or the build.
