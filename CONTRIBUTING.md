# Contributing to Localidraw

Thanks for working on Localidraw. This is the short guide for people: how to get it running, what CI checks and the
few rules that aren't up for negotiation. Coding agents working on this repo should read [AGENTS.md](AGENTS.md), the
agent-facing version of the same conventions (it's what `CLAUDE.md` loads).

## Setup

You need Node.js 22 or later (`.nvmrc` says 22) and git, on macOS or Linux. Windows isn't supported yet: CI runs it,
but doesn't require it to pass.

```sh
git clone https://github.com/edspencer/localidraw.git
cd localidraw
npm ci
npm start                       # build, then run on this checkout's folder
npm start -- ~/some/folder --port 5050
```

**Keep your real drawings out of it while you develop.** Localidraw saves as you draw, so point a development copy at
a scratch folder (`npm start -- "$(mktemp -d)"`) or at a copy of some canvases, not at work you care about.

If your shell exports `NODE_ENV=production`, `npm ci` skips the dev dependencies (TypeScript, esbuild, tsx,
Excalidraw itself): unset it (`env -u NODE_ENV npm ci`).

**Dependencies:** `package-lock.json` is written by npm 11. If you add or upgrade a dependency on Node 22 (which
ships npm 10), use npm 11 for it, e.g. `npx npm@11 install -D some-package`: npm 10 drops fields npm 11 writes, which
churns the lockfile.

## Checks

CI runs all of these on Node 22 and 24, on Linux and macOS. Run them before you open a PR:

```sh
npm run typecheck
npm test              # node:test, from source via tsx
npm run build         # dist/web (esbuild) + dist/server (tsc)
npm run smoke:pack    # npm pack, install the tarball into a temp prefix, run it as a user would
```

`smoke:pack` matters whenever you touch the build or `package.json` (`files`, `bin`, dependencies).

## The rules

These are what make Localidraw safe to point at a folder of drawings. A PR that weakens one won't be merged, however
useful the rest of it is. [AGENTS.md](AGENTS.md) has the details.

- **Opening never writes.** A canvas is saved only when an element or the background actually changed
  (`changedSince` in `web/merge.ts`), so browsing a folder leaves `git status` clean.
- **Nothing written on disk is lost.** A save carries the hash it was based on, and the server refuses it (409) if
  the file moved on; the page merges and saves again. Writes are atomic. Don't add a write path around either.
- **Only canvases inside the folder.** Every path from the page goes through `resolveInRoot` in `server/files.ts`.
  The server creates and saves canvases; it never deletes or renames anything.
- **Localhost only.** The server binds 127.0.0.1 and refuses non-localhost `Host` and `Origin` headers
  (`server/security.ts`).
- **It must look like Excalidraw.** What Localidraw adds to the UI uses Excalidraw's chrome, never its hand-drawn
  style ([docs/AESTHETIC.md](docs/AESTHETIC.md)).
- **Files stay compatible.** Excalidraw is pinned at 0.18.1, the version the VS Code extension uses. Don't upgrade it
  without checking that the extension still opens what we save.
- **No runtime dependencies.** The server is plain Node; the page's libraries are bundled at build time.

## Pull requests

- Branch off `main` and open the PR against it. Keep it focused; a stack of small PRs beats one big one.
- Say what changed and how you checked it. CI has to be green.
- **UI changes need screenshots,** in light and dark: before and after, plus a nearby view that *shouldn't* have
  changed, so a reviewer can tell a fix from something that just disappeared. A GIF if there's motion or a sequence
  of states. Draw them from a neutral demo folder: screenshots show file and folder names.
- **User-facing changes need a changeset** (below). There's no CI check for it; the PR template asks.

## Changesets

Versions and the changelog come from [changesets](https://github.com/changesets/changesets). If your PR changes
something a user of the npm package would notice (a feature, a fix, a changed default, a new CLI flag, a UI change),
add a changeset in the same PR:

```sh
npm run changeset     # pick patch / minor / major, write the summary for the changelog
git add .changeset && git commit -m "Add changeset"
```

That writes a small markdown file in `.changeset/`; you can also write or edit it by hand. Write the summary for
users, not reviewers: what they'll see, and what they need to do if something breaks (say so first, and how to keep
the old behaviour). Before 1.0, a breaking change is a minor bump. Changes nobody using the package would notice
(tests, CI, refactors, contributor docs) don't need one. `npx changeset status --verbose` shows what the next
release would be.

You don't bump `version` or edit `CHANGELOG.md` yourself: the release workflow does both. How changesets become a
release on npm: [RELEASING.md](RELEASING.md).

## Security

Please don't open a public issue for a vulnerability; see [SECURITY.md](SECURITY.md).
