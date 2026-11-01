# Browser tests

Playwright, in Chromium, against the real server and real files.

- `editor.spec.ts` covers the editor: opening never writes, autosave, edits made on disk, merging, shortcuts, and
  the first view.
- `snapshots.spec.ts` covers the theme snapshots: what Localidraw adds to Excalidraw's UI, in light and dark.

Each test starts its own server on port 0, over a temporary copy of a folder in `folders/` (`fixtures.ts`), so the
tests run in parallel and never touch each other's files.

```sh
npx playwright install chromium   # once
npm run test:e2e                  # builds the page, then runs the editor tests
npm run test:e2e -- --ui          # anything after -- goes to `playwright test`
```

## Waiting on real state

The tests never sleep. The page exposes a small handle for them, `window.localidraw`, defined as `TestHandle` in
`web/CanvasView.tsx`. It has:

- the open canvas's path and Excalidraw API;
- `saves()`, the autosave's state (`idle`, `due` or `saving`) and counts of its checks and writes;
- Excalidraw's `convertToExcalidrawElements`. It can't run in Node, so a test uses it to write the skeletons a
  coding agent would.

The page itself never reads the handle. Keep it that small.

## Theme snapshots

The screenshots in `snapshots/` are only made and compared on Linux, inside the official Playwright image
`mcr.microsoft.com/playwright:v<version>-noble`. Fonts and anti-aliasing differ between machines, so a baseline made
on a Mac would fail in CI. CI's "Browser tests" job runs in that image with `LOCALIDRAW_SNAPSHOTS=1`. Elsewhere the
snapshot tests are left out.

The canvas is hidden while each screenshot is taken (`snapshots.css`): the drawing isn't under test, only the chrome
over it.

To run them, or to update them after a deliberate UI change, use Docker:

```sh
npm run test:e2e:snapshots                          # compare, as CI does
npm run test:e2e:snapshots -- --update-snapshots    # remake the baselines in e2e/snapshots/
npm run test:e2e:snapshots -- -g "dark theme"       # just some of them
```

The script (`scripts/e2e-docker.mjs`) sends the checkout's files into the container, then runs `npm ci`, the build
and the tests there. It copies `e2e/snapshots/` and `test-results/` back (the diffs are in `test-results/`). Your
`node_modules` is never touched, and the script works with a remote Docker daemon too.

Look at every changed PNG before committing it, in both themes, and put the before and after in the PR.

`@playwright/test` is pinned to an exact version, and the image tag in `.github/workflows/ci.yml` has to match it
(`test/docs.test.ts` checks). When you bump one, bump the other, then remake the baselines.
