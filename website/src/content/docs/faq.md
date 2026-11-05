---
title: FAQ
description: Common questions about Localidraw.
---

## Is this Excalidraw?

It's Excalidraw's editor, version 0.18.1, bundled whole: the same tools, shortcuts, library and look. Localidraw adds
the files around it: the folder, the Canvases sidebar, saving, and merging changes from disk. It isn't made by or
affiliated with the Excalidraw team.

## Can I open the files in excalidraw.com or VS Code?

Yes. They're ordinary `.excalidraw` files. 0.18.1 is the version the VS Code extension
([`pomdtr.excalidraw-editor`](https://marketplace.visualstudio.com/items?itemName=pomdtr.excalidraw-editor)) uses, so
files go back and forth between them. On excalidraw.com, use Open, or drag a file onto the canvas.

## Does it need the internet?

No. The editor and its fonts, including the CJK handwriting font, are in the package, and it talks only to its own
server on your machine. The Library's "Browse libraries" link goes to libraries.excalidraw.com, as it does in Excalidraw.
And `localidraw update` and `localidraw doctor` ask the npm registry for a newer version, but only when you run them
([Updating](/updating/)).

## Where are my preferences kept?

In your browser's `localStorage`: the viewport of each canvas, the theme, and the sidebar. Never in the files, so
switching to dark mode doesn't change a file in git.

## Can two people draw on the same canvas?

Not live. Localidraw has no collaboration server. Two pages open on the same Localidraw see each other's changes when
they're saved (within a second or so), merged per element, but not stroke by stroke. Two Localidraws on the same
folder (on a shared drive, say) don't know about each other's pages. Use one per folder.

## Why port 3729?

It spells "DRAW" on a phone keypad. Use `--port` to pick another.

## What about images in a canvas?

They work, as in Excalidraw: an image is stored in the file's `files`, as a data URL. A canvas with big images makes
a big file, and the whole file is written on every save, so keep that in mind for large screenshots.

## Does it delete or rename files?

It renames and moves canvases when you ask it to, from a canvas's menu in the sidebar, and never over another file.
It never deletes one: **Delete** moves the file into `.localidraw/trash/` in the folder, where it stays until you
remove it yourself. See [The Canvases sidebar](/canvases/#rename-move-and-delete). Renaming, moving and deleting in
your shell, file manager or git works too; the sidebar follows.

## Is it related to the other projects called Localidraw?

No. Two earlier projects on GitHub use the name, [theaubmov/Localidraw](https://github.com/theaubmov/Localidraw) (a
workspace manager adding multiple documents to Excalidraw) and [lnotspotl/localidraw](https://github.com/lnotspotl/localidraw)
(a folder gallery with Hugging Face sync); this one isn't connected to either.
