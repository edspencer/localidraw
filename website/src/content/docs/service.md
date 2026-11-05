---
title: Running as a service
description: Keep Localidraw running in the background on macOS or Linux, from login on, serving one folder, with localidraw service.
---

`localidraw service` keeps Localidraw running in the background, so a folder of canvases is always at
http://localhost:3729/, without a terminal left open. On macOS it's a launchd LaunchAgent; on Linux it's a
systemd user service. Both run as you, start when you log in, and are restarted if Localidraw stops on its own.

```sh
npm install -g localidraw
localidraw service install ~/notes
```

That writes the service, starts it, and waits until it answers. Install the package first: from `npx`, the service
would run a copy in npm's cache, which npm clears, so `install` refuses there.

## One folder per machine

There's one Localidraw service per machine, and it serves the folder you gave `install`. Installing another folder
moves the service there. To draw in a second folder at the same time, run `localidraw ~/other --port 3730` in a
terminal as well.

The service is written with everything it runs with: the folder, the port, the host, the allowed hosts and `--poll`.
It doesn't read `$LOCALIDRAW_HOST` and the other variables, so it runs the same whichever shell installed it. Running
`install` again keeps those settings, unless you give new ones:

```sh
localidraw service install --port 3740   # the same folder, on another port
```

## The commands

| Command | What it does |
| --- | --- |
| `service install [folder]` | Writes the service, starts it and waits until it answers. Takes `--port`, `--host`, `--allowed-host` and `--poll`, as `serve` does. The folder is needed the first time. |
| `service install --refresh` | Writes the installed service again, from the settings it records. `update` will use this. |
| `service install --dry-run` | Prints the unit file it would write, and writes nothing. |
| `service uninstall` | Stops it and removes the service. The log and your canvases stay. |
| `service start` | Starts it, and waits until it answers. |
| `service stop` | Stops it until `service start`, or until you next log in. It stays installed: to keep it off, `uninstall` it. |
| `service restart` | Stops and starts it. If the Node or the Localidraw it names has gone (an nvm or fnm Node removed, say), it writes the service again first. |
| `service status [--json]` | Says whether it's installed, running and answering, with the folder, the port, the installed and running versions, and any warnings. |
| `service logs [-f] [-n <lines>]` | The last 50 lines of its log, or `-n` lines. `-f` follows it. |

`localidraw service --help` lists them too.

### Exit codes

`service status` exits `0` when the service is running and answering, `3` when it's installed but not running or not
answering, and `4` when it isn't installed. `start`, `stop`, `restart` and `logs` exit `4` with nothing installed,
too. A usage error exits `2`, and any other failure `1`: a port something else holds, say, or a service that didn't
answer once started (the last lines of its log are printed then). These follow the
[CLI contract](https://github.com/edspencer/cli-contract) that Ed's local tools share, so a script can run
`localidraw service status` and branch on the code:

```sh
localidraw service status > /dev/null; echo $?
```

## Where things go

| | macOS | Linux |
| --- | --- | --- |
| The service | `~/Library/LaunchAgents/net.edspencer.localidraw.plist` | `~/.config/systemd/user/localidraw.service` |
| Its log | `~/.localidraw/logs/service.log` | `~/.localidraw/logs/service.log` |

`~/.localidraw` is Localidraw's own folder: the service's log and working folder, and `runtime.json`, which says
where a running Localidraw is listening (`serve` writes it too, in a terminal, and removes it when it stops). Your
canvases are never kept there: they stay in the folder the service serves, and `install` refuses a folder inside
`~/.localidraw`.

The service runs Node and Localidraw by their full paths, so it keeps working under nvm, fnm or volta until that Node
is removed. `service status` warns when it has been, and `service restart` writes the service again with the Node
you're running.

## Hosting it as a service

The [hosting rules](/self-hosting/#listening-beyond-localhost) are the same as for `serve`. The service listens on
`127.0.0.1` unless you give `--host`, and a host beyond loopback needs at least one `--allowed-host`, or `install`
refuses:

```sh
localidraw service install /srv/canvases --host 0.0.0.0 --allowed-host draw.example.com
```

Localidraw has no login of its own, so put it behind a reverse proxy that does authentication, as
[Self-hosting](/self-hosting/) describes.

## On Linux: linger

A systemd user service stops when you log out, SSH sessions included, unless your user lingers. `install` checks,
and if linger is off it says to run, once:

```sh
sudo loginctl enable-linger $USER
```

Localidraw never runs `sudo` itself.

## Windows

Not yet. On Windows, `service status` exits `4` (nothing's installed) and the other `service` commands exit `1`. Run
`localidraw ~/notes` in a terminal, or keep it running with Task Scheduler or whatever you already use.

## Stopping and updating

`service stop` and `service restart` send SIGTERM, which lets any save under way finish writing before Localidraw
exits, as <kbd>Ctrl</kbd>+<kbd>C</kbd> does ([Stopping it](/getting-started/#stopping-it)). A page whose save
couldn't reach it says "Not saved", keeps the drawing, and saves it once the service is back.

After `npm install -g localidraw` installs a new version, run `localidraw service restart` to start it:
`service status` warns when the running version isn't the installed one.
