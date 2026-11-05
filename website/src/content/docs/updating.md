---
title: Updating
description: Update Localidraw with localidraw update, check whether it's busy with localidraw busy, and find what's wrong with localidraw doctor.
---

```sh
localidraw update
```

That asks npm for the latest version, says what it'll do, and asks before it does it. With the
[service](/service/) installed, it stops the service, installs the new version, starts it again, and waits until the
new version answers. If the new version doesn't start, it puts the old one back.

Localidraw only asks npm about new versions when you run `update`, `update --check` or `doctor`. It never checks by
itself, in the background or when it starts.

## The options

| Option | What it does |
| --- | --- |
| `--check` | Says whether there's a newer version, and changes nothing. |
| `--to <version\|tag>` | Updates to a version (`0.6.0`) or a dist-tag (`next`) instead of the latest. It's the only way to go back to an older version. |
| `--yes` | Doesn't ask first. Without a terminal (a script, cron), `update` needs it, or it exits `2`. |
| `--force` | Doesn't wait for a save under way. The health check and the rollback still run. |
| `--json` | Prints one JSON document on stdout, and everything else on stderr. |

`localidraw update --check --json` is the one for scripts: it exits `0` either way, and `updateAvailable` says
whether there's a newer version. `localidraw service status` repeats what the last check found, without asking npm
again.

## What it does

1. **Checks how Localidraw was installed.** It updates a global npm, pnpm, bun or Volta install. For anything else,
   it prints the command to run instead, and exits `5`:

   | Installed with | It says to run |
   | --- | --- |
   | Docker | `docker compose pull && docker compose up -d` (see [Self-hosting](/self-hosting/#upgrading)) |
   | `npx localidraw` | nothing: `npx localidraw@latest` already runs the latest |
   | A git checkout | `git pull && npm install && npm run build` |
   | A global folder you can't write to | the same `npm install -g` with `sudo` (it never runs `sudo` itself) |
   | A dependency of another project | update it in that project |

2. **Asks npm** for the target version, and checks that it runs on your Node.
3. **Waits for saves.** If a canvas or the Library is being saved right now, it exits `75` and changes nothing. Saves
   take a moment, so run it again, or give `--force`.
4. **Asks you** (`Update Localidraw 0.6.0 → 0.7.0? The service will restart.`), unless you gave `--yes`.
5. **Downloads both versions** into npm's cache first, while the old one is still running, so a network failure
   changes nothing.
6. **Stops the service**, installs the new version, and starts it again through the new version's own
   `service install --refresh`, keeping the folder, port and hosts the service had.
7. **Waits until the new version answers.** If it doesn't, it prints the end of the log, reinstalls the old version,
   starts that, and exits `6`. In the rare case that the old one doesn't come back either, it exits `7` and prints what
   to run.

**Without the service.** If Localidraw is running in a terminal, `update` asks you to stop it first (exit `3` if it's
still running). If nothing is running, it installs the new version and you start it as usual.

An open page doesn't hold an update up. While Localidraw is stopped, the page says it isn't running, keeps
anything you draw, and saves it once the new version is up.

## Is it busy?

```sh
localidraw busy
```

`busy` asks the Localidraw running here whether it's in the middle of a save. It exits `0` when it isn't, `75` when a
canvas or the Library is being written, and `3` when no Localidraw is running. It finds the running one through
`~/.localidraw/runtime.json`. With `--json` it prints the counts:

```json
{ "running": true, "busy": true, "url": "http://localhost:3729", "version": "0.7.0", "counts": { "canvas": 1, "library": 0 } }
```

`update`, `service stop` and `service restart` run the same check first, and refuse with exit `75` unless you give
`--force`. A script or a tool such as [Watchtower](/self-hosting/#upgrading) can run `localidraw busy` before it
restarts Localidraw. The answer is only ever counts. The server answers it at `GET /api/busy`, through the same
host checks as everything else.

A save takes a fraction of a second, and stopping Localidraw already lets the saves under way finish
([Stopping it](/getting-started/#stopping-it)). So `busy` is about not cutting a save off, not about waiting for you
to finish drawing.

## When something is wrong: doctor

```sh
localidraw doctor
```

`doctor` runs every check it knows, and prints `✓`, `!` or `✗` for each, with a `fix:` line under anything that's
wrong. It exits `1` if a check failed; warnings don't change that.

- **Node** is the version Localidraw needs (22 or later).
- **How it was installed**, and whether `update` can update it.
- **The service**, if it's installed: whether the Node, Localidraw and folder it names are still there.
- **The version running** is the one installed.
- **The port** is free, or held by Localidraw.
- **Linger** is on (Linux), so the service keeps running when you log out.
- **`~/.localidraw`** can be written.
- **The page is built.**
- **The folder** it serves can be read: the service's folder, or the current folder.
- **The limit on file watches** (Linux) covers that folder. Localidraw watches each folder in it, and
  `fs.inotify.max_user_watches` limits how many one user can watch. If the folder has more folders than that,
  changes in some of them won't show until you reload. Raise the limit, or use `--poll`.
- **A newer version** is available. `--offline` skips this one, which is the only check that asks the network.

`--json` prints the checks as one document, each with an `id`, a `status` (`pass`, `warn`, `fail` or `skip`), a
`message`, and a `fix` for each failure.

## Exit codes

| Code | `update` | `busy` |
| --- | --- | --- |
| `0` | Updated, or already up to date. `--check` exits `0` either way. | Not busy. |
| `1` | It failed: npm couldn't be reached, the version doesn't exist, or another update is running. | An answer that wasn't Localidraw's. |
| `2` | A usage error, or no terminal and no `--yes`. | A usage error. |
| `3` | Localidraw is running in a terminal: stop it first. | Nothing is running. |
| `5` | This install can't update itself. The command to run was printed. | |
| `6` | The new version didn't start. The old one is running again. | |
| `7` | The new version didn't start, and neither did the old one. What to run was printed. | |
| `75` | A save is under way. Nothing was changed. | A save is under way. |

These follow the [CLI contract](https://github.com/edspencer/cli-contract) that Ed's local tools share.

## Where things go

`update` keeps two files in `~/.localidraw`, beside the service's log and `runtime.json`:

- `update.lock`, while an update runs, so two can't run at once. If an update was killed, the next one removes the
  stale lock by itself.
- `update-check.json`, what the last `update`, `update --check` or `doctor` found, which `service status` repeats.

Neither holds a drawing, and nothing in your folder of canvases changes. A new version reads the same `.excalidraw`
files as the old one.
