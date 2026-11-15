---
"localidraw": minor
---

**The service serves Scratch and your folders.** `localidraw service install` takes no folder now: the service runs
`serve` with none, so it serves Scratch and the list, and `localidraw add <folder>` is all a new folder takes, with no
restart. A folder given to `install` is a usage error pointing at `localidraw add`. `service status` says how many
folders are listed (`folders` and `scratch` in `--json`, in place of `folder`). A service installed by 0.8 names one
folder: `status` warns, and `restart` (or `update`) writes it again without it; add that folder with `localidraw add`
to keep it. **`--open` (`-o`)** on `serve`, `service install` and `service start` opens the page once it answers.
`localidraw` with no folder, on a port a Localidraw serving the list holds already (the service, say), prints
`Localidraw is already running: <url>`, opens it with `--open`, and exits 0 instead of 1. **`doctor`** checks that
`~/.localidraw/config.json` parses and that every listed folder is there, and counts the file watches across Scratch
and every listed folder; it no longer looks at the current folder.
