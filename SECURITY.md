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

- **Only you can reach it.** The server binds 127.0.0.1 only, never a public interface. It answers only requests
  whose `Host` is `localhost`, `127.0.0.1` or `[::1]`, which stops DNS-rebinding attacks from a web page you visit.
  When the browser sends an `Origin`, it must be that same localhost address, which stops another site from writing
  to your files (cross-site request forgery). (`server/security.ts`.)
- **Only canvases inside the folder.** Every path the page sends is resolved inside the folder you started it in,
  outside dot-folders and `node_modules`, and must be a `.excalidraw` file. Nothing outside it can be read or
  written. (`resolveInRoot` in `server/files.ts`.)
- **Nothing written on disk is lost.** Localidraw creates and saves canvases. It never deletes or renames a file, and
  a save based on an older version of a file is refused rather than overwriting it. Writes are atomic: a temporary
  file, then a rename.

Out of scope: anything that needs an attacker who can already run code as you, or write to the folder you're
serving. Localidraw trusts the files in that folder the way your editor does.
