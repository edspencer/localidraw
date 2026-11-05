---
title: Updating
description: Update Localidraw with localidraw update, check whether it's busy with localidraw busy, and find what's wrong with localidraw doctor.
---

```sh
localidraw update
```

`localidraw update` **asks the registry for the latest version, checks whether Localidraw is busy, asks you to
confirm, downloads the new version first (while the old one is still running), stops the service, installs, starts
the new version and waits until it answers.** If anything from the install on fails, it puts the old version back.

Run it from a terminal. Something Localidraw itself started couldn't update it: stopping the service would stop that
too.

## The options

| Option | What it does |
| --- | --- |
| `--check` | **Reports and changes nothing. It exits `0` whether or not there's an update; with `--json`, read `updateAvailable`.** |
| `--to <version\|tag>` | **A version (`0.6.0`) or a dist-tag (`next`). It's the only way to move to a lower version.** |
| `--yes` | **Skips the question. Without a terminal (a script, cron), `--yes` is required, or `update` exits `2`.** |
| `--force` | **Skips the busy check, and nothing else: the health check and the rollback still run.** |
| `--json` | One JSON document on stdout; prose on stderr. |

`localidraw update --check --json` is the one for scripts. `localidraw service status` repeats what the last check
found, without asking the registry again.

## What it does

1. **Checks how Localidraw was installed.** It updates a global npm, pnpm, bun or Volta install. Anything else gets
   the right command instead ([below](#installs-that-cant-update-themselves)).
2. **Asks the registry** for the target version, and checks that it runs on your Node.
3. **Checks whether it's busy.** **If Localidraw is busy, `update` refuses with exit `75` before anything is
   stopped**, and says what's running: a canvas or the Library being written. Saves take a moment, so wait and run
   it again, or use `--force`.
4. **Asks you** (`Update Localidraw 0.6.0 → 0.7.0? The service will restart.`), unless you gave `--yes`.
5. **Downloads both versions** into npm's cache first, while the old one is still running, so a network failure
   changes nothing, and a rollback doesn't need the network.
6. **Stops the service**, installs the new version, and starts it again through the new version's own
   `service install --refresh`, keeping the folder, port and hosts the service had.
7. **Waits until the new version answers.**

An open page doesn't hold an update up. While Localidraw is stopped, the page says it isn't running, keeps
anything you draw, and saves it once the new version is up.

### If the new version doesn't start

**`update` waits up to 30 seconds for the new version to answer. If it doesn't, it prints the last 20 lines of the
log, reinstalls the old version and checks that it answers: exit `6`, "0.7.0 didn't start; 0.6.0 is running again."
If the old version doesn't come back either, it exits `7` and prints the commands to run by hand.**

### Without a service

If you run `localidraw serve` yourself, stop it first: if it's still answering, `update` asks you to stop it, and
exits `3`. With nothing running, `update` installs the new version, and you start Localidraw again to use it.

## Installs that can't update themselves

These exit `5` and print the right command instead:

| Installed with | It says to run |
| --- | --- |
| Docker (`LOCALIDRAW_IN_DOCKER=1`, set by the image) | `docker compose pull && docker compose up -d`, with the image's tag (see [Docker and Watchtower](#docker-and-watchtower)) |
| A managed install | **If `LOCALIDRAW_UPDATE_HINT` is set, `update` prints it and exits `5`.** Set it in the environment of an install something else manages (an Ansible role, a NixOS module), so nobody updates it by hand. |
| `npx localidraw` | nothing: **`npx localidraw@latest` already runs the latest** |
| A git checkout | `git pull && npm install && npm run build` |
| A global folder you can't write to | **the same command with `sudo`. Localidraw never runs `sudo` itself.** |
| yarn global, or a dependency of another project | update it the way you installed it |

## Docker and Watchtower

In Docker, pull the new image and start a new container from it: `docker compose pull && docker compose up -d`.
**Nothing installs anything inside a container.**

With Watchtower, enable lifecycle hooks (`WATCHTOWER_LIFECYCLE_HOOKS=true`) and label the container
`com.centurylinklabs.watchtower.lifecycle.pre-update=localidraw busy`. **When Localidraw is busy the hook exits `75`
and Watchtower skips the update until its next run.** [Self-hosting](/self-hosting/#upgrading) has the Compose file.

## No automatic checks

**Localidraw never checks for updates by itself. Only `update`, `update --check` and `doctor` ask the registry, and
only when you run them. `service status` repeats what the last of those found.** There's no check in the background
or when it starts, and the page never asks.

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
`--force`. A script or a tool such as [Watchtower](#docker-and-watchtower) can run `localidraw busy` before it
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
- **The service**, if it's installed: whether the Node, Localidraw and folder it names are still there, and whether
  it's the same install of Localidraw as the one you're running.
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
| `0` | Updated, or up to date. `--check` exits `0` either way. | Not busy. |
| `1` | It failed: the registry couldn't be reached, the version doesn't exist, or another update is running. | An answer that wasn't Localidraw's. |
| `2` | A usage error, or no terminal without `--yes`. | A usage error. |
| `3` | A foreground `serve` is still answering: stop it first. | Nothing is running. |
| `5` | This install can't update itself; the right command was printed. | |
| `6` | The update failed and was rolled back; the old version is running again. | |
| `7` | The update failed and couldn't be rolled back; a person is needed. What to run was printed. | |
| `75` | Busy: a save is under way. Nothing was changed. | Busy: a save is under way. |

These follow the [CLI contract](https://github.com/edspencer/cli-contract) that Ed's local tools share.

## Where things go

`update` keeps two files in `~/.localidraw`, beside the service's log and `runtime.json`:

- `update.lock`, while an update runs, so two can't run at once. If an update was killed, the next one removes the
  stale lock by itself.
- `update-check.json`, what the last `update`, `update --check` or `doctor` found, which `service status` repeats.

Neither holds a drawing, and nothing in your folder of canvases changes. A new version reads the same `.excalidraw`
files as the old one.
