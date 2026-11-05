---
"localidraw": minor
---

`localidraw update`, `localidraw busy` and `localidraw doctor`, from the [CLI contract](https://github.com/edspencer/cli-contract) that Ed's local tools share.

- **`localidraw update [--check] [--to <version|tag>] [--yes] [--force] [--json]`** updates a global npm, pnpm, bun or Volta install to the latest version. With the service installed, it stops it, installs the new version, starts it through the new version's `service install --refresh`, and waits for it to answer; if it doesn't, it puts the old version back and exits 6 (7 if that fails too). `--check` only looks, and `service status` (and its `--json`, as `update`) repeats what it found. Docker, npx, a checkout and a global folder you can't write to get the command to run instead, and exit 5. Without a terminal it needs `--yes` (exit 2). `upgrade` works too. Localidraw asks the npm registry only when you run `update` or `doctor`, never by itself.
- **`localidraw busy [--json]`** exits 0, 75 while a canvas or the Library is being saved, or 3 when nothing is running. The server answers `GET /api/busy` with counts only (`{ busy, version, counts: { canvas, library } }`), through the same host checks as everything else. An open page isn't counted: it saves what's due once the server is back, which a new browser test proves by restarting the server mid-save.
- **`service stop` and `service restart` can now exit 75**: they refuse, changing nothing, while a save is being written, unless `--force` (which says `Overriding: …` and goes ahead). A script that stops the service should retry on 75.
- **`localidraw doctor [--json] [--offline]`** checks Node, how it was installed, the service, the version running, the port, linger, `~/.localidraw`, that the page is built, that the folder is readable, and on Linux the limit on file watches, with a fix for each failure. It exits 1 if a check failed.
- **The image** sets `LOCALIDRAW_IN_DOCKER=1` and puts `localidraw` on `PATH`, so `docker exec <container> localidraw busy` works, and Watchtower can wait for a quiet moment with the pre-update hook `localidraw busy`. The self-hosting page's new "Upgrading" section has the details.
- `update`, `busy` and `doctor` were reserved names that exited 2; they're commands now.
