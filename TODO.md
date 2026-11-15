# To do

What Localidraw doesn't do yet, and what's been decided but not built, as of 0.4. Roughly in priority order within
each section. Delete items as they land; keep the design notes until then.

## For Ed

- [ ] **Review `AI-DECLARATION.md`.** It's a draft written by Claude in Ed's voice, modelled on Local Review's. Make it
  true and yours.
- [ ] **Deprecate the npm placeholder** `localidraw@0.0.1` (RELEASING.md has the command; it needs a logged-in
  maintainer).

## Folders: one Localidraw for drawings all over the machine

Decided with Ed on 2026-11-15, and **built in 0.9.0**: the server and the CLI (the config, `add`, `remove`, `folders`,
serving the list plus Scratch), the page (the grouped sidebar, the card, the Library that follows the open canvas),
and the service, `--open`, already-running and `doctor`. Kept as the design record; the docs site's
[Folders and Scratch](website/src/content/docs/folders.md) and [Running as a service](website/src/content/docs/service.md)
pages describe what was built. Nobody used Localidraw yet, so it broke what it liked: no migration.

- **The list is `~/.localidraw/config.json`**: `{ "folders": [{ "path": "/abs/path", "name": "notes" }] }`. The
  name defaults to the folder's basename and is unique, URL-safe and never `scratch`; it's the first part of a
  canvas's path in the URL and the API (`notes/diagrams/flow.excalidraw`). Written with `writeAtomic`, and editable by
  hand.
- **Managed from the CLI**: `localidraw add <path> [--name <n>]`, `localidraw remove <name|path>`,
  `localidraw folders [--json]`. They edit the file, so no server needs to be running. `add` refuses a path that isn't
  a folder, one inside `~/.localidraw`, one already listed, and one inside or containing a listed folder (so no canvas
  shows twice). Command names win over folders' as now (`./add`).
- **Adding a folder never needs a restart.** The server watches `config.json` (and polls it under `--poll`). A change
  starts or stops that folder's watcher and sends the pages a `projects` event. A config that doesn't parse keeps the
  last good list, with a warning on stderr and in the page.
- **A folder that's gone** (an unmounted drive, a deleted clone) stays in the list, greyed out as missing, and comes
  back when it's there again. Only `remove` drops it.
- **Scratch is `~/.localidraw/drawings/`**, listed first, always there. It's where a new canvas goes when no other
  folder is chosen (otherwise: the open canvas's folder). Created when the first canvas is, so starting still writes
  nothing. This is the one exception to "never drawings in `~/.localidraw`"; the docs say to back it up.
- **What serves what**:
  - `localidraw`, `localidraw serve` and the service serve the list plus Scratch. If the current directory has canvases
    and isn't listed, `serve` says on stderr: `localidraw add .` to keep it, `localidraw .` to open just it.
  - `localidraw <folder>` serves that folder alone, as now: no list, no Scratch. So does the image (`/data`), so a
    hosted copy is unchanged.
  - `service install` takes no folder (a folder is a usage error pointing at `localidraw add`), and its unit runs
    `serve` with no folder. `service status` shows how many folders are listed instead of the folder.
- **`--open` (`-o`)** on `serve`, `service install` and `service start` opens the page in the browser once it answers.
  If `serve` (the list) finds the port taken by a Localidraw serving the list (`runtime.json`), it prints that one's
  URL, opens it with `--open`, and exits 0 instead of 1.
- **Each folder keeps its own rules**: `resolveInRoot`, the trash (`<folder>/.localidraw/trash`) and the watcher are per
  folder. A move between folders is refused for now: `renameNoReplace` is a hard link, which can't cross filesystems.
- **The Library**: when serving the list, the Library is `~/.localidraw/library.excalidrawlib`, which the server creates
  on the first Library change (seeded from the page's `localStorage` Library, if it had one). A folder's own
  `library.excalidrawlib` still wins while one of its canvases is open. `localidraw <folder>` keeps today's rule.
- **The page**: the sidebar groups canvases by folder, Scratch first. With no folders listed, a dismissable card says
  Localidraw can also edit drawings in your projects, with `localidraw add ~/path/to/project` and a copy button
  (selecting the text where the clipboard isn't available), and the sidebar keeps a small "Add a folder" hint. Adding
  a folder from the page is deliberately not offered: a page that can point the server at any path is too much reach,
  above all on a hosted copy.
- **`doctor`** checks the config parses and every listed folder is there, and counts the folders' directories against
  the inotify limit.

