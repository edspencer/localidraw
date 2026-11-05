---
"localidraw": minor
---

`localidraw service`: run Localidraw in the background on macOS (a launchd LaunchAgent) or Linux (a systemd user
service), from login on, serving one folder. `service install <folder>` writes it, starts it and waits until it
answers, with `--port`, `--host`, `--allowed-host` and `--poll` as for `serve` (a host beyond loopback still needs an
allowed host), plus `--refresh` to re-write it from what it records and `--dry-run` to print it. Then `uninstall`,
`start`, `stop` (which doesn't disable it: it's back at the next login), `restart`, `status [--json]` and
`logs [-f] [-n <lines>]`. There's one service per machine; its log is `~/.localidraw/logs/service.log`, and your
canvases stay in the folder it serves. See https://localidraw.edspencer.net/service/.

New exit codes, for scripts: `service status` exits 0 when it's running and answering, 3 when it's installed but not
running or not answering, and 4 when nothing is installed; `start`, `stop`, `restart` and `logs` exit 4 with nothing
installed too. `service` was reserved (exit 2) in 0.5.0. On Windows, `service status` exits 4 and the other `service`
commands exit 1: not supported yet.

`serve` now writes `~/.localidraw/runtime.json` (readable only by you) once it's listening, saying where it is, and
removes it when it stops.
