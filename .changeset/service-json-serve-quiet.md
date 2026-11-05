---
"localidraw": minor
---

**`--json` on `service install`, `uninstall`, `start`, `stop` and `restart`**, as on `service status`: one JSON document on stdout, whatever happened, and what's said for a person on stderr. The document is what `service status --json` reports, taken afterwards, plus `ok`, `action` and, when it failed, `error` (`"busy"` for exit 75, `"not installed"` for exit 4, or the reason), and the action's own fields: `wasRunning` (start, stop), `wasInstalled` (uninstall), `rewritten` (restart), `movedFrom` (install), and `dryRun` and `rendered` (install --dry-run, whose unit is in the document rather than on stdout). The exit codes don't change. `service logs --json` is still a usage error (exit 2).

**`localidraw serve --quiet` (`-q`)** prints only the first line, `Localidraw <version>: <url>`. Hosted (a `--host` beyond loopback), the warning that Localidraw has no login still goes out, on stderr.
