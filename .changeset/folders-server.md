---
"localidraw": minor
---

**One Localidraw for drawings all over your machine.** `localidraw` with no folder now serves Scratch
(`~/.localidraw/drawings`, made with its first canvas) and the folders listed in `~/.localidraw/config.json`, and
follows that file as it changes: no restart. `localidraw add <folder> [--name <n>]`, `localidraw remove <name|folder>`
and `localidraw folders [--json]` edit the list. A folder that's gone stays listed as missing and comes back when it's
there; a config that doesn't parse keeps the last good list. Canvas paths in the page and the API start with the
folder's name (`notes/flow.excalidraw`); each folder keeps its own trash and watcher, and a move between folders is
refused. `localidraw <folder>` serves that folder alone, as before. **Breaking:** `localidraw` with no folder no longer
serves the current folder; run `localidraw .` for that.
