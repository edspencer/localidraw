#!/usr/bin/env bash
# `scripts/smoke-image.sh <image> <version>`: checks a built Localidraw image the way the docs say to run it, before
# anything could be pushed. CI runs it on every image it builds (ci.yml and release.yml).
#
# It starts the image with LOCALIDRAW_ALLOWED_HOSTS, waits for its HEALTHCHECK to say healthy, then checks what it
# serves: /api/health, the page for an allowed host, a 403 for another host, a canvas made and saved in /canvases (as
# the node user), and a 415 for a write that isn't JSON. And that it refuses to start without allowed hosts, that
# `localidraw` is on PATH, that `localidraw busy` finds it, and that `localidraw update` prints the pull command and
# exits 5 (against a stub registry in the container), as LOCALIDRAW_IN_DOCKER asks.
#
# Every request is made from inside the container (docker exec, with Node's fetch), so it works with a remote Docker
# daemon too, where a published port or a bind mount would be on another machine.
set -euo pipefail
image="$1" version="$2"
name="localidraw-smoke-$$"
cleanup() { docker rm -f "${name}" >/dev/null 2>&1 || true; }
trap cleanup EXIT
check() { echo "smoke-image: $1"; }
fail() { echo "smoke-image: $1" >&2; docker logs "${name}" >&2 || true; exit 1; }
# fetch(path, {method, host, type, body}) from inside the container; prints "<status> <body>"
call() {
  docker exec -e REQ="$1" "${name}" node -e '
    const r = JSON.parse(process.env.REQ);
    const headers = { host: r.host ?? "127.0.0.1" };
    if (r.type) headers["content-type"] = r.type;
    // fetch won'"'"'t set Host, so node:http
    const req = require("node:http").request({ host: "127.0.0.1", port: process.env.PORT, path: r.path, method: r.method ?? "GET", headers }, (res) => {
      let b = ""; res.on("data", (c) => (b += c)).on("end", () => console.log(res.statusCode, b));
    });
    req.end(r.body);'
}

# Without allowed hosts it refuses, and says why (bounded, in case a regression let it start and run forever).
bounded=(); command -v timeout >/dev/null && bounded=(timeout 60)
out="$("${bounded[@]}" docker run --rm "${image}" 2>&1 || true)"
case "${out}" in *"refusing to listen on 0.0.0.0 without an allowed host name"*) check "refuses to start without LOCALIDRAW_ALLOWED_HOSTS" ;; *) echo "without allowed hosts it said: ${out}" >&2; exit 1 ;; esac

docker run -d --name "${name}" -p 127.0.0.1::3729 -e LOCALIDRAW_ALLOWED_HOSTS=draw.example -e LOCALIDRAW_POLL=500 "${image}" >/dev/null
status=starting
for _ in $(seq 1 45); do
  status="$(docker inspect -f '{{.State.Health.Status}}' "${name}")"
  [ "${status}" = healthy ] && break
  [ "$(docker inspect -f '{{.State.Running}}' "${name}")" = true ] || fail "the container exited"
  sleep 2
done
[ "${status}" = healthy ] || fail "the container never became healthy (${status})"
check "healthy"
logs="$(docker logs "${name}" 2>&1)"
echo "${logs}"
for want in "listening on 0.0.0.0:3729" "answering to localhost, draw.example" "every 500 ms" "has no login"; do
  case "${logs}" in *"${want}"*) ;; *) fail "the startup output doesn't say '${want}'" ;; esac
done
check "the startup output says what's in effect"
[ "$(docker exec "${name}" id -u)" = 1000 ] || fail "it isn't running as uid 1000"
check "runs as node (uid 1000)"

expect() { # expect <what> <status> <request json> [<grep -E pattern for the body>]
  local got; got="$(call "$3")"
  [ "${got%% *}" = "$2" ] || fail "$1: got ${got:0:200}"
  [ -z "${4:-}" ] || grep -qE "$4" <<<"${got}" || fail "$1: got ${got:0:200}"
  check "$1"
}
expect "/api/health" 200 '{"path":"/api/health"}' "^200 \\{\"ok\":true,\"version\":\"${version//./\\.}\"\\}$"
expect "the page, for an allowed host" 200 '{"path":"/","host":"draw.example"}' '<div id="root">'
expect "another host is refused" 403 '{"path":"/api/health","host":"evil.example"}'
expect "a canvas is made in /canvases" 201 '{"path":"/api/canvases","method":"POST","type":"application/json","body":"{\"path\":\"smoke/first\"}"}'
expect "and listed" 200 '{"path":"/api/projects"}' '"path":"smoke/first.excalidraw"'
expect "a write that isn't JSON is refused" 415 '{"path":"/api/canvases","method":"POST","type":"text/plain","body":"{\"path\":\"smoke/second\"}"}'
[ "$(docker exec "${name}" stat -c %u /canvases/smoke/first.excalidraw)" = 1000 ] || fail "the canvas isn't owned by uid 1000"
check "the canvas belongs to uid 1000"
# The CLI in the image (the CLI contract's SPEC §9): on PATH, for `docker exec` and Watchtower's pre-update hook.
[ "$(docker exec "${name}" localidraw --version)" = "${version}" ] || fail "localidraw isn't on PATH, or isn't ${version}"
check "localidraw is on PATH"
docker exec "${name}" localidraw busy >/dev/null || fail "localidraw busy didn't exit 0 with nothing being saved (exit $?)"
check "localidraw busy finds it, idle (exit 0)"
# `update` in the image says how to pull the new one, and exits 5: never an npm install in a container. A stub registry
# in the container announces 99.0.0, so this asks nothing outside it.
docker exec -d "${name}" node -e '
  require("node:http").createServer((q, s) => {
    s.setHeader("content-type", "application/json");
    s.end(JSON.stringify(q.url.includes("dist-tags") ? { latest: "99.0.0" } : { name: "localidraw", version: "99.0.0", engines: { node: ">=22" } }));
  }).listen(4873, "127.0.0.1")'
for _ in $(seq 1 20); do docker exec "${name}" node -e 'fetch("http://127.0.0.1:4873/").then(()=>{},()=>process.exit(1))' 2>/dev/null && break; sleep 0.5; done
set +e
said="$(docker exec -e npm_config_registry=http://127.0.0.1:4873 "${name}" localidraw update --yes 2>&1)"; code=$?
set -e
[ "${code}" = 5 ] || fail "localidraw update in the image exited ${code}, not 5: ${said}"
case "${said}" in *"docker compose pull"*"ghcr.io/edspencer/localidraw:99.0.0"*) ;; *) fail "localidraw update didn't print the pull command: ${said}" ;; esac
check "localidraw update prints the pull command, and exits 5"
docker stop -t 5 "${name}" >/dev/null
# SIGTERM is a clean stop: the saves under way finish, then it exits 0 (a 143 would be a death by the signal).
[ "$(docker inspect -f '{{.State.ExitCode}}' "${name}")" = 0 ] \
  || fail "docker stop didn't stop it cleanly (exit $(docker inspect -f '{{.State.ExitCode}}' "${name}"))"
check "stops on SIGTERM, with exit 0"
check ok
