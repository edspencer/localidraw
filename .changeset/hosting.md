---
"localidraw": minor
---

Localidraw can be hosted, behind a reverse proxy that does the login. `--host <addr>` (or `LOCALIDRAW_HOST`) listens
beyond 127.0.0.1, and `--allowed-host <name>` (repeatable, or `LOCALIDRAW_ALLOWED_HOSTS`, comma-separated) names the
hosts it answers to; a `--host` that isn't loopback refuses to start without one. The `Host` must be loopback or an
allowed host, and an `Origin` must be `http(s)://` and that same host. `--poll [ms]` (or `LOCALIDRAW_POLL`) finds
changes by checking the files, for folders on NFS or SMB, where another machine's writes send no file events. At
startup it prints what's in effect, and warns that Localidraw has no login of its own.

Also: writes must be `application/json` (anything else is a 415); `/api/health` returns `{ ok, version }`; the page's
script and stylesheet have a hash in their names, and every hashed file is cached for good while the page itself is
revalidated; and responses are compressed with brotli or gzip when the browser accepts it.

Fixed: behind a reverse proxy, a page stayed offline for good after the server restarted, because the proxy answered
502 while it was down and the browser stopped reconnecting. It now keeps trying, and catches up when it's back.
