# Security policy

## Supported versions

Fixes go into the latest minor release only. Upgrade with `npm i -g localidraw@latest`, or just run
`npx localidraw@latest`.

## Reporting a vulnerability

Please report it privately through GitHub's private vulnerability reporting:
**https://github.com/edspencer/localidraw/security/advisories/new**. Don't open a public issue or pull request for
it.

Say what you found, which version, and how to reproduce it. You'll get an acknowledgement, and we'll agree on a fix
and a disclosure date with you before anything is published. Localidraw is maintained by one person, so allow a few
days for a first response.

## What Localidraw protects

Localidraw runs on your machine and reads and writes the `.excalidraw` files in the folder you start it in. What it's
built to guarantee, and so what counts as a vulnerability if broken:

- **Only you can reach it, unless you host it.** By default the server binds 127.0.0.1, never a public interface.
  It answers only requests whose `Host` is `localhost`, `127.0.0.1` or `[::1]`, which stops DNS-rebinding attacks
  from a web page you visit. When the browser sends an `Origin`, it must be that same address, which stops another
  site from writing to your files (cross-site request forgery). API calls the browser marks cross-site or same-site
  are refused, and writes must be `application/json`, which no other site can send without a CORS preflight that
  Localidraw never grants. (`server/security.ts`.)
- **Hosting is opt-in, and by name.** `--host` can listen beyond loopback, but then it refuses to start without at
  least one `--allowed-host`, and every request's `Host` must be loopback or one of those names, with an `Origin`
  of `http(s)://` and that same host. A request for any other name is refused, so a hosted Localidraw is still safe
  from DNS rebinding.
- **Only canvases inside the folder.** Every path the page sends is resolved inside the folder you started it in,
  outside dot-folders and `node_modules`, and must be a `.excalidraw` file. Nothing outside it can be read or
  written. (`resolveInRoot` in `server/files.ts`.) The one other file it reads and writes is the folder's shared
  Library, `library.excalidrawlib` at its top, at a fixed path the page can't choose, and only if it already exists.
- **Nothing written on disk is lost.** Localidraw creates, saves, renames and moves canvases (and saves the Library
  file). A rename or move never replaces another file. It never deletes one: deleting a canvas from the sidebar moves
  it into `.localidraw/trash/` under the folder, where it stays until you remove it yourself. A save based on an older
  version of a file is refused rather than overwriting it. Writes are atomic: a temporary
  file, then a rename.

Out of scope: anything that needs an attacker who can already run code as you, or write to the folder you're
serving. Localidraw trusts the files in that folder the way your editor does.

**Localidraw has no login.** Anyone who can reach a hosted Localidraw can read and change its canvases. When you host
it, put it behind a reverse proxy that does authentication (forward auth to an SSO, basic auth, a VPN such as
Tailscale), and publish its port only where that proxy can reach it. That someone who gets past your proxy can edit
the canvases is not a vulnerability in Localidraw.

## `npm audit`

The package has no runtime dependencies, so `npm audit` on an install of it finds nothing. In this repo it reports
findings in devDependencies, all of them Excalidraw's own dependencies. Excalidraw is bundled into the page
(`dist/web`), so their code does ship, inside the page's chunks, and each is triaged here. Re-check this list when
Excalidraw moves (AGENTS.md, "Upgrading Excalidraw").

As of 0.4.x, with Excalidraw pinned at 0.18.1:

| Package | Reached through | Advisory | Fixed here? | Why it doesn't matter in Localidraw |
| --- | --- | --- | --- | --- |
| `lodash-es` 4.17.21 | Mermaid, `chevrotain` | GHSA-r5fr-rjxr-66jc, GHSA-f23m-r3pf-42rh, GHSA-xxjr-mmjv-4gpg | **Yes**: `overrides` to `^4.18.1`, a minor of the same major | — |
| `nanoid` 3.3.3 | Excalidraw | GHSA-mwcw-c2x4-8c55, GHSA-28wg-ghj8-5hjv, GHSA-2v37-7h3g-55p8, GHSA-xwg4-73v4-xw9w | **Yes**: `overrides` (`nanoid@^3`) to `^3.3.18`, a patch | — |
| `nanoid` 4.0.2 | `@excalidraw/mermaid-to-excalidraw` (exact pin) | GHSA-28wg-ghj8-5hjv, GHSA-2v37-7h3g-55p8, GHSA-xwg4-73v4-xw9w | No: the fix is nanoid 5, a major | Each needs a negative, zero, non-integer or huge size, or a custom generator. It only ever calls `nanoid()`, the default 21 characters. |
| `katex` 0.16.x | Mermaid (`^0.16`) | GHSA-238p-pmpm-9mq7 | No: the fix is 0.18.2, outside Mermaid's range | It needs prototype pollution to exist already, and KaTeX only renders math in a Mermaid diagram that you type into Excalidraw's own "Mermaid to Excalidraw" dialog, in your page. |
| `mermaid`, `@excalidraw/mermaid-to-excalidraw`, `@excalidraw/excalidraw` | — | (through `katex` and `nanoid` 4 above) | No: `npm audit fix --force` would move Excalidraw back to 0.17.6 | As above. |

Nothing is fixed with `npm audit fix --force`: it downgrades Excalidraw, which breaks files' round-trip with the VS
Code extension. An override is only used for a patch or minor of the same major, and the browser tests run against it.
