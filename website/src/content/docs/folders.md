---
title: Folders and Scratch
description: One Localidraw for drawings all over your machine. List folders with localidraw add, draw in Scratch, and open one folder alone with localidraw <folder>.
---

One Localidraw serves every folder of drawings you have, plus **Scratch**, a folder of its own for when you just want
to draw. Run `localidraw` (or the [service](/service/)) once, and add folders to it as you go: no restart.

```sh
npx localidraw                        # Scratch, and the folders you've added
localidraw add ~/code/web-app         # its canvases show too, at once
localidraw add ~/notes --name notes   # with a name of your choice
localidraw folders                    # the list
localidraw remove web-app             # off the list; the files stay where they are
```

## The list

The folders are listed in `~/.localidraw/config.json`:

```json
{
  "folders": [
    { "path": "/home/you/code/web-app", "name": "web-app" },
    { "path": "/home/you/notes", "name": "notes" }
  ]
}
```

- **A folder's name** is the first part of its canvases' paths, in the sidebar and in the page's URL
  (`?canvas=web-app/docs/architecture.excalidraw`). It's the folder's own name unless you give `--name`; letters,
  digits, `-` and `_`, no two alike (a number is added if it's taken), and never `scratch`.
- **`localidraw add <folder>`** refuses a path that isn't a folder, one that's listed already, and one inside or
  holding a listed folder, so no canvas shows twice. It also refuses one inside `~/.localidraw`.
- **`localidraw remove <name or path>`** takes a folder off the list. Nothing in it is touched.
- **`localidraw folders`** prints Scratch, then each folder, marked `(missing)` if it isn't there now. `--json` prints
  one JSON document instead, as `add` and `remove` do.
- These edit the file, so no Localidraw has to be running. You can edit it by hand too; keep it valid JSON.

A Localidraw that's running follows the file: a folder added shows in the sidebar within a second or so, and one
removed goes. If the file stops being valid JSON, it keeps the folders it listed last, and says so on stderr and in the
page, until you fix it.

A folder that **isn't there** any more (an unmounted drive, a clone you deleted) stays in the list, greyed out as
missing, and nothing is ever written where it was. It comes back by itself when the folder does. Only `remove` drops
it.

## Scratch

Scratch is `~/.localidraw/drawings/`. It's listed first and is always there. A new canvas goes in the open canvas's
folder, or in Scratch when there's none. The folder is made with its first canvas, so starting Localidraw writes
nothing.

Scratch is the one place under `~/.localidraw` that holds drawings: **back it up** like any folder of your own work.
The rest of `~/.localidraw` (`runtime.json`, the service's log) can go.

## One folder alone

`localidraw <folder>` serves that folder and nothing else, as Localidraw always has: no list, no Scratch, and canvas
paths are relative to the folder (`?canvas=docs/architecture.excalidraw`). The Docker image runs this way, on
`/canvases`, so a [hosted copy](/self-hosting/) serves exactly its folder.

If you run `localidraw` in a folder that has canvases but isn't listed, it says so on stderr: `localidraw add .` keeps
it, and `localidraw .` opens just it.

A folder named like a command (`add`, `serve`, `service`, …) is given as `./add`.

## Each folder keeps its own rules

Every folder works as it does on its own: Localidraw reads and writes only `.excalidraw` files inside it (never in
`node_modules` or a dot-folder), a delete moves a canvas into that folder's own `.localidraw/trash/`, and its changes on
disk are watched. A canvas can be renamed or moved within its folder, but not into another folder yet: a move is a
hard link, which can't cross from one drive to another.

Each listed folder costs file watches (one per folder inside it, on Linux). `localidraw doctor` counts them against
the system's limit.

## The Library

Serving the list, the [Library](/library/) is kept in `~/.localidraw/library.excalidrawlib`, made the first time you
change the Library (starting with whatever this browser's Library had). A folder's own `library.excalidrawlib` still
wins while one of its canvases is open. `localidraw <folder>` keeps the one-folder rule: the folder's file if it has
one, and otherwise the browser's.
