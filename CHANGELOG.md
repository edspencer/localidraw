# localidraw

## 0.3.0

### Minor Changes

- [#21](https://github.com/edspencer/localidraw/pull/21) [`8237eb1`](https://github.com/edspencer/localidraw/commit/8237eb1cdab844731688240a179ac0c5ea848ec8) Thanks [@edspencer](https://github.com/edspencer)! - A Docker image, `ghcr.io/edspencer/localidraw`, for amd64 and arm64, with an SBOM and build provenance. It runs as
  the `node` user with the canvases at `/canvases` and a health check on `/api/health`, listens on `0.0.0.0` inside the
  container, and won't start without `LOCALIDRAW_ALLOWED_HOSTS`. The repository's `compose.yaml` publishes it on
  loopback, and has examples for a folder on a NAS and for a reverse proxy. The docs site's Self-hosting page covers
  Docker, Compose, reverse proxies (Caddy with forward auth, or basic auth) and the limits.

- [#19](https://github.com/edspencer/localidraw/pull/19) [`19b6f97`](https://github.com/edspencer/localidraw/commit/19b6f976ac40f8a2ea9d5a1d91766dccba7f01bb) Thanks [@edspencer](https://github.com/edspencer)! - Localidraw can be hosted, behind a reverse proxy that does the login. `--host <addr>` (or `LOCALIDRAW_HOST`) listens
  beyond 127.0.0.1, and `--allowed-host <name>` (repeatable, or `LOCALIDRAW_ALLOWED_HOSTS`, comma-separated) names the
  hosts it answers to; a `--host` that isn't loopback refuses to start without one. The `Host` must be loopback or an
  allowed host, and an `Origin` must be `http(s)://` and that same host. `--poll [ms]` (or `LOCALIDRAW_POLL`) finds
  changes by checking the files, for folders on NFS or SMB, where another machine's writes send no file events. At
  startup it prints what's in effect, and warns that Localidraw has no login of its own.
  
  Also: writes must be `application/json` (anything else is a 415); `/api/health` returns `{ ok, version }`; the page's
  script and stylesheet have a hash in their names, and every hashed file is cached for good while the page itself is
  revalidated; and responses are compressed with brotli or gzip when the browser accepts it.
  
  Fixed: behind a reverse proxy, a page stayed offline for good after the server restarted, because the proxy answered
  502 while it was down and the browser stopped reconnecting. It now keeps trying, and catches up when it's back.

## 0.2.1

### Patch Changes

- [#17](https://github.com/edspencer/localidraw/pull/17) [`d2804eb`](https://github.com/edspencer/localidraw/commit/d2804eb65e0a47beb08f938180d31cedf8271189) Thanks [@edspencer](https://github.com/edspencer)! - The package's homepage is now the docs site, https://localidraw.edspencer.net, with a guide to editing canvases from a coding agent.

- [#15](https://github.com/edspencer/localidraw/pull/15) [`a8765d3`](https://github.com/edspencer/localidraw/commit/a8765d39ef45a9ee77b3f185ad4ce8a7e7ff288f) Thanks [@edspencer](https://github.com/edspencer)! - A request for a path starting with `//` (such as `//?canvas=…`) no longer stops the server: it's a 404.

- [#13](https://github.com/edspencer/localidraw/pull/13) [`e4ece54`](https://github.com/edspencer/localidraw/commit/e4ece5463780abef3b50a9012f25bbe025161d98) Thanks [@edspencer](https://github.com/edspencer)! - A new icon: a folder with a diagram in it, on Excalidraw's violet, in place of the placeholder pencil.

## 0.2.0

### Minor Changes

- [#1](https://github.com/edspencer/localidraw/pull/1) [`c483f4a`](https://github.com/edspencer/localidraw/commit/c483f4a2fb01fda9efc1e2466b2fcc1a11c27067) Thanks [@edspencer](https://github.com/edspencer)! - The first release on npm, so `npx localidraw` now works. It's published from CI with npm provenance, so you can
  check which commit and workflow built it (`npm audit signatures`).

### Patch Changes

- [#10](https://github.com/edspencer/localidraw/pull/10) [`3997854`](https://github.com/edspencer/localidraw/commit/39978545ed7196aa0851bd4e7c57f1637a4cac5d) Thanks [@edspencer](https://github.com/edspencer)! - A canvas that won't open is no longer a dead end. A link to one that isn't there (a bookmark to a renamed file), or
  a file that isn't a scene, now shows why, with your canvases listed so you can open another or make one, in your
  theme. It opens by itself once the file is there and valid, so an agent can fix it while you watch. A `.excalidraw`
  file that's JSON but not a scene is no longer opened as a blank canvas that a drawing would save over, and an empty
  file (`touch plan.excalidraw`) opens as an empty canvas. The "Opening…" screen follows the dark theme too.

- [#11](https://github.com/edspencer/localidraw/pull/11) [`686a896`](https://github.com/edspencer/localidraw/commit/686a89606817c1c1649f6d8e8f84e8c037992e81) Thanks [@edspencer](https://github.com/edspencer)! - When Localidraw is started again after being stopped, an open page now catches up with what changed on disk while it
  was gone (a `git pull`, an agent's edit, a new canvas): the open canvas merges the changes in and the sidebar lists
  what's new. Before, it showed the old version until you drew something.

- [#12](https://github.com/edspencer/localidraw/pull/12) [`762df76`](https://github.com/edspencer/localidraw/commit/762df76238b60cb0f837d0337607a6de10427191) Thanks [@edspencer](https://github.com/edspencer)! - Putting an older version of an open canvas back on disk now sticks. A `git checkout`, `git stash` or branch switch
  writes elements with lower versions than the ones on screen, and the page used to keep its own copies and save them
  straight back over the file, undoing the checkout. Now an element you haven't changed since the last save takes the
  file's copy, whatever its version. One you have changed is a real conflict, and the higher version still wins.

- [#9](https://github.com/edspencer/localidraw/pull/9) [`88fff6a`](https://github.com/edspencer/localidraw/commit/88fff6acdaa6b313abe7bf5ca2c86a3ed6bdbe6f) Thanks [@edspencer](https://github.com/edspencer)! - The "No canvases yet" screen for an empty folder now follows the dark theme, like the rest of the page.

- [#7](https://github.com/edspencer/localidraw/pull/7) [`9b6ebfe`](https://github.com/edspencer/localidraw/commit/9b6ebfeb58edacf476a819513bad4fee367a2cdc) Thanks [@edspencer](https://github.com/edspencer)! - On Linux, changes made on disk to a canvas now keep showing up after you've saved it. Node's recursive file watch
  there stopped hearing a file once a new one was renamed over it, which is how Localidraw (and many editors and
  agents) save, so after your first save an agent's edits to that canvas no longer appeared until you reopened it.
  Localidraw now watches each folder instead, and skips dot-folders and `node_modules` rather than walking them.

## 0.1.0

The first version: a local Excalidraw for the `.excalidraw` files in a folder.

- Projects (folders) and canvases (files) in a Canvases tab in Excalidraw's own sidebar, with a filter and New canvas.
- Saves to the file as you draw; opening or moving around a canvas never writes it.
- Changes made on disk (a coding agent, a `git pull`) appear at once, merged per element with what you've drawn.
- Localhost only, port 3729 by default ("DRAW" on a phone keypad).
