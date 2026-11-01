---
"localidraw": minor
---

A Docker image, `ghcr.io/edspencer/localidraw`, for amd64 and arm64, with an SBOM and build provenance. It runs as
the `node` user with the canvases at `/canvases` and a health check on `/api/health`, listens on `0.0.0.0` inside the
container, and won't start without `LOCALIDRAW_ALLOWED_HOSTS`. The repository's `compose.yaml` publishes it on
loopback, and has examples for a folder on a NAS and for a reverse proxy. The docs site's Self-hosting page covers
Docker, Compose, reverse proxies (Caddy with forward auth, or basic auth) and the limits.
