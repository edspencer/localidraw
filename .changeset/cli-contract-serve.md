---
"localidraw": minor
---

The command line follows the [CLI contract](https://github.com/edspencer/cli-contract) that Ed's local tools share.

- **`localidraw serve [folder]`** runs it in the foreground. It's still the default, so `localidraw ~/notes` works as
  before.
- **Command names win over folder names.** `service`, `update`, `busy` and `doctor` are reserved for commands still to
  come, and exit 2 for now. A folder with one of those names, or called `serve`, is given as `./service`.
- **Ctrl-C and SIGTERM stop it cleanly.** It stops taking requests, lets any save under way finish writing (for up to
  five seconds), and exits 0. `docker stop` now exits 0 rather than 143.
- **Exit codes changed, which scripts may see:** a port in use exits **1**, where it exited 2. A missing built page
  exits 1 too. Usage errors still exit 2, and now print the usage after the message instead of `(see --help)`.
