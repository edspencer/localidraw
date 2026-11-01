# Localidraw as a Docker image, for hosting a folder of canvases behind a reverse proxy that does the login
# (https://localidraw.edspencer.net/self-hosting/). Localidraw has no login of its own.
#
#   docker run -d --name localidraw -p 127.0.0.1:3729:3729 -v /srv/canvases:/canvases \
#     -e LOCALIDRAW_ALLOWED_HOSTS=draw.example.com ghcr.io/edspencer/localidraw
#
# It listens on 0.0.0.0 inside the container (LOCALIDRAW_HOST), so it won't start without LOCALIDRAW_ALLOWED_HOSTS:
# the host names it's reached by. Add `localhost` to use it on this machine. Publish the port on loopback, or on the
# address your proxy reaches; never on every address.
#
# After BragDoc's and Paddock's: multi-stage, tini, a HEALTHCHECK, the `node` user. Multi-arch (linux/amd64,
# linux/arm64) is built in CI on native runners (release.yml), each pushed by digest and merged with
# `docker buildx imagetools create`.

# ---- build stage ----------------------------------------------------------
# On $BUILDPLATFORM: the build only makes JavaScript, CSS and fonts (dist/), the same for every architecture, so an
# emulated multi-arch build runs it once, natively.
FROM --platform=$BUILDPLATFORM node:22-slim AS build
WORKDIR /app

# Dependencies first, for the layer cache. No install scripts: nothing the build uses needs one (esbuild's binary
# comes as a per-platform optional dependency).
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY . .
RUN npm run build

# ---- runtime stage --------------------------------------------------------
FROM node:22-slim AS runtime

# tini, see ENTRYPOINT.
RUN apt-get update && apt-get install -y --no-install-recommends tini && rm -rf /var/lib/apt/lists/*

WORKDIR /app
# Localidraw has no runtime dependencies: the server is plain Node, and the page's libraries are bundled into
# dist/web. So the image is the built files, package.json (the version, and `type: module`) and the licences.
COPY package.json LICENSE NOTICE.md README.md ./
COPY --from=build /app/dist dist

# The canvases are /canvases: mount your folder there. Localidraw runs as the image's `node` user (uid 1000), not root,
# so the folder must be writable by uid 1000 (or run with `--user` as its owner). The directory is made here so an
# unmounted /canvases still works, in an anonymous volume.
ENV NODE_ENV=production \
    LOCALIDRAW_HOST=0.0.0.0 \
    PORT=3729
RUN mkdir -p /canvases && chown node:node /canvases
USER node
VOLUME ["/canvases"]
EXPOSE 3729

# Node's fetch, as there's no curl. 127.0.0.1 is a loopback Host, so the host check lets it through.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --start-interval=2s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3729)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

# tini as pid 1, so `docker stop`'s SIGTERM reaches node (a Node process that is pid 1 gets no default signal
# handlers) and stops it at once, rather than after Docker's 10 seconds.
ENTRYPOINT ["/usr/bin/tini", "--", "node", "/app/dist/server/cli.js"]
# The folder; add options after it, e.g. `docker run … ghcr.io/edspencer/localidraw /canvases --poll`.
CMD ["/canvases"]
