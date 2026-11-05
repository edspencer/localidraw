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
  `writeAtomic` (a temporary file, then a rename). Don't add a write path around either. A save never puts back a
  canvas that's gone (410): the page follows a move, or says it was deleted and writes it again only when asked
  (`x-base-hash: none`, which is refused if a file is there by then).
- **Only canvases inside the folder.** Every path from the page goes through `resolveInRoot` in `server/files.ts`:
  inside the root, not in a dot-folder or `node_modules`, and a `.excalidraw` file. The server creates, saves, renames
  and moves canvases (and saves `<root>/library.excalidrawlib`, a fixed path, when it exists). A rename or move never
  replaces a file (`renameNoReplace`: a hard link, then removing the old name). **It never unlinks a canvas:** delete
  is a move into `<root>/.localidraw/trash/<timestamp>-<name>` (`moveToTrash`), which the sidebar can undo, and a
  canvas comes back out of the trash only through `resolveInTrash`. Before a canvas is renamed or deleted, the page
  saves it (`release` in `web/CanvasView.tsx`), so nothing lands at the old path afterwards.
- **Localhost by default; hosting is opt-in, and never without allowed hosts.** The server binds 127.0.0.1 unless
  `--host` says otherwise, and `startServer` and the CLI both refuse a non-loopback `--host` without at least one
  `--allowed-host`. Every request goes through `guard` in `server/security.ts`: the `Host` must be loopback or an
  allowed host, an `Origin` must be `http(s)://` plus that same host, the API refuses cross-site and same-site
  `Sec-Fetch-Site`, and writes must be `application/json` (415 otherwise). Localidraw has no login: authentication is
  the reverse proxy's job, and the docs and the startup output say so. Don't add a route around `guard`, a wildcard
  allowed host, or CORS headers.
- **The CLI follows the [CLI contract](https://github.com/edspencer/cli-contract)** (SPEC 0.1) that Ed's local tools
  share. `localidraw [serve] [folder]`: command names win over a folder's, which is given as `./service`, and
  `service`, `update` (`upgrade`), `busy` and `doctor` are reserved until they land (they exit 2). Exit codes are the
  contract's (`server/contract/exit-codes.ts`): 1 for a failure such as a port in use, 2 for a usage error with the
  usage after the message. Set `process.exitCode` rather than calling `process.exit()`. `serve`'s first stdout line is
  `Localidraw <version>: <url>`, and nothing goes to stdout before it; warnings go to stderr. SIGTERM and Ctrl-C stop
  it through `drain` in `server/server.ts`, which lets the requests under way (a save mid-`writeAtomic`) finish first,
  so write before you answer: `drain` waits for each request's answer, not for work done after it. `server/contract/`
  holds copies of the contract's `reference/` files, each with its header; fix them in `edspencer/cli-contract` first,
  then copy them back.
  `cli-contract.json` lists the conformance checks (`npx cli-conformance`, in CI), and why any are skipped.
- **The service serves one folder, and is the contract's.** `localidraw service` (`server/service.ts`) runs the
  service managers copied from edspencer/cli-contract (`server/contract/service/`, each file headed with where it's
  from: change them there, then copy them back). There's one service per machine (`net.edspencer.localidraw` /
  `localidraw.service`), and its unit records everything it runs with as flags: `serve <folder>`, the port, the host,
  the allowed hosts, `--poll`. Never the environment, so `install --refresh` re-renders a unit from the unit. The
  hosting rule holds there too: `install` refuses a `--host` beyond loopback without `--allowed-host`. Its home is
  `~/.localidraw` (`localidrawHome` in `server/options.ts`): `runtime.json`, which `serve` writes 0600 once listening
  and removes on a clean stop, `logs/service.log` and `service/`. **Never drawings**: `install` refuses a folder
  inside it. `stop` and `restart` have no busy check until `/api/busy` exists (E3, marked `TODO(E3)`), and `stop`
  never disables. The real managers are proven only in CI (`scripts/service-real.mjs`); `test/service.test.ts` drives
  the commands against fake ones, whose `launchctl print` must fail when nothing is loaded.
- **The default port is one constant**, `DEFAULT_PORT` in `server/port.ts`: 3729, "DRAW" on a phone keypad (not LOCA, 5622, which is Local Review's). The
  README and the docs site (`website/src/site.mjs`) say it too; change them together (`test/docs.test.ts` checks).
- **The browser keeps preferences, the files keep drawings.** Viewport, theme and sidebar state live in
  `localStorage` (`web/prefs.ts`), never in a `.excalidraw` file. Excalidraw's Library lives in `localStorage` too,
  unless the root has a `library.excalidrawlib` (`web/library.ts`): then it's that file, saved like a canvas (base
  hash, 409, merge by item, `writeAtomic`) and only when the Library changed. The server never creates that file.
- **Excalidraw is pinned at 0.18.1**, the version the VS Code extension (`pomdtr.excalidraw-editor`) uses, so files
  round-trip between them. Moving to a newer Excalidraw means going through [Upgrading Excalidraw](#upgrading-excalidraw)
  below. React stays at 18: Excalidraw 0.18's bundled Radix packages declare React 18 or below.
- **No runtime dependencies.** The server is plain Node (`node:http`, `node:fs`). The page's libraries are bundled into
  `dist/web` at build time, so they're `devDependencies`.
- Personal, machine-specific rules go in a git-ignored `CLAUDE.local.md` next to this file.

## Upgrading Excalidraw

Dependabot leaves `@excalidraw/excalidraw` alone (`.github/dependabot.yml`): moving off 0.18.1 is a deliberate PR, and
its body says how each of these went.

1. **The VS Code extension.** Find which Excalidraw `pomdtr.excalidraw-editor`'s current release bundles. Then save a
   canvas from the new Localidraw with text, arrows bound to shapes, a frame, an embedded image and a Library item, and
   open it in the extension: it must open, look the same, and save back without Localidraw then seeing a change it
   didn't make. Do the same the other way round, from a file the extension saved. If the extension is still on 0.18,
   don't upgrade: a file it can't open is worse than an older editor.
2. **React.** Excalidraw bundles its own `@radix-ui` packages (`node_modules/@excalidraw/excalidraw/node_modules/@radix-ui`);
   at 0.18.1, `react-tabs` there declares `react` `^16.8 || ^17.0 || ^18.0`. Move React to 19 only once every one of
   them accepts it (`npm ls react` and those `peerDependencies`), and Excalidraw's own `peerDependencies` too. Bump
   `react`, `react-dom` and their `@types` together, and the dependabot hold on React majors with them.
3. **The merge.** `web/merge.ts` relies on each element's `version` going up on every edit, on `versionNonce` telling
   two edits at one version apart, on `isDeleted` tombstones, and on `index` (fractional, as strings) for z-order.
   Check the release notes for any change to those, and to `restoreElements` (`repairBindings`, `refreshDimensions`),
   `serializeAsJSON`, `updateScene`'s `captureUpdate` and `CaptureUpdateAction`, all used in `web/CanvasView.tsx`.
   `npm test` (`test/merge.test.ts`) and `npm run test:e2e` must pass unchanged; a test that needs editing is a
   behaviour change to explain.
4. **Opening never writes.** Open every canvas in `demo/` and `e2e/folders/`, and pan and zoom: `git status`
   stays clean. A newer Excalidraw that normalises something new on load (a version bump in `restore`) would rewrite
   every file opened.
5. **The look.** `npm run test:e2e:snapshots` in both themes. Excalidraw's chrome changing is expected, so remake the
   baselines with `-- --update-snapshots`, and look at every diff before committing it (e2e/README.md). Check that
   `docs/AESTHETIC.md` still describes what Excalidraw looks like, and re-record the hero GIF if the editor looks
   different (`npm run docs:media:hero`).
6. **Fonts and size.** `scripts/build-web.mjs` copies `dist/prod/fonts` whole: check the set still loads offline (no
   requests leave the page, with the network off) and that text measures the same (an agent's narrow label still
   shows in full). `npm run smoke:pack` holds the package to its size budget; if a new font set or chunk needs more,
   raise the budget in that PR and say why.
7. **The Library.** A `library.excalidrawlib` from 0.18 still loads, and a save (`serializeLibraryAsJSON`) still
   writes `version: 2` and `libraryItems`, which older Excalidraws read.
8. **The docs.** This file's pin bullet, the README, the docs site's FAQ, and a changeset (a minor, at least: files
   saved after it may need a newer extension).

## Layout

- `server/`: the CLI (`cli.ts`, with the CLI contract's shared code copied into `contract/`), `service`
  (`service.ts`), the hosting options and the home both read (`options.ts`), the HTTP server, its events and `--poll` (`server.ts`), sending the page's files
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
change the `Dockerfile`, the CLI's options or the build. `scripts/service-real.mjs` installs a real service, so it runs
only in CI (`CI=true LOCALIDRAW_REAL_SERVICE=1`), never on your machine.
