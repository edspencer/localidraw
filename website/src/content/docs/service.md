---
title: Running as a service
description: Keep Localidraw running in the background on macOS or Linux, from login on, serving one folder, with localidraw service.
---

`localidraw service install` sets Localidraw up to start when you log in and to restart if it stops: a LaunchAgent
on macOS, a systemd user service on Linux. Both run as you, and keep a folder of canvases at http://localhost:3729/
without a terminal left open. Windows isn't supported yet ([below](#windows)).

```sh
npm install -g localidraw
localidraw service install ~/notes
```

## Installing

`service install [folder]` takes the folder of canvases, and `--port`, `--host`, `--allowed-host` and `--poll`, as
`serve` does. The folder is needed the first time. It writes the service, starts it, and **waits until Localidraw
answers** (up to 20 seconds) before it returns. If it doesn't answer, `install` prints the last 20 lines of its log
and exits `1`.

- **Running it again is safe:** it keeps the port and settings the service already has, unless you give new ones,
  and restarts the running service onto them.

  ```sh
  localidraw service install --port 3740   # the same folder, on another port
  ```

- **`--dry-run` prints the unit and writes nothing.**
- It refuses to install **from an npx cache** (the folder is temporary: npm clears it, and the service would stop
  working), **from a git checkout unless you add `--from-checkout`**, and **when something else holds the port**
  (it says when that's a `localidraw` running in a terminal).
- On Linux, **linger.** Without it, the service stops when you log out, SSH sessions included, and starts only when
  you log in. `install` and [`doctor`](/updating/#when-something-is-wrong-doctor) check, and print what to run, once:

  ```sh
  sudo loginctl enable-linger $USER
  ```

  Localidraw never runs `sudo` itself.

### One folder per machine

There's one Localidraw service per machine, and it serves the folder you gave `install`. Installing another folder
moves the service there. To draw in a second folder at the same time, run `localidraw ~/other --port 3730` in a
terminal as well.

The service is written with everything it runs with: the folder, the port, the host, the allowed hosts and `--poll`.
It doesn't read `$LOCALIDRAW_HOST` and the other variables, so it runs the same whichever shell installed it.

### Hosting it as a service

The [hosting rules](/self-hosting/#listening-beyond-localhost) are the same as for `serve`. The service listens on
`127.0.0.1` unless you give `--host`, and a host beyond loopback needs at least one `--allowed-host`, or `install`
refuses:

```sh
localidraw service install /srv/canvases --host 0.0.0.0 --allowed-host draw.example.com
```

Localidraw has no login of its own, so put it behind a reverse proxy that does authentication, as
[Self-hosting](/self-hosting/) describes.

## Where things are

| | macOS | Linux |
| --- | --- | --- |
| The unit | `~/Library/LaunchAgents/net.edspencer.localidraw.plist` | `~/.config/systemd/user/localidraw.service` |
| The log | `~/.localidraw/logs/service.log` | `~/.localidraw/logs/service.log` |

`~/.localidraw` is Localidraw's own folder: the service's log and working folder, and `runtime.json`, which says
where a running Localidraw is listening (`serve` writes it too, in a terminal, and removes it when it stops). Your
canvases are never kept there: they stay in the folder the service serves, and `install` refuses a folder inside
`~/.localidraw`.

The unit runs this Node and this install's `cli.js` by their real paths, never the `localidraw` shim, so **if you
remove that Node version (nvm, fnm, volta), `service status` and `doctor` warn, and `service install` again fixes
it.** So does `service restart`, which writes the unit again first when the Node or Localidraw it names has gone.
They also warn when the service runs another install of Localidraw than the one you're asking (a second global
install, say): run `localidraw service install` from the one you mean it to run.

## The commands

| Command | What it does |
| --- | --- |
| `service install [folder]` | Writes the unit, starts it and waits until it answers ([above](#installing)). `--dry-run` prints the unit instead; `--refresh` writes it again from the settings it records, which [`update`](/updating/) uses. |
| `service uninstall` | Stops it and removes the unit. Your canvases and the log stay. |
| `service start` | Starts it, and waits until it answers. |
| `service stop [--force]` | Stops it until `service start`, or the next login or boot. It doesn't disable the service. To keep it off for good, use `service uninstall`. |
| `service restart [--force]` | Stops and starts it, writing the unit again first if the Node or the Localidraw it names has gone. |
| `service status [--json]` | Says whether it's installed, running and answering, with the folder, the port, the installed and running versions, the unit, the log, and any warnings. |
| `service logs [-f] [-n <lines>]` | The last 50 lines of its log; `-f` follows, `-n` sets how many. |

`localidraw service --help` lists them too.

Every command but `logs` takes `--json`: it prints one JSON document on stdout, and what it says for a person goes to
stderr. For `status` that's the report; for `install`, `uninstall`, `start`, `stop` and `restart` it's the same
report, taken afterwards, plus `ok`, `action` and, when it failed, `error` (`"busy"`, `"not installed"`, or the
reason). The exit code is the same as without it.

```sh
localidraw service stop --json | jq '{ok, error, running}'
```

## Busy

**`service stop` and `service restart` first ask the running Localidraw whether it's busy**: whether a canvas or the
Library is being written right now (a save, a new canvas, a rename, a move or a delete). **If it is, they refuse
with exit `75` and say what's running. Wait and try again, or add `--force`, which prints the same message prefixed
`Overriding:` and goes ahead.** A save takes a fraction of a second, so trying again a moment later is the usual
answer. `uninstall` doesn't ask. [`localidraw busy`](/updating/#is-it-busy) asks the same question on its own: it
exits `0` when it isn't busy, `75` when it is, and `3` when nothing is running.

Either way, stopping sends SIGTERM, which lets any save under way finish writing before Localidraw exits, as
<kbd>Ctrl</kbd>+<kbd>C</kbd> does ([Stopping it](/getting-started/#stopping-it)). A page whose save couldn't reach it
says "Not saved", keeps the drawing, and saves it once the service is back.

## Logs

There's one file, `~/.localidraw/logs/service.log`, which stdout and stderr both append to; `service logs` reads it.
**Localidraw rotates it itself** (by copying and truncating, at 8 MB, keeping 3: `service.log.1` to `.3`), because
the service manager holds it open. It looks when it starts and every 15 minutes after.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Running and answering (`status`), or done. |
| `1` | It failed: a port something else holds, say, or a service that didn't answer once started (the last lines of its log are printed then). |
| `2` | A usage error: an unknown command or flag, or a bad value. |
| `3` | Installed but not running or not answering (`status`). |
| `4` | Not installed (`status`, `start`, `stop`, `restart`, `logs`). |
| `75` | Busy: a save is under way, and `stop` or `restart` changed nothing. |

These follow the [CLI contract](https://github.com/edspencer/cli-contract) that Ed's local tools share, so a script
can run `localidraw service status` and branch on the code:

```sh
localidraw service status > /dev/null; echo $?
```

## Windows

Not yet. On Windows, `service status` exits `4` (nothing's installed) and the other `service` commands exit `1`. Run
`localidraw ~/notes` in a terminal, or keep it running with Task Scheduler or whatever you already use.

## Updating

Run `localidraw update`: it stops the service, installs the new version and starts it, and puts the old one back if
the new one doesn't answer. [Updating](/updating/) has the details. If you install a new version yourself with
`npm install -g localidraw`, run `localidraw service restart` to start it: `service status` warns when the running
version isn't the installed one.
