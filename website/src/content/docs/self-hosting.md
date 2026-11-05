---
title: Self-hosting
description: Running Localidraw on a server, in Docker or with Node, for a folder of shared canvases, behind a reverse proxy that does the login.
---

Localidraw is built for one person on their own machine, and that's what it does unless you ask for more. It can also
serve a folder on a server, for a team or for yourself from anywhere, behind a reverse proxy.

:::caution[Localidraw has no login]
Anyone who can reach a hosted Localidraw can read and change every canvas in its folder. Authentication is the
reverse proxy's job: forward auth to your SSO, basic auth, or a private network such as Tailscale. Publish
Localidraw's own port only where the proxy can reach it, never to the internet.
:::

## With Docker

The image is `ghcr.io/edspencer/localidraw`, for amd64 and arm64. It's tagged with each version and `latest`, and
carries an SBOM and build provenance. It runs as the `node` user (uid 1000), with the canvases at `/canvases`, and a
health check on `/api/health`. It listens on every address inside the container, so it **won't start without
`LOCALIDRAW_ALLOWED_HOSTS`**:

```sh
docker run -d --name localidraw --restart unless-stopped \
  -p 127.0.0.1:3729:3729 \
  -v /srv/canvases:/canvases \
  -e LOCALIDRAW_ALLOWED_HOSTS=draw.example.com \
  ghcr.io/edspencer/localidraw
```

- **Publish the port on loopback**, as above, when the proxy is on the same machine, or on the one address the proxy
  reaches (`-p 192.168.1.20:3729:3729`). Never use a bare `-p 3729:3729`, which opens it to every network the machine
  is on.
- **The folder must be writable by uid 1000**, or run the container as its owner with `--user $(id -u):$(id -g)`.
- Add `localhost` to `LOCALIDRAW_ALLOWED_HOSTS` (`localhost,draw.example.com`) to use it at
  `http://localhost:3729/` on the machine itself.
- Options go after the folder: `ghcr.io/edspencer/localidraw /canvases --poll`. Or use the variables below.

To check that an image is the one this repository's release workflow built:

```sh
gh attestation verify oci://ghcr.io/edspencer/localidraw:latest -R edspencer/localidraw
```

### Docker Compose

The repository's [`compose.yaml`](https://github.com/edspencer/localidraw/blob/main/compose.yaml) runs it on
`./canvases`, published on loopback, answering to `localhost`. It also has commented examples for a NAS folder over
NFS and for a reverse proxy. The essentials:

```yaml
services:
  localidraw:
    image: ghcr.io/edspencer/localidraw:latest
    ports:
      - "127.0.0.1:3729:3729"
    user: "1000:1000"
    environment:
      LOCALIDRAW_ALLOWED_HOSTS: draw.example.com
      # LOCALIDRAW_POLL: "2000"   # for a folder on NFS or SMB
    volumes:
      - /srv/canvases:/canvases
    restart: unless-stopped
```

## Without Docker

Localidraw is one Node process with no runtime dependencies. On macOS or Linux, `localidraw service` installs it as a
user service for you ([Running as a service](/service/)):

```sh
npm install -g localidraw
localidraw service install /srv/canvases --host 0.0.0.0 --allowed-host draw.example.com
```

Or write a service file of your own that runs
`npx localidraw@latest /srv/canvases --allowed-host draw.example.com` (Node 22 or later). The rest of this page applies
to each.

## Listening beyond localhost

Two options do it, and they go together:

```sh
localidraw /srv/canvases --host 0.0.0.0 --allowed-host draw.example.com
```

- **`--host <addr>`** is the address to listen on: `0.0.0.0` for every interface, or one address, such as the
  server's LAN address. The default is `127.0.0.1`.
- **`--allowed-host <name>`** is a host name Localidraw answers to besides localhost: the name your browser (or your
  proxy) uses to reach it, without `https://` or a port. Repeat it for more names.

A `--host` that isn't loopback **won't start without an allowed host** (the Docker image listens on `0.0.0.0`, so it
needs one too):

```
localidraw: refusing to listen on 0.0.0.0 without an allowed host name.
```

That's deliberate. Localidraw checks the `Host` of every request, and refuses any that isn't localhost or an allowed
host. That's what stops a web page from reaching it by [DNS rebinding](https://en.wikipedia.org/wiki/DNS_rebinding),
and it's why there's no wildcard. Browsers' `Origin` headers are checked against the same host, over `http` or
`https`, so another site can't write to your canvases either. If you see "Localidraw doesn't answer to that host
name", the name in your address bar, or the `Host` your proxy sends, isn't in the list.

Every option has an environment variable, which is handier in a service file or a container:

| Option | Variable |
| --- | --- |
| `--host <addr>` | `LOCALIDRAW_HOST` |
| `--allowed-host <name>` (repeatable) | `LOCALIDRAW_ALLOWED_HOSTS`, comma-separated |
| `--poll [ms]` | `LOCALIDRAW_POLL`: the milliseconds, or `true` for 2000 |
| `--port <n>` | `PORT` |

At startup it prints what's in effect, so you can check:

```
Localidraw 0.4.0: http://localhost:3729/
  /srv/canvases (12 canvases)
  listening on 0.0.0.0:3729
  answering to localhost, draw.example.com
  watching for changes by checking the files every 2000 ms
  Localidraw has no login: anyone who can reach this port can read and change these canvases. Put it behind a reverse proxy that does authentication.
```

## Behind a reverse proxy

The proxy terminates TLS, does the login, and passes requests on with their `Host` unchanged (which most proxies do
by default). Localidraw's change events are a long-lived [server-sent events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events)
stream, `/api/events`. Caddy passes them straight through. Localidraw sends `X-Accel-Buffering: no`, so nginx does
too. It compresses its own responses, so the proxy needn't.

If the proxy runs on the same machine, keep `--host 127.0.0.1` (the default) and add the public name with
`--allowed-host`: the proxy reaches it on loopback, and nothing else can.

### Caddy with forward auth (Authentik)

With an [Authentik](https://goauthentik.io) proxy provider in forward-auth mode for `draw.example.com`, bound to an
outpost:

```caddy
draw.example.com {
	# Inside `route`, the directives run in the order written.
	route {
		# The outpost's own pages: the login redirect and its callback.
		reverse_proxy /outpost.goauthentik.io/* http://authentik-outpost:9000

		# Every other request is checked with the outpost first.
		forward_auth http://authentik-outpost:9000 {
			uri /outpost.goauthentik.io/auth/caddy
			copy_headers X-Authentik-Username X-Authentik-Email
			trusted_proxies private_ranges
		}

		reverse_proxy 127.0.0.1:3729
	}
}
```

```sh
localidraw /srv/canvases --allowed-host draw.example.com
```

The same shape works with other forward-auth servers (Authelia, oauth2-proxy). Localidraw doesn't read the user
headers today; everyone who gets through is the same to it.

### Caddy with basic auth

The simple option, for yourself or a few people. Make a password hash with `caddy hash-password`, then:

```caddy
draw.example.com {
	basic_auth {
		ed <the hash from caddy hash-password>
	}
	reverse_proxy 127.0.0.1:3729
}
```

## A folder on a network mount

Localidraw sees changes, an agent's edit or a `git pull`, through the operating system's file events. On a network
mount (NFS, SMB), those only arrive for writes made by the same machine; another machine's writes send none. Docker
Desktop's bind mounts from macOS can miss events too. For those, use **`--poll`**: Localidraw then checks every
canvas's size and modification time on an interval (2000 ms, or `--poll 500` for another), instead of waiting for
events.

```sh
localidraw /mnt/nas/canvases --allowed-host draw.example.com --poll
```

NFS clients cache file attributes, by default for up to a minute, so a poll can still see an old modification time.
Mount the share with a short attribute cache (`actimeo=1`, or `noac`) if other machines write to it.

## Health check

`GET /api/health` answers `{ "ok": true, "version": "0.4.0" }`. It's subject to the same host check as everything
else, so check it as `http://127.0.0.1:3729/api/health` from the machine itself.

## Upgrading

**With Docker**, pull the new image and start a new container from it. Nothing is installed inside a running
container: `localidraw update` there says what to run, and exits `5`.

```sh
docker compose pull && docker compose up -d
```

Or, with `docker run`, `docker pull ghcr.io/edspencer/localidraw`, then remove the container and run it again with
the same options. The canvases are in your folder, not the container, so nothing is lost. To see whether there's a
newer version first:

```sh
docker exec localidraw localidraw update --check
```

**Wait for a save to finish.** `docker stop` already lets a save under way finish, and an open page saves again
once the new container is up. To be sure, ask first: `localidraw busy` exits `75` while a canvas or the Library is
being written, `0` when nothing is ([Is it busy?](/updating/#is-it-busy)).

```sh
docker exec localidraw localidraw busy && docker compose up -d
```

**With [Watchtower](https://containrrr.dev/watchtower/)**, which updates containers when a new image is pushed, a
pre-update hook does the same. Turn on its lifecycle hooks (`WATCHTOWER_LIFECYCLE_HOOKS=true`, or
`--enable-lifecycle-hooks`) and add the label to Localidraw's container. When the hook exits `75`, Watchtower skips
the update until its next run.

```yaml
services:
  localidraw:
    image: ghcr.io/edspencer/localidraw:latest
    labels:
      com.centurylinklabs.watchtower.lifecycle.pre-update: "localidraw busy"
    # … ports, user, environment and volumes as above
```

**Without Docker**, `localidraw update` updates a global npm install and restarts the service: see
[Updating](/updating/).

## The limits

These come from what Localidraw is, a file server for one folder, and they'll stay:

- **One Localidraw per folder.** Change events come from the one server watching the folder, and a save's conflict
  check is between the page and that server. Two Localidraws on the same folder (on a shared drive, say) don't know
  about each other's pages.
- **Changes arrive on save, not live.** There's no collaboration server. Other people's drawing appears when their
  page saves it, under a second after they stop, not stroke by stroke.
- **Two people on one canvas merge on save.** Each save is merged per element with the file, so neither loses work,
  but if you both move the same box, the copy with more edits (the higher `version`) wins, the file's on a tie, and the
  other person's page tells them their edit lost.
- **File events can be missed** on NFS and SMB mounts, and through Docker Desktop's bind mounts on macOS. Use
  `--poll` there.
- **On Linux, every folder is a file watch.** Localidraw watches each folder under the root (not dot-folders or
  `node_modules`), and the system limits how many watches a user has (`fs.inotify.max_user_watches`). In a very big
  tree it says so at startup if it runs out, and `localidraw doctor` counts the folders against the limit beforehand;
  raise the limit (`sysctl fs.inotify.max_user_watches=524288`), or use `--poll`.
- **There's no login,** and no record of who changed what. That's the proxy's job, and git's.
