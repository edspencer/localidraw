---
title: Self-hosting
description: Running Localidraw on a server for a folder of shared canvases. Coming in the next release.
---

:::note[Not yet]
Today Localidraw is for one person on their own machine: it listens on `127.0.0.1` only, and refuses requests from
any host but localhost. Running it on a server, behind a reverse proxy, is being built now, and this page will
describe it.
:::

What's planned:

- **`--host` and `--allowed-host`**, to listen beyond localhost while still refusing requests for any other host name.
  It won't start on a non-loopback address unless at least one allowed host is set.
- **No login of its own.** Authentication is the reverse proxy's job (SSO with forward auth, basic auth, Tailscale,
  Cloudflare Access).
- **A Docker image**, `ghcr.io/edspencer/localidraw`, for amd64 and arm64, with the canvases on a volume, a non-root
  user and a health check (`/api/health`).
- **`--poll`**, for folders on a network mount (NFS or SMB), where file events from other machines don't arrive.

And the limits, which will stay: one Localidraw per folder, and other people's changes arrive when they're saved,
not stroke by stroke, because there's no collaboration server.

Until then, you can follow it on [GitHub](https://github.com/edspencer/localidraw).
